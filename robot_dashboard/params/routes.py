import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .param_client import ParamClient, ParamClientError

# ROS2 node fully-qualified names start with "/" (and namespaced nodes embed
# further "/"s, e.g. "/ns/pose_node"). Over HTTP we always carry the fqn
# WITHOUT its leading slash and use a `:path` route converter so embedded
# slashes survive - `_fqn()` re-adds the leading slash before touching rclpy.


def _fqn(node_name: str) -> str:
    return "/" + node_name.lstrip("/")


def _strip(fqn: str) -> str:
    return fqn.lstrip("/")


class SetParameterRequest(BaseModel):
    value: object
    type_id: int


def create_params_router(client: ParamClient) -> APIRouter:
    router = APIRouter(prefix="/api/params", tags=["params"])

    @router.get("/nodes")
    async def list_nodes():
        names = await asyncio.to_thread(client.list_nodes)
        return [_strip(n) for n in names]

    @router.get("/nodes/{node_name:path}")
    async def list_parameters(node_name: str):
        fqn = _fqn(node_name)
        try:
            names = await asyncio.to_thread(client.list_parameters, fqn)
            return await asyncio.to_thread(client.describe_and_get, fqn, names)
        except ParamClientError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @router.get("/nodes/{node_name:path}/params/{param_name}")
    async def get_parameter(node_name: str, param_name: str):
        fqn = _fqn(node_name)
        try:
            return await asyncio.to_thread(client.get_parameter, fqn, param_name)
        except ParamClientError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @router.post("/nodes/{node_name:path}/params/{param_name}")
    async def set_parameter(node_name: str, param_name: str, body: SetParameterRequest):
        fqn = _fqn(node_name)
        try:
            result = await asyncio.to_thread(
                client.set_parameter, fqn, param_name, body.value, body.type_id
            )
        except ParamClientError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        # A rejected set (e.g. read_only=True) is a clean, expected outcome,
        # not a server error - surface it as structured {ok:false, reason},
        # not a 500.
        return result

    return router
