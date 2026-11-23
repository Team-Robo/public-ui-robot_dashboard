"""Boolean condition engine for target dependencies.

Dependencies are expressed as an expression tree over a pluggable set of
atomic predicates (the "vocabulary"), in the same shape as JSON Schema's
`allOf` / `anyOf` / `not` - so a `requires` entry is *not* a flat list of
target ids, it's a composable boolean condition:

    requires:
      all:
        - target: webcam_publisher
        - any:
            - device: /dev/video0
            - usb: 30c9:009f
        - not:
            - platform: windows

Leaves are single-key dicts (`{kind: arg}`). Compound nodes are `all` /
`any` (a list of sub-expressions) and `not` (a list treated as `all`, then
negated). Every predicate resolves to `EvalResult(ok, reason)`, where
`reason` is human prose so the caller can show the user *which* leaf failed
- the explanation is at least as useful as the boolean for a dialog.

This module is deliberately transport-free: it takes an `EvalContext` of
callables (target state, ROS graph lookups, platform, custom command
runner) so the exact same engine works headless in tests, from the
ProcessManager's start-gate, and from an HTTP route. The importable
surface is: `evaluate`, `validate`, `collect_target_ids`,
`platform_lockout`, `EvalContext`, `EvalResult`, `ConditionError`,
`DependencyNotMet`.

Predicate vocabulary (kind -> arg -> true when):

    target   :target_id        the named managed target is RUNNING
    node     :/fq_name         a ROS node is on the graph
    topic    :/name            the topic has >=1 publisher (active)
    service  :/name            a ROS service is on the graph
    action   :/name            a ROS action is on the graph
    device   :/dev/video0      the path exists (no ~ expansion)
    file     :/path            the path exists (~ expanded)
    env      :KEY | KEY=val    env var set, or set to that value
    platform :wsl|native|linux|windows   matches the current platform
    usb      :vid:pid          a USB device with that VID:PID is attached to WSL
    custom   :{cmd:[...], timeout:N}     a command whose exit 0 == true
    flag     :flag_name        THIS target's own flag_name is currently selected
                                for the start being evaluated (not a different
                                target's flag - see note below)

`flag:` is deliberately scoped to "the target whose `requires` this leaf
lives in" - there's no cross-target flag syntax, because a flag only means
something in the context of the specific start it's about to apply to.
It's the tool for making a *dependency conditional on an option*, e.g. "if
I'm about to be started with use_real_person_face on, then also
require the whole identity pipeline, otherwise don't":

    requires:
      any:
        - not: {flag: use_real_person_face}
        - all:
            - target: person_face
            - target: person_body

Evaluated only where the caller actually knows which flags are about to be
used for this specific start (ProcessManager.start/start_with_dependencies,
and the dependency pre-check route, which now takes the in-progress flag
selection so the dialog reflects it before the operator even clicks Start).
Anywhere a `requires` expression is evaluated without that context (e.g.
resolving a *nested* dependency's own flag-gated requires two hops deep,
where its planned flags aren't known yet), `flag:` reads as not-selected -
same conservative default the rest of this module uses for "unknowable
here" (see EvalContext's docstring).

Usage guidance
--------------
`requires` should describe things that SHOULD ALL be true before you start
the target - a mix of "this target is running" and "this device is present".
Prefer `target:` leaves for anything the dashboard can start: auto-start
("Start dependencies too") only ever starts `target:` ids, and it does so in
dependency order. A non-target leaf (`device:`/`file:`/`topic:`/`usb:`/
`custom:`...) is a *prerequisite that must already hold*: it is reported in
the prompt's reason, but it never blocks or refuses the target starts - the
solver doesn't know the consequence of starting a target (it might create the
device, or not), so it gathers the startable targets and leaves the rest to
the operator (the "Start this anyway" / manual step). For a `topic:`, either
require it to be live before start, or depend on the target that publishes it
instead. `custom:` is the escape hatch for "some script must have succeeded".
"""

import glob
import os
import subprocess
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set

# Python 3.10 doesn't have a great Set[str]-typed alias; keep it plain.
StrSet = set


class ConditionError(ValueError):
    """A malformed `requires` expression (bad shape, unknown kind, bad arg)."""


