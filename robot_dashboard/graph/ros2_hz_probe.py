"""The real `ros2 topic hz`, run as a subprocess, for the Graph tab's Hz readout.

Why not just trust the dashboard's own subscription rate: that callback runs
deserialized, on the dashboard's one SingleThreadedExecutor alongside
everything else, so a busy backend (or a slow link) drops messages and the
rate it reports is "what the backend received", not "what the publisher is
doing". `ros2 topic hz` runs in its own process, subscribes raw (no
deserialization) with the sensor-data QoS, and so is what you'd see typing it
by hand on the robot. It is shown as the headline number, ours in brackets.

Behaviours inherited from the CLI on purpose, so the number matches what a
person would see: it is a cumulative average over up to 10000 messages (not a
short sliding window - slow to react to a rate change), it uses ROS time, and
it prints a line only when a message arrives. A topic that stops publishing
therefore just stops producing lines; snapshot() reports `ros2_hz: None` once
the last line is older than STALE_AFTER_SEC rather than showing a frozen value.

A backend that is SIGKILLed can't clean up after itself; its probes exit on
their next print (the pipe is closed, so the write raises BrokenPipeError),
i.e. only once the topic next publishes.
"""

import atexit
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from typing import Callable, Optional, Sequence

STALE_AFTER_SEC = 5.0
KILL_AFTER_SEC = 3.0

_RATE_RE = re.compile(r"average rate:\s*([0-9]*\.?[0-9]+)")
_WINDOW_RE = re.compile(r"window:\s*(\d+)")

_live_probes: "set[Ros2HzProbe]" = set()
_live_lock = threading.Lock()


def parse_rate_line(line: str) -> Optional[float]:
    m = _RATE_RE.search(line)
    return float(m.group(1)) if m else None


def parse_window_line(line: str) -> Optional[int]:
    m = _WINDOW_RE.search(line)
    return int(m.group(1)) if m else None


def default_command(topic_name: str) -> Sequence[str]:
    return ["ros2", "topic", "hz", topic_name]


class Ros2HzProbe:
    def __init__(self, topic_name: str,
                 command_factory: Callable[[str], Sequence[str]] = default_command):
        self._topic = topic_name
        self._command_factory = command_factory
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._hz: Optional[float] = None
        self._window: Optional[int] = None
        self._hz_at = 0.0
        self._error: Optional[str] = None
        self._last_other_line = ""
        self._stopping = False

    def start(self) -> None:
        command = list(self._command_factory(self._topic))
        if shutil.which(command[0]) is None:
            self._error = f"'{command[0]}' not found on PATH"
            return
        try:
            self._proc = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                # The CLI is Python; without this its stdout is block-buffered
                # on a pipe and the first line would take minutes.
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
                # Own process group: stop() signals the group without ever
                # touching the backend itself.
                start_new_session=True,
            )
        except OSError as exc:
            self._error = f"failed to start ros2 topic hz: {exc}"
            return
        with _live_lock:
            _live_probes.add(self)
        threading.Thread(target=self._read, args=(self._proc,), daemon=True,
                         name=f"ros2-hz-{self._topic}").start()

    def _read(self, proc: subprocess.Popen) -> None:
        for line in proc.stdout:
            rate = parse_rate_line(line)
            if rate is not None:
                with self._lock:
                    self._hz, self._hz_at = rate, time.monotonic()
                continue
            window = parse_window_line(line)
            if window is not None:
                with self._lock:
                    self._window = window
            elif line.strip():
                self._last_other_line = line.strip()
        code = proc.wait()
        proc.stdout.close()
        with _live_lock:
            _live_probes.discard(self)
        if not self._stopping:
            with self._lock:
                self._error = (f"ros2 topic hz exited ({code})"
                               + (f": {self._last_other_line}" if self._last_other_line else ""))

    def snapshot(self) -> dict:
        with self._lock:
            fresh = self._hz is not None and time.monotonic() - self._hz_at <= STALE_AFTER_SEC
            return {
                "ros2_hz": self._hz if fresh else None,
                "ros2_window": self._window if fresh else None,
                "ros2_error": self._error,
            }

    def stop(self) -> None:
        """Non-blocking: SIGINT now (the CLI exits cleanly on it), SIGKILL and
        reap from a short-lived thread if it hasn't gone."""
        self._stopping = True
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        self._signal(proc, signal.SIGINT)

        def _reap():
            try:
                proc.wait(timeout=KILL_AFTER_SEC)
            except subprocess.TimeoutExpired:
                self._signal(proc, signal.SIGKILL)
                proc.wait()

        threading.Thread(target=_reap, daemon=True).start()

    @staticmethod
    def _signal(proc: subprocess.Popen, sig: int) -> None:
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


def stop_all() -> None:
    with _live_lock:
        probes = list(_live_probes)
    for probe in probes:
        probe._stopping = True
        if probe._proc is not None:
            probe._signal(probe._proc, signal.SIGKILL)


atexit.register(stop_all)
