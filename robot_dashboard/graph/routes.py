import asyncio

from fastapi import APIRouter, Body, HTTPException, WebSocket, WebSocketDisconnect

from ..auth import check_token
from ..ros_bridge import DashboardRosNode
from .action_client import ActionInvoker
from .fake_publisher import FakePublisher
from .schema import format_message_schema
from .topic_watcher import TopicWatcher

# Same convention as params/routes.py: fqns travel over HTTP without their
# leading slash (a `:path` route converter needs that to accept the
# embedded slashes of a namespaced name), re-added before touching rclpy.


def _fqn(name: str) -> str:
    return "/" + name.lstrip("/")


def _strip(fqn: str) -> str:
    return fqn.lstrip("/")


def _split_fqn(fqn: str) -> tuple[str, str]:
    idx = fqn.rfind("/")
    namespace = fqn[:idx] if idx > 0 else "/"
    name = fqn[idx + 1 :]
    return namespace, name


def create_graph_router(
    ros_node: DashboardRosNode,
    topic_watcher: TopicWatcher,
    action_invoker: ActionInvoker,
    fake_publisher: FakePublisher,
) -> APIRouter:
    router = APIRouter(prefix="/api/graph", tags=["graph"])

    @router.post("/topics/{topic_name:path}/hz/start")
    async def start_hz(topic_name: str):
        error = await asyncio.to_thread(topic_watcher.start_hz, _fqn(topic_name))
        return {"error": error}

    @router.post("/topics/{topic_name:path}/hz/stop")
    async def stop_hz(topic_name: str):
        await asyncio.to_thread(topic_watcher.stop_hz, _fqn(topic_name))
        return {}

    @router.get("/topics/{topic_name:path}/hz")
    async def get_hz(topic_name: str):
        return await asyncio.to_thread(topic_watcher.get_rate, _fqn(topic_name))

    @router.websocket("/topics/{topic_name:path}/echo")
    async def echo_topic(websocket: WebSocket, topic_name: str):
        if not check_token(websocket.query_params.get("token")):
            await websocket.close(code=4401)
            return
        await websocket.accept()
        fqn = _fqn(topic_name)
        queue, error = await asyncio.to_thread(topic_watcher.subscribe_echo, fqn)
        if error:
            await websocket.send_json({"error": error})
            await websocket.close()
            return
        try:
            while True:
                payload = await queue.get()
                await websocket.send_json(payload)
        except WebSocketDisconnect:
            pass
        finally:
            await asyncio.to_thread(topic_watcher.unsubscribe_echo, fqn, queue)

    @router.get("/topics")
    async def list_topics():
        topics = await asyncio.to_thread(ros_node.list_topics)
        fake_counts = await asyncio.to_thread(fake_publisher.active_topic_counts)
        result = []
        for name, types in topics:
            info = await asyncio.to_thread(ros_node.topic_endpoint_info, name)
            result.append({"name": _strip(name), "types": types, "fake_publish_count": fake_counts.get(name, 0), **info})
        return result

    @router.get("/message_schema")
    async def message_schema(type: str):
        return {"schema": await asyncio.to_thread(format_message_schema, type)}

    @router.post("/topics/{topic_name:path}/fake_publish/start")
    async def start_fake_publish(topic_name: str, body: dict = Body(...)):
        try:
            result = await asyncio.to_thread(
                fake_publisher.start,
                _fqn(topic_name),
                body["type"],
                body.get("source", ""),
            )
        except (ImportError, ValueError, AttributeError, KeyError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        # topic/type echo back whatever actually ended up running - a
        # script declaring its own `extern ros_topic = "...";` default
        # is authoritative over the form's own values, and the frontend
        # needs to know when that happened so it can update what it's
        # showing rather than silently disagreeing with reality.
        return {"session_id": result["session_id"], "topic": _strip(result["topic"]), "type": result["type"]}

    @router.post("/topics/{topic_name:path}/fake_publish/stop")
    async def stop_fake_publish(topic_name: str, body: dict = Body(...)):
        ok = await asyncio.to_thread(fake_publisher.stop, body.get("session_id", ""))
        return {"ok": ok}

    @router.get("/topics/{topic_name:path}/fake_publish/status")
    async def fake_publish_status(topic_name: str, session_id: str):
        status = await asyncio.to_thread(fake_publisher.status, session_id)
        if status is None:
            raise HTTPException(status_code=404, detail="unknown session")
        return status

    @router.get("/services")
    async def list_services():
        services = await asyncio.to_thread(ros_node.list_services)
        return [{"name": _strip(s["name"]), "types": s["types"]} for s in services]

    @router.post("/services/{service_name:path}/call")
    async def call_service(service_name: str, body: dict = Body(...)):
        services = await asyncio.to_thread(ros_node.list_services)
        fqn = _fqn(service_name)
        service_type = next((s["types"][0] for s in services if s["name"] == fqn), None)
        if service_type is None:
            raise HTTPException(status_code=404, detail=f"service {service_name} not found")
        try:
            response, error = await asyncio.to_thread(
                ros_node.call_service_dynamic, fqn, service_type, body.get("request", {})
            )
        except (AttributeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        if error:
            raise HTTPException(status_code=504, detail=error)
        return {"response": response}

    @router.get("/actions")
    async def list_actions():
        actions = await asyncio.to_thread(ros_node.list_actions)
        return [{"name": _strip(a["name"]), "types": a["types"]} for a in actions]

    async def _action_type(action_name: str) -> str:
        actions = await asyncio.to_thread(ros_node.list_actions)
        fqn = _fqn(action_name)
        for a in actions:
            if a["name"] == fqn:
                return a["types"][0]
        raise HTTPException(status_code=404, detail=f"action {action_name} not found")

    @router.post("/actions/{action_name:path}/send_goal")
    async def send_goal(action_name: str, body: dict = Body(...)):
        action_type = await _action_type(action_name)
        try:
            goal_id = await asyncio.to_thread(
                action_invoker.send_goal, _fqn(action_name), action_type, body.get("goal", {})
            )
        except (AttributeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"goal_id": goal_id}

    @router.post("/actions/{action_name:path}/cancel")
    async def cancel_goal(action_name: str, body: dict = Body(...)):
        ok = await asyncio.to_thread(action_invoker.cancel, body.get("goal_id", ""))
        return {"ok": ok}

    @router.websocket("/actions/{action_name:path}/stream")
    async def stream_action(websocket: WebSocket, action_name: str):
        if not check_token(websocket.query_params.get("token")):
            await websocket.close(code=4401)
            return
        goal_id = websocket.query_params.get("goal_id")
        await websocket.accept()
        if not goal_id:
            await websocket.send_json({"error": "missing goal_id"})
            await websocket.close()
            return
        try:
            async for item in action_invoker.stream(goal_id):
                await websocket.send_json(item)
            await websocket.close()
        except WebSocketDisconnect:
            pass

    @router.get("/nodes/{node_name:path}")
    async def node_interfaces(node_name: str):
        namespace, name = _split_fqn(_fqn(node_name))
        return await asyncio.to_thread(ros_node.node_interfaces, name, namespace)

    return router