class DependencyNotMet(ValueError):
    """A start was requested but its `requires` condition evaluated false and
    the caller did not ask to ignore dependencies - OR a dependency chain
    aborted while opening. Carries `.reason`, the set of managed-target ids
    involved, and `.kind`, so the UI can tell the two failure modes apart:

      'precondition'  -> a node's condition isn't met (target dep down, or a
                         non-target prerequisite that didn't settle) - show the
                         dependency prompt (pass it / start them too / cancel).
      'spawn_failure' -> a node in the chain failed to actually come up - show
                         the chain-failure popup (retry / stop all / cancel);
                         the toast independently reports the crashed node.
    """

    def __init__(self, target_id: str, reason: str, missing_targets: StrSet, kind: str = "precondition"):
        super().__init__(f"target '{target_id}': dependencies not met: {reason}")
        self.target_id = target_id
        self.reason = reason
        self.missing_targets = missing_targets
        self.kind = kind


@dataclass
class EvalResult:
    ok: bool
    reason: str
    # Managed targets referenced by `target:` leaves that are currently NOT
    # running - the set the caller can offer to auto-start ("Start them too").
    missing_targets: StrSet = field(default_factory=set)

    def __bool__(self):  # convenience: `if evaluate(...)`
        return self.ok


@dataclass
class EvalContext:
    """All outer-world lookups, injected so this module stays headless.

    Every provider defaults to None; a predicate that needs an unavailable
    provider reports `ok=False, reason='<kind> not evaluable here'` rather
    than raising, so a missing resolver degrades to "unsatisfied" not a 500.
    """

    target_running: Optional[Callable[[str], bool]] = None
    node_exists: Optional[Callable[[str], bool]] = None
    topic_active: Optional[Callable[[str], bool]] = None
    service_exists: Optional[Callable[[str], bool]] = None
    action_exists: Optional[Callable[[str], bool]] = None
    platform: Optional[str] = None  # "wsl" | "native" | <free-form>
    custom_timeout: float = 5.0
    # The flag names selected for THIS specific start (see `flag:` in the
    # module docstring) - None (the default) means "not evaluable here",
    # which _flag() below treats the same as "not selected" rather than an
    # error, so a requires expression with no flag context just reads its
    # flag: leaves as false instead of raising.
    flag_selected: Optional[Callable[[str], bool]] = None


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------

def evaluate(expr: Any, ctx: Optional[EvalContext] = None) -> EvalResult:
    ctx = ctx or EvalContext()
    if not isinstance(expr, dict) or len(expr) != 1:
        raise ConditionError(f"condition must be a dict with exactly one key, got: {expr!r}")
    kind, arg = next(iter(expr.items()))
    if kind == "all":
        return _all(arg, ctx)
    if kind == "any":
        return _any(arg, ctx)
    if kind == "not":
        return _not(arg, ctx)
    # atomic leaves
    if kind == "target":
        return _target(arg, ctx)
    if kind == "node":
        return _node(arg, ctx)
    if kind == "topic":
        return _topic(arg, ctx)
    if kind == "service":
        return _service(arg, ctx)
    if kind == "action":
        return _action(arg, ctx)
    if kind == "device":
        return _device(arg, ctx)
    if kind == "file":
        return _file(arg, ctx)
    if kind == "env":
        return _env(arg, ctx)
    if kind == "platform":
        return _platform(arg, ctx)
    if kind == "usb":
        return _usb(arg, ctx)
    if kind == "custom":
        return _custom(arg, ctx)
    if kind == "flag":
        return _flag(arg, ctx)
    raise ConditionError(f"unknown predicate kind '{kind}'")


def _require_list(arg, name: str) -> List[Any]:
    if not isinstance(arg, list) or not arg:
        raise ConditionError(f"'{name}' must be a non-empty list of conditions")
    return arg


def _all(arg, ctx: EvalContext) -> EvalResult:
    failed = []
    missing: StrSet = set()
    for sub in _require_list(arg, "all"):
        r = evaluate(sub, ctx)
        missing |= r.missing_targets
        if not r.ok:
            failed.append(r.reason)
    if failed:
        return EvalResult(False, " and ".join(failed), missing)
    return EvalResult(True, "met", missing)


def _any(arg, ctx: EvalContext) -> EvalResult:
    reasons = []
    missing: StrSet = set()
    for sub in _require_list(arg, "any"):
        r = evaluate(sub, ctx)
        if r.ok:
            # If any branch succeeds, offer nothing to auto-start.
            return EvalResult(True, "met", set())
        reasons.append(r.reason)
        missing |= r.missing_targets
    return EvalResult(False, " or ".join(reasons), missing)


