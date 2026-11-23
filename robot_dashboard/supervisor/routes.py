import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from ..auth import check_token
from .conditions import DependencyNotMet
from .process_manager import ProcessManager


class DependencyFlags(BaseModel):
    flags: list[str] = Field(default_factory=list)
    flag_values: dict[str, str] = Field(default_factory=dict)


class StartRequest(BaseModel):
    flags: list[str] = Field(default_factory=list)
    # For `select`-type flags: flag name -> chosen option name. Only relevant
    # for names present in `flags`; absent means the flag's "None" was chosen.
    flag_values: dict[str, str] = Field(default_factory=dict)
    # "Start just this": spawn anyway even if `requires` is unmet.
    ignore_dependencies: bool = False
    # "Start them too": resolve + start the transitive target deps first.
    start_dependencies: bool = False
    # For a chain-resume ("Start anyway" after it paused on a node): the set of
    # node ids whose OWN precondition should NOT be re-checked this pass (we
    # already chose to pass them), so the walk continues and prompts again on
    # the next unmet node. Empty for a fresh "Start dependencies too".
    skip_preconditions: list[str] = Field(default_factory=list)
    # target id -> that target's OWN selected flags, for every target
    # besides the one this request is actually for - only meaningful when
    # start_dependencies is set. Without this, a target auto-started as a
    # dependency (not clicked directly) got NO flags at all regardless of
    # what was toggled on its own row - confirmed live as a real bug (a
    # GPU flag silently ignored the moment its target was pulled in
    # indirectly through a chain). The frontend sends whichever targets
    # currently have any flag selected, not just ones it knows will
    # actually be in this particular chain - harmless if some turn out not
    # to be, see ProcessManager.start_with_dependencies's own use of this.
    dependency_flags: dict[str, DependencyFlags] = Field(default_factory=dict)


def _dependency_not_met_detail(exc: DependencyNotMet) -> dict:
    return {
        "error": "dependency_not_met",
        "message": str(exc),
        "reason": exc.reason,
        "missing_targets": sorted(exc.missing_targets),
        "kind": exc.kind,
    }


