import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, connectEvents, getAuthToken, onAuthFailure } from './api'
import { describeCodeChanged, describeConfigDiff, notifyTargetsChanged } from './configEvents'
import { notify } from './notifications'
import NotificationCenter from './NotificationCenter'
import BatteryIndicator from './BatteryIndicator'
import EstopButton from './EstopButton'
import { EstopProvider } from './EstopContext'
import LoginScreen from './LoginScreen'
import OperationsSplit from './OperationsSplit'
import SettingsModal from './SettingsModal'
import ControlTab from './tabs/ControlTab'
import GraphTab from './tabs/GraphTab'
import ParamsTab from './tabs/ParamsTab'
import BehaviorTreeTab from './tabs/BehaviorTreeTab'
import VisualizationTab from './tabs/VisualizationTab'
import HelpTab from './tabs/HelpTab'
import MiscTab from './tabs/MiscTab'

const TABS = [
  { id: 'control', label: 'Control', Component: ControlTab },
  { id: 'graph', label: 'Graph', Component: GraphTab },
  { id: 'params', label: 'Params', Component: ParamsTab },
  { id: 'bt', label: 'Behavior Tree', Component: BehaviorTreeTab },
  { id: 'viz', label: 'Visualization', Component: VisualizationTab },
  { id: 'help', label: 'Help', Component: HelpTab },
  { id: 'misc', label: 'Misc', Component: MiscTab },
] as const

type TabId = (typeof TABS)[number]['id']

const TAB_STORAGE_KEY = 'dashboard.activeTab'
const BIG_ESTOP_STORAGE_KEY = 'dashboard.bigEstopMode'

