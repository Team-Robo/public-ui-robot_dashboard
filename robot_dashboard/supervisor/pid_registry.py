"""Persistent PID registry so a locally-spawned target is never silently
orphaned across a dashboard_server restart.

Same dotfile convention as ~/.dashboard_passcode / ~/.dashboard_debug.log -
lives outside anything colcon manages, survives a reinstall/restart
untouched. Only covers kind=run/launch targets (the ones ProcessManager
spawns itself via the PDEATHSIG shim) - kind=windows is the companion's own
process to track, out of scope here.

Important limitation, by design: a PID recorded here from a PREVIOUS
dashboard_server run has no Popen object in THIS one - no stdout pipe, no
wait()-able exit code, no way to resume streaming its logs. The only thing
checkable from the outside is "is this pid still alive, running roughly the
command we remember spawning" via /proc. That's why reconcile() below can
only detect + warn + offer a kill, not restore full monitoring - genuine
reattachment isn't possible for a process this instance didn't spawn.
"""
import json
import logging
import os

logger = logging.getLogger("robot_dashboard.supervisor")

REGISTRY_PATH = os.path.expanduser("~/.dashboard_pids.json")


def _read() -> dict:
    try:
        with open(REGISTRY_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _write(entries: dict) -> None:
    try:
        tmp = f"{REGISTRY_PATH}.tmp"
        with open(tmp, "w") as f:
            json.dump(entries, f, indent=2)
        os.replace(tmp, REGISTRY_PATH)
    except OSError:
        logger.exception("failed to write PID registry at %s", REGISTRY_PATH)


def record(target_id: str, pid: int, cmd: list[str]) -> None:
    entries = _read()
    entries[target_id] = {"pid": pid, "cmd": cmd}
    _write(entries)


def forget(target_id: str) -> None:
    entries = _read()
    if entries.pop(target_id, None) is not None:
        _write(entries)


def _cmdline_matches(pid: int, cmd: list[str]) -> bool:
    """Guards against PID reuse: a bare "is this pid alive" check
    true-positives on a totally unrelated process that happens to land on
    the same reused pid after enough churn/a reboot. /proc/<pid>/cmdline is
    the kernel's own record of that process's actual argv - if none of the
    recorded command's own tokens show up in it, treat this as a stale
    entry (something else now owns that pid) rather than a live orphan.
    """
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            raw = f.read()
    except OSError:
        return False
    if not raw:
        return False
    live = raw.decode(errors="replace").replace("\0", " ")
    # Skip short/generic tokens ("ros2", "run", "-p") - only a distinctive
    # one (package name, executable name, an arg value) is real signal.
    return any(tok in live for tok in cmd if len(tok) > 3)


def group_member_pids(pgid: int) -> list[int]:
    """PIDs of every live process whose process-group id is ``pgid``
    (excluding the group leader itself). Scanning /proc is the one way to
    find a group whose leader has died: reparenting moves a child's PPID to
    init but does NOT change its PGID, so the group id stays valid (and
    killpg-able) as long as any member survives - which is exactly the leak
    shape reconcile() exists to catch. OSError on any /proc entry (process
    raced out of existence) is skipped, not fatal."""
    members = []
    try:
        names = os.listdir("/proc")
    except OSError:
        return members
    for name in names:
        if not name.isdigit():
            continue
        member = int(name)
        if member == pgid:
            continue
        try:
            with open(f"/proc/{name}/stat") as f:
                line = f.read()
        except OSError:
            continue
        # stat: "<pid> (<comm>) <state> <ppid> <pgrp> <session> ..." - comm can
        # contain spaces/parens, so split only AFTER the last ')'. Thus after
        # that point: [0]=state, [1]=ppid, [2]=pgrp.
        rest = line[line.rfind(")") + 1:].split()
        if len(rest) > 2 and rest[2] == str(pgid):
            members.append(member)
    return members


def reconcile() -> dict[str, dict]:
    """Call once at dashboard_server startup, before anything new spawns.
    Returns the recorded entries confirmed still alive as a PROCESS GROUP
    (not just the exact recorded pid) - genuine orphans from a previous run
    that ended without going through stop() (a crash, a SIGKILL of
    dashboard_server itself, `kill -9`'d by hand...).

    Checking the group rather than only the recorder pid is the whole point:
    the recorded pid is the PDEATHSIG shim (the group leader). If the shim
    took its PDEATHSIG, it died - but only when its relay actually worked do
    the children die with it. When it doesn't, the shim is gone while
    `ros2 run`/the node survives, reparented to init but still in the shim's
    process group. A record-pid-only check would drop that as "leader's dead,
    nothing to do" and silently leave the real process running forever.

    An entry is an orphan if the leader matches the command (classic) OR any
    surviving member of its group matches (leader-dead leak). Matching on the
    member's own cmdline keeps the PID-reuse guard from _cmdline_matches - an
    unrelated process that reused the pid as its own group leader won't match
    the recorded command's distinctive tokens. Everything else - leader and
    all members gone, or reused by something unrelated - is dropped silently,
    nothing to warn about there."""
    entries = _read()
    orphans = {}
    for target_id, info in entries.items():
        pid = info.get("pid")
        cmd = info.get("cmd") or []
        if not isinstance(pid, int):
            continue
        leader_live = _cmdline_matches(pid, cmd)
        members = group_member_pids(pid)
        matching_members = [m for m in members if _cmdline_matches(m, cmd)]
        if leader_live or matching_members:
            entry = dict(info)
            entry["leader_alive"] = leader_live
            entry["members"] = matching_members or members
            orphans[target_id] = entry
            if leader_live:
                logger.warning(
                    "target %s: pid %d from a previous dashboard_server run is still "
                    "alive (%s) - it was never stopped through the dashboard, so it's "
                    "now orphaned. Warning surfaced via /api/orphans; "
                    "POST /api/orphans/%s/kill to clean it up.",
                    target_id, pid, " ".join(cmd), target_id,
                )
            else:
                logger.warning(
                    "target %s: leader pid %d from a previous run is gone but %d member(s) "
                    "of its process group (%s) are still alive - an orphaned relay-shim leak. "
                    "Surfaced via /api/orphans; POST /api/orphans/%s/kill to kill the group.",
                    target_id, pid, len(matching_members or members),
                    ", ".join(map(str, matching_members or members)), target_id,
                )
    _write(orphans)
    return orphans
