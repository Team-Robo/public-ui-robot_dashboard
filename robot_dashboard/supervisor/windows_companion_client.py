"""WSL-side client for windows_companion/service.py, plus the bootstrap
that makes it transparent: dashboard_server calls ensure_companion_running()
once at its own startup, and from then on a `kind: windows` target just
works - nobody has to manually start a "companion" target first.

Stdlib only (urllib), matching the companion's own no-new-deps stance -
avoids needing a new dashboard package.xml dependency for this.
"""

import json
import logging
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.request
from typing import Optional

logger = logging.getLogger("robot_dashboard.supervisor.windows_companion")

DEFAULT_PORT = 5590
REQUEST_TIMEOUT_SEC = 5.0
STARTUP_POLL_TIMEOUT_SEC = 15.0
# service.py's own stop() can legitimately take up to grace_period_sec (the
# graceful attempt) plus its own DEFAULT_GRACE_PERIOD_SEC (5.0, the
# hard-kill fallback's wait) before its HTTP response comes back - a
# request timeout shorter than that races the companion's own logic and
# misreports a still-in-progress stop as "companion unreachable" (observed:
# a PowerShell target with no CTRL_BREAK_EVENT handler took the fallback
# path and the client's flat 5s timeout fired before the companion's own
# ~10s worst case did). +2s margin on top for HTTP/interop overhead.
COMPANION_STOP_WAIT_MARGIN_SEC = 5.0 + 2.0
# Outside the repo, same reasoning as auth.py's ~/.dashboard_passcode -
# survives across dashboard_server restarts so a still-running companion
# from a previous session doesn't get orphaned (its token would otherwise
# be lost the moment this process exits, since the companion only ever
# holds it in memory).
TOKEN_FILE = os.path.expanduser("~/.dashboard_windows_companion_token")


def reclaim_companion() -> None:
    """Best-effort kill any dashboard Windows companion (windows_companion/
    service.py) still running.

    Two reasons this matters, both from the same failure mode:
      1. A service.py that survived a dashboard restart but WEDGED (accepts TCP
         but stops answering /health) can't be reused; a fresh spawn then can't
         bind the port it still holds -> the new companion never comes up and
         they accumulate (the "spawned but never came up within 15s" warning).
      2. Stopping dashboard_server must not leave its companion running.

    Filters by command line (`*windows_companion*service.py*`) so it only ever
    touches OUR companion, never an unrelated process that happens to use the
    port. Best-effort: failures are swallowed - the pairing reclaim-on-start +
    kill-on-shutdown is a hygiene net, not a hard guarantee.
    """
    try:
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "
                "'*windows_companion*service.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
            ],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def detect_platform() -> str:
    try:
        with open("/proc/version") as f:
            return "wsl" if "microsoft" in f.read().lower() else "native"
    except FileNotFoundError:
        return "native"


def _default_gateway_ip() -> Optional[str]:
    """WSL2's default gateway is the Windows host, reachable from WSL even
    though WSL's own 127.0.0.1 and Windows' 127.0.0.1 are different
    loopbacks (confirmed empirically) - this is the IP a companion bound
    to 0.0.0.0 on the Windows side is actually reachable at from here."""
    try:
        out = subprocess.check_output(["ip", "route", "show", "default"], text=True)
        # "default via 172.25.16.1 dev eth0 proto kernel"
        parts = out.split()
        return parts[parts.index("via") + 1]
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError, IndexError):
        return None