def _not(arg, ctx: EvalContext) -> EvalResult:
    normalized = arg if isinstance(arg, list) else [arg]
    inner = _all(normalized, ctx)
    return EvalResult(not inner.ok, f"not({inner.reason})", set())


def _target(arg, ctx: EvalContext) -> EvalResult:
    if ctx.target_running is None:
        return EvalResult(False, f"target '{arg}': target-state lookup unavailable", set())
    try:
        running = bool(ctx.target_running(arg))
    except Exception as exc:  # noqa: BLE001 - don't crash the whole evaluation
        return EvalResult(False, f"target '{arg}': lookup errored: {exc}", set())
    if not running:
        return EvalResult(False, f"target '{arg}' is not running", {arg})
    return EvalResult(True, f"target '{arg}' is running", set())


def _node(arg, ctx: EvalContext) -> EvalResult:
    if ctx.node_exists is None:
        return EvalResult(False, f"node '{arg}': graph lookup unavailable")
    if ctx.node_exists(arg):
        return EvalResult(True, f"node '{arg}' is on the graph")
    return EvalResult(False, f"node '{arg}' not on graph")


def _topic(arg, ctx: EvalContext) -> EvalResult:
    if ctx.topic_active is None:
        return EvalResult(False, f"topic '{arg}': graph lookup unavailable")
    if ctx.topic_active(arg):
        return EvalResult(True, f"topic '{arg}' has a publisher")
    return EvalResult(False, f"topic '{arg}' has no active publisher")


def _service(arg, ctx: EvalContext) -> EvalResult:
    if ctx.service_exists is None:
        return EvalResult(False, f"service '{arg}': graph lookup unavailable")
    if ctx.service_exists(arg):
        return EvalResult(True, f"service '{arg}' is up")
    return EvalResult(False, f"service '{arg}' absent")


def _action(arg, ctx: EvalContext) -> EvalResult:
    if ctx.action_exists is None:
        return EvalResult(False, f"action '{arg}': graph lookup unavailable")
    if ctx.action_exists(arg):
        return EvalResult(True, f"action '{arg}' is up")
    return EvalResult(False, f"action '{arg}' absent")


def _device(arg, ctx: EvalContext) -> EvalResult:
    if os.path.exists(arg):
        return EvalResult(True, f"device '{arg}' present")
    return EvalResult(False, f"device '{arg}' absent")


def _file(arg, ctx: EvalContext) -> EvalResult:
    path = os.path.expanduser(arg)
    if os.path.exists(path):
        return EvalResult(True, f"file '{path}' present")
    return EvalResult(False, f"file '{path}' absent")


def _env(arg, ctx: EvalContext) -> EvalResult:
    if not isinstance(arg, str):
        raise ConditionError("'env' predicate takes a 'KEY' or 'KEY=val' string")
    if "=" in arg:
        key, _, value = arg.partition("=")
        if os.environ.get(key) == value:
            return EvalResult(True, f"env {key}={value}")
        return EvalResult(False, f"env {key} != {value!r}")
    if arg in os.environ:
        return EvalResult(True, f"env {arg} set")
    return EvalResult(False, f"env {arg} unset")


def _platform(arg, ctx: EvalContext) -> EvalResult:
    if ctx.platform is None:
        return EvalResult(False, "platform unknown")
    current = ctx.platform.lower()
    want = arg.lower()
    if want in ("native", "linux") and current == "native":
        return EvalResult(True, f"platform is {current}")
    if want == current:
        return EvalResult(True, f"platform is {current}")
    return EvalResult(False, f"platform is {current}, wanted {want}")


def _usb(arg, ctx: EvalContext) -> EvalResult:
    # No external tooling: read idVendor/idProduct straight out of sysfs.
    vidpid = str(arg).lower().replace(":", "") if arg else ""
    if len(vidpid) != 8 or not vidpid.isdigit() or "e" in vidpid.lower():
        # allow hex; check via int(x,16)
        try:
            int(vidpid, 16)
        except ValueError:
            return EvalResult(False, f"usb '{arg}': expected VID:PID (e.g. 04d8:00aa)")
    hit = False
    for dev in glob.glob("/sys/bus/usb/devices/*"):
        try:
            with open(os.path.join(dev, "idVendor")) as f:
                vid = f.read().strip().lower()
            with open(os.path.join(dev, "idProduct")) as f:
                pid = f.read().strip().lower()
        except (FileNotFoundError, OSError):
            continue
        if vid + pid == vidpid:
            hit = True
            break
    if hit:
        return EvalResult(True, f"usb device {arg} attached")
    return EvalResult(False, f"usb device {arg} not attached")


