"""Native Windows process-supervisor companion for the dashboard.

Runs directly on Windows (native python.exe, NOT through WSL interop) so
that stopping a managed process can use a real Windows graceful-shutdown
signal (CTRL_BREAK_EVENT) instead of a POSIX signal crossing the WSL
interop boundary, which only ever hard-kills (verified empirically - an
interop-spawned Windows process never sees SIGINT as a real Ctrl+C).

Stdlib only, deliberately - this has to run on whatever native Windows
Python is already on the machine (`python.exe` via `where.exe`), without
requiring a pip install on the Windows side first.

Run it directly on Windows (not spawned via `ros2 launch`/WSL interop -
that would put IT back under the same hard-kill-only signal problem this
exists to avoid):

    python.exe service.py [--host 127.0.0.1] [--port 5590]

Set WINDOWS_COMPANION_TOKEN in the environment to require
`Authorization: Bearer <token>` on every request except /health - same
"off unless configured" pattern as the dashboard's own auth.py. Binds to
127.0.0.1 by default; only change --host if you specifically need another
machine to reach it (WSL2 can already reach Windows localhost without
that).

API (all bodies/responses JSON):
    GET  /health                    -> {"status": "ok"}  (no auth)
    GET  /processes                 -> [status, ...]
    GET  /processes/<id>            -> status
    GET  /processes/<id>/logs?since=N -> {"lines": [...], "total": N} - since
                                     omitted/0 returns the full buffer;
                                     pass back a prior response's `total`
                                     to get only lines appended after it
    POST /processes/<id>/start      body: {"cmd": [...], "cwd"?: str, "env"?: {}}
    POST /processes/<id>/stop       body: {"grace_period_sec"?: float, "hard"?: bool}
"""

import argparse
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

if sys.platform != "win32":
    sys.exit("windows_companion/service.py must run on native Windows Python, not WSL/Linux")

LOG_BUFFER_SIZE = 2000
DEFAULT_GRACE_PERIOD_SEC = 5.0
TOKEN = os.environ.get("WINDOWS_COMPANION_TOKEN")


@dataclass
class ManagedProcess:
    id: str
    popen: subprocess.Popen
    cmd: list
    started_at: float
    state: str = "running"  # running -> stopped | exited | failed
    exit_code: Optional[int] = None
    log_buffer: deque = field(default_factory=lambda: deque(maxlen=LOG_BUFFER_SIZE))
    # Total lines ever appended, NOT len(log_buffer) - the buffer is
    # bounded (maxlen=LOG_BUFFER_SIZE) and silently drops old lines, so a
    # poller asking "give me everything after line N" needs this to tell
    # whether N is still in the buffer at all (see Registry.logs()).
    log_total: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)


