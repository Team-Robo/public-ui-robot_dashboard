import { useEffect, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { api } from './api'
import TerminalPane from './TerminalPane'
import { RESET_CONSOLE_HEIGHTS_EVENT } from './resetConsoleHeights'
import { usePersistentState } from './usePersistentState'
import { signallangSetup } from './signallangLang'

// The editor is the primary side of this row - it's the one that's
// drag-resizable (persisted per tab), and the schema pane just renders at
// whatever height that resolves to instead of setting (or dragging) one
// of its own. Same MIN as TerminalPane's own resize floor, for consistency.
const DEFAULT_EDITOR_HEIGHT_PX = 220
const MIN_EDITOR_HEIGHT_PX = 80

const STATUS_POLL_INTERVAL_MS = 1000
const SCHEMA_FETCH_DEBOUNCE_MS = 400

interface Example {
  label: string
  typeStr: string
  source: string
}

const EXAMPLES: Example[] = [
  {
    label: 'sensor (sine wave)',
    typeStr: 'geometry_msgs/msg/Twist',
    source: 'angular.z = 0.5;\nlinear.x = live { return sin(t); };\nsend hz 10;',
  },
  {
    label: 'succeed, then fail after 4.5s',
    typeStr: 'std_msgs/msg/Bool',
    source: 'data = true;\nsend hz 5 dur 4.5s;\ndata = false;\nsend hz 5 dur inf;',
  },
  {
    label: 'random walk + brownian noise',
    typeStr: 'geometry_msgs/msg/Twist',
    source: 'linear.x = rand_walk!(-1, 1).scale(0.05);\nangular.z = brown_motion!(0, 0.05);\nsend hz 10 dur inf;',
  },
  {
    label: 'macro: ramp up then down',
    typeStr: 'geometry_msgs/msg/Twist',
    source:
      'func ramp(field, from, to, duration) {\n' +
      '    field = live { return linear(_t, from, to, duration); };\n' +
      '}\n\n' +
      'ramp(linear.x, 0, 1, 3s);\n' +
      'send hz 10 dur 3s;\n' +
      'ramp(linear.x, 1, 0, 3s);\n' +
      'send hz 10 dur 3s;',
  },
  {
    label: 'timer + terop mode switch',
    typeStr: 'std_msgs/msg/Bool',
    source: 'var mission = timer();\ndata = live { return terop(mission.s < 3, true, false); };\nsend hz 5 dur inf;',
  },
  {
    label: 'paced bursts (wait)',
    typeStr: 'std_msgs/msg/Bool',
    source:
      'repeat {\n' +
      '    data = true;\n' +
      '    send hz 10 dur 1s;\n' +
      '    wait 500ms;\n' +
      '    data = false;\n' +
      '    send hz 10 dur 1s;\n' +
      '    wait 500ms;\n' +
      '}',
  },
  {
    label: 'cycling status text',
    typeStr: 'std_msgs/msg/String',
    source:
      'repeat {\n' +
      '    data = "phase A";\n' +
      '    send hz 2 dur 1s;\n' +
      '    data = "phase B";\n' +
      '    send hz 2 dur 1s;\n' +
      '    data = "phase C";\n' +
      '    send hz 2 dur 1s;\n' +
      '}',
  },
]

interface Props {
  // Scopes this instance's persisted form to its own tab - siblings never
  // share or clobber each other's topic/type/script.
  tabId: string
  // Lets PublishPanel show a running indicator on this tab's button even
  // while it's not the active one - the whole point of keeping background
  // tabs mounted is running several scripts at once, so which ones are
  // actually live needs to be visible without switching to each in turn.
  onRunningChange?: (running: boolean) => void
}

// One topic per instance, not a per-topic-row control like hz/echo - unlike
// actions/services, the target topic doesn't need to exist yet (that's
// the whole point: feed a subscriber node fake data without its real
// upstream publisher running), so there's no existing row to attach to.
// Self-contained: owns its own session lifecycle including stopping it on
// unmount, same "closed means actually stopped" rule the rest of this tab
// follows for topic hz/echo - this is actively publishing onto the real
// graph, leaving it running behind a closed sub-tab would be worse than a
// leaked subscription. PublishPanel keeps every open sub-tab's instance
// mounted (just hidden via CSS when not the active one) specifically so
// this unmount-means-stop rule only fires on a real close, not a tab
// switch - a script publishing to /tf shouldn't stop just because you
// clicked over to look at /cmd_vel's tab.
export default function PublishInstance({ tabId, onRunningChange }: Props) {
  // Persisted, not session state - the whole point of a fake-publish
  // script is that you iterate on it (tweak the rate, adjust a ramp),
  // losing it on every tab switch or reload would make that friction
  // worse than a plain text file. One combined snapshot, not per-field
  // keys - topic/type/script only ever make sense read back together.
  const [form, setForm] = usePersistentState(`dashboard.publish.form.${tabId}`, {
    topicName: '',
    typeStr: '',
    source: 'send;',
  })
  const { topicName, typeStr, source } = form
  function setTopicName(v: string) {
    setForm((f) => ({ ...f, topicName: v }))
  }
  function setTypeStr(v: string) {
    setForm((f) => ({ ...f, typeStr: v }))
  }
  function setSource(v: string) {
    setForm((f) => ({ ...f, source: v }))
  }
  // Not persisted, unlike `form` - collapsed is the right default on every
  // fresh visit (a returning user already knows the syntax; the explanation
  // + example buttons are onboarding, not something to keep re-showing).
  const [helpExpanded, setHelpExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ tick_count: number; error: string | null; done: boolean } | null>(null)
  const sessionTopicRef = useRef<string | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  // Drag-resizable editor height, persisted per tab under the same
  // `dashboard.terminalHeight.*` namespace TerminalPane uses elsewhere -
  // one flat namespace for every drag-resized pane in the app, even
  // though this one isn't a TerminalPane itself (CodeMirror manages its
  // own scrolling/content, so it doesn't need that component's other
  // machinery).
  const editorHeightStorageKey = `dashboard.terminalHeight.publish.editor.${tabId}`
  const editorWrapperRef = useRef<HTMLDivElement>(null)
  const [editorHeight, setEditorHeight] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(editorHeightStorageKey)
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) && n >= MIN_EDITOR_HEIGHT_PX ? n : DEFAULT_EDITOR_HEIGHT_PX
    } catch {
      return DEFAULT_EDITOR_HEIGHT_PX
    }
  })
  useEffect(() => {
    const el = editorWrapperRef.current
    if (!el) return
    // Same "watch the DOM, don't wait for a drag-end event" approach as
    // TerminalPane - resize:vertical has no drag-end event of its own,
    // and this also picks up CodeMirror's height when it's driven by
    // something other than a manual drag (e.g. a future programmatic
    // resize), keeping the schema pane in sync either way.
    const observer = new ResizeObserver((entries) => {
      const h = Math.round(entries[0].contentRect.height)
      if (h < MIN_EDITOR_HEIGHT_PX) return
      setEditorHeight(h)
      try {
        localStorage.setItem(editorHeightStorageKey, String(h))
      } catch {
        // storage disabled/full - resize still works, just won't survive reload
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [editorHeightStorageKey])
  // This editor isn't a TerminalPane, but it shares the same
  // `dashboard.terminalHeight.*` namespace and the same reset-all event -
  // unlike TerminalPane's ref-anchored height, editorHeight is real state
  // driving the DOM directly (see the wrapper's inline style below), so
  // resetting it is just a plain setState.
  useEffect(() => {
    function onResetAll() {
      setEditorHeight(DEFAULT_EDITOR_HEIGHT_PX)
    }
    window.addEventListener(RESET_CONSOLE_HEIGHTS_EVENT, onResetAll)
    return () => window.removeEventListener(RESET_CONSOLE_HEIGHTS_EVENT, onResetAll)
  }, [])
  // Flipped synchronously the instant Stop is clicked - a status poll can
  // already be in flight when that happens, and its response (success or
  // a 404 "unknown session" once the backend removes it) would otherwise
  // land after the session is gone and get shown as a spurious error.
  const stoppingRef = useRef(false)

  // What fields actually exist and how they're nested - the direct answer
  // to "what do I even put in the pattern" instead of needing
  // `ros2 interface show` in a separate terminal. Debounced on typeStr,
  // not fetched per keystroke.
  const [schema, setSchema] = useState<string | null>(null)
  useEffect(() => {
    if (!typeStr.trim()) {
      setSchema(null)
      return
    }
    const timer = setTimeout(() => {
      api
        .getMessageSchema(typeStr.trim())
        .then((r) => setSchema(r.schema))
        .catch((err) => setSchema(`<${String(err)}>`))
    }, SCHEMA_FETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typeStr])

  useEffect(() => {
    if (!sessionId) return
    stoppingRef.current = false
    const interval = setInterval(() => {
      api
        .fakePublishStatus(sessionTopicRef.current!, sessionId)
        .then((s) => {
          if (!stoppingRef.current) setStatus(s)
        })
        .catch((err) => {
          if (!stoppingRef.current) setStatus({ tick_count: 0, error: String(err), done: false })
        })
    }, STATUS_POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [sessionId])

  useEffect(() => {
    return () => {
      if (sessionId && sessionTopicRef.current) {
        api.stopFakePublish(sessionTopicRef.current, sessionId).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A bounded script (no trailing infinite send) halts on its own -
  // `done` just means the backend stopped ticking it, the session and its
  // publisher are still sitting there until something calls stop(). Auto-
  // stopping here is what actually tears that down, so the UI reflects
  // "finished" as "not running" rather than a stale "0 more messages,
  // still technically active" state the user has to notice and close by
  // hand.
  useEffect(() => {
    if (status?.done) {
      stop(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.done])

  function loadExample(ex: Example) {
    setTypeStr(ex.typeStr)
    setSource(ex.source)
    setError(null)
  }

  // `.signal` is signallang's own file-naming convention - plain text
  // in, plain text out, no parsing/validation here (the real syntax
  // check happens on Start, same as anything typed by hand).
  async function importScript(file: File) {
    setSource(await file.text())
    setError(null)
  }

  function exportScript() {
    const blob = new Blob([source], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(topicName || 'script').replace(/[^\w.-]+/g, '_')}.signal`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function start() {
    if (!source.trim()) {
      setError('script is empty')
      return
    }
    setError(null)
    try {
      const { session_id, topic, type } = await api.startFakePublish(topicName, typeStr, source)
      sessionTopicRef.current = topic
      // A script declaring its own `extern ros_topic = "...";` /
      // `extern ros_schema = "...";` default is authoritative over
      // whatever was typed into the form - reflect that back into the
      // form fields (already disabled while running) so what's shown
      // never silently disagrees with what's actually publishing.
      if (topic !== topicName) setTopicName(topic)
      if (type !== typeStr) setTypeStr(type)
      setSessionId(session_id)
      setStatus({ tick_count: 0, error: null, done: false })
    } catch (err) {
      setError(String(err))
    }
  }

  // clearStatus=false for the auto-stop path below - otherwise the "N
  // messages sent - script finished" line would flash and vanish in the
  // same tick that finishing it triggers the stop, defeating the point of
  // ever showing it.
  async function stop(clearStatus = true) {
    if (!sessionId || !sessionTopicRef.current) return
    stoppingRef.current = true
    await api.stopFakePublish(sessionTopicRef.current, sessionId).catch((err) => setError(String(err)))
    setSessionId(null)
    if (clearStatus) setStatus(null)
  }

  const running = sessionId !== null

  useEffect(() => {
    onRunningChange?.(running)
    // Unmount (a real tab close, not just switching away) means the
    // session this reported is about to be stopped by the cleanup effect
    // above - tell the parent it's no longer running so a closed tab's
    // indicator doesn't linger on a stale "running" dot for a tab that
    // no longer exists.
    return () => onRunningChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  return (
    <div>
      <div
        className="tree-row group"
        style={{ marginBottom: helpExpanded ? '0.5rem' : '0.25rem' }}
        onClick={() => setHelpExpanded((v) => !v)}
      >
        <span className="tree-caret">{helpExpanded ? '▾' : '▸'}</span> How this works &amp; examples
      </div>
      {helpExpanded && (
        <>
          <div className="hint" style={{ marginBottom: '0.5rem' }}>
            Feed fake data to a subscriber under test. <strong>Topic</strong> and <strong>type</strong> are the
            target (type must be spelled out, e.g. <code>geometry_msgs/msg/Twist</code> - its schema appears below
            once you pause typing). <strong>Script</strong> is a small signallang program: bare field names target
            the message (<code>linear.x = 1;</code>), <code>live {'{'} return expr; {'}'}</code> recomputes a field
            every tick, and <code>send hz H dur D;</code> controls the rate and how long that phase lasts - rate is
            part of the script now, not a separate control. This covers the basics only - for the full language
            (macros, timers, Duration, random distributions, terop, wait, seed, ...) see{' '}
            <a href="https://github.com/KhiemGOM/signallang" target="_blank" rel="noreferrer">
              signallang on GitHub
            </a>
            . Try an example:
          </div>
          <div style={{ marginBottom: '0.5rem' }}>
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                className="flag-toggle"
                style={{ marginRight: '0.4rem', marginBottom: '0.4rem' }}
                onClick={() => loadExample(ex)}
                disabled={running}
              >
                {ex.label}
              </button>
            ))}
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <input
          type="text"
          placeholder="/topic/name"
          value={topicName}
          onChange={(e) => setTopicName(e.target.value)}
          disabled={running}
          style={{ minWidth: '220px' }}
        />
        <input
          type="text"
          placeholder="pkg/msg/Type (e.g. geometry_msgs/msg/Twist)"
          value={typeStr}
          onChange={(e) => setTypeStr(e.target.value)}
          disabled={running}
          style={{ minWidth: '260px' }}
        />
      </div>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
        {schema && (
          // Grows to fit the schema tree's actual widest line, capped at
          // half the row - script gets whatever's left, which by
          // construction is always >= half (the cap guarantees it), not
          // a fixed split that's too narrow for a small message's schema
          // or wastes half the row on a one-field one.
          <div style={{ width: 'fit-content', maxWidth: '50%', minWidth: 0, flexShrink: 0 }}>
            <div className="hint">schema for {typeStr.trim()}</div>
            <TerminalPane content={schema} height={editorHeight} noWrap resizable={false} />
          </div>
        )}
        <div style={{ flex: '1 1 0%', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
            <span className="hint" style={{ marginRight: '0.2rem' }}>
              script
            </span>
            <button className="flag-toggle" onClick={() => importInputRef.current?.click()} disabled={running}>
              Import .signal
            </button>
            <button className="flag-toggle" onClick={exportScript} disabled={!source.trim()}>
              Export .signal
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".signal,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = '' // lets re-selecting the same file re-trigger onChange
                if (file) importScript(file)
              }}
            />
          </div>
          <div ref={editorWrapperRef} style={{ height: `${editorHeight}px`, resize: 'vertical', overflow: 'hidden' }}>
            <CodeMirror
              value={source}
              onChange={setSource}
              theme="none"
              extensions={signallangSetup}
              editable={!running}
              height="100%"
              basicSetup={{ foldGutter: false }}
            />
          </div>
        </div>
      </div>
      {error && <div className="input-error">{error}</div>}
      <div style={{ margin: '0.4rem 0' }}>
        <button className="action" onClick={start} disabled={running || !topicName || !typeStr}>
          Start
        </button>
        <button className="action" onClick={() => stop()} disabled={!running}>
          Stop
        </button>
        {status && (
          <span className="hint" style={{ marginLeft: '0.5rem' }}>
            {status.error
              ? `error: ${status.error}`
              : status.done
                ? `${status.tick_count} messages sent - script finished`
                : `${status.tick_count} messages sent`}
          </span>
        )}
      </div>
      {running && <div className="hint">publishing to {topicName} - expand it below (Topics) to echo it</div>}
    </div>
  )
}
