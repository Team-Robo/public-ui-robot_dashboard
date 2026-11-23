# Publishing a fake topic through the dashboard (signallang)

Graph tab → Publish → fill in the Start form, write a
[signallang](https://github.com/KhiemGOM/signallang) script, hit Start.
This is for *time-varying* fake data — a sensor feed, a status topic
ticking at some rate — not a one-shot message (a one-shot doesn't need a
publisher that keeps running; if you genuinely only need to fire one
message once, a service/action call or a trivial one-line script with no
timer both work, but most real cases here are "publish this at ~Nhz until
stopped").

This page is about **this dashboard's own integration** — how a script's
target topic/type gets resolved, what's dashboard-specific vs. plain
signallang, `.signal` file import/export. For the language itself
(`var`, timers, `Duration`, `terop`, macros, random distributions, `seed`)
read [signallang's own README](https://github.com/KhiemGOM/signallang) —
don't duplicate that knowledge here, it drifts out of date.

## The Start form

- **topic name** — e.g. `/scan`, `/robot/battery_state`. Must start with `/`.
- **message type** — `pkg/msg/Type` form, e.g. `sensor_msgs/msg/LaserScan`,
  `std_msgs/msg/Bool`, `geometry_msgs/msg/Twist`. Typing a type shows a
  live schema hint below the field (real rosidl reflection — the actual
  fields/types that message has, not a guess).
- **script** — the signallang source. A field write like `msg.linear.x =
  0.5;` sets that message field each tick; the schema hint tells you what
  fields exist.

## `extern ros_topic` / `extern ros_schema` — script-authoritative override

A script can declare its own topic/type instead of relying on the form:

```signal
extern ros_topic = "/scan";
extern ros_schema = "sensor_msgs/msg/LaserScan";
```

If present, **the script's own default wins over whatever's typed into the
Start form** — the dashboard resolves these once at Start, and if they
differ from the form's fields, the form's fields get updated to match
afterward (so the UI stays truthful about what's actually running, it
doesn't silently diverge from the script). This matters for a script
that's meant to be portable/self-describing (e.g. exported and handed to
someone else, or imported later) — put the real topic/type in the script
itself rather than relying on whoever runs it to type the right form
values.

If a script declares `extern ros_topic`/`extern ros_schema` with **no**
default (bare `extern ros_topic;`), the Start form's values are used to
supply them — this is the "form is authoritative" case, the mirror image
of the above.

Any other `extern` name beyond these two isn't given a value by the
dashboard — don't invent new extern names expecting the dashboard to fill
them in; only `ros_topic`/`ros_schema` are wired up.

## `.signal` file import/export

**Export .signal** downloads the current script editor contents as a
`<topic-name-or-"script">.signal` file — useful for handing a working
script to someone else, or checking it into a repo as a fixture.
**Import .signal** loads a `.signal` file straight into the script editor
(replacing its contents) — doesn't touch the topic name/type fields
directly; if the imported script has its own `extern ros_topic`/
`extern ros_schema` defaults, those take over at Start time per the rule
above.

## Minimal example

```signal
extern ros_topic = "/battery_status";
extern ros_schema = "std_msgs/msg/Bool";

var tick = 0;

every 1s {
    tick = tick + 1;
    msg.data = tick % 10 == 0;   // simulate a low-battery blip every 10s
}
```

Paste that into the script editor (Start form's topic/type fields can be
left blank — the script's own `extern` defaults supply them), hit Start.

## Backend reference

`dashboard/graph/fake_publisher.py` (`FakePublisher.start()`/`_extern_default()`),
`dashboard/graph/schema.py` (`RosSchemaProvider` — the real-message-reflection
seam signallang's core is built around). Route:
`POST /api/graph/topics/{topic_name}/fake_publish/start`, body
`{"type": "<msg/Type>", "source": "<script text>"}`, response
`{"session_id": ..., "topic": ..., "type": ...}` (topic/type reflect the
resolved values, which may differ from the request body per the `extern`
override rule above).