def _flag(arg, ctx: EvalContext) -> EvalResult:
    if not isinstance(arg, str) or not arg:
        raise ConditionError("'flag' predicate takes a non-empty flag-name string")
    if ctx.flag_selected is None:
        return EvalResult(False, f"flag '{arg}': not selected (no flag context here)")
    try:
        selected = bool(ctx.flag_selected(arg))
    except Exception as exc:  # noqa: BLE001
        return EvalResult(False, f"flag '{arg}': lookup errored: {exc}")
    if selected:
        return EvalResult(True, f"flag '{arg}' is selected")
    return EvalResult(False, f"flag '{arg}' is not selected")


def _custom(arg, ctx: EvalContext) -> EvalResult:
    if isinstance(arg, dict):
        cmd = arg.get("cmd")
        timeout = float(arg.get("timeout", ctx.custom_timeout))
    else:
        cmd, timeout = arg, ctx.custom_timeout
    if not isinstance(cmd, list) or not cmd:
        raise ConditionError("'custom' predicate needs {'cmd': [..], 'timeout': N}")
    try:
        rc = subprocess.run(list(cmd), capture_output=True, timeout=timeout).returncode
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return EvalResult(False, f"custom {cmd}: {exc}")
    if rc == 0:
        return EvalResult(True, f"custom {cmd} -> exit 0")
    return EvalResult(False, f"custom {cmd} -> exit {rc}")


# ---------------------------------------------------------------------------
# static validation + cycle detection (called from config load)
# ---------------------------------------------------------------------------

# Keep in sync with frontend/src/TargetsConfigEditor.tsx's REQUIRES_KINDS -
# that's a client-side mirror of this set (for instant inline validation
# while typing, before the round-trip to validate() here on save). This
# server-side set is still the sole authority actually enforced; the
# frontend copy existing means adding a kind here without updating it
# there only degrades UX (a false "unknown predicate" in the editor, or a
# save-time 400 the editor didn't warn about first), it can't make
# anything unsafe get saved.
_ATOMIC_KINDS = frozenset(
    {"target", "node", "topic", "service", "action", "device", "file", "env", "platform", "usb", "custom", "flag"}
)


def validate(expr: Any, known_target_ids: Optional[Set[str]] = None, known_flag_names: Optional[Set[str]] = None) -> None:
    """Raise `ConditionError` on a bad `requires` expression (shape, unknown
    kind, bad arg). `known_target_ids` optionally restricts `target:` leaves;
    `known_flag_names` optionally restricts `flag:` leaves to the flags
    actually declared on the SAME target this expression belongs to (a
    `flag:` leaf only ever means "this target's own flag" - see the module
    docstring - so the caller should pass that one target's own flag names,
    not the union across every target)."""
    if not isinstance(expr, dict) or len(expr) != 1:
        raise ConditionError(f"condition must be a dict with exactly one key, got: {expr!r}")
    kind, arg = next(iter(expr.items()))
    if kind == "all" or kind == "any":
        if not isinstance(arg, list) or not arg:
            raise ConditionError(f"'{kind}' must be a non-empty list")
        for sub in arg:
            validate(sub, known_target_ids, known_flag_names)
        return
    if kind == "not":
        normalized = arg if isinstance(arg, list) else [arg]
        for sub in normalized:
            validate(sub, known_target_ids, known_flag_names)
        return
    if kind == "target":
        if not isinstance(arg, str) or not arg:
            raise ConditionError("'target' predicate takes a non-empty target_id string")
        if known_target_ids is not None and arg not in known_target_ids:
            raise ConditionError(f"'target' references unknown target_id '{arg}'")
        return
    if kind == "flag":
        if not isinstance(arg, str) or not arg:
            raise ConditionError("'flag' predicate takes a non-empty flag-name string")
        if known_flag_names is not None and arg not in known_flag_names:
            raise ConditionError(f"'flag' references unknown flag '{arg}' (not declared on this target)")
        return
    if kind not in _ATOMIC_KINDS:
        raise ConditionError(f"unknown predicate kind '{kind}'")
    # generic arg sanity for the host/graph atoms
    if kind in ("node", "topic", "service", "action", "device", "file") and (not isinstance(arg, str) or not arg):
        raise ConditionError(f"'{kind}' predicate takes a non-empty string")
    if kind == "platform" and not isinstance(arg, str):
        raise ConditionError("'platform' predicate takes a string")
    if kind == "custom" and not isinstance(arg, (dict, list)):
        raise ConditionError("'custom' predicate takes a {cmd:.., timeout:..} dict or a cmd list")


