import asyncio
import logging
import os
import threading
from contextlib import asynccontextmanager

import rclpy
import uvicorn
from ament_index_python.packages import get_package_share_directory
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from rclpy.executors import SingleThreadedExecutor

from .auth import AuthMiddleware, create_auth_router
from .bt.config import load_trees
from .bt.registry import TreeRegistry
from .bt.routes import create_bt_router
from .config_routes import create_config_router, reload_live_config
from .env_reload import reload_ros_environment, start_periodic_reload, workspace_install_setup_path
from .estop import create_estop_router
from .graph.action_client import ActionInvoker
from .graph.fake_publisher import FakePublisher
from .graph.routes import create_graph_router
from .battery import BatteryService, create_battery_router, load_config as load_battery_config
from .graph.topic_watcher import TopicWatcher
from .params.param_client import ParamClient
from .params.routes import create_params_router
from .ros_bridge import DashboardRosNode
from .spin_dispatch import SpinDispatch
from .supervisor.config import load_targets
from .supervisor.process_manager import ProcessManager
from .supervisor.routes import create_events_router, create_orphans_router, create_supervisor_router
from .supervisor.windows_companion_client import detect_platform, ensure_companion_running, reclaim_companion

# File handler at a fixed path outside anything colcon manages (same
# convention as ~/.dashboard_passcode / ~/.dashboard_windows_companion_token)
# alongside the normal console one - dashboard_server is usually started
# directly in a terminal, so its own stdout isn't durably captured
# anywhere by default. Needed while chasing "real ROS data confirmed
# flowing, dashboard's own watcher shows zero forever" - only ever
# reproduced on the LIVE long-running instance, never a fresh one running
# identical code - readable regardless of how the live process was
# launched. TODO: drop the file handler (keep the console one) once that
# investigation is actually closed.
logging.basicConfig(
    level=logging.INFO,
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.expanduser("~/.dashboard_debug.log")),
    ],
)
logger = logging.getLogger("robot_dashboard.main")


def create_app(
    ros_node: DashboardRosNode,
    pm: ProcessManager,
    tree_registry: TreeRegistry,
    install_setup_path: str,
    spin_dispatch: SpinDispatch,
) -> FastAPI:
    topic_watcher = TopicWatcher(ros_node, spin_dispatch)
    action_invoker = ActionInvoker(ros_node)
    battery_service = BatteryService(ros_node, spin_dispatch, load_battery_config())
    # No event loop needed here unlike the other two - FakePublisher's
    # timer callbacks only publish and update in-memory session state,
    # they never push anything across to the asyncio side (status is
    # polled via a plain GET, not streamed).
    fake_publisher = FakePublisher(ros_node, spin_dispatch)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Must happen after uvicorn's event loop is actually running - both
        # ProcessManager and TopicWatcher need it to schedule thread-safe
        # callbacks from background threads (the rclpy executor thread, the
        # subprocess log-reader threads) onto the asyncio loop.
        loop = asyncio.get_running_loop()
        pm.set_event_loop(loop)
        topic_watcher.set_event_loop(loop)
        action_invoker.set_event_loop(loop)
        # Blocks on the spin thread (creating the subscription) and spawns
        # the monitor - keep both off the event loop.
        await asyncio.to_thread(battery_service.start)
        yield
        topic_watcher.shutdown()
        battery_service.shutdown()

    app = FastAPI(title="RoboHome Dashboard", lifespan=lifespan)
    app.add_middleware(AuthMiddleware)

    app.include_router(create_auth_router())
    app.include_router(create_supervisor_router(pm))
    app.include_router(create_orphans_router(pm))
    app.include_router(create_events_router(pm))
    app.include_router(create_params_router(ParamClient(ros_node)))
    app.include_router(create_estop_router(ros_node, pm))
    app.include_router(create_graph_router(ros_node, topic_watcher, action_invoker, fake_publisher))
    app.include_router(create_battery_router(battery_service))
    app.include_router(create_bt_router(tree_registry))
    app.include_router(
        create_config_router(pm, tree_registry, lambda: reload_ros_environment(install_setup_path))
    )

    @app.get("/api/platform")
    async def get_platform():
        # Gated like any other /api/* route (see AuthMiddleware) - only
        # ever needed alongside the target list, which is itself
        # post-login, so no reason to special-case it into the public set.
        return {"platform": detect_platform(), "windows_companion_available": pm.windows_available()}

    @app.post("/api/environment/reload")
    async def reload_environment():
        # Manual trigger (Misc tab) for the same refresh that already
        # happens automatically every 5 min and after every targets/trees
        # save - see env_reload.py's module docstring for why this exists
        # instead of just restarting dashboard_server.
        success, changed_keys = await asyncio.to_thread(reload_ros_environment, install_setup_path)
        return {"success": success, "changed_keys": changed_keys}

    static_dir = os.path.join(get_package_share_directory("robot_dashboard"), "static")
    if os.path.isdir(static_dir):
        # colcon --symlink-install chains index.html/assets through symlinks
        # that point outside static_dir (share dir -> build dir -> src's own
        # frontend/dist) - Starlette's default path-traversal guard treats
        # that as escaping the served root and 404s everything. These
        # symlinks are colcon's own doing, not something to route around;
        # follow_symlink=True is what Starlette added for exactly this.
        app.mount("/", StaticFiles(directory=static_dir, html=True, follow_symlink=True), name="frontend")
    else:
        @app.get("/")
        async def _no_frontend():
            return {
                "detail": "Frontend not built yet - run `npm run build` in "
                "dashboard/frontend and rebuild the package."
            }

    return app


