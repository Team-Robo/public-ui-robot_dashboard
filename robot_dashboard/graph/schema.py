import re

from rosidl_runtime_py.utilities import get_message

# Nested message field types come back missing their '/msg/' segment (e.g.
# 'geometry_msgs/Vector3', not 'geometry_msgs/msg/Vector3') and need it
# reinserted before get_message() can resolve them again. Array/sequence
# wrappers ('type[]', 'type[9]', 'sequence<type>', 'sequence<type, 9>')
# are unwrapped first so the inner type can still be recognized as a
# message and recursed into.
_ARRAY_SUFFIX_RE = re.compile(r"^(.*)\[\d*\]$")
_SEQUENCE_RE = re.compile(r"^sequence<(.+?)(?:,\s*\d+)?>$")
_MSG_TYPE_RE = re.compile(r"^[a-zA-Z0-9_]+/[A-Z][a-zA-Z0-9_]*$")

# Real recursion-safety net is the _seen frozenset (catches genuinely
# self-referential message types); this is just a sanity ceiling on top
# of that for pathologically deep-but-non-cyclic nesting, so it can
# afford to be generous - 6 was cutting off legitimate real messages, and
# even 100 levels deep is nowhere near Python's default 1000-frame
# recursion limit.
MAX_SCHEMA_DEPTH = 100

# rosidl_runtime_py reports field types as IDL-normalized names, not the
# .msg-declared ones - empirically verified against real std_msgs types,
# since the two diverge in exactly the places you'd assume they wouldn't:
# bool -> "boolean", byte -> "octet", float32 -> "float", float64 ->
# "double" (char isn't even a distinct string - std_msgs/Char reports
# plain "uint8"). Maps to signallang's type_at() vocabulary (bool/int/
# float/string/array/object); nested messages and unrecognized types
# return None ("no opinion") rather than appearing here.
_ROS_TYPE_NAME = {
    "boolean": "bool",
    "octet": "int",
    "int8": "int",
    "uint8": "int",
    "int16": "int",
    "uint16": "int",
    "int32": "int",
    "uint32": "int",
    "int64": "int",
    "uint64": "int",
    "float": "float",
    "double": "float",
    "string": "string",
    "wstring": "string",
}


def _unwrap(field_type: str) -> tuple[str, str]:
    m = _SEQUENCE_RE.match(field_type)
    if m:
        return m.group(1), "[]"
    m = _ARRAY_SUFFIX_RE.match(field_type)
    if m:
        return m.group(1), "[]"
    return field_type, ""


def _positional_skeleton(type_str: str, _depth: int = 0, _seen: frozenset = frozenset()) -> str:
    """The [[...], [...]] shape a `send [...]`/`msg = [...]` positional
    fill needs for this type - signallang's own rule is that array
    nesting depth mirrors schema nesting depth, with no field-name labels
    inside it (that's the whole point of positional fill), so this shows
    only the innermost leaf names, nested to match. A sub-message field -
    array-of-submessages included, same rule either way, no special case -
    recurses into its own anonymous bracket; a plain leaf just contributes
    its name so you can see which position is which."""
    if _depth > MAX_SCHEMA_DEPTH:
        return "..."
    try:
        msg_cls = get_message(type_str)
    except (ImportError, ValueError, AttributeError, TypeError):
        return "?"
    parts = []
    for name, field_type in msg_cls.get_fields_and_field_types().items():
        inner, suffix = _unwrap(field_type)
        if _MSG_TYPE_RE.match(inner) and inner not in _seen:
            pkg, cls_name = inner.split("/")
            parts.append(_positional_skeleton(f"{pkg}/msg/{cls_name}", _depth + 1, _seen | {inner}))
        else:
            parts.append(name)
    return "[" + ", ".join(parts) + "]"


def _positional_type_skeleton(type_str: str, _depth: int = 0, _seen: frozenset = frozenset()) -> str:
    """Same shape and recursion as _positional_skeleton (same brackets,
    same positions, array-of-submessages recursing anonymously the same
    way) - but each leaf shows its expected value type instead of its
    field name. Genuinely easier to read once you already know which
    position is which from the name-labeled version: "what do I actually
    type here" beats re-deriving it from a field name you might not
    recognize. Uses signallang's own type vocabulary (_ROS_TYPE_NAME) -
    a primitive array field (float64[] data) is a single leaf slot here
    too, shown as "array" (signallang's own value-category name for it),
    not the element type, since positional fill still needs the whole
    array value there, not one element."""
    if _depth > MAX_SCHEMA_DEPTH:
        return "..."
    try:
        msg_cls = get_message(type_str)
    except (ImportError, ValueError, AttributeError, TypeError):
        return "?"
    parts = []
    for _name, field_type in msg_cls.get_fields_and_field_types().items():
        inner, suffix = _unwrap(field_type)
        if _MSG_TYPE_RE.match(inner) and inner not in _seen:
            pkg, cls_name = inner.split("/")
            parts.append(_positional_type_skeleton(f"{pkg}/msg/{cls_name}", _depth + 1, _seen | {inner}))
        elif suffix:
            parts.append("array")
        else:
            parts.append(_ROS_TYPE_NAME.get(inner, inner))
    return "[" + ", ".join(parts) + "]"


