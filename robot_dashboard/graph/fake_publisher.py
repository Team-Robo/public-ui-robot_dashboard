import threading
import uuid
from typing import Optional

from signallang import ExprError, ScriptError, compile_script
from signallang import evaluate as _sl_evaluate
from rosidl_runtime_py.utilities import get_message

from .schema import RosSchemaProvider, _MSG_TYPE_RE, _unwrap


def _fqn(name: str) -> str:
    """Same normalization routes.py's own _fqn() does for a topic name
    coming in from the Start form - needed again here since a script's
    own `extern ros_topic = "...";` default is free-text the script
    author typed, with no guarantee of a leading slash. "cmd_vel" and
    "/cmd_vel" must resolve to the same real topic either way."""
    return "/" + name.lstrip("/")

# Guards against an accidental typo (e.g. a stray extra zero on a `send hz`)
# hammering the graph - this is a debug tool, not a real sensor driver. Its
# own ceiling, independent of whatever signallang's package-level default
# happens to be - passed explicitly into compile_script() below.
MAX_RATE_HZ = 50.0


def _array_element_class(msg_cls, field_name: str):
    """The element message class for an array-of-submessages field (e.g.
    tf2_msgs/TFMessage's `transforms` -> geometry_msgs/TransformStamped),
    or None for a plain-value array (a real array field stays a real
    array field, coerced as-is) or an unrecognized/non-array field.
    Reuses schema.py's own array/sequence-unwrap logic rather than
    duplicating it - the two need to agree on what "array of X" means."""
    field_types = msg_cls.get_fields_and_field_types()
    if field_name not in field_types:
        return None
    inner, suffix = _unwrap(field_types[field_name])
    if not suffix or not _MSG_TYPE_RE.match(inner):
        return None
    pkg, cls_name = inner.split("/")
    return get_message(f"{pkg}/msg/{cls_name}")


def _coerce_into(msg, data: dict) -> None:
    """Applies a signallang tick's rendered `{field: value}` dict onto a
    real generated message object, recursively for nested sub-messages
    and for arrays of sub-messages (a plain dict per element, same as a
    single nested field). Same coercion rule the old apply_pattern() used
    for scalars: a generated message's setter asserts-rejects a bare
    float on a bool/int field, so bool is checked before int (bool is an
    int subclass) and a plain float only survives for genuinely
    float-typed fields."""
    for name, value in data.items():
        current = getattr(msg, name)
        if isinstance(value, dict):
            _coerce_into(current, value)
            continue
        if isinstance(value, list):
            elem_cls = _array_element_class(type(msg), name)
            if elem_cls is None:
                # A plain-value array (numbers/strings/bools) - the
                # generated setter accepts the raw list as-is, same as
                # any other scalar-ish field.
                setattr(msg, name, value)
            else:
                items = []
                for item in value:
                    inst = elem_cls()
                    if isinstance(item, dict):
                        _coerce_into(inst, item)
                    items.append(inst)
                setattr(msg, name, items)
            continue
        if isinstance(current, bool):
            coerced = bool(value)
        elif isinstance(current, int):
            coerced = int(round(value))
        elif isinstance(current, str):
            coerced = str(value)
        else:
            coerced = value
        setattr(msg, name, coerced)


def _extern_default(compiled, name: str) -> Optional[str]:
    """A script's own declared default for `extern <name> = expr;`, if
    any - lets a .signal file be self-describing (carry its own intended
    topic/type) rather than always deferring to whatever's currently in
    the Start form. None if the script doesn't declare `name` at all, or
    declares it with no default (fully host-supplied either way, no
    override to apply)."""
    for decl in compiled.externs:
        if decl.name == name and decl.default is not None:
            return str(_sl_evaluate(decl.default.text, {}, compiled.duration_vars))
    return None


