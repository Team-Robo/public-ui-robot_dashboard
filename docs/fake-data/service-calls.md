# Calling a service through the dashboard

Graph tab → Services → expand the service you want → a JSON textarea
(default `{}`) plus a **Call** button. Type the request fields, hit Call,
the response (or error) shows in the terminal pane below it.

## What to type

Just the request fields, as plain JSON — no envelope, no type field:

```json
{
  "linear": { "x": 0.5, "y": 0.0, "z": 0.0 },
  "angular": { "x": 0.0, "y": 0.0, "z": 0.2 }
}
```

The dashboard already knows the service's type (it discovered it browsing
the graph), so don't include a `type`/`_type` field — it isn't read.

## Field-mapping rules (this is exact, not a guess)

The JSON goes through `rosidl_runtime_py.set_message.set_message_fields` —
a straight, recursive dict → typed-message assignment:

- **Primitive field** (`int32`, `float64`, `string`, `bool`) → JSON
  number/string/boolean directly. `1` and `1.0` both work for a float field.
- **Nested message field** → a nested JSON object with that message's own
  field names, recursively. `geometry_msgs/Twist`'s `linear`/`angular` are
  each `geometry_msgs/Vector3`, so each is `{"x":.., "y":.., "z":..}`.
- **Array/sequence of primitives** → a plain JSON array: `"data": [1, 2, 3]`.
- **Array/sequence of submessages** → a JSON array of objects, each shaped
  like the submessage: `"points": [{"x":1,"y":2,"z":0}, {"x":3,"y":4,"z":0}]`.
- **Field you omit** → keeps the message type's zero-value default (empty
  string, `0`, `false`, empty array) — you don't have to specify every
  field, only the ones that matter for the test.
- **Enum/constant fields** (e.g. a `uint8` status code defined as a
  constant) → just the underlying numeric value, e.g. `"status": 2`, not
  the constant's name.

## Auto-discovery, not something you specify

The dashboard resolves the service's type itself via `list_services()`
against the exact service name — you never provide it. If the service
isn't visible on the graph yet (its server node hasn't started), the call
fails with 404, not a hang.

## Error responses

| HTTP status | Meaning |
| --- | --- |
| 404 | Service name not found on the current ROS2 graph |
| 400 | JSON has an unknown field name, or a value that doesn't fit the field's type (`AttributeError`/`ValueError` from `set_message_fields`) |
| 504 | Service exists on the graph but didn't respond (server not actually up, or hung) |

A 400 almost always means a typo'd field name or the wrong shape (e.g. a
bare number where a nested object was expected) — check the service's
field names via the Graph tab's own tree view for the service, which lists
the real request/response field names and types before you write the JSON.

## Backend reference

`dashboard/graph/routes.py`: `POST /api/graph/services/{service_name:path}/call`,
body `{"request": {...}}`, response `{"response": {...}}`. Delegates to
`call_service_dynamic()` in `dashboard/ros_bridge.py`.