class Registry:
    def __init__(self):
        self._procs: dict[str, ManagedProcess] = {}
        self._lock = threading.Lock()

    def start(self, proc_id: str, cmd: list, cwd: Optional[str], env: Optional[dict]) -> dict:
        with self._lock:
            existing = self._procs.get(proc_id)
            if existing is not None and existing.state == "running":
                return self._status(existing)

            full_env = {**os.environ, **(env or {})}
            try:
                popen = subprocess.Popen(
                    cmd,
                    cwd=cwd,
                    env=full_env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    # Required for CTRL_BREAK_EVENT to be deliverable later -
                    # a process in the parent's own console group can't be
                    # signaled independently of the parent.
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
                )
            except OSError as exc:
                managed = ManagedProcess(id=proc_id, popen=None, cmd=cmd, started_at=time.time(), state="failed")
                managed.log_buffer.append(f"[companion] failed to spawn: {exc}")
                managed.log_total += 1
                self._procs[proc_id] = managed
                return self._status(managed)

            managed = ManagedProcess(id=proc_id, popen=popen, cmd=cmd, started_at=time.time())
            self._procs[proc_id] = managed

        threading.Thread(target=self._pump_output, args=(managed,), daemon=True).start()
        return self._status(managed)

    def stop(self, proc_id: str, grace_period_sec: float, hard: bool) -> Optional[dict]:
        with self._lock:
            managed = self._procs.get(proc_id)
        if managed is None:
            return None
        if managed.state != "running" or managed.popen is None:
            return self._status(managed)

        managed.state = "stopping"
        graceful = False
        if not hard:
            try:
                managed.popen.send_signal(signal.CTRL_BREAK_EVENT)
                managed.popen.wait(timeout=grace_period_sec)
                graceful = True
            except subprocess.TimeoutExpired:
                pass
            except (OSError, ValueError) as exc:
                with managed.lock:
                    managed.log_buffer.append(f"[companion] CTRL_BREAK_EVENT delivery failed: {exc}")
                    managed.log_total += 1

        if not graceful:
            # Fallback: the process either ignored CTRL_BREAK_EVENT, took
            # longer than grace_period_sec, or `hard` was requested
            # outright - TerminateProcess it, no further waiting for
            # cooperation.
            with managed.lock:
                managed.log_buffer.append(
                    "[companion] stopping without cooperation (hard kill)" if hard
                    else f"[companion] no graceful exit within {grace_period_sec}s, hard-killing"
                )
                managed.log_total += 1
            try:
                managed.popen.kill()
                managed.popen.wait(timeout=DEFAULT_GRACE_PERIOD_SEC)
            except (OSError, subprocess.TimeoutExpired):
                pass

        # _pump_output's own thread is racing to observe EOF and set the
        # final exited/failed state + exit_code - don't clobber it here,
        # just report whatever it lands on.
        return self._status(managed)

    def status(self, proc_id: str) -> Optional[dict]:
        with self._lock:
            managed = self._procs.get(proc_id)
        return self._status(managed) if managed else None

    def status_all(self) -> list:
        with self._lock:
            procs = list(self._procs.values())
        return [self._status(p) for p in procs]

    def logs(self, proc_id: str, since: int = 0) -> Optional[dict]:
        """since=0 (or omitted) returns the full current buffer, same as
        before. since=N (the caller's own log_total from a previous call)
        returns only lines appended after that point - or, if N is older
        than what the bounded buffer still holds (already dropped), the
        full current buffer instead, since there's no way to give a true
        delta for lines that no longer exist. Either way the response's
        own `total` tells the caller what to pass as `since` next time."""
        with self._lock:
            managed = self._procs.get(proc_id)
        if managed is None:
            return None
        with managed.lock:
            buffer = list(managed.log_buffer)
            total = managed.log_total
        dropped = total - len(buffer)
        if since <= dropped:
            return {"lines": buffer, "total": total}
        return {"lines": buffer[since - dropped:], "total": total}

    @staticmethod
    def _status(managed: ManagedProcess) -> dict:
        return {
            "id": managed.id,
            "cmd": managed.cmd,
            "state": managed.state,
            "pid": managed.popen.pid if managed.popen else None,
            "exit_code": managed.exit_code,
            "started_at": managed.started_at,
        }

    @staticmethod
    def _pump_output(managed: ManagedProcess) -> None:
        try:
            for line in managed.popen.stdout:
                with managed.lock:
                    managed.log_buffer.append(line.rstrip("\n"))
                    managed.log_total += 1
        finally:
            managed.popen.wait()
            managed.exit_code = managed.popen.returncode
            # A stop() call already moved this to "stopping" - a clean
            # exit after that is still a stop, not an unexpected exit.
            if managed.state == "stopping" or managed.exit_code == 0:
                managed.state = "stopped" if managed.state == "stopping" else "exited"
            else:
                managed.state = "failed"


registry = Registry()