class _Session:
    def __init__(self, publisher, topic_name, msg_cls, run) -> None:
        self.publisher = publisher
        self.topic_name = topic_name
        self.msg_cls = msg_cls
        self.run = run
        self.timer = None
        self.current_period: Optional[float] = None
        self.tick_count = 0
        self.last_error: Optional[str] = None
        self.done = False


class FakePublisher:
    """Publishes synthetic messages by driving a compiled signallang
    script's ScriptRun.step() from a real rclpy wall timer - the fake-data
    counterpart to ActionInvoker/TopicWatcher, for testing a subscriber node
    in isolation without its real upstream publisher running.

    signallang's core never touches a real clock (see its own README) -
    step() returns instantly, and a script's `send hz X` can vary the rate
    from one phase to the next. Since an rclpy Timer's period can't be
    changed once created, each tick compares the just-returned hz against
    the timer's current period and only recreates the timer when it
    actually changed - a steady-rate phase (the common case) never touches
    the timer at all, it just keeps firing on its own schedule.
    """

    def __init__(self, node, spin_dispatch) -> None:
        self._node = node
        # Only needed for start()/stop() below - both run on a FastAPI
        # request thread. _retime()/_tick() are timer CALLBACKS, already
        # executing on the spin thread when they run (rclpy fires them from
        # inside spin_once()), so they call create_timer/destroy_timer
        # directly - routing those through the dispatch too would deadlock
        # (run() blocks waiting for drain(), which only runs BETWEEN
        # spin_once() calls on that same thread - a call already inside one
        # can never reach the next drain()). See spin_dispatch.py.
        self._spin_dispatch = spin_dispatch
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.Lock()

    def start(self, topic_name: str, type_str: str, source: str) -> dict:
        # Best-effort discovery pass: a script declaring its own
        # `extern ros_topic = "...";` / `extern ros_schema = "...";`
        # default is being self-describing on purpose - carrying its own
        # intended target instead of always deferring to whatever the
        # Start form currently says. Compiled against the *form's* type
        # (not None) so a script using `default`/positional-fill still
        # discovers cleanly in the common case; any failure here (a
        # genuinely broken script, or one whose fields don't match the
        # form's current type) just means no override was found - the
        # real compile below is what surfaces an actual error to the user.
        effective_topic, effective_type = topic_name, type_str
        try:
            discovery = compile_script(source, schema_provider=RosSchemaProvider(type_str), max_hz=MAX_RATE_HZ)
            effective_topic = _fqn(_extern_default(discovery, "ros_topic") or topic_name)
            effective_type = _extern_default(discovery, "ros_schema") or type_str
        except Exception:  # noqa: BLE001 - discovery is best-effort; the real compile below reports real errors
            pass

        # get_message() raises on a bad type string on its own (ImportError
        # or ValueError) - left uncaught here, same as the original code
        # did for the form's own type_str; routes.py's outer handler
        # already maps those to a 400.
        msg_cls = get_message(effective_type)
        schema_provider = RosSchemaProvider(effective_type)
        external_params = {"ros_topic": effective_topic, "ros_schema": effective_type}

        # Fail fast on a bad script before ever starting a timer - a typo
        # shouldn't silently spin up a publisher that immediately errors on
        # every single tick instead. Compilation alone doesn't evaluate
        # anything (expression leaves stay unparsed source text until
        # render time), so the probe has to actually step() once too - and
        # actually coerce that tick onto a real message object, not just
        # check that signallang's own compile+step succeeded: signallang
        # itself doesn't know or care whether a field name is real, only
        # _coerce_into (via getattr on the generated message class) does.
        # A leading `wait`, if the script has one, reports sent=False/
        # value=None - not a real tick to validate, so the probe steps
        # past any of those to find the first one that actually publishes.
        try:
            compiled = compile_script(source, schema_provider=schema_provider, max_hz=MAX_RATE_HZ)
            probe_run = compiled.new_run(external_params=external_params)
            probe_result = probe_run.step()
            while probe_result is not None and not probe_result.sent:
                probe_result = probe_run.step()
            if probe_result is None:
                raise ValueError("script never sends anything")
            _coerce_into(msg_cls(), probe_result.value)
        except (ScriptError, ExprError, AttributeError, TypeError) as exc:
            raise ValueError(str(exc)) from exc

        publisher = self._spin_dispatch.run(lambda: self._node.create_publisher(msg_cls, effective_topic, 10))
        run = compiled.new_run(external_params=external_params)
        session = _Session(publisher, effective_topic, msg_cls, run)
        session_id = uuid.uuid4().hex
        with self._lock:
            self._sessions[session_id] = session

        # Placeholder period until the first real tick reports its own hz -
        # fast enough that the first message goes out promptly regardless
        # of what the script's actual starting rate turns out to be. This
        # call is start()'s own (FastAPI thread) - goes through the
        # dispatch, unlike _tick()'s calls to the same method below.
        self._spin_dispatch.run(lambda: self._retime(session, 1.0 / MAX_RATE_HZ))
        return {"session_id": session_id, "topic": effective_topic, "type": effective_type}

    def _retime(self, session: _Session, period: float) -> None:
        """Caller must already be on the spin thread - either a timer
        callback (_tick(), already there) or wrapped in
        self._spin_dispatch.run() (start(), on a FastAPI thread)."""
        if session.timer is not None:
            session.timer.cancel()
            self._node.destroy_timer(session.timer)
        session.timer = self._node.create_timer(period, lambda: self._tick(session))
        session.current_period = period

    def _tick(self, session: _Session) -> None:
        try:
            result = session.run.step()
        except (ScriptError, ExprError, KeyError) as exc:  # noqa: BLE001 - keep the session alive, surface via status() instead of killing the timer over one bad tick
            session.last_error = str(exc)
            return

        if result is None:
            session.done = True
            if session.timer is not None:
                session.timer.cancel()
                self._node.destroy_timer(session.timer)
                session.timer = None
            return

        if not result.sent:
            # a `wait` tick - nothing to publish, but it still paces the
            # timer at its own rate (result.hz), same as a real send tick.
            session.last_error = None
            new_period = 1.0 / result.hz
            if session.current_period is None or abs(new_period - session.current_period) > 1e-9:
                self._retime(session, new_period)
            return

        msg = session.msg_cls()
        try:
            _coerce_into(msg, result.value)
        except (AttributeError, TypeError) as exc:
            session.last_error = str(exc)
            return

        session.publisher.publish(msg)
        session.tick_count += 1
        session.last_error = None

        new_period = 1.0 / result.hz
        if session.current_period is None or abs(new_period - session.current_period) > 1e-9:
            self._retime(session, new_period)

    def active_topic_counts(self) -> dict[str, int]:
        """FQN topic -> number of live fake-publish sessions on it right now
        (including a finished-but-not-yet-stopped one - its publisher stays
        registered in the ROS graph until stop() destroys it, same as this
        count should say). A count, not just a bool, since nothing stops
        two sessions running on the same topic at once. Exact, not a
        heuristic - lets the Graph tab flag a topic's publisher as ours by
        asking this instead of guessing from node names, which would
        misfire if the dashboard's own node ever gains an unrelated
        publisher of its own."""
        counts: dict[str, int] = {}
        with self._lock:
            for s in self._sessions.values():
                counts[s.topic_name] = counts.get(s.topic_name, 0) + 1
        return counts

    def status(self, session_id: str) -> Optional[dict]:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        return {"tick_count": session.tick_count, "error": session.last_error, "done": session.done}

    def stop(self, session_id: str) -> bool:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        timer, publisher = session.timer, session.publisher

        def _teardown():
            if timer is not None:
                timer.cancel()
                self._node.destroy_timer(timer)
            self._node.destroy_publisher(publisher)

        self._spin_dispatch.run(_teardown)
        return True
