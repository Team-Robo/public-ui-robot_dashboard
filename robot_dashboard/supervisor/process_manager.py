import asyncio
import logging
import os
import shlex
import signal
import subprocess
import threading
import time
import urllib.error
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Optional

from ament_index_python.packages import PackageNotFoundError, get_package_prefix

from .conditions import (
    ConditionError,
    DependencyNotMet,
    EvalContext,
    EvalResult,
    collect_target_ids,
    evaluate,
    iter_leaves,
    platform_lockout,
)
from . import pid_registry
from .models import ProcessState, TargetConfig, TargetStatus
from .windows_companion_client import STARTUP_POLL_TIMEOUT_SEC, WindowsCompanionClient, detect_platform

logger = logging.getLogger("robot_dashboard.supervisor")

LOG_BUFFER_SIZE = 2000
GRACE_PERIOD_SEC = 5.0
READY_POLL_INTERVAL_SEC = 0.25
WINDOWS_POLL_INTERVAL_SEC = 2.0
# main.py's own bootstrap thread can take up to STARTUP_POLL_TIMEOUT_SEC to
# resolve the Windows companion (cold-starting it over the WSL<->Windows
# interop boundary) - a kind=windows start() landing in that window used to
# read "no client yet" as "permanently unavailable" and fail immediately,
# even though the companion might come up a second later. This is how long
# _start_windows waits for that resolution before giving up for real; +2s
# margin over the bootstrap's own budget for thread-scheduling/IPC overhead,
# so a start() that arrives right as bootstrap begins doesn't lose the race.
WINDOWS_BOOTSTRAP_WAIT_TIMEOUT_SEC = STARTUP_POLL_TIMEOUT_SEC + 2.0
# Two DIFFERENT grace windows, because they're different kinds of unknown:
#   * A target we JUST spawned is genuinely coming up (node registration,
#     model load...) - we KNOW it will be running barring a crash, so wait for
#     it to actually reach RUNNING. Generous/"excessive": starting is real
#     work, and a too-short window turns a slow-but-fine bring-up into a
#     spurious pause.
DEPENDENCY_STARTING_WAIT_SEC = 30.0
#   * A non-target prerequisite (device:/file:/topic:/custom:) is a MAYBE -
#     something external that may or may not appear. Keep it short and
#     conservative; if it takes longer the operator decides at the prompt.
DEPENDENCY_GRACE_RETRY_SEC = 3.0
DEPENDENCY_GRACE_POLL_SEC = 0.4
# A target with no ready_node_name reports RUNNING the instant start()
# spawns it (see start()'s own "immediate-RUNNING" default) - BEFORE the
# underlying process has proven it's actually still alive. A fast crash
# (bad args, a missing runtime dependency, ...) only flips the state to
# FAILED once _pump_output's own thread observes stdout EOF, which hasn't
# necessarily happened yet at the instant start() returns. Without a
# settle window, start_with_dependencies's spawn-failure check races that
# thread and can lose - confirmed live: a target pointed at a nonexistent
# ros2 package/executable (fails in ~0.2-1s) was read as a clean success
# because its own state hadn't been updated to FAILED yet. Short on
# purpose - this is only meant to catch "crashed almost immediately," not
# stand in for ready_node_name's own (much longer) real readiness wait.
SPAWN_SETTLE_SEC = 1.5
SPAWN_SETTLE_POLL_SEC = 0.15

_COMPANION_STATE_MAP = {
    "running": ProcessState.RUNNING,
    "stopping": ProcessState.STOPPING,
    "stopped": ProcessState.STOPPED,
    "exited": ProcessState.EXITED,
    "failed": ProcessState.FAILED,
}


def build_command(cfg: TargetConfig, extra_args: list[str] = ()) -> list[str]:
    if cfg.kind == "run":
        if not cfg.package or not cfg.executable:
            raise ValueError(f"target {cfg.id}: kind=run requires 'package' and 'executable'")
        return ["ros2", "run", cfg.package, cfg.executable, *cfg.args, *extra_args]
    if cfg.kind == "launch":
        if not cfg.package or not cfg.launch_file:
            raise ValueError(f"target {cfg.id}: kind=launch requires 'package' and 'launch_file'")
        return ["ros2", "launch", cfg.package, cfg.launch_file, *cfg.args, *extra_args]
    if cfg.kind == "windows":
        # Never spawned locally - start()/stop() dispatch these to the
        # companion client instead of using build_command() at all. Only
        # reachable here if that dispatch is ever bypassed by mistake.
        raise ValueError(f"target {cfg.id}: kind=windows targets don't use build_command()")
    raise ValueError(f"target {cfg.id}: unknown kind '{cfg.kind}'")


def _package_fingerprint(package: str) -> Optional[float]:
    """Latest mtime across every file under this package's install prefix -
    the cheapest available signal that a package's actual CODE changed (a
    colcon rebuild), independent of targets.yaml (a rebuild edits no
    config) and independent of any AMENT_PREFIX_PATH-style env var (the
    install path itself doesn't move on a rebuild, only the files inside
    it). This workspace's packages are confirmed plain-copy installs, not
    symlink-installed, so a rebuild really does refresh changed files'
    mtimes rather than just re-pointing an unchanged symlink. Returns None
    if the package isn't found (not yet built, or a typo) - callers should
    treat that as "unknown", not "unchanged"."""
    try:
        prefix = get_package_prefix(package)
    except PackageNotFoundError:
        return None
    latest = 0.0
    for root, _dirs, files in os.walk(prefix):
        for name in files:
            try:
                latest = max(latest, os.path.getmtime(os.path.join(root, name)))
            except OSError:
                continue
    return latest or None


# PR_SET_PDEATHSIG (Linux prctl option 1): tells the kernel to deliver a
# signal to THIS process the moment its real parent dies, for ANY reason -
# a graceful shutdown, a crash, or a SIGKILL that can't be caught or
# handled by definition. start_new_session=True (below) already gives
# stop()'s own SIGINT/SIGTERM/SIGKILL escalation a clean process group to
# kill against, but that's only reached if something actually CALLS
# stop() - it does nothing if dashboard_server itself dies first, which is
# exactly the "closed the dashboard and it left everything running" bug
# this exists to fix.
#
# NOT an exec-replacing one-liner (the first version of this) - confirmed
# live that's insufficient: `ros2 run` does NOT exec-replace itself into
# the target executable, it forks the real node as its OWN child (every
# `ros2 run` target has shown up as two distinct PIDs all session: the
# `ros2 run ...` process and a separate one for the actual installed
# binary). PDEATHSIG only protects the ONE process that called prctl() -
# exec-replacing into `ros2 run` meant PDEATHSIG correctly killed `ros2
# run` itself on parent death, but `ros2 run`'s own grandchild (the real
# node) was one hop further removed and was left orphaned, re-parented to
# WSL's /init, still running (observed live: webcam_publisher survived a
# dashboard_server death this way).
#
# Fixed by making the shim a persistent supervisor instead of a one-shot
# exec-replacer: sets PDEATHSIG on itself, spawns the real command as its
# OWN child (staying in the same process group - Popen already made this
# shim the group leader via start_new_session=True below, and a plain
# fork/exec child inherits that group unless it explicitly changes it),
# then on receiving SIGTERM (from PDEATHSIG firing, or a normal kill/
# stop() call) forwards it to the WHOLE group via killpg - covering
# whatever `ros2 run`/`ros2 launch` spawned underneath it, regardless of
# how many hops deep. Relays the child's real exit code as its own so
# existing exit_code tracking is unaffected.
#
# Deliberately NOT subprocess.Popen's preexec_fn for the prctl call - it's
# fork-unsafe in a multithreaded parent (this one: rclpy's
# MultiThreadedExecutor on a background thread, uvicorn/asyncio on the
# main one) and a known source of intermittent deadlocks.
_PDEATHSIG_SHIM = "\n".join([
    "import ctypes, os, signal, subprocess, sys",
    "ctypes.CDLL('libc.so.6', use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0)",
    "child = subprocess.Popen(sys.argv[1:])",
    "def _relay(signum, frame):",
    "    signal.signal(signum, signal.SIG_DFL)",
    "    os.killpg(os.getpgrp(), signum)",
    "signal.signal(signal.SIGTERM, _relay)",
    "signal.signal(signal.SIGINT, _relay)",
    "sys.exit(child.wait())",
])


