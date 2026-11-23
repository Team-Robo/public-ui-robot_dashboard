"""Refreshes dashboard_server's own os.environ from a fresh `source
install/setup.zsh`, without restarting the process.

Why this exists: this workspace uses colcon's per-package install layout
(install/<pkg>/... , not a merged single prefix), so PATH/PYTHONPATH/
AMENT_PREFIX_PATH/etc. are built by *walking whatever package directories
exist* at the moment something sources install/setup.zsh. dashboard_server's
os.environ is just a snapshot from when it itself started - a package
colcon-built afterward was never in that snapshot, so `ros2 run <newpkg>
...` spawned as its subprocess (see ProcessManager.start(), which builds
each child's env fresh from os.environ on every call) fails to find it,
even though a brand-new terminal that re-sources would see it fine.
Refreshing os.environ in place here fixes that for every *subsequent*
start() - no dashboard_server restart needed. It does NOT help when
dashboard's own already-imported Python code changes; nothing short of an
actual process restart picks that up.
"""

import logging
import os
import shlex
import subprocess
from pathlib import Path

logger = logging.getLogger("robot_dashboard.env_reload")

DEFAULT_RELOAD_INTERVAL_SEC = 300

# Only merge back the keys colcon's setup.zsh actually populates - not the
# subshell's entire environment snapshot, which would also pick up
# zsh/shell-session specifics (PWD, SHLVL, a prompt var, ...) that have
# nothing to do with the ROS overlay and could clobber something
# dashboard_server's own launcher deliberately set.
_ROS_ENV_KEYS = {
    "PATH",
    "PYTHONPATH",
    "AMENT_PREFIX_PATH",
    "CMAKE_PREFIX_PATH",
    "LD_LIBRARY_PATH",
    "COLCON_PREFIX_PATH",
    "ROS_PACKAGE_PATH",
    "PKG_CONFIG_PATH",
}


def workspace_install_setup_path(dashboard_share_dir: str) -> str:
    """dashboard_share_dir is get_package_share_directory("robot_dashboard"),
    e.g. .../install/robot_dashboard/share/robot_dashboard in this workspace's
    per-package layout - three levels up from there is the workspace's
    own install/ root."""
    install_root = Path(dashboard_share_dir).parents[2]
    bash_setup = install_root / "setup.bash"
    zsh_setup = install_root / "setup.zsh"
    if bash_setup.is_file():
        return str(bash_setup)
    return str(zsh_setup)


def reload_ros_environment(install_setup_path: str) -> tuple[bool, list[str]]:
    """Returns (success, changed_keys). Leaves os.environ untouched on
    failure - a stale env beats a half-applied one."""
    if not os.path.isfile(install_setup_path):
        logger.warning("env_reload: %s doesn't exist, skipping", install_setup_path)
        return False, []

    shell = "zsh" if install_setup_path.endswith(".zsh") else "bash"
    try:
        result = subprocess.run(
            [shell, "-c", f"source {shlex.quote(install_setup_path)} && env -0"],
            capture_output=True,
            timeout=30,
            check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("env_reload: sourcing %s failed: %s", install_setup_path, exc)
        return False, []

    new_env: dict[str, str] = {}
    for entry in result.stdout.split(b"\0"):
        if b"=" not in entry:
            continue
        key, _, value = entry.partition(b"=")
        new_env[key.decode(errors="replace")] = value.decode(errors="replace")

    changed = []
    for key in _ROS_ENV_KEYS:
        new_value = new_env.get(key)
        if new_value is not None and new_value != os.environ.get(key):
            os.environ[key] = new_value
            changed.append(key)

    if changed:
        logger.info("env_reload: refreshed %s", changed)
    return True, changed


def start_periodic_reload(
    install_setup_path: str,
    interval_sec: float = DEFAULT_RELOAD_INTERVAL_SEC,
    extra_refresh: "callable | None" = None,
) -> None:
    """Runs forever on a daemon thread - call once from main(). Errors
    inside reload_ros_environment are already caught and logged there, so
    this loop never needs its own try/except to stay alive.

    `extra_refresh` (optional) is a zero-arg callable run on the SAME cadence,
    right after the env refresh - used to re-read the target/tree configs from
    disk (see config_routes.reload_live_config) so a hand-edit to a
    ~/.dashboard_*.yaml outside the Settings GUI gets picked up on the same
    5-minute timer the env refresh already runs on, no restart needed. Its
    exceptions are caught + logged here so it can never kill the loop."""
    import threading
    import time

    def _loop():
        while True:
            time.sleep(interval_sec)
            reload_ros_environment(install_setup_path)
            if extra_refresh is not None:
                try:
                    extra_refresh()
                except Exception:  # noqa: BLE001
                    logger.exception("env_reload: extra_refresh hook failed (continuing)")

    threading.Thread(target=_loop, daemon=True).start()