class WindowsCompanionClient:
    def __init__(self, host: str, port: int, token: str, timeout: float = REQUEST_TIMEOUT_SEC):
        self._base = f"http://{host}:{port}"
        self._token = token
        self._timeout = timeout

    def _request(self, method: str, path: str, body: Optional[dict] = None, timeout: Optional[float] = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(f"{self._base}{path}", data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=timeout if timeout is not None else self._timeout) as resp:
            raw = resp.read()
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            # Raised as URLError, not left as a bare ValueError/JSONDecodeError -
            # every caller (including _poll_windows_targets's background
            # thread) already catches urllib.error.URLError as "companion
            # unreachable this round, try again next tick." A malformed
            # response (network hiccup, companion mid-restart) is the same
            # kind of transient failure and must degrade the same way,
            # not propagate uncaught and silently kill a daemon thread.
            raise urllib.error.URLError(f"malformed JSON response from companion: {exc}") from exc

    def health(self) -> bool:
        try:
            with urllib.request.urlopen(f"{self._base}/health", timeout=self._timeout) as resp:
                return json.loads(resp.read()).get("status") == "ok"
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            return False

    def authorized(self) -> bool:
        """health() only proves *something* is listening - this proves it's
        actually our companion, with the token we think it has."""
        try:
            self._request("GET", "/processes")
            return True
        except urllib.error.HTTPError as exc:
            return exc.code != 401
        except (urllib.error.URLError, TimeoutError, OSError):
            return False

    def start(self, proc_id: str, cmd: list, cwd: Optional[str] = None, env: Optional[dict] = None) -> dict:
        return self._request("POST", f"/processes/{proc_id}/start", {"cmd": cmd, "cwd": cwd, "env": env})

    def stop(self, proc_id: str, grace_period_sec: float = 5.0, hard: bool = False) -> Optional[dict]:
        try:
            return self._request(
                "POST",
                f"/processes/{proc_id}/stop",
                {"grace_period_sec": grace_period_sec, "hard": hard},
                timeout=grace_period_sec + COMPANION_STOP_WAIT_MARGIN_SEC,
            )
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise

    def status(self, proc_id: str) -> Optional[dict]:
        try:
            return self._request("GET", f"/processes/{proc_id}")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise

    def logs(self, proc_id: str, since: int = 0) -> Optional[dict]:
        """Returns {"lines": [...], "total": N} (None if the companion
        doesn't track this id). since=0 gets the full buffer; pass back a
        prior call's "total" to get only lines appended since then - see
        service.py's own Registry.logs() for what happens if that's
        older than what the bounded buffer still holds."""
        try:
            return self._request("GET", f"/processes/{proc_id}/logs?since={since}")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise


def ensure_companion_running(share_dir: str, port: int = DEFAULT_PORT) -> Optional[WindowsCompanionClient]:
    """Called once at dashboard_server startup. Returns a ready-to-use
    client, or None if this isn't WSL, or if bootstrapping fails - callers
    treat None as "no Windows support this session", not an error to
    surface to every target."""
    if detect_platform() != "wsl":
        return None

    host = _default_gateway_ip()
    if host is None:
        logger.warning("windows_companion: couldn't determine the Windows host's IP from `ip route` - "
                        "Windows-side targets won't be available this session")
        return None

    stored_token = None
    if os.path.isfile(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            stored_token = f.read().strip() or None

    if stored_token is not None:
        client = WindowsCompanionClient(host, port, stored_token)
        if client.health() and client.authorized():
            logger.info("windows_companion: reusing already-running companion at %s:%d", host, port)
            return client
        if client.health():
            # Something's listening on the port but doesn't accept our
            # stored token - could be a companion restarted independently
            # (new random token) or an unrelated process. Don't guess by
            # killing it; that's exactly the kind of blind destructive
            # action to avoid taking automatically.
            logger.warning(
                "windows_companion: something is listening on %s:%d but rejected our stored token - "
                "not touching it. Stop whatever that is, or delete %s, then restart dashboard_server.",
                host, port, TOKEN_FILE,
            )
            return None

    # Reuse failed (nothing reachable, or a stale/wedged instance holding the
    # port). Kill any of OUR service.py that's still around so the fresh spawn
    # below can actually bind 5590 - otherwise it exits immediately and the
    # "never came up in 15s" warning repeats. See reclaim_companion().
    reclaim_companion()
    token = secrets.token_urlsafe(32)
    service_path = os.path.join(share_dir, "windows_companion", "service.py")
    try:
        windows_path = subprocess.check_output(["wslpath", "-w", service_path], text=True).strip()
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        logger.warning("windows_companion: couldn't resolve service.py's Windows path (%s) - "
                        "Windows-side targets won't be available this session", exc)
        return None

    log_path = os.path.expanduser("~/.dashboard_windows_companion.log")
    try:
        with open(log_path, "a") as log_file:
            subprocess.Popen(
                ["python.exe", windows_path, "--host", "0.0.0.0", "--port", str(port)],
                env={**os.environ, "WINDOWS_COMPANION_TOKEN": token, "WSLENV": "WINDOWS_COMPANION_TOKEN"},
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
    except OSError as exc:
        logger.warning("windows_companion: failed to spawn companion (%s) - "
                        "Windows-side targets won't be available this session", exc)
        return None

    client = WindowsCompanionClient(host, port, token)
    deadline = time.monotonic() + STARTUP_POLL_TIMEOUT_SEC
    while time.monotonic() < deadline:
        if client.health():
            with open(TOKEN_FILE, "w") as f:
                f.write(token)
            os.chmod(TOKEN_FILE, 0o600)
            logger.info("windows_companion: started fresh companion at %s:%d (log: %s)", host, port, log_path)
            return client
        time.sleep(0.5)

    logger.warning("windows_companion: spawned but never came up within %.0fs (check %s) - "
                    "Windows-side targets won't be available this session", STARTUP_POLL_TIMEOUT_SEC, log_path)
    return None