def format_message_schema(type_str: str, _prefix: str = "", _depth: int = 0, _seen: frozenset = frozenset()) -> str:
    """Box-drawing field:type tree for a message type - what to put in the
    fake-publisher's base/expressions JSON, without needing `ros2 interface
    show` in a separate terminal. Not a full IDL parser: array-of-message
    fields expand once (suffixed '[]'), self-referential or too-deep types
    stop expanding and show as a plain type name instead of looping.
    `_prefix` is the accumulated connector-guide string from ancestors
    (e.g. "│   " to keep a still-open ancestor branch visible, "    " once
    that ancestor was the last child of its own parent) - same algorithm
    as tfTree.ts's own, just built as a string here instead of React props,
    since there's no root name to print bare the way a TF frame has one."""
    if _depth > MAX_SCHEMA_DEPTH:
        return f"{_prefix}└ ... (nesting too deep, stopped expanding)"
    try:
        msg_cls = get_message(type_str)
    except (ImportError, ValueError, AttributeError, TypeError) as exc:
        return f"{_prefix}<can't resolve '{type_str}': {exc}>"

    lines = []
    items = list(msg_cls.get_fields_and_field_types().items())
    for i, (name, field_type) in enumerate(items):
        is_last = i == len(items) - 1
        branch = "└ " if is_last else "├ "
        child_prefix = _prefix + ("  " if is_last else "│ ")
        inner, suffix = _unwrap(field_type)
        if _MSG_TYPE_RE.match(inner) and inner not in _seen:
            pkg, cls_name = inner.split("/")
            lines.append(f"{_prefix}{branch}{name}{suffix}  ({inner}{suffix})")
            lines.append(
                format_message_schema(f"{pkg}/msg/{cls_name}", child_prefix, _depth + 1, _seen | {inner})
            )
        else:
            lines.append(f"{_prefix}{branch}{name}: {field_type}")
    text = "\n".join(lines)
    if _depth == 0:
        text += f"\n\n[] structure: {_positional_skeleton(type_str)}"
        text += f"\n[] types:     {_positional_type_skeleton(type_str)}"
    return text


class RosSchemaProvider:
    """signallang's SchemaProvider Protocol (fields_at/default_at), backed
    by real ROS2 message reflection - the seam signallang's core is
    designed around, so fake_publisher.py never has to teach the language
    itself about rosidl. Reuses this module's own array/sequence unwrap
    logic rather than duplicating it."""

    def __init__(self, type_str: str):
        self._root_type = type_str

    def _resolve_class(self, path: list):
        msg_cls = get_message(self._root_type)
        for seg in path:
            field_types = msg_cls.get_fields_and_field_types()
            if seg not in field_types:
                raise KeyError(f"no field '{seg}' on {msg_cls.__name__}")
            inner, suffix = _unwrap(field_types[seg])
            if suffix or not _MSG_TYPE_RE.match(inner):
                raise KeyError(f"'{seg}' is not a nested message field")
            pkg, cls_name = inner.split("/")
            msg_cls = get_message(f"{pkg}/msg/{cls_name}")
        return msg_cls

    def fields_at(self, path: list) -> list:
        return list(self._resolve_class(path).get_fields_and_field_types().keys())

    def default_at(self, path: list):
        if not path:
            return self._default_value(get_message(self._root_type))
        parent_cls = self._resolve_class(path[:-1])
        field_types = parent_cls.get_fields_and_field_types()
        leaf_name = path[-1]
        if leaf_name not in field_types:
            raise KeyError(f"no field '{leaf_name}' on {parent_cls.__name__}")
        inner, suffix = _unwrap(field_types[leaf_name])
        if not suffix and _MSG_TYPE_RE.match(inner):
            pkg, cls_name = inner.split("/")
            return self._default_value(get_message(f"{pkg}/msg/{cls_name}"))
        # a leaf field - the generated class's own zero-init constructor
        # value, same "type's raw zero-init, not a semantically sensible
        # value" rule the language spec calls out for `default`.
        return getattr(parent_cls(), leaf_name)

    def type_at(self, path: list) -> str | None:
        """signallang's optional SchemaProvider hook - lets a script's
        field assignment get caught at write time (e.g. a string sent to
        an int field) instead of only surfacing later as a coercion
        crash in _coerce_into. Real rosidl type strings, not Python
        types, so this needs its own primitive-name table rather than
        reusing expr.type_name."""
        if not path:
            return None
        try:
            parent_cls = self._resolve_class(path[:-1])
        except KeyError:
            return None
        field_types = parent_cls.get_fields_and_field_types()
        leaf_name = path[-1]
        if leaf_name not in field_types:
            return None
        inner, suffix = _unwrap(field_types[leaf_name])
        if suffix:
            return "array"
        if _MSG_TYPE_RE.match(inner):
            return None  # a sub-message, not a leaf - no single type
        return _ROS_TYPE_NAME.get(inner)

    def _default_value(self, msg_cls) -> dict:
        instance = msg_cls()
        result = {}
        for name, field_type in msg_cls.get_fields_and_field_types().items():
            inner, suffix = _unwrap(field_type)
            if not suffix and _MSG_TYPE_RE.match(inner):
                result[name] = self._default_value(type(getattr(instance, name)))
            else:
                result[name] = getattr(instance, name)
        return result
