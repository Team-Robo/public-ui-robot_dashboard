import concurrent.futures
import queue
from typing import Callable, TypeVar

T = TypeVar("T")

# Generous but bounded - a hang here means the spin thread itself is stuck
# (e.g. wedged inside a misbehaving rclpy call), and the caller (a FastAPI
# request thread, already in asyncio.to_thread) should eventually give up
# and surface an error rather than block the request forever.
RUN_TIMEOUT_SEC = 10.0


class SpinDispatch:
    """Marshals rclpy entity mutations (create_subscription,
    destroy_subscription, create_publisher, destroy_publisher, create_timer,
    destroy_timer, create_client, ...) onto the SAME thread that spins the
    executor - never call these directly from a different thread while
    spin_once() may be running concurrently.

    Confirmed empirically this matters, not just a theoretical concern: a
    FastAPI request thread calling destroy_subscription()/
    create_subscription() concurrently with the executor thread's
    spin_once() (which iterates this node's entities to build its wait set)
    doesn't always raise - sometimes it silently corrupts the wait set
    instead, so the affected subscription (and occasionally an unrelated
    one caught mid-rebuild) never gets its callback scheduled again,
    permanently, with nothing in any log to point at why. That's the same
    underlying race as the InvalidHandle crash main.py's _resilient_spin
    loop already guards against - that fix only stopped the crash from
    killing the spin thread, it never addressed the race itself. This does.

    This alone is NOT sufficient with a MultiThreadedExecutor - see
    main.py's own comment on why the dashboard's node uses
    SingleThreadedExecutor instead. Kept as a separate mechanism anyway
    (rather than folded away) because it's still doing real work: without
    it, create_subscription()/destroy_subscription() would still be called
    directly from FastAPI request threads, racing spin_once()'s own
    wait-set iteration on the spin thread - true regardless of which
    Executor subclass is spinning.

    Usage: call run() from any thread EXCEPT the spin thread itself (a
    timer or subscription callback is already executing ON the spin thread
    during spin_once() - calling run() from inside one would deadlock,
    since drain() only runs BETWEEN spin_once() calls on that same thread;
    such a callback should just call the rclpy method directly, it's
    already safe there). The spin thread calls drain() once per loop
    iteration, strictly outside of spin_once().
    """

    def __init__(self):
        self._queue: "queue.Queue[tuple[Callable[[], object], concurrent.futures.Future]]" = queue.Queue()
        self._executor = None

    def attach_executor(self, executor) -> None:
        """The rclpy Executor whose spin_once() this interleaves with."""
        self._executor = executor

    def run(self, fn: Callable[[], T]) -> T:
        fut: "concurrent.futures.Future[T]" = concurrent.futures.Future()
        self._queue.put((fn, fut))
        if self._executor is not None:
            # Measured, not assumed: this does NOT make an in-progress
            # spin_once() return early in practice. rclpy's own
            # wait_for_ready_callbacks() re-enters its internal wait when a
            # guard condition fires but no actual rclpy entity is ready -
            # and a queued SpinDispatch item isn't a rclpy entity, so it
            # never satisfies that check. Measured a flat ~1000ms per run()
            # call on an otherwise-idle node with the caller's spin_once()
            # at timeout_sec=1.0 - wake() made no difference at all. Kept
            # anyway (harmless, and it's the documented way to signal an
            # entity change to an executor - may help in cases this wasn't
            # measured against) but the real latency bound is whatever
            # timeout_sec the caller's spin_once() uses - see main.py's own
            # comment on why that's short.
            self._executor.wake()
        return fut.result(timeout=RUN_TIMEOUT_SEC)

    def drain(self) -> None:
        """Call ONLY from the spin thread, between spin_once() calls."""
        while True:
            try:
                fn, fut = self._queue.get_nowait()
            except queue.Empty:
                return
            if not fut.set_running_or_notify_cancel():
                continue
            try:
                fut.set_result(fn())
            except Exception as exc:  # noqa: BLE001 - relayed to run()'s caller via fut.exception()
                fut.set_exception(exc)
