from typing import Any, Optional

from rcl_interfaces.msg import ParameterType, ParameterValue
from rcl_interfaces.msg import Parameter as ParameterMsg
from rcl_interfaces.srv import (
    DescribeParameters,
    GetParameters,
    ListParameters,
    SetParameters,
)

from ..ros_bridge import DashboardRosNode

_ARRAY_FIELD_BY_TYPE = {
    ParameterType.PARAMETER_BOOL_ARRAY: "bool_array_value",
    ParameterType.PARAMETER_INTEGER_ARRAY: "integer_array_value",
    ParameterType.PARAMETER_DOUBLE_ARRAY: "double_array_value",
    ParameterType.PARAMETER_STRING_ARRAY: "string_array_value",
}

_SCALAR_FIELD_BY_TYPE = {
    ParameterType.PARAMETER_BOOL: "bool_value",
    ParameterType.PARAMETER_INTEGER: "integer_value",
    ParameterType.PARAMETER_DOUBLE: "double_value",
    ParameterType.PARAMETER_STRING: "string_value",
}


def param_value_to_python(pv: ParameterValue) -> Any:
    if pv.type == ParameterType.PARAMETER_NOT_SET:
        return None
    if pv.type in _SCALAR_FIELD_BY_TYPE:
        return getattr(pv, _SCALAR_FIELD_BY_TYPE[pv.type])
    if pv.type in _ARRAY_FIELD_BY_TYPE:
        return list(getattr(pv, _ARRAY_FIELD_BY_TYPE[pv.type]))
    if pv.type == ParameterType.PARAMETER_BYTE_ARRAY:
        return list(pv.byte_array_value)
    return None


def python_to_param_value(value: Any, type_: int) -> ParameterValue:
    pv = ParameterValue()
    pv.type = type_
    if type_ in _SCALAR_FIELD_BY_TYPE:
        setattr(pv, _SCALAR_FIELD_BY_TYPE[type_], value)
    elif type_ in _ARRAY_FIELD_BY_TYPE:
        setattr(pv, _ARRAY_FIELD_BY_TYPE[type_], list(value))
    elif type_ == ParameterType.PARAMETER_BYTE_ARRAY:
        pv.byte_array_value = bytes(value)
    else:
        raise ValueError(f"unsupported parameter type {type_}")
    return pv


TYPE_NAMES = {
    ParameterType.PARAMETER_NOT_SET: "not_set",
    ParameterType.PARAMETER_BOOL: "bool",
    ParameterType.PARAMETER_INTEGER: "integer",
    ParameterType.PARAMETER_DOUBLE: "double",
    ParameterType.PARAMETER_STRING: "string",
    ParameterType.PARAMETER_BYTE_ARRAY: "byte_array",
    ParameterType.PARAMETER_BOOL_ARRAY: "bool_array",
    ParameterType.PARAMETER_INTEGER_ARRAY: "integer_array",
    ParameterType.PARAMETER_DOUBLE_ARRAY: "double_array",
    ParameterType.PARAMETER_STRING_ARRAY: "string_array",
}


class ParamClientError(Exception):
    """Service was unreachable (node not up / no parameter interface yet)."""


class ParamClient:
    def __init__(self, ros_node: DashboardRosNode):
        self._ros_node = ros_node

    def list_nodes(self) -> list[str]:
        return self._ros_node.list_node_names()

    def list_parameters(self, node_fqn: str) -> list[str]:
        request = ListParameters.Request(prefixes=[], depth=ListParameters.Request.DEPTH_RECURSIVE)
        response = self._ros_node.call_service(node_fqn, ListParameters, "list_parameters", request)
        if response is None:
            raise ParamClientError(f"'{node_fqn}' has no reachable parameter interface")
        return list(response.result.names)

    def describe_and_get(self, node_fqn: str, names: list[str]) -> list[dict]:
        describe_req = DescribeParameters.Request(names=names)
        describe_resp = self._ros_node.call_service(
            node_fqn, DescribeParameters, "describe_parameters", describe_req
        )
        get_req = GetParameters.Request(names=names)
        get_resp = self._ros_node.call_service(node_fqn, GetParameters, "get_parameters", get_req)
        if describe_resp is None or get_resp is None:
            raise ParamClientError(f"'{node_fqn}' has no reachable parameter interface")

        result = []
        for descriptor, value in zip(describe_resp.descriptors, get_resp.values):
            result.append(
                {
                    "name": descriptor.name,
                    "type": TYPE_NAMES.get(value.type, "unknown"),
                    "type_id": value.type,
                    "value": param_value_to_python(value),
                    "read_only": descriptor.read_only,
                    "description": descriptor.description,
                }
            )
        return result

    def get_parameter(self, node_fqn: str, name: str) -> dict:
        results = self.describe_and_get(node_fqn, [name])
        if not results:
            raise ParamClientError(f"'{name}' not found on '{node_fqn}'")
        return results[0]

    def set_parameter(self, node_fqn: str, name: str, value: Any, type_id: int) -> dict:
        param_value = python_to_param_value(value, type_id)
        request = SetParameters.Request(parameters=[ParameterMsg(name=name, value=param_value)])
        response = self._ros_node.call_service(node_fqn, SetParameters, "set_parameters", request)
        if response is None:
            raise ParamClientError(f"'{node_fqn}' has no reachable parameter interface")
        result = response.results[0]
        return {"ok": result.successful, "reason": result.reason}
