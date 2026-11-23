import { useEffect, useState } from 'react'
import { api, connectEvents, TargetStatus } from '../api'
import { usePersistentStringSetMap } from '../usePersistentState'
import { copyText } from '../clipboard'

// Deliberately NOT an embedded Lichtblick/Foxglove web client - that's the
// full Phase C from the original plan (vendor a web bundle, mount it,
// wire deep-link query params) and carries real unverified risk (exact
// repo/build/param names need checking against a live build). This tab is
// the achievable, low-risk slice of that: 1-click start/stop for
// foxglove_bridge and rviz2 (both are just entries in
// config/targets.yaml - the SAME process supervisor the Control tab uses,
// no new backend code), plus a step-by-step walkthrough for the fastest
// EXTERNAL client, verified by actually clicking through it (not guessed):
// https://lichtblick-suite.github.io - public, open-source, no install, no
// account. app.foxglove.dev looks like the equivalent zero-friction option
// but isn't - it gates the connection screen behind a mandatory Google/
// email sign-in, checked directly, so it's deliberately not the one
// recommended here. Goal: zero manual `ros2 run`/`ros2 launch` typing, and
// no guessing at the external client's UI once you get there either.
const FOXGLOVE_TARGET_ID = 'foxglove_bridge'
const RVIZ_TARGET_ID = 'rviz2'

