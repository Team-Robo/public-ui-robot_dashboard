"""Battery: its settings, the battery_monitor process, and the latest reading.

Deliberately NOT a ProcessManager target: the monitor's whole command line
(topics, thresholds, where hdas_msg lives) comes from the Settings page, and a
generated target would fight targets.yaml's reload/diff logic. This service
spawns `ros2 run battery_monitor battery_monitor` itself, keeps its last log
lines for the Settings page, and subscribes to the monitor's sensor_msgs/
BatteryState output - a standard type, so the dashboard needs no hdas_msg.

It is monitoring only, so an e-stop (which acts on ProcessManager targets)
doesn't touch it.
"""

import collections
import math
import os
import signal
import subprocess
import threading
import time
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ValidationError, field_validator, model_validator
from rclpy.qos import HistoryPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import BatteryState

from .config_store import load_live_yaml, save_live_yaml
from .supervisor.process_manager import _with_pdeathsig

CONFIG_FILE = "battery.yaml"
LOG_LINES = 40
STOP_WAIT_SEC = 4.0


class BatteryConfig(BaseModel):
    enabled: bool = True
    spawn_monitor: bool = True
    state_topic: str = "/battery_state"
    bms_topic: str = "/hdas/bms"
    hdas_msg_path: str = ""
    capital_mode: Literal["auto", "percent", "raw"] = "auto"
    warn_pct: float = 25.0
    critical_pct: float = 10.0
    stale_sec: float = 5.0

    @field_validator("state_topic", "bms_topic")
    @classmethod
    def _topic(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith("/") or any(c.isspace() for c in v):
            raise ValueError("must be an absolute topic name like /battery_state")
        return v

    @model_validator(mode="after")
    def _ranges(self):
        if not 0 <= self.critical_pct <= self.warn_pct <= 100:
            raise ValueError("need 0 <= critical_pct <= warn_pct <= 100")
        if self.stale_sec <= 0:
            raise ValueError("stale_sec must be > 0")
        return self


def load_config() -> BatteryConfig:
    return BatteryConfig(**dict(load_live_yaml(CONFIG_FILE) or {}))


def save_config(cfg: BatteryConfig) -> None:
    doc = load_live_yaml(CONFIG_FILE)
    for key, value in cfg.model_dump().items():
        doc[key] = value
    save_live_yaml(CONFIG_FILE, doc)


def monitor_command(cfg: BatteryConfig) -> list[str]:
    return [
        "ros2", "run", "battery_monitor", "battery_monitor", "--ros-args",
        "-p", f"bms_topic:={cfg.bms_topic}",
        "-p", f"out_topic:={cfg.state_topic}",
        "-p", f"capital_mode:={cfg.capital_mode}",
        "-p", f"warn_pct:={cfg.warn_pct}",
        "-p", f"critical_pct:={cfg.critical_pct}",
        "-p", f"stale_sec:={cfg.stale_sec}",
    ]


def monitor_env(cfg: BatteryConfig, environ: dict) -> dict:
    """hdas_msg is not a rosdep package - it lives in Galaxea's own install, so
    its python and shared-lib dirs are PREPENDED to whatever is already set
    (replacing LD_LIBRARY_PATH would drop /opt/ros off it, see
    ProcessManager.start)."""
    if not cfg.hdas_msg_path:
        return dict(environ)
    root = os.path.expanduser(cfg.hdas_msg_path)
    env = dict(environ)
    for var, sub in (("PYTHONPATH", "local/lib/python3.10/dist-packages"), ("LD_LIBRARY_PATH", "lib")):
        path = os.path.join(root, sub)
        env[var] = f"{path}:{environ[var]}" if environ.get(var) else path
    return env


def battery_level(percentage: Optional[float], cfg: BatteryConfig) -> str:
    if percentage is None:
        return "unknown"
    if percentage < cfg.critical_pct:
        return "critical"
    return "warn" if percentage < cfg.warn_pct else "ok"


def _finite(x: float) -> Optional[float]:
    return float(x) if math.isfinite(x) else None


class BatteryService:
    def __init__(self, ros_node, spin_dispatch, config: BatteryConfig):
        self._node = ros_node
        self._spin = spin_dispatch
        self._cfg = config
        self._lock = threading.Lock()
        self._subscription = None
        self._last: Optional[dict] = None
        self._last_rx = 0.0
        self._proc: Optional[subprocess.Popen] = None
        self._stopping = False
        self._monitor_state = "stopped"
        self._monitor_message: Optional[str] = None
        self._log: collections.deque = collections.deque(maxlen=LOG_LINES)

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        self._apply_subscription()
        if self._cfg.spawn_monitor:
            self._spawn()

    def shutdown(self) -> None:
        self._stop_monitor()

    def apply(self, new: BatteryConfig) -> None:
        with self._lock:
            old, self._cfg = self._cfg, new
        if new.state_topic != old.state_topic or new.enabled != old.enabled:
            self._apply_subscription()
        monitor_changed = {k: v for k, v in new.model_dump().items() if k != "enabled"} != \
            {k: v for k, v in old.model_dump().items() if k != "enabled"}
        if monitor_changed:
            self.restart_monitor()

    def restart_monitor(self) -> None:
        self._stop_monitor()
        if self._cfg.spawn_monitor:
            self._spawn()

    # -- subscription ------------------------------------------------------

    def _apply_subscription(self) -> None:
        old, self._subscription = self._subscription, None
        if old is not None:
            self._spin.run(lambda: self._node.destroy_subscription(old))
        with self._lock:
            self._last = None
            enabled, topic = self._cfg.enabled, self._cfg.state_topic
        if not enabled:
            return
        # BEST_EFFORT is compatible with a reliable or a best-effort publisher.
        qos = QoSProfile(reliability=ReliabilityPolicy.BEST_EFFORT, history=HistoryPolicy.KEEP_LAST, depth=1)
        self._subscription = self._spin.run(
            lambda: self._node.create_subscription(BatteryState, topic, self._on_state, qos))

    def _on_state(self, msg: BatteryState) -> None:
        pct = _finite(msg.percentage)
        with self._lock:
            self._last = {
                "percentage": pct * 100.0 if pct is not None else None,
                "voltage": _finite(msg.voltage),
                "current": _finite(msg.current),
            }
            self._last_rx = time.monotonic()

    # -- monitor process ---------------------------------------------------

    def _spawn(self) -> None:
        cfg = self._cfg
        self._log.clear()
        self._stopping = False
        try:
            proc = subprocess.Popen(
                _with_pdeathsig(monitor_command(cfg)),
                env=monitor_env(cfg, dict(os.environ)),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                start_new_session=True,
            )
        except OSError as exc:
            self._monitor_state, self._monitor_message = "failed", f"failed to spawn: {exc}"
            return
        self._proc = proc
        self._monitor_state, self._monitor_message = "running", None
        threading.Thread(target=self._read, args=(proc,), daemon=True, name="battery-monitor-log").start()

    def _read(self, proc: subprocess.Popen) -> None:
        for line in proc.stdout:
            self._log.append(line.rstrip())
        code = proc.wait()
        proc.stdout.close()
        if self._proc is not proc:
            return  # superseded by a restart
        if self._stopping:
            self._monitor_state, self._monitor_message = "stopped", None
        elif code == 0:
            self._monitor_state, self._monitor_message = "exited", "monitor exited (0)"
        else:
            self._monitor_state, self._monitor_message = "failed", f"monitor exited ({code})"

    def _stop_monitor(self) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        self._stopping = True
        for sig, wait in ((signal.SIGINT, STOP_WAIT_SEC), (signal.SIGKILL, 2.0)):
            try:
                os.killpg(proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                return
            try:
                proc.wait(timeout=wait)
                return
            except subprocess.TimeoutExpired:
                continue

    # -- status ------------------------------------------------------------

    def config(self) -> BatteryConfig:
        return self._cfg

    def status(self) -> dict:
        with self._lock:
            cfg, last, last_rx = self._cfg, self._last, self._last_rx
        age = time.monotonic() - last_rx if last is not None else None
        stale = last is None or age > cfg.stale_sec
        pct = last["percentage"] if last and not stale else None
        return {
            "enabled": cfg.enabled,
            "topic": cfg.state_topic,
            "data": None if last is None else {**last, "age_sec": age},
            "stale": stale,
            "level": battery_level(pct, cfg),
            "monitor": {
                "state": self._monitor_state if cfg.spawn_monitor or self._monitor_state != "stopped" else "disabled",
                "message": self._monitor_message,
                "log": list(self._log),
            },
        }


def create_battery_router(service: BatteryService) -> APIRouter:
    import asyncio

    router = APIRouter(prefix="/api/battery", tags=["battery"])

    @router.get("")
    async def get_status():
        return service.status()

    @router.get("/config")
    async def get_config():
        return service.config().model_dump()

    @router.put("/config")
    async def put_config(body: dict):
        try:
            cfg = BatteryConfig(**body)
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail="; ".join(
                f"{'.'.join(map(str, e['loc'])) or 'config'}: {e['msg']}" for e in exc.errors()))
        await asyncio.to_thread(save_config, cfg)
        await asyncio.to_thread(service.apply, cfg)
        return cfg.model_dump()

    @router.post("/monitor/restart")
    async def restart_monitor():
        await asyncio.to_thread(service.restart_monitor)
        return {}

    return router
