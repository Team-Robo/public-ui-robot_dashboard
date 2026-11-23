import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from rclpy.qos_event import SubscriptionEventCallbacks
from ..json_safe import message_to_json_dict
from rosidl_runtime_py.utilities import get_message

from ..ros_bridge import DashboardRosNode
from ..spin_dispatch import SpinDispatch
from .ros2_hz_probe import Ros2HzProbe, stop_all as stop_all_hz_probes

# TEMPORARY - diagnosing "real ROS data confirmed flowing (matching QoS,
# independent CLI hz all show it), dashboard's own watcher still shows zero
# messages forever" on specific topics (/person_reid/annotated - now
# /perception/debug/person_body/image, /pose/keypoints - now
# /perception/people/poses, /camera/color/image_raw so far - always on the
# LIVE long-running instance, never reproduced yet on a genuinely fresh one
# running identical code) with no root cause found from outside the
# process. Remove once that's actually understood. Reaches
# ~/.dashboard_debug.log via main.py's root logging config (a file
# handler alongside the console one), not a handler of its own here.
_debug_logger = logging.getLogger("robot_dashboard.graph.topic_watcher.DEBUG")

RATE_WINDOW_SEC = 5.0
MAX_TIMESTAMPS = 200
DEFAULT_QOS_DEPTH = 10
ECHO_MAX_RATE_HZ = 5.0
ECHO_MIN_INTERVAL_SEC = 1.0 / ECHO_MAX_RATE_HZ
# Floor between auto-resubscribes triggered by the incompatible_qos event -
# without this, a publisher that's GENUINELY incompatible no matter what we
# pick (e.g. two publishers on one topic offering different, mutually
# exclusive QoS) would otherwise have us tearing the subscription down and
# recreating it in a tight loop every time the event fires again. With a
# properly-compatible matcher this is just a safety net, not the main path.
RESUBSCRIBE_MIN_INTERVAL_SEC = 2.0
# How long after a (re)subscribe the rate limit is suspended - long enough
# for DDS to deliver a burst of retained TRANSIENT_LOCAL samples (one per
# matching writer) without the normal cap collapsing it down to just the
# first one; short enough that a genuinely fast-from-the-start publisher
# only gets this one bounded grace window, not sustained relief.
ECHO_BACKLOG_GRACE_SEC = 2.0
MAX_ARRAY_PREVIEW = 20


def _summarize(value):
    """Keeps echo payloads small and JSON-safe. A raw Image/PointCloud2's
    byte array can be megabytes - dumping that straight to the browser at
    even a throttled rate is exactly the "clogs the bridge" problem this
    workspace's own lidar_filter README already warned about for
    foxglove_bridge. Any array/bytes field over MAX_ARRAY_PREVIEW long is
    replaced with a short preview + the real length, not sent whole."""
    if isinstance(value, dict):
        return {k: _summarize(v) for k, v in value.items()}
    if isinstance(value, bytes):
        return {"__truncated__": True, "length": len(value), "preview": list(value[:MAX_ARRAY_PREVIEW])}
    if isinstance(value, (list, tuple)):
        if len(value) > MAX_ARRAY_PREVIEW:
            return {
                "__truncated__": True,
                "length": len(value),
                "preview": [_summarize(v) for v in value[:MAX_ARRAY_PREVIEW]],
            }
        return [_summarize(v) for v in value]
    return value


@dataclass
class _WatchedTopic:
    subscription: Optional[object] = None
    hz_watcher_count: int = 0
    echo_subscribers: set = field(default_factory=set)
    error: Optional[str] = None
    timestamps: list = field(default_factory=list)
    last_echo_forward: float = 0.0
    # Set whenever the subscription is (re)created - a TRANSIENT_LOCAL
    # publisher's retained sample(s) all arrive in a tight burst right
    # after subscribing (one per matching writer, e.g. one per static
    # transform), which the rate limit below would otherwise flatten down
    # to just the first one, exactly the case this exists to fix.
    subscribed_at: float = 0.0
    # Debounce for auto-resubscribe on incompatible_qos - see
    # RESUBSCRIBE_MIN_INTERVAL_SEC.
    last_resubscribe_at: float = 0.0
    # Guards everything else on this dataclass - the per-message callback is
    # on the hot path, so this is deliberately a separate, finer-grained
    # lock from TopicWatcher._lock (which only guards topic dict
    # membership: does an entry exist at all).
    data_lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def total_watchers(self) -> int:
        return self.hz_watcher_count + len(self.echo_subscribers)