function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && TABS.some((t) => t.id === value)
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const stored = localStorage.getItem(TAB_STORAGE_KEY)
    return isTabId(stored) ? stored : 'control'
  })
  // null = still checking, false = login screen, true = show the app.
  // onAuthFailure fires on ANY 401 from ANY tab (not just at startup) - a
  // stored token can go stale if the server restarted (tokens are
  // in-memory, see auth.py), so this has to be able to flip back to the
  // login screen mid-session, not just gate the initial load.
  const [authReady, setAuthReady] = useState<boolean | null>(null)
  const [authRequired, setAuthRequired] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Non-intrusive "needs attention" toasts: push one when a target leaves
  // RUNNING on its own (threw -> failed, or exited cleanly). User-initiated
  // 'stopped'/'stopping' and the initial state backlog are ignored (tracked
  // via lastState per id), so a Stop click or a page reload doesn't spam.
  useEffect(() => {
    const last = new Map<string, string>()
    return connectEvents((ev) => {
      // Orphan cleanup (a manual kill via the row's tag, or start()
      // auto-killing a leftover pid before spawning a fresh one) - always
      // worth a toast since it can happen without the operator directly
      // asking for it (the auto-kill-before-start path). Independent of the
      // failed/exited watcher below, which only reacts to state_change.
      if (ev.type === 'orphan_killed') {
        notify({
          title: `Orphan cleaned up (${ev.id})`,
          message: `pid ${ev.pid} from a previous dashboard session was killed`,
          severity: 'info',
        })
        return
      }
      if (ev.state === undefined) return
      const prev = last.get(ev.id)
      last.set(ev.id, ev.state)
      if (prev === undefined || prev === ev.state) return
      if (ev.state === 'failed') {
        notify({ title: `Target ${ev.label || ev.id}`, message: `threw (${ev.state})`, severity: 'error', autoDismissMs: 8000 })
      } else if (ev.state === 'exited') {
        notify({ title: `Target ${ev.label || ev.id}`, message: 'stopped on its own (exited)', severity: 'warn', autoDismissMs: 6000 })
      }
    })
  }, [])
  const [bigEstopMode, setBigEstopMode] = useState(() => localStorage.getItem(BIG_ESTOP_STORAGE_KEY) === 'true')
  // Every tab you've ever visited THIS session stays mounted (hidden via
  // CSS, not unmounted) once you first open it - switching away used to
  // fully tear a tab down and remount a fresh one on return, which is what
  // was killing an in-progress BT recording or a live watch the instant
  // you checked another tab. Lazy: a tab you never open never mounts, so
  // this doesn't turn "visit every tab once" into "poll everything
  // forever from app load." Reset only by an actual page reload - there's
  // no in-app "stop watching X" button for this, matching how the
  // subscriptions themselves already only ever got torn down on unmount.
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(() => new Set([activeTab]))

  useEffect(() => {
    onAuthFailure(() => setAuthReady(false))
    api
      .authStatus()
      .then(({ auth_required }) => {
        setAuthRequired(auth_required)
        setAuthReady(!auth_required || getAuthToken() !== null)
      })
      .catch(() => setAuthReady(true)) // fail open here - a real 401 on any actual API call still catches it
  }, [])

  // A full page load (i.e. F5 / re-opening the dashboard) re-reads BOTH live
  // config files from disk into the running server - so a hand-edit of
  // ~/.dashboard_{targets,behavior_trees}.yaml is picked up on refresh, not
  // just by the 5-min timer or the Misc button. Once per page load (ref
  // guard); notifyTargetsChanged() afterward so the Control tab re-fetches
  // the reloaded target list. Errors are fire-and-forget - the page renders
  // regardless, and the Misc button / periodic timer cover a reload failure.
  // If the reload actually found a difference from what this server had in
  // memory (someone else's save, a hand-edit, a git pull) - toast it, since
  // otherwise "something changed on refresh" is invisible unless you
  // happen to go looking at the target list yourself.
  const reloadedConfigRef = useRef(false)
  useEffect(() => {
    if (authReady !== true || reloadedConfigRef.current) return
    reloadedConfigRef.current = true
    api
      .reloadConfig()
      .then((result) => {
        notifyTargetsChanged()
        const lines = [
          ...describeConfigDiff('target', result.targets_diff),
          ...describeConfigDiff('tree', result.trees_diff),
          ...describeCodeChanged(result.code_changed),
        ]
        if (lines.length > 0) {
          notify({ title: 'Config changed since last load', message: lines.join(' · '), severity: 'info' })
        }
      })
      .catch((err) => console.error('reload config on page load failed', err))
  }, [authReady])

  useEffect(() => {
    localStorage.setItem(TAB_STORAGE_KEY, activeTab)
    setVisitedTabs((prev) => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)))
  }, [activeTab])

  // Every tab renders inside ONE shared scroll container (.tab-content, or
  // .operations-split-content in Big E-Stop mode) - switching tabs only
  // flips display:none/contents on the panels, so that container's scrollTop
  // used to just carry over from whichever tab you left. Remember each tab's
  // own offset on the way out and restore it (or 0, for a never-scrolled
  // tab) on the way in, before paint so there's no visible jump.
  const mainRef = useRef<HTMLElement>(null)
  const scrollByTab = useRef<Partial<Record<TabId, number>>>({})
  const getScrollOwner = () =>
    mainRef.current?.querySelector<HTMLElement>('.operations-split-content') ?? mainRef.current
  function switchTab(next: TabId) {
    const owner = getScrollOwner()
    if (owner) scrollByTab.current[activeTab] = owner.scrollTop
    setActiveTab(next)
  }
  useLayoutEffect(() => {
    const owner = getScrollOwner()
    if (owner) owner.scrollTop = scrollByTab.current[activeTab] ?? 0
  }, [activeTab])

  useEffect(() => {
    localStorage.setItem(BIG_ESTOP_STORAGE_KEY, String(bigEstopMode))
  }, [bigEstopMode])

  if (authReady === null) return null
  if (!authReady) return <LoginScreen onSuccess={() => setAuthReady(true)} />

  // Every visited tab renders here, always - the inactive ones just get
  // display:none'd instead of not being in the tree at all, so their
  // internal state (a live BT recording, Graph's hz/echo subscriptions,
  // Control's log websockets) keeps running while you're looking at a
  // different tab, instead of being torn down and losing all of it.
  // display:contents on the active wrapper means it doesn't add a layout
  // box of its own - .tab-content's flex/scroll behavior applies to the
  // tab's own root element directly, same as when Active rendered alone.
  const tabPanels = (
    <>
      {TABS.filter((t) => visitedTabs.has(t.id)).map(({ id, Component }) => (
        <div key={id} style={{ display: activeTab === id ? 'contents' : 'none' }}>
          <Component />
        </div>
      ))}
    </>
  )

  return (
    <EstopProvider>
      <header className="app-header">
        <span className="app-title">RoboHome Dashboard</span>
        <BatteryIndicator />
        <EstopButton />
        <button className={`action${bigEstopMode ? ' active' : ''}`} onClick={() => setBigEstopMode((v) => !v)}>
          ⛶ Big E-Stop
        </button>
        <button className="action" onClick={() => setSettingsOpen(true)}>
          ⚙ Settings
        </button>
        {authRequired && (
          <button className="action" onClick={() => api.logout().then(() => setAuthReady(false))}>
            Logout
          </button>
        )}
      </header>
      <nav className="tab-bar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab-button${activeTab === t.id ? ' active' : ''}`}
            onClick={() => switchTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main ref={mainRef} className={`tab-content${bigEstopMode ? ' split-mode' : ''}`}>
        {bigEstopMode ? <OperationsSplit>{tabPanels}</OperationsSplit> : tabPanels}
      </main>
      <NotificationCenter />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </EstopProvider>
  )
}
