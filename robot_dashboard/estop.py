import asyncio

from fastapi import APIRouter

from .ros_bridge import DashboardRosNode
from .supervisor.process_manager import ProcessManager


def create_estop_router(ros_node: DashboardRosNode, pm: ProcessManager) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["estop"])

    @router.post("/estop")
    async def estop():
        # No confirmation dialog, no auth gate, no grace period - e-stop's
        # only job is to be the fastest possible path to "stop everything
        # this dashboard can stop." /estop has no subscriber yet (no motor
        # node exists in this workspace) - this is a forward-looking
        # contract for whenever one does, not a verified safety mechanism
        # today.
        await asyncio.to_thread(ros_node.publish_estop)
        stopped = await asyncio.to_thread(pm.stop_all)
        return {"estop_published": True, "stopped_targets": stopped}

    return router
