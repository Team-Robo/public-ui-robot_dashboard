import threading
from typing import Any, Optional

import rclpy.action
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, ReliabilityPolicy
from rosidl_runtime_py.set_message import set_message_fields
from rosidl_runtime_py.utilities import get_service
from std_msgs.msg import Bool

from .json_safe import message_to_json_dict

SERVICE_WAIT_TIMEOUT_SEC = 2.0
# Separate from the above: how long to wait for an ACTUAL RESPONSE once a
# service call has been sent. Services called from the Graph tab's Call
# button are arbitrary and can legitimately be slow (e.g. a VLM service
# lazy-loading its model on the first call) - reusing the 2s existence-check
# timeout here made every such call 504 regardless of whether the service
# was actually healthy.
SERVICE_RESPONSE_TIMEOUT_SEC = 120.0

# Standard rcl_interfaces parameter services every rclpy node exposes by
# default (start_parameter_services=True, the default) - same clutter
# problem as actions, just for the Params tab's own territory instead of
# a new category. Filtered out of the plain services list; the Params tab
# already covers get/set for these.
STANDARD_PARAM_SERVICE_SUFFIXES = (
    "describe_parameters",
    "get_parameter_types",
    "get_parameters",
    "list_parameters",
    "set_parameters",
    "set_parameters_atomically",
)


def _qos_incompatible(pub_qos, sub_qos) -> bool:
    if sub_qos.reliability == ReliabilityPolicy.RELIABLE and pub_qos.reliability == ReliabilityPolicy.BEST_EFFORT:
        return True
    if sub_qos.durability == DurabilityPolicy.TRANSIENT_LOCAL and pub_qos.durability == DurabilityPolicy.VOLATILE:
        return True
    return False


