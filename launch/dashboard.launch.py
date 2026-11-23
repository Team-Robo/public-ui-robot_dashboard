"""Launches the dashboard server with ~/dashboard-env's site-packages
injected onto PYTHONPATH, so `ros2 launch robot_dashboard dashboard.launch.py`
works without manually exporting PYTHONPATH first - same pattern
person_pose_python uses for its own venv.
"""

import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

DEFAULT_DASHBOARD_ENV_SITE_PACKAGES = os.environ.get(
    "DASHBOARD_ENV_SITE_PACKAGES",
    os.path.expanduser("~/dashboard-env/lib/python3.10/site-packages"),
)


def _launch_setup(context, *args, **kwargs):
    dashboard_env = LaunchConfiguration("dashboard_env_site_packages").perform(context)
    existing_pythonpath = os.environ.get("PYTHONPATH", "")
    env = {}
    if dashboard_env and os.path.isdir(dashboard_env):
        env["PYTHONPATH"] = (
            f"{existing_pythonpath}:{dashboard_env}" if existing_pythonpath else dashboard_env
        )
    elif existing_pythonpath:
        env["PYTHONPATH"] = existing_pythonpath
    # Auth is off unless a passcode is actually supplied - an empty string
    # (the default) must NOT set DASHBOARD_PASSCODE at all, since auth.py
    # treats "unset" and "off" as the same thing but a genuinely-empty env
    # var is a different, unsafe case (would match an empty submitted
    # passcode). See auth.py's PASSCODE line for the matching server-side
    # guard against that.
    passcode = LaunchConfiguration("passcode").perform(context)
    if passcode:
        env["DASHBOARD_PASSCODE"] = passcode

    node = Node(
        package="robot_dashboard",
        executable="dashboard_server",
        output="screen",
        parameters=[
            {
                "host": LaunchConfiguration("host"),
                "port": LaunchConfiguration("port"),
            }
        ],
        additional_env=env,
    )
    return [node]


def generate_launch_description():
    return LaunchDescription(
        [
            DeclareLaunchArgument("host", default_value="0.0.0.0"),
            DeclareLaunchArgument("port", default_value="8080"),
            DeclareLaunchArgument(
                "dashboard_env_site_packages",
                default_value=DEFAULT_DASHBOARD_ENV_SITE_PACKAGES,
            ),
            DeclareLaunchArgument(
                "passcode",
                default_value="",
                description="One-off passcode override, doesn't persist anywhere. "
                "Empty (default) = fall back to ~/.dashboard_passcode if it "
                "exists, else no auth at all. For daily use, write the "
                "passcode to that dotfile once instead of passing this arg "
                "every launch - see README's Auth section.",
            ),
            OpaqueFunction(function=_launch_setup),
        ]
    )
