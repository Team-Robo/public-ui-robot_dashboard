"""Robust usbipd-win/WSL2 USB-device passthrough helper for the dashboard.

Wraps `usbipd.exe` (usbipd-win) into idempotent, preflight-checked
operations that the dashboard's *Windows* companion
(windows_companion/service.py) can drive as a `kind: windows` target.

Why this file exists
--------------------
The dashboard companion only knows how to spawn a process and watch it.
usbipd itself is a blunt, stateful tool: `bind` needs admin, `attach`
fails if Windows is holding the device, a `--force` steal is sometimes the
only way through, and an attach that "succeeds" can still take a second or
two before the WSL /dev/videoN node actually appears. Bare `usbipd.exe`
invocations from a target would just show a cryptic exit code in the
dashboard's /logs and give nobody any idea which of those stages failed.
This helper collapses all of it into `attach`/`detach`/`state`/`list` with
real preflight checks, clear diagnostics, idempotency, and - for the
`attach` "session" mode used as a dashboard target - honest
start/stop semantics: on graceful shutdown (CTRL_BREAK_EVENT, i.e. the
companion's Stop) it detaches the device and exits 0, instead of leaking a
device attached to a process nobody owns.

Stdlib only, like service.py - this runs on native Windows `python.exe`
(which needs no pip install), or on the Windows side of WSL via `python.exe`.
It talks back to WSL through `wsl` only to *verify* an attach (checking that
the /dev/videoN node actually showed up) - the passthrough itself is usbipd's
job, not this script's.

Usage (run on Windows / with Windows python.exe):
    python.exe usbipd_helper.py list
    python.exe usbipd_helper.py state --vidpid 30c9:009f          # or --busid
    python.exe usbipd_helper.py attach --vidpid 30c9:009f --verify video
    python.exe usbipd_helper.py attach --busid 1-6 --wsl Ubuntu-20.04
    python.exe usbipd_helper.py detach --vidpid 30c9:009f

Operational rules (the "robust" part):
-   Idempotent: `attach` when already attached is a no-op success; `detach`
    when not attached is a no-op success. Safe to click Start/Stop any
    number of times out of order.
-   Preflight before any mutation: usbipd present? device present? admin
    needed (bind requires it) and are we elevated? Each failure is a
    distinct, actionable message - never a silent non-zero exit.
-   A device already `Shared` skips `bind` (no admin needed). A device that
    is `Not shared`, or that refuses `attach` because Windows has it open,
    is force-bound only if we're admin, and even then only as a documented
    retry - the script never guesses with `--force` silently.
-   Verification: after attach, re-read `usbipd list` and, with
    `--verify video`, poll WSL for the /dev/videoN node (a real camera
    export can take a moment to enumerate in WSL).
-   Exit code 0 only when the device genuinely reached the requested state;
    non-zero otherwise, with the reason in the human log + `--json` payload.

The dashboard "session" target maps Start -> `attach` (this process stays
alive, monitoring the device) and Stop -> a graceful CTRL_BREAK_EVENT which
runs the detach here and exits. Use `--once` to run a single attach and
return (handy for tests / manual use, and for a plain shell one-shot).
"""

import argparse
import ctypes
import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field


_DEFAULT_WSL_DISTRO = "Ubuntu-20.04"
ATTACH_POLL_INTERVAL_SEC = 2.0
VERIFY_DEFAULT_TIMEOUT_SEC = 10.0
SESSION_POLL_INTERVAL_SEC = 3.0


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def log(line: str) -> None:
    print(line, flush=True)


