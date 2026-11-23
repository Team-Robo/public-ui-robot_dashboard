# Sending an action goal through the dashboard

Graph tab → Actions → expand the action → a JSON textarea (default `{}`)
plus **Send Goal**. Expanding the row starts watching the action's status
topic automatically (even without the sending toggle on) — sending is only
exposed once "advanced: send goals" is on.

## What to type

Just the goal fields, as plain JSON — same rules as
[service-calls.md](service-calls.md) (nested message → nested object,
array of primitives → JSON array, array of submessages → array of objects,
omit a field to keep its zero-value default). No type field, no envelope
around the fields themselves:

```json
{
  "pose": {
    "position": { "x": 1.0, "y": 2.0, "z": 0.0 },
    "orientation": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 }
  }
}
```

Sending returns a `goal_id` (a UUID hex string) — that's what identifies
*this* goal for cancelling it or matching it against the feedback/result
stream.

## Feedback, result, cancellation

Once sent, the dashboard opens a websocket stream scoped to that
`goal_id` and shows feedback/result messages live in the terminal pane —
you don't poll for anything. The stream carries these message shapes:

```json
{"type": "accepted", "ros_goal_id": [ ...16 bytes... ]}
{"type": "feedback", "data": { ...feedback message fields... }}
{"type": "result", "status": 4, "data": { ...result message fields... }}
{"type": "rejected"}
```

`status` in the result message is the standard `action_msgs/GoalStatus`
integer (`4` = SUCCEEDED, `5` = CANCELED, `6` = ABORTED — same codes as
everywhere else in ROS2 actions).

Cancel via the row's Cancel button once a goal is in flight — it calls the
real `cancel_goal_async()` on the goal handle, not a fake/local stop.

## Error responses

Same as services: 404 if the action name isn't on the graph, 400 for a
malformed/mistyped goal field, 504 if the action server didn't respond to
the send-goal request. A `{"type": "rejected"}` on the stream is different
from a 400 — that means the request reached the action server fine, but
the server's own goal-acceptance callback said no.

## Backend reference

`dashboard/graph/routes.py`:
- `POST /api/graph/actions/{action_name:path}/send_goal`, body
  `{"goal": {...}}`, response `{"goal_id": "..."}`.
- `POST /api/graph/actions/{action_name:path}/cancel`, body
  `{"goal_id": "..."}`.
- `WS /api/graph/actions/{action_name:path}/stream?goal_id=...`.

All three delegate to `ActionInvoker` in `dashboard/graph/action_client.py`,
which uses the same `set_message_fields()` mapping as the service-call path
described in [service-calls.md](service-calls.md).
