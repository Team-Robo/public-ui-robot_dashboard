from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


class ProcessState(str, Enum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    FAILED = "failed"
    EXITED = "exited"


class FlagOptionConfig(BaseModel):
    """One choice in a `select`-type flag (see FlagConfig.type). `arg` is
    appended verbatim when that option is chosen. A "None" (pass nothing)
    state is implied by the UI for every select flag - it is NOT an option
    here, so there's never an explicit "no flag" entry to manage."""

    name: str
    label: str
    arg: str


class FlagConfig(BaseModel):
    """A flag widget in the Control tab, generalized from the old toggle-only
    checkbox. `type` decides the widget:
      * toggle (default): on/off checkbox/button. `arg` is appended to the
        ros2 run/launch command verbatim when checked - e.g. arg="debug:=true"
        for a `ros2 launch` boolean argument, or a plain "--foo" for a
        `ros2 run` CLI flag. Only "append when checked" is supported (not a
        true/false toggle pair) - that covers the normal case (a launch arg's
        own XML default is the "off" state) without needing two templates.
      * select: dropdown with an implicit "None" (nothing passed) plus the
        configured options. The chosen option's `arg` is appended verbatim
        (e.g. `device` -> None / cpu / gpu). `arg` on the flag itself is
        unused here - options carry their own.
      * text: free-text input, blank (nothing passed) unless the operator
        types something. `arg` is a TEMPLATE containing the literal token
        `{value}`, replaced with whatever was typed before being appended -
        e.g. arg="-p rate_hz:={value}" with "5.0" typed becomes
        "-p rate_hz:=5.0". `options` is unused. `placeholder` (optional) is
        shown as the input's hint text in the Control tab.
    `name` is what the UI sends as the selected flag; a select OR text flag
    also sends its value (the chosen option's name, or the typed text) via
    StartRequest.flag_values.

    `label` is optional and, when set, shown next to the widget - a toggle
    needs it (it's the button's own text, falls back to `name` if blank
    since a blank button isn't usable) but a select's own options are
    usually self-explanatory enough on their own, and a text flag already
    has `placeholder` doing that job - leave it unset there rather than
    forcing a redundant caption."""

    name: str
    label: Optional[str] = None
    arg: Optional[str] = None
    type: Literal["toggle", "select", "text"] = "toggle"
    options: list[FlagOptionConfig] = Field(default_factory=list)
    placeholder: Optional[str] = None


class TargetConfig(BaseModel):
    id: str
    label: str
    category: str
    kind: Literal["run", "launch", "windows"]
    # Required for run/launch (a ROS2 package name); meaningless for
    # windows, which runs a plain command on the native Windows companion
    # instead of `ros2 run`/`ros2 launch` - see build_command().
    package: Optional[str] = None
    executable: Optional[str] = None
    launch_file: Optional[str] = None
    # kind: windows only - the command to hand the companion's
    # /processes/<id>/start, e.g. ["powershell.exe", "-Command", "..."].
    cmd: Optional[list[str]] = None
    args: list[str] = Field(default_factory=list)
    flags: list[FlagConfig] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    cwd: Optional[str] = None
    autostart: bool = False
    # Opt-in readiness probe: a fully-qualified ROS2 node name (e.g.
    # "/person_pose_python", check with `ros2 node list` once the target is
    # actually running by hand) - when set, the supervisor holds the
    # target at STARTING and polls the ROS graph for this name instead of
    # reporting RUNNING the instant the process spawns. Unset (the
    # default) keeps the old immediate-RUNNING behavior unchanged - there's
    # no reliable general way to infer a node's real registered name from
    # its executable/package alone (remapping, multi-node launch files),
    # so this stays per-target and explicit rather than guessed.
    ready_node_name: Optional[str] = None
    ready_timeout_sec: float = 10.0
    # Optional boolean precondition the target must satisfy before it will
    # start (evaluated at the start-gate, never a runtime lease). Not a flat
    # list of target ids - an expression tree over the predicate vocabulary in
    # supervisor/conditions.py (`all`/`any`/`not` + target/node/topic/service/
    # action/device/file/env/platform/usb/custom leaves). Example:
    #   requires:
    #     all:
    #       - target: webcam_publisher
    #       - any: [{device: /dev/video0}, {usb: 30c9:009f}]
    # Validated at config load (shape + target-id existence). Cyclic
    # references are allowed/get left alone - only cyclic *opening* is
    # prevented, by the dependency closure's visited-set (see
    # ProcessManager.dependency_closure). See conditions.py for the full
    # vocabulary.
    requires: Optional[dict] = None
    # Declared, not inferred from `category` (a plain free-form display
    # label everywhere else - overloading it with e-stop semantics would
    # be an easy-to-forget landmine). Default False: e-stop hits
    # everything unless a target explicitly opts out. Meant for things
    # that can't hurt anyone and you want to keep watching the robot
    # through even after an e-stop - foxglove_bridge, rviz2 - not for
    # anything that could still move the robot.
    estop_exempt: bool = False


class TargetStatus(BaseModel):
    id: str
    label: str
    category: str
    kind: Literal["run", "launch", "windows"]
    state: ProcessState
    pid: Optional[int] = None
    exit_code: Optional[int] = None
    # Flag *definitions* (what checkboxes to render), not which were
    # actually used to start the currently-running process - the frontend
    # only needs to disable them while running, not reconstruct history.
    flags: list[FlagConfig] = Field(default_factory=list)
    # The required platform string (e.g. "wsl") if this target's `requires`
    # unambiguously needs a platform this dashboard_server can never
    # satisfy this session - see conditions.platform_lockout(). None means
    # not locked out (may still have an ordinary unmet `requires`, handled
    # by the normal dependency-dialog flow instead). The frontend hides a
    # locked-out target from the list entirely rather than showing it
    # disabled - it structurally cannot ever start here, not just "not yet".
    platform_locked_out: Optional[str] = None
    # A pid recorded (pid_registry.py) as still alive under this target_id
    # from a PREVIOUS dashboard_server run that never went through stop() -
    # not something THIS instance is managing (no Popen behind it). None
    # means no known orphan for this target. See ProcessManager.status().
    orphan_pid: Optional[int] = None