def run(cmd, timeout: float = 30.0) -> tuple:
    """Run a command, return (returncode, stdout_text, stderr_text). Never
    raises on spawn/capture errors - those come back as a non-zero rc with
    the message in stderr instead, so the caller can decide how to react."""
    try:
        proc = subprocess.run(
            list(cmd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            text=True,
            errors="replace",
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        return 127, "", f"executable not found: {cmd[0] if cmd else cmd}"
    except subprocess.TimeoutExpired:
        return 124, "", f"command timed out after {timeout}s: {' '.join(map(str, cmd))}"
    except Exception as exc:  # noqa: BLE001 - keep the caller in control
        return -1, "", f"failed to run {' '.join(map(str, cmd))}: {exc}"


def is_admin() -> bool:
    """True if the current Windows process is elevated (admin) - `usbipd
    bind`/`unbind` require it. Non-Windows platforms just return False; the
    attach-side code relies on this only when bind is actually needed."""
    if sys.platform != "win32":
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:  # noqa: BLE001
        # Can't tell - assume not, so we force the user down the explicit
        # "run as admin" path rather than gambling on a hidden privilege.
        return False


def usbipd_present() -> bool:
    rc, _, _ = run(["usbipd.exe", "--version"], timeout=15)
    return rc == 0


def wsl_distros() -> list:
    """Detect WSL 2 distro names. `wsl -l -q` emits UTF-16LE (the classic
    spaced-between-chars rendering on a mis-decoding console); decode
    defensively and return a clean list, empty if none."""
    try:
        res = subprocess.run(["wsl", "-l", "-q"], capture_output=True, timeout=15)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    data = res.stdout
    if not data:
        return []
    # `wsl -l -q` emits UTF-16LE. It usually has a BOM, but some WSL builds
    # leave it off, in which case every ASCII char is followed by a NUL byte -
    # the classic "spaced between chars" render seen on a mis-decoding console.
    # Strip the BOM (if any), then drop all NULs before decoding: that yields
    # the plain distro name either way, no guessing between codecs.
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        data = data[2:]
    if b"\x00" in data:
        text = data.replace(b"\x00", b"").decode("utf-8", errors="replace")
    else:
        text = data.decode("utf-8", errors="replace")
    text = text.replace("\ufeff", "")
    names = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return names


def pick_wsl_distro(explicit: str | None) -> str:
    if explicit:
        return explicit
    distros = wsl_distros()
    if not distros:
        return _DEFAULT_WSL_DISTRO
    for d in distros:
        if "ubuntu" in d.lower():
            return d
    return distros[0]


# ---------------------------------------------------------------------------
# usbipd list parsing
# ---------------------------------------------------------------------------

@dataclass
class UsbDevice:
    busid: str
    vidpid: str
    device: str
    state: str
    is_camera: bool = False
    is_audio: bool = False

    def to_json(self) -> dict:
        return {
            "busid": self.busid,
            "vidpid": self.vidpid,
            "device": self.device,
            "state": self.state,
            "is_camera": self.is_camera,
            "is_audio": self.is_audio,
        }


# usbipd-win reports a device that was bound with --force as "Shared (forced)"
# - treat it as Shared (it IS shared; the "(forced)" just notes it was stolen
# from a competing client). Also tolerate "(it won't attach)" style suffixes
# usbipd appends in some versions, so we match the known prefix.
_RE_LINE = re.compile(
    r"^(?P<busid>\S+)\s+(?P<vidpid>[0-9a-fA-F]{4}:[0-9a-fA-F]{4})\s+"
    r"(?P<device>.+?)\s+(?P<state>Not shared|Shared(?: \(forced\))?|Attached)\s*$"
)


def _normalize_state(state: str) -> str:
    """Collapse "Shared (forced)" -> "Shared" so downstream state checks just
    see the three canonical states (Not shared / Shared / Attached)."""
    s = (state or "").strip()
    return "Shared" if s.lower().startswith("shared") else s

# Substrings that heuristically identify a camera vs. an audio device from the
# device name alone (usbipd gives us no USB device class). Used only to raise
# the right verification, not to block anything.
_CAMERA_HINTS = ("camera", "cam ", "webcam", "uvc", "depthsensor", "realsense")
_AUDIO_HINTS = ("mic", "audio", "microphone", "headset", "speaker", "usb audio")


def _heuristic(device_name: str) -> tuple:
    lower = device_name.lower()
    is_cam = any(h in lower for h in _CAMERA_HINTS)
    is_aud = any(h in lower for h in _AUDIO_HINTS)
    return is_cam, is_aud


def usbipd_list() -> list:
    """Parse `usbipd list` into UsbDevice records (the 'Connected:' table
    only - 'Persisted:' entries are auto-bind registrations for *unplugged*
    devices, not current state, so they're intentionally skipped)."""
    rc, out, err = run(["usbipd.exe", "list"])
    if rc != 0:
        return []
    devices = []
    in_connected = False
    for raw in out.splitlines():
        line = raw.strip()
        if line == "Connected:":
            in_connected = True
            continue
        if line in ("Persisted:",) or line.startswith("Persisted:"):
            in_connected = False
            continue
        if not in_connected or line == "BUSID" or not line:
            continue
        m = _RE_LINE.match(line)
        if not m:
            continue
        is_cam, is_aud = _heuristic(m.group("device"))
        devices.append(
            UsbDevice(
                busid=m.group("busid"),
                vidpid=m.group("vidpid").lower(),
                device=m.group("device").strip(),
                state=_normalize_state(m.group("state")),
                is_camera=is_cam,
                is_audio=is_aud,
            )
        )
    return devices


def find_by_busid(devices, busid: str):
    for d in devices:
        if d.busid.lower() == busid.lower():
            return d
    return None


def find_by_vidpid(devices, vidpid: str):
    needle = vidpid.lower()
    for d in devices:
        if d.vidpid == needle or d.vidpid.replace(":", "") == needle.replace(":", ""):
            return d
    return None


# ---------------------------------------------------------------------------
# the operations
# ---------------------------------------------------------------------------

@dataclass
class OpResult:
    ok: bool
    message: str
    busid: str | None = None
    vidpid: str | None = None
    final_state: str | None = None
    extra: dict = field(default_factory=dict)

    def dump(self) -> dict:
        return {
            "ok": self.ok,
            "message": self.message,
            "busid": self.busid,
            "vidpid": self.vidpid,
            "final_state": self.final_state,
            **self.extra,
        }


def _emit(result: OpResult, as_json: bool) -> int:
    if as_json:
        print(json.dumps(result.dump(), default=str))
    else:
        log(result.message)
    return 0 if result.ok else 1


def _resolve_device(args) -> str | None:
    """Resolve --vidpid/--busid to a connected usbipd device. Returns the
    device, or exits already-emitted with a clear preflight failure via
    sys.exit()."""
    devices = usbipd_list()
    if not devices:
        print("usbipd: no devices found in `usbipd list` (is a device plugged in?)", file=sys.stderr)
        sys.exit(3)
    dev = None
    if args.busid:
        dev = find_by_busid(devices, args.busid)
    elif args.vidpid:
        dev = find_by_vidpid(devices, args.vidpid)
    if dev is None:
        known = ", ".join(f"{d.busid}={d.vidpid} ({d.device})" for d in devices)
        print(
            f"usbipd: no connected device matches "
            f"{'--busid ' + args.busid if args.busid else '--vidpid ' + str(args.vidpid)}. "
            f"Connected: {known}",
            file=sys.stderr,
        )
        sys.exit(3)
    return dev


def cmd_list(args) -> int:
    devices = usbipd_list()
    if args.json:
        print(json.dumps([d.to_json() for d in devices], default=str))
        return 0
    if not devices:
        log("usbipd: no connected devices")
        return 0
    log("BUSID\tVID:PID\tSTATE\t\tDEVICE")
    for d in devices:
        kind = " [cam]" if d.is_camera else (" [audio]" if d.is_audio else "")
        log(f"{d.busid}\t{d.vidpid}\t{d.state}\t{d.device}{kind}")
    return 0


def cmd_state(args) -> int:
    dev = _resolve_device(args)
    result = OpResult(True, "attached" if dev.state == "Attached" else dev.state, dev.busid, dev.vidpid, dev.state,
                      extra={"device": dev.device, "using": "wsl"})
    return _emit(result, args.json)


def _run_usbipd(cmd) -> str | None:
    """Run a usbipd subcommand; return its stderr+stdout summary on failure
    (so the caller can escalate), or None on success."""
    rc, out, err = run(cmd)
    if rc == 0:
        return None
    return (err.strip() or out.strip() or f"exit code {rc}")


def _bind(dev, force: bool) -> str | None:
    cmd = ["usbipd.exe", "bind", "--busid", dev.busid] + (["--force"] if force else [])
    return _run_usbipd(cmd)


def _attach(dev, distro) -> str | None:
    cmd = ["usbipd.exe", "attach", "--wsl", distro, "--busid", dev.busid]
    return _run_usbipd(cmd)


def _detach(dev) -> str | None:
    rc, out, err = run(["usbipd.exe", "detach", "--busid", dev.busid])
    if rc == 0:
        return None
    errtext = (err.strip() or out.strip())
    # detaching something already detached is a successful no-op (idempotent).
    if "not attached" in errtext.lower() or "is not attached" in errtext.lower():
        return None
    return errtext


def _ensure_shared(dev) -> tuple:
    """Make sure the device is bound (`Shared`) so it can be attached.
    Returns (ok, error_message_or_None)."""
    fresh = usbipd_list()
    current = find_by_busid(fresh, dev.busid) or find_by_vidpid(fresh, dev.vidpid)
    if current is not None and current.state == "Shared":
        return True, None
    if current is not None and current.state == "Attached":
        return True, None

    if not is_admin():
        return False, (
            f"device {dev.busid} is '{current.state if current else 'absent'}' and needs `usbipd bind` "
            "to be shareable, which requires an elevated (Administrator) window. Either run the dashboard "
            "companion elevated, or bind the device manually: `usbipd bind --busid " + dev.busid + "`"
        )
    # Try without the force flag first - only escalate to --force if the plain
    # bind failed specifically because the device is held open by Windows.
    err = _bind(dev, force=False)
    if err is not None and ("in use" in err.lower() or "busy" in err.lower() or "access denied" in err.lower()):
        log(f"bind without force failed ({err}) - retrying with --force (steals the device from Windows)")
        err = _bind(dev, force=True)
    if err is not None:
        return False, f"usbipd bind failed: {err}"
    return True, None


def cmd_attach(args) -> int:
    dev = _resolve_device(args)
    distro = pick_wsl_distro(args.wsl)

    # 0) Already attached to WSL -> idempotent success. Verify & (if not --once)
    #    drop into the monitoring session loop.
    if dev.state == "Attached":
        log(f"device {dev.busid} already attached to WSL - nothing to do")
        return _session(args, dev, distro, already_attached=True)

    # 1) Make it shareable (bind) if it isn't already.
    ok, msg = _ensure_shared(dev)
    if not ok:
        return _emit(OpResult(False, msg, dev.busid, dev.vidpid, dev.state), args.json)

    # 2) Attach. A first failure can be the "device is held by Windows" case
    #    even after a successful bind - retry after a forced bind (admin).
    err = _attach(dev, distro)
    if err is not None:
        should_force = (
            "busy" in err.lower() or "in use" in err.lower() or "exported" in err.lower()
        )
        if should_force and is_admin():
            log(f"attach failed ({err}); re-binding with --force then attaching again")
            ferr = _bind(dev, force=True)
            if ferr:
                return _emit(OpResult(False, f"forced bind failed: {ferr}", dev.busid, dev.vidpid, dev.state), args.json)
            err = _attach(dev, distro)
        if err is not None:
            return _emit(
                OpResult(
                    False,
                    f"attach failed: {err}. If Windows has the camera open, close that app and retry, "
                    "or accept a forced steal by running the companion elevated.",
                    dev.busid, dev.vidpid, dev.state,
                ),
                args.json,
            )

    # 3) Verify the state genuinely flipped, and (if requested) that the WSL
    #    device node appeared.
    vres = _verify(dev, distro, args.verify, args.verify_timeout)
    if not vres.ok:
        return _emit(vres, args.json)

    log(f"device {dev.busid} ({dev.device}) attached to WSL [{distro}]")
    if args.once:
        return _emit(OpResult(True, "attached", dev.busid, dev.vidpid, "Attached", extra={"distro": distro}), args.json)
    return _session(args, dev, distro, already_attached=False)


def _verify(dev, distro, verify: str, timeout: float) -> OpResult:
    """Confirm the attach landed. verify='video' polls WSL for a /dev/videoN
    node (started for a camera export). Returns an OpResult *potentially
    failed*, else a will-be-overwritten ok placeholder (caller sets the final
    fields)."""
    fresh = usbipd_list()
    current = find_by_busid(fresh, dev.busid) or find_by_vidpid(fresh, dev.vidpid)
    if current is None or current.state != "Attached":
        return OpResult(False, f"attach did not stick (state is now '{current.state if current else 'gone'}')", dev.busid, dev.vidpid)

    if verify != "video":
        return OpResult(True, "attached", dev.busid, dev.vidpid, "Attached")

    deadline = time.monotonic() + timeout
    found = []
    while time.monotonic() < deadline:
        rc, out, _ = run(["wsl", "-d", distro, "--", "sh", "-c", "ls /dev/video* 2>/dev/null || true"])
        if rc == 0 and out.strip():
            found = [p.strip() for p in out.split() if p.strip()]
            break
        time.sleep(ATTACH_POLL_INTERVAL_SEC)
        # The wsl check can be slow to enumerate; don't give up if the usbipd
        # state already shows Attached, poll a couple of times before failing.
        if not found and time.monotonic() + 1 >= deadline:
            break

    if not found:
        # The usbipd attach DID stick (state=Attached) - only the WSL node is
        # lagging. This is a WARNING, not a failure: falling out here would
        # exit the session with the device attached and nobody monitoring it,
        # which Stop could then never clean up (an orphaned attach). Keep the
        # session alive and let its monitor re-report /dev/video* when it shows.
        return OpResult(
            True,
            f"attached; no /dev/video* in WSL [{distro}] yet after {timeout:.0f}s "
            "(USB/IP enumeration lags - the session keeps monitoring; verify with "
            "`ls /dev/video*` in WSL)",
            dev.busid, dev.vidpid, "Attached",
            extra={"wsl_video_node": [], "warning": True},
        )

    return OpResult(True, f"attached; WSL video node: {', '.join(found)}", dev.busid, dev.vidpid, "Attached",
                    extra={"wsl_video_node": found})


def _session(args, dev, distro, already_attached: bool) -> int:
    """Dashboard target 'session' mode: keep this process alive so the target
    reads RUNNING, monitor the device, and detach it cleanly on graceful
    shutdown (CTRL_BREAK_EVENT -> SIGBREAK) or SIGINT."""
    def _shutdown(signum, frame):
        log(f"received shutdown signal ({signal.Signals(signum).name}) - detaching {dev.busid}")
        err = _detach(dev)
        if err:
            log(f"detach failed during shutdown: {err}")
        else:
            log(f"device {dev.busid} detached")
        sys.exit(0)

    for sig in (signal.SIGBREAK, signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _shutdown)
        except Exception:  # noqa: BLE001 - some signals unavailable on some builds
            pass

    if already_attached:
        log(f"monitoring device {dev.busid} (already attached) - Stop to detach")
    else:
        log(f"monitoring device {dev.busid} - Stop to detach")
    log("[session] Ctrl+Break/Ctrl+C to detach and exit")
    marker = False
    while True:
        time.sleep(SESSION_POLL_INTERVAL_SEC)
        fresh = usbipd_list()
        current = find_by_busid(fresh, dev.busid) or find_by_vidpid(fresh, dev.vidpid)
        state = current.state if current else "gone"
        if state != "Attached":
            if not marker:
                log(f"WARNING: device {dev.busid} is no longer attached (state: {state})")
                marker = True
        else:
            if marker:
                log(f"device {dev.busid} re-attached")
                marker = False


def cmd_detach(args) -> int:
    dev = _resolve_device(args)
    if dev.state != "Attached":
        log(f"device {dev.busid} is not attached - nothing to do")
        if args.unbind and dev.state in ("Shared",):
            if not is_admin():
                return _emit(OpResult(False, "unbind needs an elevated (Administrator) window", dev.busid, dev.vidpid, dev.state), args.json)
            rc, out, err = run(["usbipd.exe", "unbind", "--busid", dev.busid])
            if rc != 0:
                return _emit(OpResult(False, f"unbind failed: {err or out}", dev.busid, dev.vidpid, dev.state), args.json)
            log(f"device {dev.busid} unbound (returned to Windows)")
            return _emit(OpResult(True, "detached (was not attached; unbound)", dev.busid, dev.vidpid, "Not shared"), args.json)
        return _emit(OpResult(True, "not attached - already detached", dev.busid, dev.vidpid, dev.state), args.json)

    err = _detach(dev)
    if err:
        return _emit(OpResult(False, f"detach failed: {err}", dev.busid, dev.vidpid, dev.state), args.json)
    log(f"device {dev.busid} detached")
    return _emit(OpResult(True, "detached", dev.busid, dev.vidpid, "Shared"), args.json)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="usbipd_helper", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="command", required=True)

    pl = sub.add_parser("list", help="list connected usbipd devices")
    pl.add_argument("--json", action="store_true")
    pl.set_defaults(func=cmd_list)

    ps = sub.add_parser("state", help="show one device's share/attach state")
    _add_device_args(ps)
    ps.add_argument("--json", action="store_true")
    ps.set_defaults(func=cmd_state)

    pa = sub.add_parser("attach", help="bind (if needed) + attach a device to WSL")
    _add_device_args(pa)
    pa.add_argument("--wsl", default=None, help="WSL distro name (default: auto-detect)")
    pa.add_argument("--verify", default="auto", choices=["auto", "video", "none"],
                    help="post-attach verification (default auto: video if the device looks like a camera)")
    pa.add_argument("--verify-timeout", type=float, default=VERIFY_DEFAULT_TIMEOUT_SEC)
    pa.add_argument("--once", action="store_true",
                    help="attach and exit instead of running the monitoring session")
    pa.add_argument("--json", action="store_true")
    pa.set_defaults(func=cmd_attach)

    pd = sub.add_parser("detach", help="detach a device from WSL")
    _add_device_args(pd)
    pd.add_argument("--wsl", default=None, help=argparse.SUPPRESS)
    pd.add_argument("--unbind", action="store_true", help="also unbind so Windows regains the device")
    pd.add_argument("--json", action="store_true")
    pd.set_defaults(func=cmd_detach)

    return p


def _add_device_args(p) -> None:
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--busid", help="usbipd busid (e.g. 1-6)")
    g.add_argument("--vidpid", help="USB VID:PID (e.g. 30c9:009f) - more stable across reboots")


def main() -> int:
    if sys.platform != "win32":
        print("usbipd_helper must run on native Windows python.exe (or the Windows side of WSL), not Linux.",
              file=sys.stderr)
        return 2
    if not usbipd_present():
        print(
            "usbipd.exe not found. Install usbipd-win (https://github.com/dorssel/usbipd-win/releases), "
            "then ensure it's on PATH.",
            file=sys.stderr,
        )
        return 3
    args = build_parser().parse_args()
    # Auto: verify video only if the resolved device looks like a camera.
    if getattr(args, "verify", None) == "auto":
        dev = _resolve_device(args) if args.command != "list" else None
        if dev is not None:
            args.verify = "video" if dev.is_camera else "none"
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