class TopicWatcher:
    """Ref-counted dynamic subscriptions shared by both `hz` (arrival-time
    counting) and `echo` (rate-limited message content) - one real rclpy
    subscription per topic name no matter how many hz-watchers and/or
    echo-subscribers are active on it, torn down only when the last one of
    either kind goes away.

    QoS note carried over from the hz-only version, verified empirically:
    the QoSProfile returned by get_publishers_info_by_topic() must NOT be
    reused as-is (throws "invalid allocator") - only reliability/durability
    are copied, history/depth use our own defaults.

    create_subscription/destroy_subscription are NOT safe to call directly
    from a thread other than the one spinning the executor - an earlier
    version of this docstring claimed otherwise ("verified empirically"),
    which turned out to only have been tested lightly enough to miss a real
    race: concurrent access with spin_once() (which iterates this node's
    subscriptions to build its wait set) doesn't always raise - it can
    silently corrupt the wait set instead, permanently starving a
    subscription's callback with nothing in any log to explain why. Every
    call below goes through SpinDispatch instead - see its own docstring.

    That alone isn't sufficient with a MultiThreadedExecutor - its
    spin_once() dispatches each ready callback to a separate worker thread
    and returns before that callback finishes, so a callback can still be
    mid-flight (or merely queued, not yet started - confirmed via rclpy's
    own source that submitting to the thread pool and recording it as
    pending aren't even atomic with each other) while SpinDispatch destroys
    the very subscription it's using. This is why main.py's node uses
    SingleThreadedExecutor: its spin_once() runs the callback inline, on
    the SAME thread, so it cannot return while a callback is still in
    flight - closing the race by construction instead of trying to detect
    it. This class has no way to enforce that from here; it's a real
    requirement on whatever Executor main.py hands this node to.
    """

    def __init__(self, ros_node: DashboardRosNode, spin_dispatch: SpinDispatch):
        self._node = ros_node
        self._spin_dispatch = spin_dispatch
        self._topics: dict[str, _WatchedTopic] = {}
        # One real `ros2 topic hz` subprocess per topic with >=1 hz watcher -
        # see ros2_hz_probe.py. Guarded by self._lock like _topics.
        self._probes: dict[str, Ros2HzProbe] = {}
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def set_event_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    # -- hz ---------------------------------------------------------------

    def start_hz(self, topic_name: str) -> Optional[str]:
        with self._lock:
            watched = self._get_or_create_locked(topic_name)
            with watched.data_lock:
                watched.hz_watcher_count += 1
                error = watched.error
            if not error and topic_name not in self._probes:
                probe = Ros2HzProbe(topic_name)
                probe.start()
                self._probes[topic_name] = probe
        return error

    def stop_hz(self, topic_name: str) -> None:
        probe = None
        with self._lock:
            watched = self._topics.get(topic_name)
            if watched is None:
                return
            with watched.data_lock:
                watched.hz_watcher_count = max(0, watched.hz_watcher_count - 1)
                last_hz_watcher = watched.hz_watcher_count == 0
            if last_hz_watcher:
                probe = self._probes.pop(topic_name, None)
            self._teardown_if_empty_locked(topic_name, watched)
        if probe is not None:
            probe.stop()

    def shutdown(self) -> None:
        with self._lock:
            probes, self._probes = list(self._probes.values()), {}
        for probe in probes:
            probe.stop()
        stop_all_hz_probes()

    def get_rate(self, topic_name: str) -> dict:
        """`rate_hz` / `sample_count` are THIS process's own subscription (what
        the dashboard received, 5s sliding window). `ros2_hz` is the real
        `ros2 topic hz` figure (see ros2_hz_probe.py), None until its first
        line / when stale; `ros2_error` is set if the CLI couldn't run."""
        watched = self._topics.get(topic_name)
        if watched is None:
            return {"error": "not currently watched"}
        with watched.data_lock:
            if watched.error:
                return {"error": watched.error}
            now = time.monotonic()
            recent = [t for t in watched.timestamps if now - t <= RATE_WINDOW_SEC]
        result: dict = {"rate_hz": None, "sample_count": len(recent)}
        if len(recent) >= 2:
            span = recent[-1] - recent[0]
            result["rate_hz"] = (len(recent) - 1) / span if span > 0 else None
        probe = self._probes.get(topic_name)
        if probe is not None:
            result.update(probe.snapshot())
        return result

    # -- echo ---------------------------------------------------------------

    def subscribe_echo(self, topic_name: str) -> tuple[Optional[asyncio.Queue], Optional[str]]:
        with self._lock:
            watched = self._get_or_create_locked(topic_name)
            # A TRANSIENT_LOCAL (latched) publisher only redelivers its
            # retained sample to a freshly-created subscription, not to one
            # that already exists and has already received it once - the
            # shared-subscription model below (one real rclpy subscription
            # ref-counted across every watcher, efficient for an ordinary
            # continuously-publishing topic) means every echo watcher after
            # the very first would otherwise see nothing at all on a topic
            # like /tf_static. Recreating it in place on every new echo join
            # is cheap and correct for the low-volume, often-one-shot topics
            # this actually matters for; existing watchers keep working
            # through the swap since the callback is rebound to the same
            # _WatchedTopic object, not a fresh one.
            if watched.subscription is not None and self._is_transient_local(topic_name):
                self._subscribe_locked(topic_name, watched)
        with watched.data_lock:
            if watched.error:
                return None, watched.error
            # Bounded + drop-oldest-on-full: a slow/disconnecting websocket
            # consumer must never make the subscription callback block or
            # back up memory.
            queue: asyncio.Queue = asyncio.Queue(maxsize=10)
            watched.echo_subscribers.add(queue)
        return queue, None

    def unsubscribe_echo(self, topic_name: str, queue: asyncio.Queue) -> None:
        with self._lock:
            watched = self._topics.get(topic_name)
            if watched is None:
                return
            with watched.data_lock:
                watched.echo_subscribers.discard(queue)
            self._teardown_if_empty_locked(topic_name, watched)

    # -- shared subscription management --------------------------------------

    def _get_or_create_locked(self, topic_name: str) -> _WatchedTopic:
        """Caller holds self._lock."""
        existing = self._topics.get(topic_name)
        if existing is not None:
            return existing

        type_name = self._resolve_type_name(topic_name)
        if type_name is None:
            watched = _WatchedTopic(error="topic not currently on the graph")
            self._topics[topic_name] = watched
            return watched

        try:
            msg_class = get_message(type_name)
        except (ImportError, ValueError, AttributeError) as exc:
            watched = _WatchedTopic(error=f"can't resolve message type '{type_name}': {exc}")
            self._topics[topic_name] = watched
            return watched

        watched = _WatchedTopic()
        self._subscribe_locked(topic_name, watched, msg_class)
        self._topics[topic_name] = watched
        return watched

    def _subscribe_locked(self, topic_name: str, watched: "_WatchedTopic", msg_class=None) -> None:
        """Caller holds self._lock. (Re)creates the underlying rclpy
        subscription, rebinding the callback to THIS _WatchedTopic object
        so existing echo/hz watchers keep working across a resubscribe
        (see subscribe_echo()'s transient-local handling above) - not just
        used at first-creation time."""
        if watched.subscription is not None:
            # run() blocks until the spin thread has actually executed the
            # lambda, so watched.subscription is still valid at that point
            # regardless - captured into a local anyway so correctness here
            # doesn't depend on the reader tracing through run()'s blocking
            # semantics to confirm the assignment below hasn't raced it.
            old_subscription = watched.subscription
            self._spin_dispatch.run(lambda: self._node.destroy_subscription(old_subscription))
            watched.subscription = None
        watched.subscribed_at = time.monotonic()

        if msg_class is None:
            type_name = self._resolve_type_name(topic_name)
            try:
                msg_class = get_message(type_name)
            except (ImportError, ValueError, AttributeError, TypeError) as exc:
                watched.error = f"can't resolve message type '{type_name}': {exc}"
                return

        qos = self._matching_qos(topic_name)
        _debug_logger.warning(
            "SUBSCRIBE topic=%s msg_class=%s qos=(reliability=%s durability=%s depth=%s)",
            topic_name, msg_class, qos.reliability, qos.durability, qos.depth,
        )

        _msg_count = 0

        def _on_message(msg, _watched=watched):
            nonlocal _msg_count
            _msg_count += 1
            if _msg_count <= 5 or _msg_count % 20 == 0:
                _debug_logger.warning(
                    "ON_MESSAGE topic=%s count=%d thread=%s",
                    topic_name, _msg_count, threading.current_thread().name,
                )
            now = time.monotonic()
            should_forward = False
            subscribers_snapshot: list = []
            with _watched.data_lock:
                _watched.timestamps.append(now)
                if len(_watched.timestamps) > MAX_TIMESTAMPS:
                    _watched.timestamps.pop(0)
                in_backlog_grace = (now - _watched.subscribed_at) < ECHO_BACKLOG_GRACE_SEC
                if _watched.echo_subscribers and (in_backlog_grace or now - _watched.last_echo_forward >= ECHO_MIN_INTERVAL_SEC):
                    _watched.last_echo_forward = now
                    should_forward = True
                    subscribers_snapshot = list(_watched.echo_subscribers)
            # Message-to-dict conversion happens OUTSIDE the lock - it's the
            # most expensive part of this callback, no reason to hold up
            # timestamp recording (used by every hz-watcher too) for it.
            if should_forward and self._loop is not None:
                payload = _summarize(message_to_json_dict(msg))
                self._loop.call_soon_threadsafe(self._dispatch_echo, subscribers_snapshot, payload)

        def _on_incompatible_qos(status, _topic=topic_name, _watched=watched):
            # Fires on the executor thread, same as _on_message - and we're
            # about to destroy/recreate the very subscription this callback
            # belongs to, which isn't safe to do reentrantly from inside its
            # own event callback (and, under the SingleThreadedExecutor drain
            # model, SpinDispatch.run() from the spin thread would deadlock).
            # Debounce, then hand off to the asyncio loop (matching every
            # other rclpy->asyncio handoff in this module) rather than acting
            # inline here - _resubscribe() re-runs on a thread-pool thread,
            # not the spin thread.
            now = time.monotonic()
            with _watched.data_lock:
                if now - _watched.last_resubscribe_at < RESUBSCRIBE_MIN_INTERVAL_SEC:
                    return
                _watched.last_resubscribe_at = now
            self._node.get_logger().warning(
                f"{_topic}: requested QoS incompatible with a current publisher "
                f"(policy={status.last_policy_kind}, total={status.total_count}) - "
                "re-subscribing to match its currently-offered QoS")
            if self._loop is not None:
                self._loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(self._resubscribe(_topic)))

        event_callbacks = SubscriptionEventCallbacks(incompatible_qos=_on_incompatible_qos)
        try:
            watched.subscription = self._spin_dispatch.run(
                lambda: self._node.create_subscription(
                    msg_class, topic_name, _on_message, qos, event_callbacks=event_callbacks)
            )
            _debug_logger.warning("SUBSCRIBE_OK topic=%s subscription=%r", topic_name, watched.subscription)
        except Exception as exc:  # noqa: BLE001 - surface any rcl failure as a clean error, not a 500
            watched.error = f"failed to subscribe: {exc}"
            _debug_logger.warning("SUBSCRIBE_FAILED topic=%s exc=%r", topic_name, exc)

    async def _resubscribe(self, topic_name: str) -> None:
        """Re-run _subscribe_locked against whatever QoS the topic's
        publisher(s) currently offer - self-heal for the dashboard's OWN
        watcher subscription (see _on_incompatible_qos above), not something
        that can fix a genuine mismatch between two OTHER nodes (DDS QoS is
        immutable once an endpoint exists on either side; that needs a real
        code fix + restart on whichever node owns the wrong one)."""
        def _do():
            with self._lock:
                watched = self._topics.get(topic_name)
                if watched is None:
                    return
                self._subscribe_locked(topic_name, watched)
        await asyncio.to_thread(_do)

    def _is_transient_local(self, topic_name: str) -> bool:
        return any(
            info.qos_profile.durability == DurabilityPolicy.TRANSIENT_LOCAL
            for info in self._node.get_publishers_info_by_topic(topic_name)
        )

    @staticmethod
    def _dispatch_echo(subscribers: list, payload) -> None:
        for queue in subscribers:
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass  # slow consumer - drop rather than block or grow unbounded

    def _teardown_if_empty_locked(self, topic_name: str, watched: _WatchedTopic) -> None:
        """Caller holds self._lock. Re-checks watcher count under
        data_lock in case something started watching again in between."""
        with watched.data_lock:
            if watched.total_watchers > 0:
                return
            subscription = watched.subscription
        if subscription is not None:
            self._spin_dispatch.run(lambda: self._node.destroy_subscription(subscription))
        del self._topics[topic_name]

    def _resolve_type_name(self, topic_name: str) -> Optional[str]:
        for name, types in self._node.get_topic_names_and_types():
            if name == topic_name:
                return types[0] if types else None
        return None

    def _matching_qos(self, topic_name: str) -> QoSProfile:
        """Resolve a subscriber QoSProfile compatible with EVERY current
        publisher on the topic, not just the first one.

        Why not mirror infos[0] (the old _compatible_qos): with several
        publishers on one topic offering different QoS, infos[0] is arbitrary
        (get_publishers_info_by_topic does not guarantee a stable order) and
        can pick one whose QoS is incompatible with, or simply not shared by,
        the rest - leaving a subscriber that silently receives nothing from
        the publishers it actually cares about. Note also the QoSProfile
        returned in publisher info must NOT be reused/assigned wholesale - it
        throws "invalid allocator"; only policy values (reliability,
        durability) are copied here, history/depth use our own defaults.

        Resolution is a monotonic join, same shape for both policies -
        compatibility (per ros_bridge.py's own _qos_incompatible, the
        authority this mirrors) requires the SUBSCRIBER's policy to be no
        STRICTER than what a publisher offers:
          * sub=RELIABLE is compatible ONLY with pub=RELIABLE (a BEST_EFFORT
            publisher makes no reliability guarantee to keep, so a RELIABLE
            request against it is incompatible - confirmed against
            _qos_incompatible's own check, not assumed). sub=BEST_EFFORT is
            compatible with EITHER. So: request RELIABLE only if EVERY
            current publisher offers RELIABLE, else BEST_EFFORT - matching
            the most publishers, never zero. Getting this backwards (asking
            RELIABLE unconditionally) would make the dashboard's own
            subscriber permanently incompatible with any BEST_EFFORT
            publisher - exactly the common case for the large/frequent image
            topics this workspace already deliberately set to BEST_EFFORT
            (/camera/color/image_raw, /person_reid/annotated) - and given
            _on_incompatible_qos re-runs this same resolution on every
            mismatch, that mistake would resubscribe in an infinite loop
            every RESUBSCRIBE_MIN_INTERVAL_SEC, never actually receiving
            anything, rather than fixing the topic it was meant to fix.
          * sub=VOLATILE is compatible with EITHER durability; sub=
            TRANSIENT_LOCAL only with pub=TRANSIENT_LOCAL. Request
            TRANSIENT_LOCAL only if EVERY publisher offers it (so a
            latched-only topic like /tf_static still gets its retained
            history, matching _is_transient_local's re-subscribe logic
            elsewhere), else VOLATILE.
        A mixed topic (some publishers stricter than others) is pathological
        and rare either way; staying at the permissive end matches the most
        publishers, and incompatible_qos then spotlights whichever one is
        still genuinely lost rather than losing all of them.
        """
        infos = self._node.get_publishers_info_by_topic(topic_name)
        if infos:
            reliabilities = {info.qos_profile.reliability for info in infos}
            reliability = (
                ReliabilityPolicy.RELIABLE
                if reliabilities == {ReliabilityPolicy.RELIABLE}
                else ReliabilityPolicy.BEST_EFFORT
            )
            durabilities = {info.qos_profile.durability for info in infos}
            durability = (
                DurabilityPolicy.TRANSIENT_LOCAL
                if durabilities == {DurabilityPolicy.TRANSIENT_LOCAL}
                else DurabilityPolicy.VOLATILE
            )
        else:
            reliability = ReliabilityPolicy.RELIABLE
            durability = DurabilityPolicy.VOLATILE
        return QoSProfile(
            reliability=reliability,
            durability=durability,
            history=HistoryPolicy.KEEP_LAST,
            depth=DEFAULT_QOS_DEPTH,
        )