def iter_leaves(expr: Any):
    """Yield (kind, arg) for every atomic leaf in the expression tree (both
    `target:` and non-target leaves, inside all/any/not). Used to enumerate
    the non-target prerequisites an operator must satisfy themselves."""
    if not isinstance(expr, dict) or len(expr) != 1:
        return
    kind, arg = next(iter(expr.items()))
    if kind == "all" or kind == "any":
        for sub in arg:
            yield from iter_leaves(sub)
    elif kind == "not":
        normalized = arg if isinstance(arg, list) else [arg]
        for sub in normalized:
            yield from iter_leaves(sub)
    else:
        yield (kind, arg)


def platform_lockout(expr: Any, ctx: EvalContext) -> Optional[str]:
    """The required platform string if `expr` unambiguously requires a
    platform this dashboard_server can never satisfy this session, else
    None. `platform:` is the one predicate kind whose truth value is fixed
    for the server's whole lifetime (unlike target:/device:/topic:/etc,
    which could all still become true later) - a target gated on it isn't
    "temporarily unmet," it structurally cannot start here, which is a
    UI-hide decision (see ControlTab.tsx), not just a disabled button.

    Deliberately conservative: only recognizes a bare `{platform: X}` leaf,
    or one directly inside a top-level `all:` - never anything nested
    inside `any:`/`not:`, where another branch could still satisfy the
    overall condition and hiding the target would be wrong. Reuses
    evaluate() for the actual match (native/linux aliasing etc.) rather
    than re-implementing _platform()'s own comparison here."""
    if not isinstance(expr, dict) or len(expr) != 1:
        return None
    kind, arg = next(iter(expr.items()))
    candidates = [expr] if kind == "platform" else (arg if kind == "all" and isinstance(arg, list) else [])
    for leaf in candidates:
        if isinstance(leaf, dict) and len(leaf) == 1 and next(iter(leaf.keys())) == "platform":
            if not evaluate(leaf, ctx).ok:
                return str(next(iter(leaf.values())))
    return None


def collect_target_ids(expr: Any) -> StrSet:
    """Every `target:` id referenced anywhere in the expression tree."""
    found: StrSet = set()
    if not isinstance(expr, dict):
        return found
    kind, arg = next(iter(expr.items()))
    if kind == "target":
        found.add(arg)
    elif kind in ("all", "any"):
        for sub in arg:
            found |= collect_target_ids(sub)
    elif kind == "not":
        normalized = arg if isinstance(arg, list) else [arg]
        for sub in normalized:
            found |= collect_target_ids(sub)
    return found


def detect_cycles(requires: Dict[str, Any]) -> StrSet:
    """Given {target_id: expr}, find the ids participating in a *start-order*
    cycle among the managed `target:` leaves, or return an empty set.

    Informational only - this is NOT enforced at config load. Cyclic
    references (A needs B, B needs A) are legitimate config and are left
    alone; auto-start handles them with a visited-set (see
    ProcessManager.dependency_closure), which resolves to a valid start order
    instead of looping. This exists for diagnostics/UI (e.g. to annotate a
    group of mutually-dependent targets), not to block anything."""
    edges: Dict[str, set] = {tid: collect_target_ids(expr) for tid, expr in requires.items()}
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {tid: WHITE for tid in edges}
    stack: List[str] = []
    on_cycle: StrSet = set()

    def dfs(node: str):
        color[node] = GRAY
        stack.append(node)
        for nxt in edges.get(node, ()):
            if nxt not in color:
                continue  # dependency not a managed target - no start edge
            if color[nxt] == GRAY:
                # found a back-edge: everything from nxt..node is on a cycle
                idx = stack.index(nxt)
                for it in stack[idx:]:
                    on_cycle.add(it)
            elif color[nxt] == WHITE:
                dfs(nxt)
        stack.pop()
        color[node] = BLACK

    for node in edges:
        if color[node] == WHITE:
            dfs(node)
    return on_cycle