def create_supervisor_router(pm: ProcessManager) -> APIRouter:
    router = APIRouter(prefix="/api/targets", tags=["supervisor"])

    def _require_target(target_id: str) -> None:
        if target_id not in {s.id for s in pm.status_all()}:
            raise HTTPException(status_code=404, detail=f"unknown target '{target_id}'")

    @router.get("")
    async def list_targets():
        return pm.status_all()

    @router.get("/{target_id}/status")
    async def get_status(target_id: str):
        _require_target(target_id)
        return pm.status(target_id)

    @router.get("/{target_id}/dependencies")
    async def get_dependencies(target_id: str, flags: list[str] = Query(default=[])):
        _require_target(target_id)
        # flags: the target's CURRENTLY selected flags in the UI, sent for
        # this pre-check even though Start hasn't been clicked yet - a
        # `flag:` leaf in this target's OWN requires (see conditions.py)
        # needs to know that selection to evaluate correctly, same as the
        # real start() gate does once the request actually comes in. Only
        # this target's own flags are meaningful here (flag: is never about
        # a different target), so nothing else in dependency_flags applies.
        selected_flags = set(flags)

        def _compute():
            # All three calls can do real work (a custom: subprocess, an
            # rclpy graph query) - run them on a worker thread, same as
            # every other route here, so a slow one doesn't stall the
            # single-threaded event loop for every other client/route.
            result = pm.dependency_status(target_id, selected_flags=selected_flags)
            # missing_targets must be the TRANSITIVE closure (deps of deps),
            # not just this target's own direct `target:` leaves - "Start
            # dependencies too" resolves the whole tree, so the dialog
            # should tell the truth about how many actually start.
            # dependency_closure returns deps-first with the target itself
            # last; drop the last entry.
            order = pm.dependency_closure(target_id, selected_flags=selected_flags)
            missing = order[:-1] if order else []
            return {
                "met": result.ok,
                "reason": result.reason,
                "missing_targets": missing,
                # Non-target prerequisites (device:/file:/topic:/custom:...)
                # that are unmet - the dashboard only auto-starts `target:`
                # deps, so these are the operator's to satisfy. The UI warns
                # about them rather than pretending auto-start can fix them.
                "external_prereqs": pm.external_prereqs(target_id, selected_flags=selected_flags),
            }

        return await asyncio.to_thread(_compute)

    @router.post("/{target_id}/start")
    async def start(target_id: str, body: Optional[StartRequest] = None):
        # Body is genuinely optional - a bare POST with no body (curl, older
        # callers, manual testing) must keep working exactly like before
        # flags existed, not 422 on a missing/empty JSON body.
        _require_target(target_id)
        flags = body.flags if body else []
        flag_values = body.flag_values if body else {}
        try:
            if body is not None and body.start_dependencies:
                # Checked chain. skip_preconditions carries any node(s) the
                # operator already said "start anyway" to, so the walk passes
                # them without re-checking and keeps prompting on later nodes.
                dependency_flags = {
                    tid: (df.flags, df.flag_values) for tid, df in body.dependency_flags.items()
                }
                return await asyncio.to_thread(
                    pm.start_with_dependencies,
                    target_id,
                    flags,
                    set(body.skip_preconditions),
                    flag_values,
                    dependency_flags,
                )
            ignore = bool(body is not None and body.ignore_dependencies)
            return await asyncio.to_thread(pm.start, target_id, flags, ignore, flag_values)
        except DependencyNotMet as exc:
            raise HTTPException(status_code=409, detail=_dependency_not_met_detail(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @router.post("/{target_id}/stop")
    async def stop(target_id: str):
        _require_target(target_id)
        return await asyncio.to_thread(pm.stop, target_id)

    @router.post("/{target_id}/restart")
    async def restart(target_id: str):
        _require_target(target_id)
        try:
            return await asyncio.to_thread(pm.restart, target_id)
        except DependencyNotMet as exc:
            # restart() = stop() then start() - the stop already happened,
            # so the target is left STOPPED (not restarted) if its
            # dependency is down. Same structured 409 as /start, so the
            # frontend's existing DependencyDialog handling applies here
            # too instead of surfacing an unhandled 500.
            raise HTTPException(status_code=409, detail=_dependency_not_met_detail(exc)) from exc

    @router.post("/{target_id}/logs/clear")
    async def clear_logs(target_id: str):
        _require_target(target_id)
        pm.clear_logs(target_id)
        return {"cleared": True}

    @router.websocket("/{target_id}/logs")
    async def stream_logs(websocket: WebSocket, target_id: str):
        if not check_token(websocket.query_params.get("token")):
            await websocket.close(code=4401)
            return
        if target_id not in {s.id for s in pm.status_all()}:
            await websocket.close(code=4404)
            return
        await websocket.accept()
        for line in pm.log_backlog(target_id):
            await websocket.send_json({"line": line})
        queue = pm.subscribe_logs(target_id)
        try:
            while True:
                line = await queue.get()
                await websocket.send_json({"line": line})
        except WebSocketDisconnect:
            pass
        finally:
            pm.unsubscribe_logs(target_id, queue)

    return router


def create_orphans_router(pm: ProcessManager) -> APIRouter:
    """Surfaces pids recorded by a PREVIOUS dashboard_server run that are
    still alive - see pid_registry.py's own docstring for why these can
    only be detected + killed, not reattached to for logs/exit codes."""
    router = APIRouter(prefix="/api/orphans", tags=["supervisor"])

    @router.get("")
    async def list_orphans():
        return pm.list_orphans()

    @router.post("/{target_id}/kill")
    async def kill_orphan(target_id: str):
        killed = await asyncio.to_thread(pm.kill_orphan, target_id)
        if not killed:
            raise HTTPException(status_code=404, detail=f"no live orphan tracked for '{target_id}'")
        return {"killed": True}

    return router


def create_events_router(pm: ProcessManager) -> APIRouter:
    router = APIRouter(tags=["supervisor"])

    @router.websocket("/api/events")
    async def stream_events(websocket: WebSocket):
        if not check_token(websocket.query_params.get("token")):
            await websocket.close(code=4401)
            return
        await websocket.accept()
        for status in pm.status_all():
            await websocket.send_json({"type": "state_change", **status.model_dump()})
        queue = pm.subscribe_events()
        try:
            while True:
                event = await queue.get()
                await websocket.send_json(event)
        except WebSocketDisconnect:
            pass
        finally:
            pm.unsubscribe_events(queue)

    return router
