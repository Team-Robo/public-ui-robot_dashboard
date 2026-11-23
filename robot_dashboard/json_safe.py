import math
from typing import Any

from rosidl_runtime_py.convert import message_to_ordereddict


def sanitize_nonfinite(value: Any) -> Any:
    """NaN/+-inf -> None, recursively. ROS float fields legitimately carry
    NaN ("no depth", "unknown"), but JSON can't - json.dumps raises
    "Out of range float values are not JSON compliant" and FastAPI/the
    websocket send then 500s/drops the whole reply over one bad float."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: sanitize_nonfinite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize_nonfinite(v) for v in value]
    return value


def message_to_json_dict(msg: Any) -> dict:
    """message_to_ordereddict() that's always safe to hand to json.dumps -
    every dashboard path that serializes a ROS message (service replies,
    topic echo, action feedback/result) goes through this."""
    return sanitize_nonfinite(message_to_ordereddict(msg))