def _with_pdeathsig(command: list[str]) -> list[str]:
    return ["python3", "-c", _PDEATHSIG_SHIM, *command]


@dataclass
class ManagedProcess:
    config: TargetConfig
    state: ProcessState = ProcessState.STOPPED
    popen: Optional[subprocess.Popen] = None
    pid: Optional[int] = None
    exit_code: Optional[int] = None
    log_buffer: Deque[str] = field(default_factory=lambda: deque(maxlen=LOG_BUFFER_SIZE))
    log_subscribers: set = field(default_factory=set)
    # True when this target was REMOVED from the config but was still RUNNING,
    # so reload_targets() kept it to finish its lifecycle instead of dropping
    # a live process. Once it reaches a terminal state it's pruned and a
    # 'removed' event is broadcast, so the row disappears on its own.
    detached: bool = False


class ProcessManager:
    """Owns start/stop/status for every configured target.

    Blocking by design (subprocess.Popen/.wait, os.killpg) - callers on the
    asyncio side must wrap calls in `asyncio.to_thread`, never call directly
    from an `async def` route handler.
    """

    def __init__(
        self,
        targets: list[TargetConfig],
        node_exists: Optional[Callable[[str], bool]] = None,
        windows_client: Optional[WindowsCompanionClient] = None,
        ros_node: Optional[object] = None,
    ):
        self._processes: dict[str, ManagedProcess] = {
            t.id: ManagedProcess(config=t) for t in targets
        }
        # target_id -> its `requires` expression tree (see conditions.py).
        self._requires: dict[str, Optional[dict]] = {
            t.id: t.requires for t in targets if t.requires
        }
        # package name -> latest mtime seen across its install prefix - see
        # check_package_changes(). Starts empty deliberately: the first
        # check after startup has nothing to compare against yet, so
        # nothing is reported changed (not "everything changed") - same
        # spirit as targets_diff never firing on the very first reload.
        self._package_fingerprints: dict[str, float] = {}
        # The dashboard's own rclpy node, used ONLY to answer graph predicates
        # (`topic`/`service`/`action`/`node` leaves) inside a dependency
        # condition. None in tests / on a host without it -> those predicates
        # simply evaluate false ("lookup unavailable"), never raise.
        self._ros_node = ros_node
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._event_subscribers: set[asyncio.Queue] = set()
        self._lock = threading.Lock()
        # Optional: True iff a fully-qualified node name is currently on the
        # ROS graph. Only used for targets that declare ready_node_name -
        # see start()/_probe_ready(). None (the default in tests / anywhere
        # without ROS graph access) falls back to the old immediate-RUNNING
        # behavior even for a target that declares one, rather than hanging.
        self._node_exists = node_exists
        # None on a native-Linux robot, or if the companion failed to
        # bootstrap (see windows_companion_client.ensure_companion_running) -
        # kind=windows targets stay reachable in the API either way, they
        # just always report FAILED with an explanatory log line instead of
        # ever actually starting. Never raises on its own.
        self._windows_client = windows_client
        self._windows_seen_log_count: dict[str, int] = {}
        # Set once the companion bootstrap has resolved one way or the other
        # (a client, or definitively none - see set_windows_client/
        # set_windows_unavailable). A caller that already HAS a client at
        # construction time has nothing left to resolve, so that case starts
        # pre-set; main.py's real startup path always constructs with None
        # and resolves this later from its background bootstrap thread
        # (which can take a while - see _start_windows), so that's the case
        # this starts UNSET for, deliberately.
        self._windows_bootstrap_done = threading.Event()
        if windows_client is not None:
            self._windows_bootstrap_done.set()
            threading.Thread(target=self._poll_windows_targets, daemon=True).start()
        # Orphans left behind by a PREVIOUS dashboard_server run that ended
        # without going through stop() (killed -9, crashed...) - see
        # pid_registry's own docstring. Read once at construction, before
        # this instance spawns anything of its own, so a target_id showing
        # up here can never be confused with something THIS instance just
        # started (that always goes through start()/pid_registry.record()
        # instead). Cleared per-target as each orphan gets killed via
        # kill_orphan(), never repopulated afterward.
        self._orphans: dict[str, dict] = pid_registry.reconcile()

    def set_windows_client(self, windows_client: WindowsCompanionClient) -> None:
        """Same effect as passing windows_client to __init__, for when the
        companion bootstrap runs on its own background thread instead of
        blocking dashboard_server's own startup (main.py calls this once
        ensure_companion_running() resolves with an actual client). Starts
        the poller thread here instead, since __init__ never got a client to
        decide that from. Setting _windows_bootstrap_done releases any
        start() currently blocked in _start_windows waiting to find out."""
        self._windows_client = windows_client
        self._windows_bootstrap_done.set()
        threading.Thread(target=self._poll_windows_targets, daemon=True).start()

    def set_windows_unavailable(self) -> None:
        """The companion-bootstrap counterpart to set_windows_client: called
        once ensure_companion_running() resolves to None (native-Linux
        platform, or the companion failed to come up) - there's definitely
        no client coming this session, so any start() blocked in
        _start_windows waiting to find out should stop waiting and report
        FAILED now rather than sit out the full wait timeout for nothing."""
        self._windows_client = None
        self._windows_bootstrap_done.set()

    def set_event_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def reload_targets(self, new_targets: list[TargetConfig]) -> list[str]:
        """Replaces the target list from a config-GUI save. An id that's
        still present gets its config swapped in place, keeping whatever
        runtime state it currently has (a running process doesn't get
        reset just because its label changed) - only a brand new id gets a
        fresh ManagedProcess. An id that's RUNNING or STARTING but no
        longer appears in new_targets is deliberately NOT removed: a
        config edit must never silently drop tracking of a live process
        just because someone deleted its entry. Returns the ids that were
        skipped for that reason, so the caller can tell the user their
        removal didn't actually take effect."""
        new_by_id = {t.id: t for t in new_targets}
        skipped = []
        with self._lock:
            for tid, proc in list(self._processes.items()):
                if tid in new_by_id:
                    continue
                if proc.state in (ProcessState.RUNNING, ProcessState.STARTING):
                    # Kept to finish its lifecycle, but mark it detached so it
                    # auto-prunes (and the row disappears) once it stops.
                    proc.detached = True
                    skipped.append(tid)
                    continue
                del self._processes[tid]
            for tid, cfg in new_by_id.items():
                if tid in self._processes:
                    self._processes[tid].config = cfg
                    self._processes[tid].detached = False
                else:
                    self._processes[tid] = ManagedProcess(config=cfg)
            # Rebuild alongside self._processes, same filter as __init__ -
            # every dependency-condition method (dependency_status/closure,
            # external_prereqs, start()'s gate) reads self._requires, not
            # proc.config.requires directly. Without this, a `requires:`
            # added or edited after startup was silently never enforced:
            # proc.config.requires got the new expression above, but the
            # gate kept reading the stale (or absent) entry here.
            self._requires = {tid: t.requires for tid, t in new_by_id.items() if t.requires}
        return skipped

    def current_target_configs(self) -> dict[str, TargetConfig]:
        """Each target's config as currently held here - the only place the
        PREVIOUS state lives when a caller wants to diff against a fresh
        reload_targets() call, since load_targets() always reads straight
        from disk (no memory of what it returned last time)."""
        return {tid: proc.config for tid, proc in self._processes.items()}

    def check_package_changes(self, targets: list[TargetConfig]) -> list[str]:
        """Target ids whose underlying PACKAGE's installed files changed
        since the last call - catches "someone colcon-built a new version
        of this node" even when targets.yaml is untouched and no env var
        moved, neither of which a plain config diff (see config_routes.py's
        _diff_by_id) or an environment reload (env_reload.py) would ever
        catch on their own. kind=windows targets have no `package` and are
        skipped; a package not yet built (get_package_prefix fails) is
        skipped too, not reported as "changed" - nothing to compare against.

        Stateful: updates self._package_fingerprints as it goes, so this
        is meant to be called once per reload (see config_routes.py's
        reload_live_config), not repeatedly for the same reload."""
        changed_ids = []
        for t in targets:
            if not t.package:
                continue
            fingerprint = _package_fingerprint(t.package)
            if fingerprint is None:
                continue
            previous = self._package_fingerprints.get(t.package)
            self._package_fingerprints[t.package] = fingerprint
            if previous is not None and fingerprint != previous:
                changed_ids.append(t.id)
        return sorted(changed_ids)

    def _prune_if_detached(self, target_id: str) -> None:
        """If a target was removed from config (detached) and has reached a
        terminal state, drop it from the registry and broadcast a 'removed'
        event so the Control tab clears the row - instead of a dead
        still-listed target lingering forever."""
        with self._lock:
            proc = self._processes.get(target_id)
            if (
                proc is None
                or not proc.detached
                or proc.state not in (ProcessState.STOPPED, ProcessState.EXITED, ProcessState.FAILED)
            ):
                return
            self._processes.pop(target_id, None)
            # after dropping, deliver an explicit removed event
            if self._loop is not None:
                self._loop.call_soon_threadsafe(self._broadcast_removed, target_id)

    def _broadcast_removed(self, target_id: str) -> None:
        event = {"type": "removed", "id": target_id}
        for q in list(self._event_subscribers):
            q.put_nowait(event)

    def _broadcast_orphan_killed(self, target_id: str, pid: int) -> None:
        event = {"type": "orphan_killed", "id": target_id, "pid": pid}
        for q in list(self._event_subscribers):
            q.put_nowait(event)

    # -- status -----------------------------------------------------------

    def status(self, target_id: str) -> TargetStatus:
        proc = self._processes[target_id]
        locked_out = (
            platform_lockout(proc.config.requires, self._dependency_ctx())
            if proc.config.requires
            else None
        )
        return TargetStatus(
            id=proc.config.id,
            label=proc.config.label,
            category=proc.config.category,
            kind=proc.config.kind,
            state=proc.state,
            pid=proc.pid,
            exit_code=proc.exit_code,
            flags=proc.config.flags,
            platform_locked_out=locked_out,
            orphan_pid=self._orphans.get(target_id, {}).get("pid"),
        )

    def status_all(self) -> list[TargetStatus]:
        return [self.status(tid) for tid in self._processes]

    def windows_available(self) -> bool:
        return self._windows_client is not None

    # -- orphaned PIDs from a previous dashboard_server run ----------------

    def list_orphans(self) -> list[dict]:
        return [
            {"target_id": tid, "pid": info["pid"], "cmd": info["cmd"]}
            for tid, info in self._orphans.items()
        ]

    def kill_orphan(self, target_id: str) -> bool:
        """Best-effort kill of a pid this instance never spawned (no Popen,
        no pgid we created ourselves) - reachable only for entries
        list_orphans() is currently reporting, i.e. already confirmed alive
        under roughly the recorded command at the last reconcile(). Same
        escalation shape as stop()'s graceful path (SIGINT -> SIGTERM ->
        SIGKILL against the whole group), since every locally-spawned
        target is its own process group leader (start_new_session=True in
        start()) - just driven from a raw pid instead of a live Popen.
        Returns False if the pid is already gone (nothing to do, not an
        error - most likely someone else/the OS cleaned it up already)."""
        info = self._orphans.get(target_id)
        if info is None:
            return False
        pid = info["pid"]
        try:
            pgid = os.getpgid(pid)
        except ProcessLookupError:
            # Leader pid is already gone (reconcile() may have flagged this as
            # a leader-dead-but-group-surviving leak). getpgid() dies with the
            # leader, but the group id EQUALS that recorded leader pid
            # (start_new_session=True => popen.pid == pgid), which stays a
            # valid killpg target while any reparented member survives. So
            # target the group by that id directly rather than giving up.
            pgid = pid

        self._killpg_quiet(pgid, signal.SIGINT)
        if not self._wait_group_gone(pgid, GRACE_PERIOD_SEC):
            self._killpg_quiet(pgid, signal.SIGTERM)
            if not self._wait_group_gone(pgid, GRACE_PERIOD_SEC):
                self._killpg_quiet(pgid, signal.SIGKILL)
                self._wait_group_gone(pgid, GRACE_PERIOD_SEC)

        self._orphans.pop(target_id, None)
        pid_registry.forget(target_id)
        # Fires for BOTH paths that call this: the manual Kill tag, and
        # start()'s own auto-kill-before-spawn - one broadcast covers both,
        # so the frontend toast is consistent regardless of which triggered
        # it (see App.tsx's connectEvents watcher).
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._broadcast_orphan_killed, target_id, pid)
        return True

    @staticmethod
    def _wait_pid_gone(pid: int, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            time.sleep(0.1)
        return False

    @staticmethod
    def _wait_group_gone(pgid: int, timeout: float) -> bool:
        """True when no process still shares this group id. Used instead of
        _wait_pid_gone when killing an orphan whose recorded pid is the (dead)
        leader - there the leader is already gone but the whole point is the
        surviving members, so waiting on the single pid would just return
        immediately and never actually verify the leak was reaped."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not pid_registry.group_member_pids(pgid):
                return True
            time.sleep(0.1)
        return False

    # -- dependency conditions ------------------------------------------------

    def _dependency_ctx(self, allow_starting: bool = False, selected_flags: Optional[set] = None) -> EvalContext:
        """Fresh EvalContext bound to the current process states + the ROS
        graph (if a graph node was injected). Every graph predicate falls
        back to "unsatisfied/lookup-unavailable" rather than raising when the
        provider is absent.

        allow_starting=True is the chain-start view: a target we JUST spawned
        is legitimately STARTING, so for the purpose of "is the thing I need up"
        STARTING counts as satisfied. The pre-check (allow_starting=False) is
        stricter - it's asking "is it actually RUNNING right now." This is what
        keeps a chain-start from aborting on a dep that's still registering.

        selected_flags: the flag NAMES selected for the ONE target whose own
        `requires` is about to be evaluated against this ctx (see `flag:` in
        conditions.py) - None leaves flag_selected unset, so any `flag:` leaf
        reads as not-selected rather than erroring. Every call site below
        that evaluates a SPECIFIC target's own expression passes that
        target's own in-progress flags here; call sites that walk MULTIPLE
        targets' expressions with one shared ctx (dependency_closure's
        stack, external_prereqs) can only honor this for the root target -
        see their own notes."""
        node = self._ros_node

        def target_running(tid: str) -> bool:
            proc = self._processes.get(tid)
            if proc is None:
                return False
            if allow_starting:
                return proc.state in (ProcessState.RUNNING, ProcessState.STARTING)
            return proc.state == ProcessState.RUNNING

        def topic_active(name: str) -> bool:
            if node is None:
                return False
            try:
                return node.topic_endpoint_info(name).get("publisher_count", 0) > 0
            except Exception:  # noqa: BLE001
                return False

        def service_exists(name: str) -> bool:
            if node is None:
                return False
            try:
                return any(n == name for n, _ in node.get_service_names_and_types())
            except Exception:  # noqa: BLE001
                return False

        def action_exists(name: str) -> bool:
            if node is None:
                return False
            try:
                import rclpy.action
                return any(n == name for n, _ in rclpy.action.get_action_names_and_types(node))
            except Exception:  # noqa: BLE001
                return False

        return EvalContext(
            target_running=target_running,
            node_exists=self._node_exists,
            topic_active=topic_active,
            service_exists=service_exists,
            action_exists=action_exists,
            platform=detect_platform(),
            flag_selected=(lambda name: name in selected_flags) if selected_flags is not None else None,
        )

    def dependency_status(self, target_id: str, allow_starting: bool = False,
                          selected_flags: Optional[set] = None) -> EvalResult:
        """Evaluate a single target's `requires` condition right now. A target
        with no `requires` is always satisfied. Never raises: a `target:` leaf
        or graph leaf that can't be resolved just reads false. allow_starting
        treats STARTING deps as satisfied (the chain-start view - see
        _dependency_ctx). selected_flags: target_id's OWN in-progress flag
        selection, for `flag:` leaves - see _dependency_ctx."""
        expr = self._requires.get(target_id)
        if not expr:
            return EvalResult(True, "no dependencies")
        ctx = self._dependency_ctx(allow_starting=allow_starting, selected_flags=selected_flags)
        try:
            return evaluate(expr, ctx)
        except Exception as exc:  # noqa: BLE001
            return EvalResult(False, f"dependency evaluation error: {exc}")

    def _retry_non_target(self, expr: dict, ctx: EvalContext) -> EvalResult:
        """Give a NON-target prerequisite (device:/file:/topic:/custom:) a few
        seconds to settle before the chain-start gives up on it. Re-checks the
        target's condition repeatedly. If at ANY polling point a *target*-leaf
        failure appears (missing_targets becomes non-empty) it stops retrying -
        a target going down aborts, never waits. Returns the final result."""
        deadline = time.monotonic() + DEPENDENCY_GRACE_RETRY_SEC
        result = evaluate(expr, ctx)
        while time.monotonic() < deadline and not result.ok:
            if result.missing_targets:
                break  # a target-condition failure appeared - don't keep waiting
            time.sleep(DEPENDENCY_GRACE_POLL_SEC)
            result = evaluate(expr, ctx)
        return result

    def _wait_condition(self, expr: dict, ctx: EvalContext) -> tuple[str, EvalResult]:
        """Resolve one chain node's precondition, waiting where it makes sense.
        Returns (outcome, last_result) where outcome is:

          'satisfied' - the condition holds (possibly after waiting).
          'abort'     - a needed *target* dep is DOWN (FAILED/STOPPED, not even
                        coming up) - abort the chain immediately, no grace.
          'pause'     - a non-target prerequisite is still unmet after the
                        short conservative grace - pause + re-prompt.

        Waiting rules (the whole point): a target dep that is STARTING is
        WAITED for up to DEPENDENCY_STARTING_WAIT_SEC - we know it's coming up
        (barring a crash, which aborts); a non-target thing is only given the
        short DEPENDENCY_GRACE_RETRY_SEC, because it's a maybe, not a known."""
        result = evaluate(expr, ctx)
        if result.ok:
            return ("satisfied", result)
        if not result.missing_targets:
            return self._classify_settled(self._retry_non_target(expr, ctx))

        # Some target dep is missing. If any is genuinely down (not even
        # STARTING) -> abort immediately, no wait ("if the earlier target
        # condition fails at ANY point abort everything").
        if any(self._processes[m].state not in (ProcessState.RUNNING, ProcessState.STARTING)
               for m in result.missing_targets):
            return ("abort", result)

        # All the missing targets are STARTING (we just spawned them) - wait
        # the generous window for them to actually RUN. Abort if one crashes.
        deadline = time.monotonic() + DEPENDENCY_STARTING_WAIT_SEC
        while time.monotonic() < deadline:
            time.sleep(DEPENDENCY_GRACE_POLL_SEC)
            result = evaluate(expr, ctx)
            if result.ok:
                return ("satisfied", result)
            if result.missing_targets:
                if any(self._processes[m].state not in (ProcessState.RUNNING, ProcessState.STARTING)
                       for m in result.missing_targets):
                    return ("abort", result)  # a dep crashed while we waited
            else:
                # The targets came up; now only a non-target thing is left ->
                # give it the short grace instead of the long wait.
                return self._classify_settled(self._retry_non_target(expr, ctx))
        # Targets never all came RUNNING within the generous window.
        return ("abort", result)

    @staticmethod
    def _classify_settled(result: EvalResult) -> tuple[str, EvalResult]:
        """A _retry_non_target() result, once its grace period has run out,
        only ever means one of these three things - shared by both call
        sites in _wait_condition (the no-target-dep-at-all path, and the
        targets-came-up-then-only-a-non-target-thing-left path)."""
        if result.ok:
            return ("satisfied", result)
        if result.missing_targets:
            return ("abort", result)
        return ("pause", result)

    def _pull_targets(self, expr: dict, ctx: EvalContext) -> set:
        """Targets whose starting would satisfy `expr`, as far as the solver
        can tell. Only `target:` leaves contribute. Non-target leaves
        (`device:`/`file:`/`topic:`/`usb:`/`custom:`/`not:`...) are NEVER a
        block: some target the operator runs might make one available, but the
        solver can't know the consequence of starting a target (side effects
        are unknowable), so it just gathers the startable `target:` list and
        lets the operator decide the rest via the dialog's "Start dependencies
        too". An unmet device/topic still shows up in the start-gate's reason,
        but it never refuses to start the targets. Greedy for `any`: the first
        branch that yields a target wins."""
        kind, arg = next(iter(expr.items()))
        if kind == "target":
            if self._processes.get(arg) and self._processes[arg].state == ProcessState.RUNNING:
                return set()
            return {arg}
        if kind == "all":
            pulls: set = set()
            for sub in arg:
                pulls |= self._pull_targets(sub, ctx)
            return pulls
        if kind == "any":
            for sub in arg:
                if evaluate(sub, ctx).ok:
                    return set()
            for sub in arg:
                s = self._pull_targets(sub, ctx)
                if s:
                    return s
            return set()
        # `not`, and every non-target atomic leaf: nothing startable, never a
        # block - the start-gate's dependency_status still reports the reason.
        return set()

    def dependency_closure(self, target_id: str, selected_flags: Optional[set] = None) -> list[str]:
        """Arbitrary-depth resolution of the targets to start so that
        `target_id` will satisfy its `requires`, in correct start order
        (dependencies first, `target_id` last). Nothing can *block* the
        auto-start once you choose it: non-target predicates (device/topic/
        file/custom) don't gate it - the only thing that aborts a chained
        start is a target that fails to come up (see
        start_with_dependencies). Cyclic references are resolved by the
        gathered/visited sets, never looped.

        selected_flags: target_id's OWN in-progress flag selection, so a
        `flag:`-gated branch of target_id's OWN requires pulls in the right
        targets (e.g. only include the identity pipeline when the flag that
        gates it is actually on). This can only be honored for target_id
        itself - once the walk pulls in some OTHER target and recurses into
        ITS requires, that target's own planned flags aren't known this far
        ahead (nothing upstream of an actual start call has them), so a
        nested `flag:` leaf reads as not-selected there, same as anywhere
        else this module can't resolve one (see EvalContext.flag_selected)."""
        expression = self._requires.get(target_id)
        if not expression:
            return [target_id]

        root_ctx = self._dependency_ctx(selected_flags=selected_flags)
        nested_ctx = self._dependency_ctx()  # no flag context past the root - see above
        gathered: set = set()
        stack = [target_id]
        while stack:
            t = stack.pop()
            texpr = self._requires.get(t)
            if not texpr:
                continue
            pulls = self._pull_targets(texpr, root_ctx if t == target_id else nested_ctx)
            for p in pulls:
                if p not in gathered and p != t:
                    gathered.add(p)
                    stack.append(p)

        # topological order over the targets we're going to start, deps first
        ids = gathered | {target_id}
        edges: dict[str, set] = {}
        for tid in ids:
            texpr = self._requires.get(tid)
            deps = set()
            if texpr:
                deps = collect_target_ids(texpr) & ids
            edges[tid] = deps

        visited: set = set()
        order: list[str] = []

        def visit(nid: str) -> None:
            if nid in visited:
                return
            visited.add(nid)
            for dep in edges.get(nid, ()):
                visit(dep)
            order.append(nid)

        for tid in sorted(ids):
            visit(tid)
        return order

    def external_prereqs(self, target_id: str, selected_flags: Optional[set] = None) -> list[str]:
        """The non-`target` prerequisites (device:/file:/topic:/usb:/custom:...
        leaves) referenced anywhere in the closure for `target_id` that are
        currently NOT satisfied. The dashboard only auto-starts `target:`
        deps - these are the things the operator must satisfy themselves, and
        the UI uses this list to say so instead of pretending auto-start could
        fix them. Evaluates each leaf (custom: runs its command; cheap for the
        host/graph ones).

        selected_flags: target_id's OWN in-progress flag selection, for its
        OWN `flag:` leaves - same root-only caveat as dependency_closure
        (nested targets' own flag-gated leaves read as not-selected)."""
        root_ctx = self._dependency_ctx(selected_flags=selected_flags)
        nested_ctx = self._dependency_ctx()
        unsatisfied: list[str] = []
        seen_leaves: set = set()
        seen_targets: set = set()
        stack = [target_id]
        while stack:
            t = stack.pop()
            if t in seen_targets:
                continue
            seen_targets.add(t)
            texpr = self._requires.get(t)
            if not texpr:
                continue
            ctx = root_ctx if t == target_id else nested_ctx
            for kind, arg in iter_leaves(texpr):
                if kind == "target":
                    continue
                # flag: is per-target (two different targets' own "identity"
                # flag are unrelated) - unlike device:/topic:/etc, where the
                # same key really does mean the same real-world thing however
                # many targets reference it, so those intentionally collapse.
                key = f"{kind}:{t}:{arg}" if kind == "flag" else f"{kind}:{arg}"
                if key in seen_leaves:
                    continue
                seen_leaves.add(key)
                try:
                    if not evaluate({kind: arg}, ctx).ok:
                        unsatisfied.append(f"{kind} {arg}")
                except ConditionError:
                    # A malformed leaf can't be judged - still list it so the
                    # operator knows it's there and unresolved.
                    unsatisfied.append(f"{kind} {arg}")
        return unsatisfied

    def start_with_dependencies(self, target_id: str, flags: Optional[list[str]] = None,
                                skip_preconditions: Optional[set] = None,
                                flag_values: Optional[dict[str, str]] = None,
                                dependency_flags: Optional[dict[str, tuple[list[str], dict[str, str]]]] = None
                                ) -> TargetStatus:
        """'Start them too': walk the transitive `target:` deps in dependency
        order (matching the dialog's list order), starting each - including
        the requested target - verifying each one's precondition just before
        spawning it. Aborts (raises DependencyNotMet) on:

        dependency_flags: target id -> (flags, flag_values) for every OTHER
        target in the chain besides target_id itself (which uses `flags`/
        `flag_values` directly, same as before). Without this, every
        dependency this walk auto-starts got NO flags at all regardless of
        what was toggled on ITS OWN row - confirmed live as a real bug (a
        GPU flag silently dropped the moment its target was started
        indirectly, as someone else's dependency, instead of directly).
        The caller may send entries for targets that don't end up in THIS
        particular closure at all - harmless, .get() below just won't find
        them.

         1. A target fails to spawn (state failed/exited) - don't launch the
            rest of a chain on top of a missing prerequisite.
         2. A *target*-condition failure - a required `target:` dep is down
            (not even STARTING). No grace: "if the earlier target condition
            fails at ANY point abort everything."
         3. A *non-target* prerequisite (device:/file:/topic:/custom:) that
            is still unmet after a short grace/retry (DEPENDENCY_GRACE_RETRY_SEC)
            - the chain pauses on THAT node and the UI re-prompts. A
            non-target thing like a device can take a moment to appear, so it
            gets retried a few times first; a target failure doesn't wait.

        "Start anyway" / resume calls back with that node id in
        skip_preconditions, which spawns it WITHOUT re-checking its
        precondition, then continues the walk - prompting AGAIN for the NEXT
        unmet node if there is one. So each unmet node prompts in sequence
        (pass it → next one → ...). Cancel simply never re-enters this
        function; already-started deps stay up (no rollback)."""
        order = self.dependency_closure(target_id, selected_flags=set(flags or []))
        # Walk in dependency order (strict: a required target must actually be
        # RUNNING, not just STARTING). Per node, just before spawning it,
        # _wait_condition() decides: satisfied (maybe after waiting for a
        # STARTING dep to genuinely come up), abort (a target dep is DOWN -> no
        # grace, stop the whole chain), or pause (non-target didn't settle).
        # "Start anyway" (resume) passes that node via skip_preconditions.
        skip = skip_preconditions or set()
        # Only ids THIS call actually spawns - order is the full transitive
        # closure and can include targets that were already RUNNING before
        # this chain-start for an unrelated reason. "Stop all" on a spawn
        # failure must only roll back what this attempt brought up, never
        # something that predates it and has nothing to do with this chain.
        started_this_round: set[str] = set()
        for tid in order:
            if self._processes[tid].state in (ProcessState.RUNNING, ProcessState.STARTING):
                continue
            # Resolved before the precondition check (not just before spawning,
            # as it used to be) - a `flag:` leaf in tid's OWN requires needs
            # tid's OWN planned flags to read correctly, same as start()'s own
            # gate. Every OTHER node's flags come from dependency_flags (see
            # this function's own docstring); target_id itself uses flags/
            # flag_values directly.
            if tid == target_id:
                tid_flags, tid_flag_values = flags, flag_values
            else:
                tid_flags, tid_flag_values = (dependency_flags or {}).get(tid, (None, None))
            if tid not in skip:
                expr = self._requires.get(tid)
                if expr:
                    tid_ctx = self._dependency_ctx(selected_flags=set(tid_flags or []))
                    outcome, result = self._wait_condition(expr, tid_ctx)
                    if outcome == "abort":
                        raise DependencyNotMet(tid, result.reason, result.missing_targets)
                    if outcome == "pause":
                        raise DependencyNotMet(tid, result.reason, {tid})
            started_this_round.add(tid)
            status = self.start(tid, tid_flags, ignore_dependencies=True, flag_values=tid_flag_values)
            failed_state = self._settle_or_fail(tid, status.state)
            if failed_state is not None:
                # A node WE started failed to come up -> the chain fails NOW.
                # Abort immediately (don't start the rest). Already-started
                # deps stay running; the chain-failure popup offers Stop all,
                # scoped to started_this_round - never something this attempt
                # didn't touch.
                raise DependencyNotMet(
                    target_id,
                    f"dependency '{tid}' failed to start (state: {failed_state})",
                    started_this_round,
                    kind="spawn_failure",
                )
        return self.status(target_id)

    def _settle_or_fail(self, tid: str, immediate_state: ProcessState) -> Optional[ProcessState]:
        """Returns the failed ProcessState if `tid` (just started) either
        already failed, or fails within SPAWN_SETTLE_SEC of being asked to
        settle - None if it's fine (or at least not provably broken yet).
        See SPAWN_SETTLE_SEC's own comment for why this poll exists at all
        instead of trusting start()'s immediately-returned status.

        Deliberately does NOT treat state == RUNNING as an early-exit
        success on its own: for a target with no ready_node_name, RUNNING
        is exactly the premature state start() assigns the instant it
        spawns - the thing this poll exists to look past, not trust. Only
        a target WITH a ready_node_name gets to exit early on RUNNING,
        because there a readiness probe actually confirmed it, not just
        start()'s optimistic default."""
        if immediate_state in (ProcessState.FAILED, ProcessState.EXITED):
            return immediate_state
        has_ready_probe = bool(self._processes[tid].config.ready_node_name)
        deadline = time.monotonic() + SPAWN_SETTLE_SEC
        while time.monotonic() < deadline:
            state = self._processes[tid].state
            if state in (ProcessState.FAILED, ProcessState.EXITED):
                return state
            if has_ready_probe and state == ProcessState.RUNNING:
                return None
            time.sleep(SPAWN_SETTLE_POLL_SEC)
        return None

    def log_backlog(self, target_id: str) -> list[str]:
        return list(self._processes[target_id].log_buffer)

    def clear_logs(self, target_id: str) -> None:
        # The backlog is what a *new* /logs websocket connection replays on
        # connect (see routes.py's stream_logs) - clearing only the
        # frontend's own in-memory lines would look cleared until the next
        # collapse/expand (or reload) reconnects and replays the same old
        # backlog right back. This is the actual "make it stick" half of
        # a Clear click; doesn't touch subscribers already streaming.
        self._processes[target_id].log_buffer.clear()

    # -- lifecycle ----------------------------------------------------------

    def start(self, target_id: str, flags: Optional[list[str]] = None, ignore_dependencies: bool = False,
              flag_values: Optional[dict[str, str]] = None) -> TargetStatus:
        proc = self._processes[target_id]
        if proc.state in (ProcessState.RUNNING, ProcessState.STARTING):
            return self.status(target_id)

        # Deliberately OUTSIDE self._lock: dependency_status() can run a
        # custom: subprocess or an rclpy graph query, and the manager has
        # exactly one global lock - holding it here would freeze every
        # other start()/reload_targets()/_prune_if_detached() call for as
        # long as that check takes. A concurrent Start on the SAME target
        # racing this is still safe: the RUNNING/STARTING re-check right
        # after acquiring the lock below catches it - worst case both
        # callers redundantly ran the check once.
        #
        # Start-gate, NOT a runtime lease (a running target is never torn
        # down because a dependency later drops - that's the known sensor-
        # staleness problem, not this feature's job). ignore_dependencies
        # is the per-start escape hatch ("Start just this"), and
        # start_with_dependencies uses it after resolving the closure.
        if proc.config.requires and not ignore_dependencies:
            result = self.dependency_status(target_id, selected_flags=set(flags or []))
            if not result.ok:
                raise DependencyNotMet(
                    target_id,
                    result.reason,
                    result.missing_targets,
                )

        # An orphan from a PREVIOUS dashboard_server run (see pid_registry.py)
        # can still be alive under this target_id even though proc.state
        # reads STOPPED here - this instance never spawned it, so nothing
        # above would have caught it. Starting a fresh process on top would
        # leave TWO live processes under the same target_id, breaking the
        # one-process-per-target assumption stop()/_pump_output/kill_orphan
        # all rely on (a single pgid, a single Popen to reap...). Kill it
        # now rather than blocking Start outright - kill_orphan() broadcasts
        # an 'orphan_killed' event so the frontend can toast exactly what
        # happened instead of a fresh process just silently appearing.
        # Deliberately AFTER the dependency check and OUTSIDE self._lock:
        # if the check above already means this start won't happen, there's
        # nothing to gain from tearing down a perfectly fine orphan for it -
        # and kill_orphan's own escalation can take up to ~15s worst case,
        # which must never hold the manager's one global lock that long.
        if target_id in self._orphans:
            self.kill_orphan(target_id)

        with self._lock:
            if proc.state in (ProcessState.RUNNING, ProcessState.STARTING):
                return self.status(target_id)

            selected = set(flags or [])
            known = {f.name for f in proc.config.flags}
            unknown = selected - known
            if unknown:
                raise ValueError(f"target {target_id}: unknown flag(s) {sorted(unknown)}")
            # subprocess.Popen needs each argv token as its OWN list element -
            # a flag's arg is naturally written as one readable string (e.g.
            # "-p device:=cuda:0"), but appending it as a single list element
            # passes that whole string as ONE token, which the target's own
            # arg parser then can't recognize (confirmed live:
            # rclpy.UnknownROSArgsError: ['-p device:=cuda:0'] - a bug that
            # was silently present in every existing multi-word flag arg
            # before this, not just a new one). shlex.split() tokenizes it
            # the way a shell would, so "-p device:=cuda:0" correctly becomes
            # ["-p", "device:=cuda:0"].
            extra_args = self._flag_args(proc.config, selected, flag_values or {}, target_id)

            if proc.config.kind == "windows":
                # Claim the slot now (a concurrent start() sees STARTING and
                # short-circuits above) but make the actual HTTP call after
                # releasing the lock - see _start_windows's own note.
                proc.state = ProcessState.STARTING
                self._broadcast(target_id)
                windows_dispatch = True
            else:
                windows_dispatch = False
                command = build_command(proc.config, extra_args)
                env = {**os.environ, **proc.config.env}
                # PYTHONPATH/LD_LIBRARY_PATH are search paths, not plain
                # values - a target declaring one (e.g. a venv's own
                # site-packages, or a venv's pip-packaged CUDA libs like
                # person_face's cuDNN/cuBLAS dirs) means "prepend
                # this," not "replace the dashboard server's own value
                # wholesale." A blind overwrite here was dropping
                # /opt/ros/humble's own site-packages/lib off the spawned
                # process's path entirely, breaking `ros2 run`/`ros2 launch`
                # itself for that child (confirmed live: LD_LIBRARY_PATH
                # replacement made `ros2 run` itself fail to import rclpy -
                # "librcl_action.so: cannot open shared object file" - since
                # /opt/ros/humble/lib fell off the path) - the exact bug
                # the documented manual command
                # (`PYTHONPATH=<venv>:$PYTHONPATH ros2 run ...`) already
                # avoids by prepending instead of replacing.
                for path_var in ("PYTHONPATH", "LD_LIBRARY_PATH"):
                    if path_var in proc.config.env:
                        existing = os.environ.get(path_var, "")
                        target_value = proc.config.env[path_var]
                        env[path_var] = f"{target_value}:{existing}" if existing else target_value
                proc.state = ProcessState.STARTING
                self._broadcast(target_id)

                try:
                    popen = subprocess.Popen(
                        _with_pdeathsig(command),
                        env=env,
                        cwd=proc.config.cwd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                        start_new_session=True,
                    )
                except OSError as exc:
                    proc.state = ProcessState.FAILED
                    proc.log_buffer.append(f"[dashboard] failed to spawn: {exc}")
                    self._broadcast(target_id)
                    return self.status(target_id)

                proc.popen = popen
                proc.pid = popen.pid
                proc.exit_code = None
                # Record BEFORE this instance can crash/be killed - the whole
                # point is surviving exactly that. popen.pid is the
                # PDEATHSIG shim's own pid (the direct child here), which
                # stays alive for the process's entire life and whose own
                # /proc/<pid>/cmdline embeds `command` verbatim as its
                # trailing argv - see pid_registry._cmdline_matches.
                pid_registry.record(target_id, popen.pid, command)
                if proc.config.ready_node_name and self._node_exists is not None:
                    # Stay in STARTING - _probe_ready polls the ROS graph and
                    # flips this to RUNNING once the node actually registers
                    # (or once ready_timeout_sec elapses, so a wrong/renamed
                    # node name degrades to "slow" rather than "stuck forever").
                    proc.state = ProcessState.STARTING
                    self._broadcast(target_id)
                    threading.Thread(
                        target=self._probe_ready, args=(target_id,), daemon=True
                    ).start()
                else:
                    # No readiness probe configured for this target (or no ROS
                    # graph access available at all) - same immediate-RUNNING
                    # behavior this had before the probe existed.
                    proc.state = ProcessState.RUNNING
                    self._broadcast(target_id)

        # Both branches below run AFTER self._lock is released.
        if windows_dispatch:
            return self._start_windows(proc, target_id)

        threading.Thread(
            target=self._pump_output, args=(target_id,), daemon=True
        ).start()
        return self.status(target_id)

    @staticmethod
    def _resolve_windows_cmd(cmd: list[str]) -> list[str]:
        """kind=windows cmd entries are sent verbatim to the Windows
        companion, which runs them as a native Windows process. Any token
        that names a file inside the WSL filesystem - either a plain Linux
        absolute path (/home/...) or a UNC-into-WSL path
        (//wsl.localhost/<dist>/...) - must be translated to a real Windows
        path first. wslpath -w resolves symlinks, which matters because
        --symlink-install makes the install/share .py files symlinks that the
        Windows python.exe cannot traverse (it dies with "[Errno 2] No such
        file or directory"; see the wsl_usb_camera target). This mirrors the
        companion bootstrap's own wslpath -w on its service.py. Non-path
        tokens (command name, flags, UUIDs) are left untouched - wslpath is
        only for paths into the WSL filesystem."""
        out = []
        for token in cmd:
            t = token
            if token.startswith("/") and not token.startswith("//"):
                pass  # already a WSL Linux path
            elif token.startswith("//wsl.localhost/"):
                # //wsl.localhost/Ubuntu-20.04/home/... -> /home/... (strip
                # the wsl.localhost/<dist> prefix back to the WSL root)
                parts = token.split("/", 4)
                t = "/" + parts[4] if len(parts) > 4 else token
            else:
                out.append(token)
                continue
            try:
                windows = subprocess.check_output(["wslpath", "-w", t], text=True).strip()
                if windows:
                    out.append(windows)
                    continue
            except (subprocess.CalledProcessError, FileNotFoundError, OSError):
                pass
            out.append(token)
        return out

    def _start_windows(self, proc: "ManagedProcess", target_id: str) -> TargetStatus:
        """Called by start() AFTER releasing self._lock (which already
        claimed the slot by setting proc.state = STARTING) - the actual
        HTTP round-trip to the companion must never happen while the
        manager's single global lock is held, or one slow/stalled
        companion connection freezes every other start()/reload_targets()/
        _prune_if_detached() call dashboard-wide. No local subprocess, no
        readiness probe, no _pump_output thread - the companion owns the
        actual process, _poll_windows_targets picks up state/log changes
        afterward the same way _pump_output would for a local one.

        Blocks (outside the lock, same reasoning as the companion HTTP calls
        below) until the companion bootstrap has actually resolved, rather
        than treating "no client YET" the same as "no client EVER" - a
        start() landing in main.py's up-to-~15s bootstrap window used to fail
        immediately with a misleading "isn't available" message even though
        the companion might come up moments later. proc.state is already
        STARTING (set by start() before releasing the lock) and already
        broadcast, so the UI shows real progress during this wait instead of
        looking stuck."""
        if not self._windows_bootstrap_done.wait(timeout=WINDOWS_BOOTSTRAP_WAIT_TIMEOUT_SEC):
            proc.state = ProcessState.FAILED
            proc.log_buffer.append(
                "[dashboard] Windows companion bootstrap is still unresolved after "
                f"{WINDOWS_BOOTSTRAP_WAIT_TIMEOUT_SEC:.0f}s - dashboard_server may be starting "
                "very slowly, or wedged; check its own log, then try starting this target again"
            )
            self._broadcast(target_id)
            return self.status(target_id)
        if self._windows_client is None:
            proc.state = ProcessState.FAILED
            proc.log_buffer.append(
                "[dashboard] Windows companion isn't available this session "
                "(native-Linux platform, or it failed to bootstrap - check dashboard_server's own log)"
            )
            self._broadcast(target_id)
            return self.status(target_id)
        if not proc.config.cmd:
            proc.state = ProcessState.FAILED
            proc.log_buffer.append(f"[dashboard] target {target_id}: kind=windows requires 'cmd'")
            self._broadcast(target_id)
            return self.status(target_id)

        try:
            result = self._windows_client.start(target_id, self._resolve_windows_cmd(proc.config.cmd), cwd=proc.config.cwd, env=proc.config.env)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            proc.state = ProcessState.FAILED
            proc.log_buffer.append(f"[dashboard] companion unreachable: {exc}")
            self._broadcast(target_id)
            return self.status(target_id)

        proc.pid = result.get("pid")
        proc.exit_code = result.get("exit_code")
        proc.state = _COMPANION_STATE_MAP.get(result.get("state"), ProcessState.FAILED)
        self._broadcast(target_id)
        return self.status(target_id)

    def _probe_ready(self, target_id: str) -> None:
        proc = self._processes[target_id]
        node_name = proc.config.ready_node_name
        assert node_name is not None and self._node_exists is not None
        deadline = time.monotonic() + proc.config.ready_timeout_sec
        found = False
        while time.monotonic() < deadline:
            # The process may have died, or been stopped, while this was
            # polling - _pump_output/stop() already moved the state past
            # STARTING in that case, and this must not clobber it back.
            if proc.state != ProcessState.STARTING:
                return
            try:
                if self._node_exists(node_name):
                    found = True
                    break
            except Exception:
                logger.exception("target %s: readiness probe failed", target_id)
                break
            time.sleep(READY_POLL_INTERVAL_SEC)
        if not found:
            logger.warning(
                "target %s: node '%s' never appeared on the ROS graph within %.1fs - "
                "reporting running anyway (check ready_node_name in targets.yaml if this "
                "target is actually fine)",
                target_id,
                node_name,
                proc.config.ready_timeout_sec,
            )
        with self._lock:
            if proc.state == ProcessState.STARTING:
                proc.state = ProcessState.RUNNING
                self._broadcast(target_id)

    def stop(
        self, target_id: str, hard: bool = False, grace_period: float = GRACE_PERIOD_SEC
    ) -> TargetStatus:
        proc = self._processes[target_id]
        if proc.config.kind == "windows":
            return self._stop_windows(proc, target_id, hard, grace_period)

        if proc.popen is None or proc.state not in (
            ProcessState.RUNNING,
            ProcessState.STARTING,
        ):
            return self.status(target_id)

        proc.state = ProcessState.STOPPING
        self._broadcast(target_id)

        try:
            pgid = os.getpgid(proc.popen.pid)
        except ProcessLookupError:
            return self.status(target_id)

        if hard:
            self._killpg_quiet(pgid, signal.SIGKILL)
        else:
            # ros2 nodes shut down cleanly on SIGINT; escalate only if they
            # don't exit within the grace period.
            self._killpg_quiet(pgid, signal.SIGINT)
            if not self._wait_quiet(proc.popen, grace_period):
                self._killpg_quiet(pgid, signal.SIGTERM)
                if not self._wait_quiet(proc.popen, grace_period):
                    self._killpg_quiet(pgid, signal.SIGKILL)
        # Do NOT wait()/reap here: _pump_output's `finally` block (a
        # different thread) is racing to do exactly that the moment stdout
        # hits EOF, and also resets proc.popen to None once it's done. A
        # second unconditional wait() here can land on a None reference if
        # that thread wins the race first (was crashing with a 500 on
        # `'NoneType' object has no attribute 'wait'`). _wait_quiet above
        # already reaps for the graceful path's own confirmation; the final
        # state transition is _pump_output's job, not this method's.
        return self.status(target_id)

    def _stop_windows(self, proc: "ManagedProcess", target_id: str, hard: bool, grace_period: float) -> TargetStatus:
        if self._windows_client is None or proc.state not in (ProcessState.RUNNING, ProcessState.STARTING):
            return self.status(target_id)

        proc.state = ProcessState.STOPPING
        self._broadcast(target_id)
        try:
            # hard=True (e-stop's stop_all()) maps straight onto the
            # companion's own hard=True - skip CTRL_BREAK_EVENT entirely,
            # TerminateProcess immediately. Otherwise its normal
            # graceful-then-fallback-hard-kill behavior (see service.py).
            result = self._windows_client.stop(target_id, grace_period_sec=grace_period, hard=hard)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            proc.state = ProcessState.FAILED
            proc.log_buffer.append(f"[dashboard] companion unreachable while stopping: {exc}")
            self._broadcast(target_id)
            return self.status(target_id)

        if result is not None:
            proc.pid = result.get("pid")
            proc.exit_code = result.get("exit_code")
            proc.state = _COMPANION_STATE_MAP.get(result.get("state"), ProcessState.FAILED)
        else:
            # The companion doesn't track this process id (it started under a
            # previous/stale companion, or a split-brain on port 5590). There's
            # nothing left to stop -> it's effectively stopped. Previously this
            # left the target stuck at STOPPING forever.
            proc.state = ProcessState.STOPPED
            proc.pid = None
            proc.log_buffer.append(
                "[dashboard] companion doesn't track this process - treating as stopped"
            )
        self._broadcast(target_id)
        status = self.status(target_id)
        self._prune_if_detached(target_id)
        return status

    def restart(self, target_id: str) -> TargetStatus:
        self.stop(target_id)
        return self.start(target_id)

    def stop_all(self) -> list[str]:
        """Hard-stop every running/starting target immediately, except ones
        declared estop_exempt (foxglove_bridge, rviz2 - things you want to
        keep watching the robot through, not things that can move it). Used
        by e-stop - no grace period, straight to SIGKILL, dispatched without
        waiting for each one to fully exit before moving to the next.

        Each stop() runs on its own thread, not called inline in this loop -
        a kind=windows target's stop() is a real synchronous HTTP round-trip
        to the companion (up to ~12s worst case if it's slow/stalled), and
        during an emergency stop that must never delay every OTHER target's
        stop behind it. A local target's stop() only sends a signal and
        returns immediately either way, so this doesn't change its
        behavior - it just makes the "don't wait" guarantee this docstring
        already claims actually hold for every target kind, not just local
        ones."""
        stopped = []
        for tid, proc in self._processes.items():
            if proc.config.estop_exempt:
                continue
            if proc.state in (ProcessState.RUNNING, ProcessState.STARTING):
                threading.Thread(target=self.stop, args=(tid,), kwargs={"hard": True}, daemon=True).start()
                stopped.append(tid)
        return stopped

    @staticmethod
    def _killpg_quiet(pgid: int, sig: signal.Signals) -> None:
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass

    @staticmethod
    def _flag_args(cfg: TargetConfig, selected: set, flag_values: dict, target_id: str) -> list[str]:
        """Map selected flag names (+ chosen options/typed text) to argv
        tokens. Toggle flags append their single `arg` when selected; select
        flags append the CHOSEN option's `arg` (an empty/"None" choice means
        the flag name is never in `selected`, so nothing is appended); text
        flags substitute the typed value into `arg`'s `{value}` placeholder.
        Each token goes through shlex.split so a multi-word arg like
        "-p device:=cuda:0" tokenizes to ["-p", "device:=cuda:0"] the way a
        shell would - appending it whole would pass ONE token that rclpy's
        arg parser rejects (UnknownROSArgsError, the bug this was written to
        fix)."""
        args: list[str] = []
        for f in cfg.flags:
            if f.name not in selected:
                continue
            if f.type == "select":
                chosen = flag_values.get(f.name)
                match = next((o for o in f.options if o.name == chosen), None)
                if match is None:
                    raise ValueError(
                        f"target {target_id}: flag '{f.name}' needs one of "
                        f"{sorted(o.name for o in f.options)}; got {chosen!r}"
                    )
                args += shlex.split(match.arg)
            elif f.type == "text":
                typed = flag_values.get(f.name)
                if not typed:
                    raise ValueError(f"target {target_id}: flag '{f.name}' needs a value")
                if not f.arg:
                    raise ValueError(f"target {target_id}: flag '{f.name}' has no arg template configured")
                args += shlex.split(f.arg.replace("{value}", typed))
            elif f.arg:
                args += shlex.split(f.arg)
        return args

    @staticmethod
    def _wait_quiet(popen: subprocess.Popen, timeout: float) -> bool:
        try:
            popen.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    # -- windows-target polling ----------------------------------------------

    def _poll_windows_targets(self) -> None:
        """kind=windows targets have no local subprocess for _pump_output to
        watch - this is their equivalent: picks up state changes the
        companion made on its own (e.g. the process crashed, or exited on
        its own) that start()/stop() wouldn't otherwise notice, and relays
        new log lines the same way _append_log does for a local target.
        One thread total, not one per target - companion calls are cheap
        network round-trips, not worth a thread each."""
        while True:
            time.sleep(WINDOWS_POLL_INTERVAL_SEC)
            for target_id, proc in list(self._processes.items()):
                if proc.config.kind != "windows" or proc.state not in (
                    ProcessState.RUNNING,
                    ProcessState.STARTING,
                    ProcessState.STOPPING,
                ):
                    continue
                seen_total = self._windows_seen_log_count.get(target_id, 0)
                try:
                    result = self._windows_client.status(target_id)
                    # since=seen_total - the companion only sends lines
                    # appended after what we already have, not the whole
                    # (bounded, up to 2000-line) buffer every 2s regardless
                    # of how many are actually new.
                    log_result = self._windows_client.logs(target_id, since=seen_total)
                except (urllib.error.URLError, OSError, TimeoutError):
                    # Companion unreachable this tick - leave state as
                    # last-known rather than flapping to FAILED on a
                    # transient network hiccup; next tick tries again.
                    continue
                if result is None:
                    # The companion no longer tracks this id - a split-brain on
                    # the port, or the process was started under a stale
                    # companion. If it was mid-stop this is what left it stuck
                    # at STOPPING; reconcile to a terminal state so it doesn't
                    # hang, and let a detached one auto-prune.
                    if proc.state == ProcessState.STOPPING:
                        proc.state = ProcessState.STOPPED
                        proc.pid = None
                        self._broadcast(target_id)
                        self._prune_if_detached(target_id)
                    # RUNNING/STARTING + unknown is a transient split-brain;
                    # the single-companion fix prevents it; don't flap states.
                    continue

                if log_result is not None:
                    new_total = log_result.get("total", 0)
                    if new_total < seen_total:
                        # The companion's own log_total went backwards - it
                        # restarted (a fresh instance for this id starts
                        # counting from 0 again), so `since=seen_total`
                        # above was meaningless to it and came back empty.
                        # Reset to 0 so the NEXT tick fetches the full
                        # current buffer instead of silently getting
                        # nothing forever.
                        self._windows_seen_log_count[target_id] = 0
                    else:
                        for line in log_result.get("lines", []):
                            self._append_log(target_id, line)
                        self._windows_seen_log_count[target_id] = new_total

                new_state = _COMPANION_STATE_MAP.get(result.get("state"), ProcessState.FAILED)
                if new_state != proc.state or result.get("pid") != proc.pid:
                    proc.state = new_state
                    proc.pid = result.get("pid")
                    proc.exit_code = result.get("exit_code")
                    self._broadcast(target_id)
                    self._prune_if_detached(target_id)

    # -- log/output streaming ------------------------------------------------

    def _pump_output(self, target_id: str) -> None:
        proc = self._processes[target_id]
        assert proc.popen is not None and proc.popen.stdout is not None
        try:
            for line in proc.popen.stdout:
                self._append_log(target_id, line.rstrip("\n"))
        finally:
            returncode = proc.popen.wait()
            proc.exit_code = returncode
            proc.pid = None
            proc.popen = None
            # Exited on its own (clean stop or a crash) while THIS instance
            # was alive to see it - nothing left to reconcile on a future
            # restart, so drop it from the persistent registry now rather
            # than leaving a stale entry that reconcile() would need to
            # rediscover is dead.
            pid_registry.forget(target_id)
            if proc.state == ProcessState.STOPPING:
                proc.state = ProcessState.STOPPED
            elif returncode == 0:
                proc.state = ProcessState.EXITED
            else:
                proc.state = ProcessState.FAILED
            self._broadcast(target_id)
            self._prune_if_detached(target_id)

    def _append_log(self, target_id: str, line: str) -> None:
        proc = self._processes[target_id]
        proc.log_buffer.append(line)
        if self._loop is not None:
            for q in list(proc.log_subscribers):
                self._loop.call_soon_threadsafe(q.put_nowait, line)

    def subscribe_logs(self, target_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._processes[target_id].log_subscribers.add(q)
        return q

    def unsubscribe_logs(self, target_id: str, q: asyncio.Queue) -> None:
        self._processes[target_id].log_subscribers.discard(q)

    # -- event stream (global state-change feed) -----------------------------

    def subscribe_events(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._event_subscribers.add(q)
        return q

    def unsubscribe_events(self, q: asyncio.Queue) -> None:
        self._event_subscribers.discard(q)

    def _broadcast(self, target_id: str) -> None:
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._broadcast_on_loop, target_id)

    def _broadcast_on_loop(self, target_id: str) -> None:
        status = self.status(target_id)
        event = {"type": "state_change", **status.model_dump()}
        for q in list(self._event_subscribers):
            q.put_nowait(event)
