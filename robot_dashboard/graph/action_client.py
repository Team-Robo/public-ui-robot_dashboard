import asyncio
import uuid
from typing import AsyncIterator, Optional

from rclpy.action import ActionClient
from ..json_safe import message_to_json_dict
from rosidl_runtime_py.set_message import set_message_fields
from rosidl_runtime_py.utilities import get_action


class _Invocation:
    def __init__(self) -> None:
        self.queue: asyncio.Queue = asyncio.Queue()
        self.goal_handle = None


class ActionInvoker:
    """Sends one-off action goals and streams feedback/result back - the
    action equivalent of TopicWatcher, but per-goal rather than a shared
    ref-counted subscription (an invocation is inherently one-shot, not
    something multiple watchers share the way a topic subscription is).

    Goal fields come in as a plain dict (JSON from the frontend) and get
    converted to the real typed Goal message via rosidl_runtime_py's
    set_message_fields() - the same approach message_to_ordereddict() (used
    for topic echo elsewhere in this app) takes in the opposite direction.
    A bad field name/type raises a clean AttributeError/ValueError, which
    the route layer turns into a 400 with the real message, not a 500.
    """

    def __init__(self, ros_node) -> None:
        self._node = ros_node
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._invocations: dict[str, _Invocation] = {}
        self._clients: dict[tuple[str, str], ActionClient] = {}

    def set_event_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def _get_client(self, action_name: str, action_type_str: str) -> ActionClient:
        key = (action_name, action_type_str)
        client = self._clients.get(key)
        if client is None:
            action_cls = get_action(action_type_str)
            client = ActionClient(self._node, action_cls, action_name)
            self._clients[key] = client
        return client

    def send_goal(self, action_name: str, action_type_str: str, goal_dict: dict) -> str:
        """Builds and sends the goal, returns a goal_id the caller streams
        feedback/result through via stream(). Callbacks below fire on the
        rclpy executor thread (same as call_service()'s done-callback
        pattern elsewhere in this codebase) - never call
        spin_until_future_complete here, the node is already being spun."""
        action_cls = get_action(action_type_str)
        goal_msg = action_cls.Goal()
        set_message_fields(goal_msg, goal_dict)

        client = self._get_client(action_name, action_type_str)
        goal_id = uuid.uuid4().hex
        inv = _Invocation()
        self._invocations[goal_id] = inv

        def feedback_cb(feedback_msg):
            self._push(goal_id, {"type": "feedback", "data": message_to_json_dict(feedback_msg.feedback)})

        def result_cb(future):
            result_response = future.result()
            self._push(
                goal_id,
                {
                    "type": "result",
                    "status": result_response.status,
                    "data": message_to_json_dict(result_response.result),
                },
            )

        def goal_response_cb(future):
            goal_handle = future.result()
            if not goal_handle.accepted:
                self._push(goal_id, {"type": "rejected"})
                return
            inv.goal_handle = goal_handle
            # The real ROS goal UUID (distinct from our own goal_id above,
            # which is just this invocation's bookkeeping key) - sent so the
            # frontend can recognize this goal when it also shows up on the
            # action's raw status topic (every goal, any client) and mark it
            # as "yours" instead of an anonymous id.
            # goal_id.uuid is a numpy uint8 array, not plain Python ints -
            # json can't serialize numpy scalars (this crashed the stream
            # WebSocket outright the first time, right after this message).
            self._push(goal_id, {"type": "accepted", "ros_goal_id": [int(b) for b in goal_handle.goal_id.uuid]})
            goal_handle.get_result_async().add_done_callback(result_cb)

        send_future = client.send_goal_async(goal_msg, feedback_callback=feedback_cb)
        send_future.add_done_callback(goal_response_cb)

        return goal_id

    def _push(self, goal_id: str, payload: dict) -> None:
        inv = self._invocations.get(goal_id)
        if inv is None or self._loop is None:
            return
        self._loop.call_soon_threadsafe(inv.queue.put_nowait, payload)

    async def stream(self, goal_id: str) -> AsyncIterator[dict]:
        """Yields feedback dicts as they arrive, then one final result/
        rejected dict, then stops - the WS route closes the connection
        right after."""
        inv = self._invocations.get(goal_id)
        if inv is None:
            return
        while True:
            item = await inv.queue.get()
            yield item
            if item["type"] in ("result", "rejected"):
                del self._invocations[goal_id]
                return

    def cancel(self, goal_id: str) -> bool:
        inv = self._invocations.get(goal_id)
        if inv is None or inv.goal_handle is None:
            return False
        inv.goal_handle.cancel_goal_async()
        return True
