import os
import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

# Auth is OFF entirely unless a passcode is actually configured - preserves
# the existing zero-friction localhost-only workflow by default, only
# turning on once someone sets one up for LAN exposure. One shared
# passcode, not per-user accounts: this is a single-team LAN control
# surface, not a multi-tenant service.
#
# Two ways to set it, checked in this order:
#   1. DASHBOARD_PASSCODE env var (`passcode:=` launch arg) - one-off
#      override, doesn't persist anywhere.
#   2. ~/.dashboard_passcode - a plain-text dotfile outside the repo
#      entirely. This is the "set once, forget it" path - no risk of ever
#      landing in git (it's not even inside the workspace), no need to
#      retype it per launch, no colcon rebuild needed to change it (just
#      relaunch).
def _load_passcode() -> str | None:
    env_val = os.environ.get("DASHBOARD_PASSCODE")
    if env_val:
        return env_val
    dotfile = os.path.expanduser("~/.dashboard_passcode")
    if os.path.isfile(dotfile):
        with open(dotfile) as f:
            content = f.read().strip()
        return content or None
    return None


PASSCODE = _load_passcode()

# In-memory only - a server restart invalidates every session (everyone
# re-enters the passcode), which is an acceptable tradeoff for a LAN tool
# and avoids needing any persistent session store.
_valid_tokens: set[str] = set()

# Endpoints reachable without a token even when auth is on: the login route
# itself (chicken-and-egg otherwise) and the auth-status probe the frontend
# uses to decide whether to show a login screen at all. Static frontend
# files are excluded from the check entirely (see main.py) since the login
# form itself has to load before any token exists.
_PUBLIC_API_PATHS = {"/api/auth/login", "/api/auth/status"}


def check_token(token: str | None) -> bool:
    if PASSCODE is None:
        return True
    return token is not None and token in _valid_tokens


def login(passcode: str) -> str | None:
    if PASSCODE is None or not secrets.compare_digest(passcode, PASSCODE):
        return None
    token = secrets.token_urlsafe(32)
    _valid_tokens.add(token)
    return token


def logout(token: str) -> None:
    _valid_tokens.discard(token)


class AuthMiddleware(BaseHTTPMiddleware):
    """Gates every /api/* HTTP route behind a bearer token. WebSocket routes
    aren't covered here - Starlette's BaseHTTPMiddleware only intercepts
    scope["type"] == "http", websocket scopes pass straight through - each
    websocket handler checks its own ?token= query param instead (see
    supervisor/routes.py, graph/routes.py)."""

    async def dispatch(self, request: Request, call_next):
        if PASSCODE is None:
            return await call_next(request)
        path = request.url.path
        if path.startswith("/api/") and path not in _PUBLIC_API_PATHS:
            auth_header = request.headers.get("authorization", "")
            token = auth_header[7:] if auth_header.startswith("Bearer ") else None
            if not check_token(token):
                return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)


class LoginRequest(BaseModel):
    passcode: str


def create_auth_router() -> APIRouter:
    router = APIRouter(prefix="/api/auth", tags=["auth"])

    @router.get("/status")
    async def status():
        return {"auth_required": PASSCODE is not None}

    @router.post("/login")
    async def do_login(body: LoginRequest):
        token = login(body.passcode)
        if token is None:
            raise HTTPException(status_code=401, detail="incorrect passcode")
        return {"token": token}

    @router.post("/logout")
    async def do_logout(request: Request):
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            logout(auth_header[7:])
        return {}

    return router