def main():
    rclpy.init()
    spin_dispatch = SpinDispatch()
    ros_node = DashboardRosNode(spin_dispatch)
    ros_node.declare_parameter("host", "0.0.0.0")
    ros_node.declare_parameter("port", 8080)
    host = ros_node.get_parameter("host").value
    port = ros_node.get_parameter("port").value

    share_dir = get_package_share_directory("robot_dashboard")
    targets = load_targets()
    pm = ProcessManager(
        targets,
        node_exists=lambda name: name in ros_node.list_node_names(),
        windows_client=None,
        ros_node=ros_node,
    )
    tree_registry = TreeRegistry(load_trees())

    # Runs on its own thread rather than blocking here - ensure_companion_running
    # can take up to STARTUP_POLL_TIMEOUT_SEC (~15s) cold-starting the companion
    # over the WSL<->Windows interop boundary, and the whole dashboard (every
    # non-Windows target included) has no reason to be unreachable for that
    # long just to find out if Windows-side support exists this session.
    # Best-effort either way: None on a native-Linux robot, or if bootstrapping
    # fails - kind=windows targets stay in the target list either way. A
    # start() that lands before this resolves BLOCKS (up to its own wait
    # timeout) rather than failing on a stale "no client yet" read, then
    # reports FAILED with an explanatory log line once the real answer is
    # in - never silently, and never confusing "still starting" with
    # "never coming up" (see ProcessManager._start_windows).
    def _bootstrap_companion() -> None:
        client = ensure_companion_running(share_dir)
        if client is not None:
            pm.set_windows_client(client)
        else:
            # Must still resolve the pending state even on failure (native
            # platform, or bootstrap genuinely failed) - otherwise a
            # kind=windows start() that arrived while this was in flight
            # blocks in ProcessManager._start_windows for its own full wait
            # timeout instead of failing as soon as the real answer is known.
            pm.set_windows_unavailable()

    threading.Thread(target=_bootstrap_companion, daemon=True).start()

    install_setup_path = workspace_install_setup_path(share_dir)
    # Same periodic timer refreshes BOTH: the ROS environment (install/setup
    # re-source) AND the live target/tree configs from disk - so a hand-edit
    # of ~/.dashboard_{targets,behavior_trees}.yaml is picked up within the
    # same 5-minute cadence, no restart. reload_live_config swallows nothing
    # but has it own error handling inside reload_targets/tree_registry.reload.
    start_periodic_reload(
        install_setup_path,
        extra_refresh=lambda: reload_live_config(pm, tree_registry),
    )

    # SingleThreadedExecutor, NOT MultiThreadedExecutor - deliberate, and
    # not the first thing tried here. MultiThreadedExecutor's spin_once()
    # SUBMITS each ready callback to its own internal ThreadPoolExecutor and
    # returns immediately - it does NOT wait for the callback to finish, and
    # (confirmed straight from rclpy's source, not assumed) the submit-then-
    # append-to-_futures sequence in _spin_once_impl isn't atomic either, so
    # even polling that internal bookkeeping from drain() before destroying
    # anything still left a real, reproducible gap: a worker thread can pick
    # up and start running take_from_wait_list() (which touches the
    # subscription's underlying handle) in the microsecond window before the
    # task is even recorded as pending. Confirmed live with a full traceback
    # (rclpy._rclpy_pybind11.InvalidHandle: cannot use Destroyable because
    # destruction was requested, raised from executors.py's own
    # _take_subscription, called via a worker thread mid-flight) that a
    # concurrent resubscribe stress test still broke topics permanently even
    # with SpinDispatch fully serializing create/destroy against spin_once()
    # AND a lock held around the Python callback's own body AND a wait on
    # MultiThreadedExecutor's private _futures list - none of that closes a
    # race that's baked into rclpy's own submit-before-record ordering, not
    # something pollable from outside it.
    #
    # SingleThreadedExecutor's spin_once() calls the ready callback INLINE,
    # synchronously, on the SAME thread that called spin_once() (confirmed
    # by reading _spin_once_impl - `handler()` called directly, no
    # ThreadPoolExecutor, no submit() at all) - spin_once() cannot return
    # until the callback has FULLY finished. That removes the race by
    # construction: there is no other thread that could ever be touching an
    # entity while it's being destroyed, because nothing runs concurrently
    # with the spin thread anymore. Verified with the same concurrent
    # resubscribe stress test that broke MultiThreadedExecutor - passes
    # cleanly here. Tradeoff: every callback across every subscription/
    # timer/service on this node now runs strictly one at a time instead of
    # in a thread pool - acceptable here since none of this node's callbacks
    # do real work (topic_watcher's is a timestamp + optional dict-format
    # for echo; service calls block the CALLING FastAPI thread on a
    # threading.Event, not an executor callback). If a future callback here
    # ever becomes genuinely slow/blocking, that assumption needs revisiting
    # - it would now stall every other subscription/timer on this node, not
    # just itself.
    executor = SingleThreadedExecutor()
    executor.add_node(ros_node)
    spin_dispatch.attach_executor(executor)

    def _resilient_spin():
        # executor.spin() lets any exception from spin_once() propagate and
        # end the thread's target function - meaning the thread dies
        # permanently on the FIRST one. Originally hit as (and still guards
        # against, belt-and-suspenders) rclpy._rclpy_pybind11.InvalidHandle:
        # cannot use Destroyable because destruction was requested - back
        # when this node used MultiThreadedExecutor, a genuine race between
        # topic_watcher's destroy_subscription() (running on a FastAPI
        # request thread) and this executor thread concurrently mid-
        # processing that same subscription in spin_once(). Once the
        # thread's dead, EVERY topic stops getting ROS callbacks - not just
        # the one subscription involved in the race - which is why this
        # was showing up as "real data confirmed flowing at the ROS level,
        # dashboard shows zero" on completely unrelated topics, permanently,
        # until a full process restart. Looping spin_once() with a catch-
        # and-continue instead of a bare executor.spin() call means one bad
        # iteration logs and moves on, rather than silently ending ROS
        # processing for the rest of this process's life.
        #
        # spin_dispatch.drain() + SingleThreadedExecutor together are the
        # actual fix for the RACE ITSELF (this try/except only ever stopped
        # a crash from being fatal, it never addressed the underlying
        # concurrent access - see the executor construction above for the
        # full story, including why MultiThreadedExecutor plus SpinDispatch
        # alone turned out not to be enough). drain() executes every entity
        # mutation queued by SpinDispatch.run() (topic_watcher, fake_
        # publisher, ros_bridge's dynamic service clients) HERE, strictly
        # between spin_once() calls on this same thread, and
        # SingleThreadedExecutor guarantees nothing else is ever
        # concurrently touching those entities either.
        while rclpy.ok():
            spin_dispatch.drain()
            try:
                # Short on purpose, down from an earlier 1.0 - confirmed by
                # measurement (not guesswork) that SpinDispatch.run()'s own
                # executor.wake() does NOT make spin_once() return early on
                # its own: rclpy's wait_for_ready_callbacks() re-enters its
                # internal wait when a guard condition fires but no actual
                # ROS entity is ready (a queued SpinDispatch item isn't a
                # rclpy entity, so it never satisfies that check) - measured
                # a flat ~1000ms per run() call on an otherwise-idle node
                # with timeout_sec=1.0, i.e. wake() was doing nothing
                # useful here. drain() only ever gets a chance to run once
                # per spin_once() call, so its own poll interval is what
                # actually bounds dispatch latency - 0.1s trades a small,
                # constant amount of extra wake-and-check CPU for an
                # interactive-feels-instant subscribe/unsubscribe from the
                # Graph tab, and also makes shutdown notice rclpy.ok() went
                # false 10x sooner than before.
                executor.spin_once(timeout_sec=0.1)
            except Exception:
                logger.exception(
                    "executor.spin_once() raised - continuing rather than letting "
                    "the ROS spin thread die (see _resilient_spin's own comment)"
                )

    ros_thread = threading.Thread(target=_resilient_spin, daemon=True)
    ros_thread.start()

    app = create_app(ros_node, pm, tree_registry, install_setup_path, spin_dispatch)

    # uvicorn.run(app, ...) (the convenience wrapper) builds its own Server
    # internally and never hands it back - no way to hook anything into its
    # shutdown path. Building the Server ourselves instead lets us wrap
    # handle_exit, the actual method capture_signals() registers via
    # signal.signal() for SIGINT/SIGTERM (confirmed against uvicorn's own
    # source - it does signal.signal(sig, self.handle_exit) per HANDLED
    # signal). Overriding the INSTANCE attribute here means that lookup
    # resolves to our wrapper instead of the class method, so cleanup runs
    # the instant the signal arrives - not after uvicorn.run() has already
    # returned via the finally: block below, which only helps if uvicorn's
    # own graceful shutdown gets to fully complete first. Confirmed that
    # matters: a plain SIGINT was observed NOT even attempting the
    # companion cleanup - something (most likely the parent `ros2 launch`
    # wrapper's own supervision) was tearing things down before the old
    # finally-block path ever ran.
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port))
    original_handle_exit = server.handle_exit

    def _handle_exit_with_companion_cleanup(sig, frame):
        # Best-effort, synchronous, BEFORE anything else - see
        # reclaim_companion()'s own docstring for why this can't just fail
        # silently forever (a wedged companion blocks port 5590 for the
        # next fresh spawn). Then hand off to uvicorn's real handler so its
        # own graceful HTTP shutdown still proceeds exactly as before -
        # this wraps, not replaces, the existing behavior.
        reclaim_companion()
        original_handle_exit(sig, frame)

    server.handle_exit = _handle_exit_with_companion_cleanup

    try:
        server.run()
    finally:
        # executor.shutdown() only requests spin() to stop - without
        # joining, rclpy.shutdown() can tear down the context while the
        # executor thread is still mid-callback, which aborts the process
        # (observed: "terminate called without an active exception" /
        # SIGABRT) instead of exiting cleanly. Join first.
        executor.shutdown()
        ros_thread.join(timeout=2.0)
        ros_node.destroy_node()
        rclpy.shutdown()
        # Redundant with the handle_exit wrapper above on a clean SIGINT/
        # SIGTERM path (reclaim_companion() no-ops harmlessly if it already
        # ran) - kept as a second safety net for any exit path that skips
        # straight here without going through handle_exit at all (e.g. an
        # unhandled exception inside serve()).
        reclaim_companion()


if __name__ == "__main__":
    main()