class _CompanionHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer on Windows, but binding the port EXCLUSIVELY.

    HTTPServer defaults to allow_reuse_address=1 -> SO_REUSEADDR, which on
    Windows lets a SECOND process bind the very same port. That is exactly the
    split-brain that makes the dashboard's requests round-robin between two
    companions (one with the target's process, one without), so a stop can hit
    the empty one and the target wedges at STOPPING. SO_EXCLUSIVEADDRUSE makes
    a second bind fail loudly instead - the dashboard's reclaim-on-start kills
    a stale companion first, so only one is ever bound.

    This is Windows-only (the module already exits on non-Windows); the option
    is a harmless no-op elsewhere.
    """

    allow_reuse_address = False

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")

    def _authorized(self) -> bool:
        if TOKEN is None:
            return True
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {TOKEN}"

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        split = urllib.parse.urlsplit(self.path)
        if split.path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        if not self._authorized():
            self._send_json(401, {"detail": "unauthorized"})
            return

        parts = split.path.strip("/").split("/")
        if parts == ["processes"]:
            self._send_json(200, registry.status_all())
        elif len(parts) == 2 and parts[0] == "processes":
            status = registry.status(parts[1])
            self._send_json(200, status) if status else self._send_json(404, {"detail": "unknown process id"})
        elif len(parts) == 3 and parts[0] == "processes" and parts[2] == "logs":
            query = urllib.parse.parse_qs(split.query)
            try:
                since = int(query.get("since", ["0"])[0])
            except ValueError:
                since = 0
            result = registry.logs(parts[1], since=since)
            self._send_json(200, result) if result is not None else self._send_json(404, {"detail": "unknown process id"})
        else:
            self._send_json(404, {"detail": "not found"})

    def do_POST(self):
        if not self._authorized():
            self._send_json(401, {"detail": "unauthorized"})
            return

        parts = self.path.strip("/").split("/")
        try:
            body = self._read_json()
        except json.JSONDecodeError:
            self._send_json(400, {"detail": "invalid JSON body"})
            return

        if len(parts) == 3 and parts[0] == "processes" and parts[2] == "start":
            cmd = body.get("cmd")
            if not isinstance(cmd, list) or not cmd:
                self._send_json(400, {"detail": "'cmd' must be a non-empty list"})
                return
            self._send_json(200, registry.start(parts[1], cmd, body.get("cwd"), body.get("env")))
        elif len(parts) == 3 and parts[0] == "processes" and parts[2] == "stop":
            result = registry.stop(
                parts[1],
                grace_period_sec=float(body.get("grace_period_sec", DEFAULT_GRACE_PERIOD_SEC)),
                hard=bool(body.get("hard", False)),
            )
            self._send_json(200, result) if result else self._send_json(404, {"detail": "unknown process id"})
        else:
            self._send_json(404, {"detail": "not found"})


def main() -> None:
    global TOKEN

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5590)
    args = parser.parse_args()

    # 127.0.0.1 is only reachable from this same Windows host, so running
    # unauthenticated there is the same "off unless configured" tradeoff
    # the dashboard's own auth.py makes. Any other bind address (0.0.0.0,
    # or a specific adapter IP - both needed for WSL to reach this at all,
    # since WSL's 127.0.0.1 is a different loopback than Windows') is
    # reachable by anything else that can address this host, which for
    # 0.0.0.0 includes the LAN - refusing to run with no auth there isn't
    # optional the way it is for the dashboard itself.
    if TOKEN is None and args.host != "127.0.0.1":
        TOKEN = secrets.token_urlsafe(32)
        print(
            f"[companion] WINDOWS_COMPANION_TOKEN not set - generated one for this "
            f"session since --host {args.host} isn't loopback-only:\n"
            f"    {TOKEN}\n"
            f"Pass it as 'Authorization: Bearer {TOKEN}' from the WSL side, or set "
            f"WINDOWS_COMPANION_TOKEN yourself before starting this to pin it.",
            file=sys.stderr,
        )
    elif TOKEN is None:
        print("[companion] WARNING: WINDOWS_COMPANION_TOKEN not set - running with no auth", file=sys.stderr)

    server = _CompanionHTTPServer((args.host, args.port), Handler)
    print(f"[companion] listening on {args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