export default function VisualizationTab() {
  const [targets, setTargets] = useState<TargetStatus[]>([])
  const [pending, setPending] = useState<Set<string>>(new Set())
  // Tracks which copyable snippet was last copied, not just a single
  // boolean - two independent copy buttons now (Foxglove's ws URL, RViz's
  // run-it-yourself command), same pattern as HelpTab.tsx's copy entries.
  const [copied, setCopied] = useState<string | null>(null)
  // Same pattern as Control tab's flag checkboxes - chosen at start time
  // only, not fetched from the backend. Persisted so flag choices stick.
  const [selectedFlags, setSelectedFlags] = usePersistentStringSetMap('dashboard.viz.selectedFlags')

  useEffect(() => {
    api.listTargets().then(setTargets).catch((err) => console.error('listTargets failed', err))
    const disconnect = connectEvents((event) => {
      if (event.type === 'orphan_killed') {
        // event.pid is the KILLED ORPHAN's pid, not this target's own
        // running pid - spreading it in would clobber t.pid with the wrong
        // number (same fix as Control tab's handler).
        setTargets((prev) => prev.map((t) => (t.id === event.id ? { ...t, orphan_pid: null } : t)))
        return
      }
      setTargets((prev) => prev.map((t) => (t.id === event.id ? { ...t, ...event } : t)))
    })
    return disconnect
  }, [])

  async function runAction(id: string, action: 'start' | 'stop') {
    setPending((prev) => new Set(prev).add(id))
    try {
      const status = await (action === 'start' ? api.startTarget(id, Array.from(selectedFlags[id] ?? [])) : api.stopTarget(id))
      setTargets((prev) => prev.map((t) => (t.id === id ? status : t)))
    } catch (err) {
      console.error(`${action} ${id} failed`, err)
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  function toggleFlag(targetId: string, flagName: string) {
    setSelectedFlags((prev) => {
      const current = new Set(prev[targetId] ?? [])
      if (current.has(flagName)) current.delete(flagName)
      else current.add(flagName)
      return { ...prev, [targetId]: current }
    })
  }

  const byId = Object.fromEntries(targets.map((t) => [t.id, t]))
  const isRunningish = (s?: string) => s === 'running' || s === 'starting'
  // True only when this browser tab is loaded from the same machine the
  // dashboard backend (and therefore the process supervisor) runs on -
  // the one case where "click Start" for a native GUI process actually
  // makes sense, since its window opens on whatever host runs it, not
  // wherever the browser is. Used below to gate RViz2 (see its section).
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  // Never hardcode localhost - this has to work from a laptop on the LAN
  // once the dashboard runs on the robot's onboard computer, not just here.
  // Protocol-matched to the page's own (ws:/wss:), same as api.ts's wsUrl()
  // helper - a plain ws:// URL is blocked as mixed content by the browser
  // once the dashboard itself is ever served over https.
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${wsProto}//${window.location.hostname}:8765`
  // Foxglove's own documented shareable-link format
  // (docs.foxglove.dev/docs/visualization/shareable-links) - openIn=desktop
  // launches the installed desktop app directly, pre-filled with this
  // connection, or prompts to download it if not installed.
  const foxgloveDesktopLink = `https://app.foxglove.dev/~/view?ds=foxglove-websocket&ds.url=${encodeURIComponent(wsUrl)}&openIn=desktop`
  // RViz2 is a native Qt window, not a web view - it renders on whatever
  // machine actually runs `ros2 run rviz2 rviz2`. Clicking Start through
  // the dashboard always runs it on the backend host, so remotely that
  // window opens somewhere nobody's looking, not in front of whoever
  // clicked it. No dashboard-side fix for that (no VNC/X11 relay in this
  // codebase - same build-vs-buy tradeoff already made for Foxglove per
  // the top-of-file comment, and a bigger lift here with no existing
  // web-native fallback the way Foxglove has Lichtblick). The one already
  // genuinely available workaround - already hinted at below, just never
  // gated on whether Start could even work - is running rviz2 directly on
  // your OWN machine instead of through the dashboard at all, matching
  // ROS_DOMAIN_ID so it discovers the robot's ROS graph over the LAN.
  // ROS_DOMAIN_ID is a static assumption (whatever this dashboard's own
  // dev/deploy box happened to have unset -> 0), not fetched live - no
  // backend endpoint exposes it, so this can drift if a robot's actual
  // domain ID ever changes and nobody updates this string.
  const rvizLocalCommand = 'export ROS_DOMAIN_ID=0\nros2 run rviz2 rviz2'

  async function copy(text: string) {
    try {
      await copyText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 1500)
    } catch (err) {
      console.error('clipboard write failed', err)
    }
  }

  function StartStopRow({ id }: { id: string }) {
    const t = byId[id]
    if (!t) return <p className="hint">"{id}" isn't in config/targets.yaml.</p>
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
        <span className={`badge badge-${t.state}`}>{t.state}</span>
        {t.pid != null && <span className="hint">PID {t.pid}</span>}
        {t.flags.map((flag) => (
          <button
            key={flag.name}
            type="button"
            className={`flag-toggle${selectedFlags[id]?.has(flag.name) ? ' active' : ''}`}
            title={flag.arg}
            disabled={isRunningish(t.state)}
            onClick={() => toggleFlag(id, flag.name)}
          >
            {flag.label}
          </button>
        ))}
        <button className="action" disabled={pending.has(id) || isRunningish(t.state)} onClick={() => runAction(id, 'start')}>
          Start
        </button>
        <button className="action" disabled={pending.has(id) || !isRunningish(t.state)} onClick={() => runAction(id, 'stop')}>
          Stop
        </button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h3>Foxglove Bridge</h3>
        <StartStopRow id={FOXGLOVE_TARGET_ID} />
        <ol style={{ paddingLeft: '1.25rem', lineHeight: 1.9, margin: '0.5rem 0' }}>
          <li>Click <b>Start</b> above.</li>
          <li>
            Pick a client:{' '}
            <a href="https://lichtblick-suite.github.io" target="_blank" rel="noreferrer">
              Lichtblick (web, no login)
            </a>
            {' · '}
            <a href="https://app.foxglove.dev" target="_blank" rel="noreferrer">
              Foxglove (web, needs login)
            </a>
            {' · '}
            <a href={foxgloveDesktopLink} target="_blank" rel="noreferrer" className="action" style={{ textDecoration: 'none' }}>
              Open in Foxglove desktop app
            </a>{' '}
            <span className="hint">(sometimes can take up to ~10s)</span>
          </li>
          <li>
            Paste this:{' '}
            <code style={{ background: 'var(--bg-panel)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>{wsUrl}</code>{' '}
            <button className="action" onClick={() => copy(wsUrl)}>
              {copied === wsUrl ? 'Copied' : 'Copy'}
            </button>
            {' → '}<b>Open connection</b> → <b>Foxglove WebSocket</b> → <b>Open</b>
          </li>
        </ol>
        {/* Lichtblick steps verified by hand. Desktop app link format is per
            Foxglove's own docs (docs.foxglove.dev/docs/visualization/shareable-links)
            - not independently checked past app.foxglove.dev's login wall. */}
        <p className="hint">On the robot: also run `sudo ufw allow 8765/tcp` to view from your own machine.</p>
      </div>

      <div>
        <h3>RViz2</h3>
        {isLocal ? (
          <>
            <StartStopRow id={RVIZ_TARGET_ID} />
            <p className="hint">
              Some WSLg setups hit a zero-size RViz2 window (Qt/Wayland). Not universal - see the Help tab if Start
              above shows nothing.
            </p>
          </>
        ) : (
          <p className="hint">
            RViz2 is a native window, not a web view - Start here would open it on the machine running the
            dashboard, not on yours, so it's disabled from this browser. Run it on your own machine instead
            (needs ROS 2 + rviz2 installed), matching <code>ROS_DOMAIN_ID</code> so it discovers the robot's ROS
            graph over the LAN (currently unset here = <code>0</code>):
          </p>
        )}
        {!isLocal && (
          <div style={{ position: 'relative', marginBottom: '0.5rem' }}>
            <pre className="terminal-pane" style={{ height: 'auto', minHeight: 0, resize: 'none' }}>
              {rvizLocalCommand}
            </pre>
            <button className="action" onClick={() => copy(rvizLocalCommand)}>
              {copied === rvizLocalCommand ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