class DashboardRosNode(Node):
    """The dashboard's own rclpy node.

    This node is added to a MultiThreadedExecutor spinning in a background
    thread (see main.py) - it is NEVER spun directly from a request-handling
    thread. Service calls made from FastAPI route handlers (via
    asyncio.to_thread) block on a threading.Event set by the response's
    done-callback, which the *already-spinning* executor thread fires -
    calling rclpy.spin_until_future_complete here would start a second,
    competing spin of this node and is deliberately avoided.

    Entity creation/destruction (create_client here, create_subscription/
    destroy_subscription in topic_watcher.py, create_publisher/
    destroy_publisher/create_timer/destroy_timer in fake_publisher.py) is a
    SEPARATE hazard from spinning twice - see spin_dispatch.py's docstring.
    Publishers created once at construction time (_estop_pub below), before
    the executor ever starts spinning, are unaffected.
    """

    def __init__(self, spin_dispatch=None):
        # Naming-contract migration: fully-qualified node name /ui/dashboard.
        super().__init__("dashboard", namespace="ui")
        self._estop_pub = self.create_publisher(Bool, "/estop", 10)
        self._service_clients: dict[tuple[str, str], Any] = {}
        # Routes create_client() (called lazily, on whatever thread first
        # needs it) onto the spin thread - see spin_dispatch.py's own
        # docstring for why calling it directly from a FastAPI request
        # thread, concurrently with the executor's spin_once(), is unsafe.
        # None is only expected outside of main()'s real wiring (e.g. a
        # test building this node directly without a live spin thread to
        # race against in the first place) - falls back to a direct call.
        self._spin_dispatch = spin_dispatch

    def publish_estop(self) -> None:
        self._estop_pub.publish(Bool(data=True))

    def list_node_names(self) -> list[str]:
        """Fully-qualified names of every node currently visible on the ROS graph."""
        result = []
        for name, ns in self.get_node_names_and_namespaces():
            ns = ns.rstrip("/")
            result.append(f"{ns}/{name}" if ns else f"/{name}")
        return sorted(result)

    def _action_internal_names(self, suffixes: tuple[str, ...]) -> set[str]:
        action_names = {n for n, _ in rclpy.action.get_action_names_and_types(self)}
        return {f"{action}/_action/{suffix}" for action in action_names for suffix in suffixes}

    def list_topics(self) -> list[tuple[str, list[str]]]:
        """(topic name, [msg types]) for every topic on the graph, minus the
        2 raw feedback/status topics any detected action is built from -
        same reasoning as list_services()'s filtering, just for the topic
        half of an action instead of the service half. They're already
        shown once, cleanly, in the graph-wide Actions list."""
        action_internal_names = self._action_internal_names(("feedback", "status"))
        return [
            (name, types) for name, types in self.get_topic_names_and_types() if name not in action_internal_names
        ]

    def list_services(self) -> list[dict]:
        """(service name, [types]) for every service on the graph - same
        filtering as node_interfaces() (action internals, standard
        parameter services), applied graph-wide instead of per-node. Only
        matches by suffix here, not the full {node_fqn}/{suffix} name,
        since this isn't scoped to one node."""
        action_internal_names = self._action_internal_names(("send_goal", "cancel_goal", "get_result"))
        result = []
        for name, types in self.get_service_names_and_types():
            if name in action_internal_names:
                continue
            if name.rsplit("/", 1)[-1] in STANDARD_PARAM_SERVICE_SUFFIXES:
                continue
            result.append({"name": name, "types": types})
        return result

    def list_actions(self) -> list[dict]:
        """(action name, [types]) for every action on the graph - the thing
        list_services()/node_interfaces() filter OUT of their own lists,
        surfaced here as its own first-class list instead."""
        return [{"name": n, "types": types} for n, types in rclpy.action.get_action_names_and_types(self)]

    def topic_endpoint_info(self, topic_name: str) -> dict:
        """Pub/sub counts plus a QoS compatibility check - a subscriber
        asking for a stricter policy than any actual publisher offers gets
        silently dropped by DDS with no error anywhere, one of the more
        opaque classes of "why am I getting nothing" ROS2 bugs. Per the DDS
        RxO rule, a subscriber's request must be no stricter than what a
        publisher offers: RELIABLE sub + BEST_EFFORT pub, or TRANSIENT_LOCAL
        sub + VOLATILE pub, are both incompatible. SYSTEM_DEFAULT/UNKNOWN on
        either side is deliberately never flagged - the actual negotiated
        policy isn't visible here, and a false positive is worse than
        missing a real one for a debugging aid like this."""
        pubs = self.get_publishers_info_by_topic(topic_name)
        subs = self.get_subscriptions_info_by_topic(topic_name)
        mismatch = any(_qos_incompatible(pub.qos_profile, sub.qos_profile) for pub in pubs for sub in subs)
        return {"publisher_count": len(pubs), "subscriber_count": len(subs), "qos_mismatch": mismatch}

    def node_interfaces(self, node_name: str, node_namespace: str) -> dict:
        """Publishers/subscribers/services/clients/actions for one node - the
        data behind `ros2 node info`. Actions use rclpy.action's own
        get_action_{server,client}_names_and_types_by_node() - a real graph
        API, not the `_action/` name pattern-matching `ros2 node info` does
        (an earlier version of this docstring wrongly claimed no such API
        existed). The 5 raw services/topics an action is actually built from
        (send_goal/cancel_goal/get_result services, feedback/status topics)
        are filtered out of the plain lists below so an action shows up once,
        not 6 times total."""
        action_servers = rclpy.action.get_action_server_names_and_types_by_node(
            self, node_name, node_namespace
        )
        action_clients = rclpy.action.get_action_client_names_and_types_by_node(
            self, node_name, node_namespace
        )
        action_names = {n for n, _ in action_servers} | {n for n, _ in action_clients}
        action_internal_names = {
            f"{action}/_action/{suffix}"
            for action in action_names
            for suffix in ("send_goal", "cancel_goal", "get_result", "feedback", "status")
        }

        ns = node_namespace.rstrip("/")
        node_fqn = f"{ns}/{node_name}" if ns else f"/{node_name}"
        param_service_names = {f"{node_fqn}/{suffix}" for suffix in STANDARD_PARAM_SERVICE_SUFFIXES}

        all_services = self.get_service_names_and_types_by_node(node_name, node_namespace)

        return {
            "publishers": [
                {"topic": t, "types": types}
                for t, types in self.get_publisher_names_and_types_by_node(node_name, node_namespace)
                if t not in action_internal_names
            ],
            "subscribers": [
                {"topic": t, "types": types}
                for t, types in self.get_subscriber_names_and_types_by_node(node_name, node_namespace)
                if t not in action_internal_names
            ],
            "services": [
                {"name": n, "types": types}
                for n, types in all_services
                if n not in action_internal_names and n not in param_service_names
            ],
            "clients": [
                {"name": n, "types": types}
                for n, types in self.get_client_names_and_types_by_node(node_name, node_namespace)
                if n not in action_internal_names
            ],
            "action_servers": [{"name": n, "types": types} for n, types in action_servers],
            "action_clients": [{"name": n, "types": types} for n, types in action_clients],
            "has_parameters": any(n in param_service_names for n, _ in all_services),
        }

    def call_service(
        self,
        node_fqn: str,
        srv_type,
        srv_suffix: str,
        request,
        timeout: float = SERVICE_WAIT_TIMEOUT_SEC,
    ) -> Optional[Any]:
        """Blocking call to `{node_fqn}/{srv_suffix}`. Returns None on timeout
        or if the service never becomes available - callers turn that into a
        clean "unavailable" response rather than hanging."""
        client = self._get_client(node_fqn, srv_type, srv_suffix)

        if not client.wait_for_service(timeout_sec=timeout):
            return None

        future = client.call_async(request)
        done = threading.Event()
        future.add_done_callback(lambda _f: done.set())
        if not done.wait(timeout=timeout):
            return None
        return future.result()

    def _get_client(self, node_fqn: str, srv_type, srv_suffix: str):
        key = (node_fqn, srv_suffix)
        client = self._service_clients.get(key)
        if client is None:
            client = self._create_client_safe(srv_type, f"{node_fqn}/{srv_suffix}")
            self._service_clients[key] = client
        return client

    def _create_client_safe(self, srv_type, service_name: str):
        if self._spin_dispatch is not None:
            return self._spin_dispatch.run(lambda: self.create_client(srv_type, service_name))
        return self.create_client(srv_type, service_name)

    def call_service_dynamic(
        self,
        service_name: str,
        service_type_str: str,
        request_dict: dict,
        wait_timeout: float = SERVICE_WAIT_TIMEOUT_SEC,
        response_timeout: float = SERVICE_RESPONSE_TIMEOUT_SEC,
    ) -> tuple[Optional[dict], Optional[str]]:
        """Dynamic-type counterpart to call_service() - for arbitrary
        services picked off the graph rather than this app's own known
        internal calls. Same dict->typed-message conversion action goals
        already use (set_message_fields), same response->dict conversion
        topic echo already uses (message_to_json_dict). Returns
        (response_dict, error) - error is a plain string for both bad
        request fields and an unavailable/timed-out service, so the route
        layer can turn either into a clean 4xx instead of a 500."""
        srv_cls = get_service(service_type_str)
        request = srv_cls.Request()
        set_message_fields(request, request_dict)

        key = ("__dynamic__", service_name)
        client = self._service_clients.get(key)
        if client is None:
            client = self._create_client_safe(srv_cls, service_name)
            self._service_clients[key] = client

        if not client.wait_for_service(timeout_sec=wait_timeout):
            return None, "service unavailable"

        future = client.call_async(request)
        done = threading.Event()
        future.add_done_callback(lambda _f: done.set())
        if not done.wait(timeout=response_timeout):
            return None, "timed out waiting for response"
        return message_to_json_dict(future.result()), None
