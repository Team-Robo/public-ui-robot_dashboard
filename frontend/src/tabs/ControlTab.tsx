import { CSSProperties, Fragment, useEffect, useRef, useState } from 'react'
import {
  closestCenter,
  DndContext,
  DragEndEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api, connectEvents, connectLogs, DependencyNotMetError, DependencyStatus, TargetStatus } from '../api'
import ChainFailureDialog from '../ChainFailureDialog'
import DependencyDialog from '../DependencyDialog'
import Dropdown from '../Dropdown'
import { onTargetsChanged } from '../configEvents'
import Highlight from '../Highlight'
import { notify } from '../notifications'
import { resetAllConsoleHeights } from '../resetConsoleHeights'
import TerminalPane from '../TerminalPane'
import { usePersistentSet, usePersistentState } from '../usePersistentState'

const CATEGORY_STORAGE_KEY = 'dashboard.control.collapsedCategories'
// Category display order - purely a Control-tab UI preference (categories
// aren't a backend concept, just a string field on each target used for
// grouping), so unlike target order this never round-trips to targets.yaml
// - same reasoning and same storage mechanism as CATEGORY_STORAGE_KEY above.
const CATEGORY_ORDER_STORAGE_KEY = 'dashboard.control.categoryOrder'
const EXPANDED_TARGETS_STORAGE_KEY = 'dashboard.control.expandedTargets'

const isRunningish = (s: string) => s === 'running' || s === 'starting'

// Applies a category's newly-reordered id sequence back onto the full flat
// `targets` array, without disturbing where OTHER categories' items sit.
// Walks the flat list; every index that belongs to this category gets
// filled from newOrderIds in sequence, every other index is left alone.
// This is what makes dropping on the last row actually mean "last" -
// arrayMove(ids, oldIndex, newIndex) already resolves the correct target
// index (not "insert before"), so this just needs to honor that sequence
// exactly rather than re-deriving position from a single dropOnId.
function applyOrderWithinPositions(list: TargetStatus[], newOrderIds: string[]): TargetStatus[] {
  const byId = new Map(list.map((t) => [t.id, t]))
  const idSet = new Set(newOrderIds)
  let cursor = 0
  return list.map((t) => {
    if (!idSet.has(t.id)) return t
    const next = byId.get(newOrderIds[cursor])!
    cursor += 1
    return next
  })
}

function TargetDragPreview({ target }: { target: TargetStatus }) {
  return (
    <div
      style={{
        background: 'var(--bg-panel)',
        border: '1px solid var(--accent)',
        borderRadius: '6px',
        padding: '0.5rem 0.9rem',
        boxShadow: '0 12px 28px rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        cursor: 'grabbing',
      }}
    >
      <span style={{ color: 'var(--text-dim)' }}>⠿</span>
      <strong>{target.label}</strong>
      <span className={`badge badge-${target.state}`}>{target.state}</span>
    </div>
  )
}

function CategoryDragPreview({ category, count }: { category: string; count: number }) {
  return (
    <div
      style={{
        background: 'var(--bg-panel)',
        border: '1px solid var(--accent)',
        borderRadius: '6px',
        padding: '0.5rem 1rem',
        boxShadow: '0 12px 28px rgba(0,0,0,0.45)',
        fontWeight: 600,
        textTransform: 'capitalize',
        cursor: 'grabbing',
      }}
    >
      ⠿ {category} <span className="hint">({count})</span>
    </div>
  )
}

interface SortableTargetRowProps {
  target: TargetStatus
  expanded: boolean
  dragEnabled: boolean
  selectedFlags: Record<string, boolean | string> | undefined
  pending: boolean
  searchQuery: string
  logLines: string[]
  onToggle: () => void
  onToggleFlag: (flagName: string) => void
  onSelectFlag: (flagName: string, option: string) => void
  onRunAction: (action: 'start' | 'stop' | 'restart') => void
  onClearLogs: () => void
  onKillOrphan: () => void
}

// One sortable target row. The drag handle (last cell) is the only element
// wired to dnd-kit's listeners/attributes - ref + the transform/transition
// style that actually moves the row live on the <tr> itself - so clicking
// anywhere else in the row (to expand logs, flag toggles, Start/Stop/
// Restart) is completely unaffected by drag activation.
function SortableTargetRow({
  target: t,
  expanded,
  dragEnabled,
  selectedFlags,
  pending,
  searchQuery,
  logLines,
  onToggle,
  onToggleFlag,
  onSelectFlag,
  onRunAction,
  onClearLogs,
  onKillOrphan,
}: SortableTargetRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: t.id,
    disabled: !dragEnabled,
  })
  // Generalized from the old hardcoded `kind === 'windows'` check: any
  // target whose `requires` declares an unambiguous `platform:` leaf that
  // doesn't match this session gets platform_locked_out set server-side
  // (conditions.platform_lockout()) - shown disabled with an explanation,
  // not hidden (a hidden target isn't discoverable at all, and doesn't
  // tell you it'd work in a different setup).
  const platformLockedOut = t.platform_locked_out
  const platformLockedOutTitle = platformLockedOut
    ? `This target requires platform "${platformLockedOut}", which doesn't match this dashboard's current platform.`
    : undefined
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : platformLockedOut ? 0.55 : 1,
    cursor: 'pointer',
  }

  return (
    <Fragment>
      <tr ref={setNodeRef} style={style} onClick={onToggle} title={platformLockedOutTitle}>
        <td title={t.id}>
          <span className="tree-caret">{expanded ? '▾' : '▸'}</span> <Highlight text={t.label} query={searchQuery} />
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            {/* Restart is just Start with an unconditional stop-first (a
                no-op when not already running - see process_manager.stop()'s
                own early-return) - so Start is really Restart's special
                case for "not running yet." One button covers both: label +
                dispatched action flip on the target's current state, so
                clicking it starts a stopped target or restarts a running
                one. Stop stays its own button (there's no "not running"
                case for it to collapse into). */}
            <button
              className="action"
              disabled={Boolean(platformLockedOut) || pending}
              onClick={() => onRunAction(isRunningish(t.state) ? 'restart' : 'start')}
            >
              {/* A chain-start can legitimately sit waiting on a
                  dependency for up to DEPENDENCY_STARTING_WAIT_SEC (30s)
                  before this target itself even spawns - t.state stays
                  whatever it was (not yet 'starting') the whole time, so
                  without this the row showed no visible sign anything was
                  happening and a "did my click register?" re-click was a
                  reasonable (if redundant, now that it's guarded) response. */}
              {pending
                ? (isRunningish(t.state) ? 'Restarting…' : 'Starting…')
                : (isRunningish(t.state) ? 'Restart' : 'Start')}
            </button>
            <button
              className="action"
              disabled={Boolean(platformLockedOut) || pending || !isRunningish(t.state)}
              onClick={() => onRunAction('stop')}
            >
              {pending && isRunningish(t.state) ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        </td>
        <td>
          <span className={`badge badge-${t.state}`}>{t.state}</span>
          {t.orphan_pid != null && (
            // Independent of Start/Stop/Restart - those keep working
            // normally (Start auto-kills this pid itself before spawning a
            // fresh one, see runAction/doRunAction). This is only for
            // "I don't want to start a new one, just get rid of the old
            // one" - a separate, explicit action rather than overloading
            // any of the three existing verbs to secretly mean kill.
            <button
              type="button"
              className="badge badge-orphaned"
              title={`pid ${t.orphan_pid} is still alive from a previous dashboard session - this session isn't managing it. Click to kill it.`}
              onClick={(e) => {
                e.stopPropagation()
                onKillOrphan()
              }}
            >
              orphaned
            </button>
          )}
        </td>
        <td>{t.pid ?? '-'}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }}>
            {t.flags.map((flag) => {
              if (flag.type === 'select' && flag.options?.length) {
                return (
                  <div
                    key={flag.name}
                    onClick={(e) => e.stopPropagation()}
                    className="flag-labeled"
                    title={isRunningish(t.state) ? 'Stop the target first to change flags' : undefined}
                  >
                    {flag.label && <span className="flag-label">{flag.label}</span>}
                    <Dropdown
                      value={(selectedFlags?.[flag.name] as string) || ''}
                      onChange={(v) => onSelectFlag(flag.name, v)}
                      disabled={isRunningish(t.state)}
                      emptyLabel="None"
                      options={flag.options.map((opt) => ({ value: opt.name, label: opt.label }))}
                    />
                  </div>
                )
              }
              if (flag.type === 'text') {
                return (
                  <input
                    key={flag.name}
                    type="text"
                    className="flag-toggle text-flag"
                    placeholder={flag.placeholder}
                    title={isRunningish(t.state) ? 'Stop the target first to change flags' : undefined}
                    disabled={isRunningish(t.state)}
                    value={(selectedFlags?.[flag.name] as string) || ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onSelectFlag(flag.name, e.target.value)}
                  />
                )
              }
              return (
                <button
                  key={flag.name}
                  type="button"
                  className={`flag-toggle${selectedFlags?.[flag.name] === true ? ' active' : ''}`}
                  title={isRunningish(t.state) ? 'Stop the target first to change flags' : flag.arg}
                  disabled={isRunningish(t.state)}
                  onClick={() => onToggleFlag(flag.name)}
                >
                  {flag.label || flag.name}
                </button>
              )
            })}
          </div>
        </td>
        <td
          className="drag-handle"
          title="Drag to reorder"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: dragEnabled ? 'grab' : 'default', color: 'var(--text-dim)', textAlign: 'right' }}
        >
          {dragEnabled ? '⠿' : ''}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6}>
            <TerminalPane
              content={logLines.join('\n')}
              emptyHint="No output yet."
              storageKey={`control.logs.${t.id}`}
              onClear={onClearLogs}
            />
          </td>
        </tr>
      )}
    </Fragment>
  )
}

interface CategoryBlockProps {
  category: string
  items: TargetStatus[]
  isOpen: boolean
  dragEnabled: boolean
  expandedTargets: Set<string>
  logLinesByTarget: Record<string, string[]>
  selectedFlags: Record<string, Record<string, boolean | string>>
  pending: Set<string>
  searchQuery: string
  onToggleCategory: (category: string) => void
  onToggleTarget: (id: string) => void
  onToggleFlag: (targetId: string, flagName: string) => void
  onSelectFlag: (targetId: string, flagName: string, option: string) => void
  onRunAction: (id: string, action: 'start' | 'stop' | 'restart') => void
  onReorderTargets: (newOrderIds: string[]) => void
  onClearLogs: (id: string) => void
  onKillOrphan: (id: string) => void
}

// A category header (itself draggable, to reorder categories) plus its own
// nested DndContext scoped to just this category's targets - keeping each
// category's target-reordering fully independent means a target can never
// structurally end up dragged into a different category, no manual
// same-category check needed like the old native-HTML5-DnD version had.
function CategoryBlock({
  category,
  items,
  isOpen,
  dragEnabled,
  expandedTargets,
  logLinesByTarget,
  selectedFlags,
  pending,
  searchQuery,
  onToggleCategory,
  onToggleTarget,
  onToggleFlag,
  onSelectFlag,
  onRunAction,
  onReorderTargets,
  onClearLogs,
  onKillOrphan,
}: CategoryBlockProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: category,
    disabled: !dragEnabled,
  })
  const style: CSSProperties = {
    marginBottom: '1.5rem',
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const targetSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null)
  const activeTarget = items.find((t) => t.id === activeTargetId) ?? null

  return (
    <div ref={setNodeRef} style={style}>
      <h3
        className="tree-row group"
        style={{
          textTransform: 'capitalize',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
        onClick={() => onToggleCategory(category)}
      >
        <span>
          <span className="tree-caret">{isOpen ? '▾' : '▸'}</span> {category}{' '}
          <span className="hint">({items.length})</span>
        </span>
        <span
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          title="Drag to reorder category"
          style={{ cursor: dragEnabled ? 'grab' : 'default', color: 'var(--text-dim)', padding: '0 0.4rem' }}
        >
          {dragEnabled ? '⠿' : ''}
        </span>
      </h3>
      {isOpen && (
        <DndContext
          sensors={targetSensors}
          collisionDetection={closestCenter}
          onDragStart={(e) => setActiveTargetId(String(e.active.id))}
          onDragEnd={(e: DragEndEvent) => {
            setActiveTargetId(null)
            const { active, over } = e
            if (!over || active.id === over.id) return
            const ids = items.map((t) => t.id)
            const oldIndex = ids.indexOf(String(active.id))
            const newIndex = ids.indexOf(String(over.id))
            if (oldIndex === -1 || newIndex === -1) return
            onReorderTargets(arrayMove(ids, oldIndex, newIndex))
          }}
          onDragCancel={() => setActiveTargetId(null)}
        >
          {/* table-layout:fixed + a percentage colgroup makes column widths
              deterministic (not auto layout's content-based heuristics,
              which kept dumping leftover space into whichever column it
              favored) - every category's table uses the same colgroup, so
              they land at the same x-positions as a side effect too. */}
          <table className="control-table">
            <colgroup>
              <col style={{ width: '24%' }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '21%' }} />
              <col style={{ width: '36px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Target</th>
                <th>Actions</th>
                <th>State</th>
                <th>PID</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <tbody>
                {items.map((t) => (
                  <SortableTargetRow
                    key={t.id}
                    target={t}
                    expanded={expandedTargets.has(t.id)}
                    dragEnabled={dragEnabled}
                    selectedFlags={selectedFlags[t.id]}
                    pending={pending.has(t.id)}
                    searchQuery={searchQuery}
                    logLines={logLinesByTarget[t.id] ?? []}
                    onToggle={() => onToggleTarget(t.id)}
                    onToggleFlag={(flagName) => onToggleFlag(t.id, flagName)}
                    onSelectFlag={(flagName, option) => onSelectFlag(t.id, flagName, option)}
                    onRunAction={(action) => onRunAction(t.id, action)}
                    onClearLogs={() => onClearLogs(t.id)}
                    onKillOrphan={() => onKillOrphan(t.id)}
                  />
                ))}
              </tbody>
            </SortableContext>
          </table>
          <DragOverlay>{activeTarget ? <TargetDragPreview target={activeTarget} /> : null}</DragOverlay>
        </DndContext>
      )}
    </div>
  )
}

export default function ControlTab() {
  const [targets, setTargets] = useState<TargetStatus[]>([])
  // Persisted - which targets' log panels are open survives a reload, same
  // as every other expand/collapse control in this app. Reconnecting the
  // actual log stream for whatever comes back expanded is handled by the
  // mount effect further down, not by this alone - restoring the id set
  // doesn't restore the underlying websocket subscription by itself.
  const [expandedTargets, setExpandedTargets] = usePersistentSet(EXPANDED_TARGETS_STORAGE_KEY)
  const [logLinesByTarget, setLogLinesByTarget] = useState<Record<string, string[]>>({})
  const [pending, setPending] = useState<Set<string>>(new Set())
  // The in-app "start dependencies?" prompt - set when a Start/Restart hits
  // an unmet `requires`, kept until the user picks a course or dismisses it.
  const [depPrompt, setDepPrompt] = useState<{
    id: string
    action: 'start' | 'restart'
    deps: DependencyStatus
    fromChain: boolean
  } | null>(null)
  // Chain-failure popup - a node in the chain we opened crashed coming up.
  // Independent of the toast (which reports the crashed node) and of the
  // precondition prompt. Retry / Stop all / Cancel.
  const [chainFail, setChainFail] = useState<{
    id: string
    action: 'start' | 'restart'
    closure: string[]
    reason: string
  } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  // Which flag widget choices are set per target, chosen at start time only
  // - not fetched from the backend (status only reports flag *definitions*,
  // not which were used for the currently-running process). Value is `true`
  // for a checked toggle, or the chosen option name for a select flag
  // (absent/"None" = pass nothing). Persisted so the same choices stick
  // across a reload instead of resetting every time you reopen the dashboard.
  const [selectedFlags, setSelectedFlags] = usePersistentState<Record<string, Record<string, boolean | string>>>('dashboard.control.selectedFlags', {})
  // Persisted, not session-only: the whole point is that once you've
  // collapsed the noise (individual test targets etc.) it should STAY
  // collapsed next time you open the dashboard, not reset every reload.
  const [collapsedCategories, setCollapsedCategories] = usePersistentSet(CATEGORY_STORAGE_KEY)
  const [categoryOrder, setCategoryOrder] = usePersistentState<string[]>(CATEGORY_ORDER_STORAGE_KEY, [])
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const categorySensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const logDisconnectRef = useRef<Record<string, () => void>>({})

  useEffect(() => {
    function refresh() {
      api.listTargets().then(setTargets).catch((err) => console.error('listTargets failed', err))
    }
    refresh()
    const disconnect = connectEvents((event) => {
      // A target removed from config that already stopped gets pruned + a
      // 'removed' event - drop its row instead of leaving a dead row forever.
      if (event.type === 'removed') {
        setTargets((prev) => prev.filter((t) => t.id !== event.id))
        return
      }
      if (event.type === 'orphan_killed') {
        // event.pid here is the KILLED ORPHAN's pid, not this target's own
        // running pid - only clear orphan_pid, never spread the whole event
        // onto the row (that would clobber t.pid with the wrong number).
        setTargets((prev) => prev.map((t) => (t.id === event.id ? { ...t, orphan_pid: null } : t)))
        return
      }
      setTargets((prev) => prev.map((t) => (t.id === event.id ? { ...t, ...event } : t)))
    })
    // Saving in Settings applies live on the backend, but this list was
    // only ever fetched once on mount - without this, a target added/
    // removed/relabeled there just doesn't show up here until a manual
    // reload, even though it's already true on the server.
    const unsubscribe = onTargetsChanged(refresh)
    return () => {
      disconnect()
      unsubscribe()
    }
  }, [])

  // Unmounting (switching tabs) closes every open log connection, same
  // reasoning as Graph tab's echo/hz cleanup - nothing should keep
  // streaming behind a tab you've navigated away from.
  useEffect(() => {
    return () => {
      for (const disconnect of Object.values(logDisconnectRef.current)) disconnect()
    }
  }, [])

  function connectTargetLogs(id: string) {
    logDisconnectRef.current[id] = connectLogs(id, (line) => {
      setLogLinesByTarget((prev) => ({ ...prev, [id]: [...(prev[id] ?? []).slice(-999), line] }))
    })
  }

  // Reconnects whatever was left expanded from a previous session -
  // expandedTargets is persisted, but a websocket subscription obviously
  // isn't, so restoring the id set alone would show open-but-frozen panels
  // (no live tail) until the next manual toggle. Mount only: toggleTarget
  // below already handles connecting for anything expanded during THIS
  // session.
  useEffect(() => {
    for (const id of expandedTargets) {
      if (!logDisconnectRef.current[id]) connectTargetLogs(id)
    }
    // Intentionally mount-only - see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Click-to-toggle, same interaction as the Params/Graph tabs' expandable
  // rows - opening connects the log stream, closing disconnects it. This is
  // also just "the close button": there is no separate one, collapsing the
  // row IS closing the log.
  function toggleTarget(id: string) {
    if (expandedTargets.has(id)) {
      logDisconnectRef.current[id]?.()
      delete logDisconnectRef.current[id]
      setExpandedTargets((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setLogLinesByTarget((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } else {
      setExpandedTargets((prev) => new Set(prev).add(id))
      connectTargetLogs(id)
    }
  }

  function clearLogs(id: string) {
    setLogLinesByTarget((prev) => ({ ...prev, [id]: [] }))
    // Also clears the server-side backlog - otherwise the very next
    // collapse/expand (or a start/restart's own auto-clear) reconnects the
    // logs websocket, which replays that same backlog right back per
    // stream_logs()'s "send the backlog, then subscribe" behavior. Fire-
    // and-forget: the frontend already looks cleared regardless of whether
    // this succeeds, and a failure here just means a future reconnect
    // brings old lines back - not worth blocking or surfacing an error for.
    api.clearTargetLogs(id).catch((err) => console.error('clearTargetLogs failed', err))
  }

  // THE single start/stop/restart entry point - every trigger in this file
  // (a plain row click, "Start dependencies too", "Start anyway", a chain
  // retry) calls this and only this to actually talk to the backend. It is
  // the only place flags/dependencyFlags ever get resolved - callers supply
  // WHAT to do (id/action/mode/depClosure), never HOW to resolve flags for
  // it. This used to be split across doRunAction plus 3 near-identical
  // dialog handlers that each separately called resolveFlagsFor/
  // buildDependencyFlags themselves - confirmed live that this split let a
  // dependency's own GPU flag silently go unsent even with the toggle
  // visibly lit on its row, and was unreproducible from reading the code
  // alone. Collapsing every path through one function that ALWAYS resolves
  // fresh (never a value threaded in by whichever caller happened to reach
  // it) removes the possibility of a caller forgetting to, by construction.
  //
  // dependencyFlags is now sent on every start regardless of mode - the
  // backend only ever reads it when start_dependencies is set (see
  // routes.py), so sending it for a 'normal'/'force' start is inert, not a
  // second special case to keep in sync.
  //
  // depClosure: for mode 'deps' only - the OTHER targets this chain will
  // pull in (from getTargetDependencies' missing_targets, or a chain
  // failure's closure), not including `id` itself.
  async function doRunAction(id: string, action: 'start' | 'stop' | 'restart', mode: 'normal' | 'force' | 'deps' = 'normal', skipPreconditions: string[] = [], depClosure: string[] = []) {
    const { flags, flagValues } = resolveFlagsFor(id)
    const dependencyFlags = buildDependencyFlags()
    // A 'deps' mode start doesn't just start `id` - it starts every target
    // in the closure too. Every per-start side effect below needs to apply
    // to ALL of them, not just `id` - same bug class as the flags fix:
    // clearLogs(id) alone left a chain-started dependency's PREVIOUS run's
    // log output sitting there un-cleared (confirmed live), and pending
    // only covering `id` meant no spinner/double-click guard on the OTHER
    // targets while the chain was spawning them. Falls back to [id] for
    // 'normal'/'force' starts, where this was already correct.
    const affectedIds = depClosure.length > 0 ? [...depClosure, id] : [id]

    // A fresh process invocation deserves a fresh terminal - otherwise a
    // restarted (or re-started after exit) process's output just piles up
    // underneath whatever the PREVIOUS run left behind (its exit trace
    // included), with nothing visually separating the two runs. Stop is
    // deliberately excluded - you want to see final output right after
    // stopping, not have it vanish the moment you click Stop.
    if (action === 'start' || action === 'restart') {
      for (const aid of affectedIds) clearLogs(aid)
    }
    setPending((prev) => {
      const next = new Set(prev)
      for (const aid of affectedIds) next.add(aid)
      return next
    })
    try {
      let status: TargetStatus
      if (action === 'start') {
        status = await api.startTarget(id, flags, mode, skipPreconditions, flagValues, dependencyFlags)
      } else if (action === 'restart') {
        await api.stopTarget(id)
        status = await api.startTarget(id, flags, mode, skipPreconditions, flagValues, dependencyFlags)
      } else {
        status = await api.stopTarget(id)
      }
      setTargets((prev) => prev.map((t) => (t.id === id ? status : t)))
    } catch (err) {
      if (err instanceof DependencyNotMetError) {
        if (err.kind === 'spawn_failure') {
          // A node in the chain crashed coming up -> the chain is aborted NOW.
          // Show the dedicated chain-failure popup (retry/stop all/cancel); the
          // toast independently reports the crashed node. This is separate
          // from the precondition prompt.
          setChainFail({
            id,
            action: action === 'stop' ? 'start' : action,
            closure: err.missingTargets,
            reason: err.reason,
          })
          return
        }
        // Refused on a precondition (either a start we didn't pre-check, deps
        // changed mid-flight, or a chained start paused on a node). Re-fetch
        // the CURRENT dependency state - after a chained start brought up the
        // target deps, the pre-check snapshot is stale, and what's actually
        // left unmet is only the non-target prerequisites. The re-prompt must
        // show that, not the original list.
        const fresh = await api.getTargetDependencies(id, flags).catch(() => null)
        // A chained start ('deps') that paused mid-way: the target deps are
        // already up, so the re-prompt is a resume-or-cancel decision - show
        // only the leftover non-target prerequisites, don't offer "start them
        // too" again (it'd just re-enter and re-pause on the same gate).
        const chain = mode === 'deps'
        setDepPrompt({
          id,
          // a dependency error only ever comes from a start/restart, never a
          // stop - coerce the wider union down so it fits depPrompt's type
          action: action === 'stop' ? 'start' : action,
          deps: {
            met: false,
            reason: err.reason,
            missing_targets: chain ? (err.missingTargets ?? []) : (fresh?.missing_targets ?? err.missingTargets),
            external_prereqs: fresh?.external_prereqs ?? [],
          },
          fromChain: chain,
        })
      } else {
        console.error(`${action} ${id} failed`, err)
        // A plain validation 400 (e.g. the backend rejecting a flag) used to
        // produce NOTHING visible here - only this console.error, meaning
        // the only way to even notice a start had failed was reading
        // dashboard_server's own log by hand. Surfacing it as a toast too,
        // using the backend's own `detail` message when the error body
        // parses as JSON (the common shape for a FastAPI HTTPException),
        // falling back to the raw error text otherwise.
        let detail = err instanceof Error ? err.message : String(err)
        if (err instanceof Error) {
          const bodyStart = err.message.indexOf('{')
          if (bodyStart !== -1) {
            try {
              const parsed = JSON.parse(err.message.slice(bodyStart))
              if (typeof parsed?.detail === 'string') detail = parsed.detail
            } catch {
              // not JSON - keep the raw message
            }
          }
        }
        notify({ title: `${action} ${id} failed`, message: detail, severity: 'error', autoDismissMs: 8000 })
      }
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        for (const aid of affectedIds) next.delete(aid)
        return next
      })
    }
  }

  // Shared by runAction (the target actually clicked) and
  // buildDependencyFlags (every OTHER target that might get pulled in as a
  // chain dependency) - both need the exact same "filter selectedFlags
  // against this target's CURRENT known flags" logic, see its own comment
  // below for why the filter exists at all.
  function resolveFlagsFor(id: string): { flags: string[]; flagValues: Record<string, string> } {
    const sel = selectedFlags[id] ?? {}
    // selectedFlags is persisted to localStorage (usePersistentState) and
    // keyed by flag NAME - a name that's since been renamed/removed from
    // this target's own config (edited in Settings, or just stale from an
    // earlier session) stays sitting in there forever with nothing to ever
    // clear it. Sending it anyway hits the backend's "unknown flag(s)"
    // check and 400s the whole start - confirmed live, more than once.
    // Filtering against this target's CURRENT flags here means a stale
    // name is silently dropped instead of blocking every future start.
    const knownFlagNames = new Set((targets.find((t) => t.id === id)?.flags ?? []).map((f) => f.name))
    const flags: string[] = []
    const flagValues: Record<string, string> = {}
    for (const [name, val] of Object.entries(sel)) {
      if (!knownFlagNames.has(name)) continue
      if (val === true) flags.push(name)
      else if (val) { flags.push(name); flagValues[name] = val }
    }
    return { flags, flagValues }
  }

  // A dependency-chain start ('deps' mode) only ever sent the ONE target
  // actually clicked its own flags - every OTHER target the chain pulls in
  // along the way (e.g. person_face auto-started as a dependency
  // of person_identity, not clicked directly) got NO flags at all, silently
  // dropping whatever was toggled on that target's own row (confirmed live:
  // a GPU flag toggled on for days, silently ignored the moment the target
  // was started indirectly through a chain instead of directly). Rather
  // than precisely recompute which targets will actually be in the chain
  // client-side (duplicating the backend's own dependency_closure logic, or
  // an extra round trip), just send the CURRENT flag selection for every
  // target that has one set - the backend only ever applies a given
  // target's own entry to that same target as it walks the chain, so
  // sending extras for targets that turn out not to be in this particular
  // chain is harmless.
  function buildDependencyFlags(): Record<string, { flags: string[]; flag_values: Record<string, string> }> {
    const result: Record<string, { flags: string[]; flag_values: Record<string, string> }> = {}
    for (const t of targets) {
      const { flags, flagValues } = resolveFlagsFor(t.id)
      if (flags.length > 0) result[t.id] = { flags, flag_values: flagValues }
    }
    return result
  }

  async function runAction(id: string, action: 'start' | 'stop' | 'restart') {
    if (action === 'stop') {
      await doRunAction(id, action)
      return
    }
    // pending only gets set once doRunAction is actually called (below) -
    // getTargetDependencies is itself a real network round-trip, and
    // without guarding it too, a double-click during that window could
    // fire the pre-check (and doRunAction) twice concurrently for the
    // same target. doRunAction's own add/finally-delete of `id` still
    // runs on top of this and is a harmless no-op overlap either way.
    if (pending.has(id)) return
    setPending((prev) => new Set(prev).add(id))
    try {
      // Pre-check the start condition once up front - if it's unmet we show
      // the in-app prompt (Start deps / Start anyway / Cancel) instead of a
      // 409 the user never sees. Cheaper than a full round-trip + retry, and
      // the dialog is the whole point of this feature.
      const deps = await api
        .getTargetDependencies(id, resolveFlagsFor(id).flags)
        .catch((err) => {
          console.error('getTargetDependencies failed', err)
          return null
        })
      if (deps && !deps.met) {
        setDepPrompt({ id, action, deps, fromChain: false })
        return
      }
      await doRunAction(id, action)
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  async function runDialogDeps() {
    if (!depPrompt) return
    const { id, action, deps } = depPrompt
    setDepPrompt(null)
    await doRunAction(id, action, 'deps', [], deps.missing_targets)
  }

  async function runDialogAnyway() {
    if (!depPrompt) return
    const { id, action, deps, fromChain } = depPrompt
    setDepPrompt(null)
    if (fromChain) {
      // Resume a paused chain: pass the preconditions for the node(s) that
      // paused it this round (deps.missing_targets), spawn them, then keep
      // walking - prompting again on the next unmet node if there is one.
      await doRunAction(id, action, 'deps', deps.missing_targets, deps.missing_targets)
    } else {
      // Plain "start this one only": ignore the target's own gate.
      await doRunAction(id, action, 'force')
    }
  }

  // Chain-failure popup actions.
  async function runChainRetry() {
    if (!chainFail) return
    const { id, action, closure } = chainFail
    setChainFail(null)
    await doRunAction(id, action, 'deps', [], closure)
  }
  async function runChainStopAll() {
    if (!chainFail) return
    const { closure } = chainFail
    setChainFail(null)
    // Roll back every target the chain brought up (Stop all). Non-running ones
    // are a no-op; stopTarget on them just returns their status harmlessly.
    await Promise.all(closure.map((tid) => api.stopTarget(tid).catch((e) => console.error(`stop chain ${tid}`, e))))
  }

  // Manual kill via a row's "orphaned" tag - distinct from runAction, no
  // pending-state tracking needed (the row isn't showing a Start/Stop/
  // Restart transition here). The actual UI update (orphan_pid -> null)
  // arrives via the 'orphan_killed' event on /api/events, same as the
  // auto-kill-before-start path - not applied optimistically here, so both
  // triggers land through one consistent code path.
  async function killOrphan(id: string) {
    try {
      await api.killOrphan(id)
    } catch (err) {
      console.error(`killOrphan ${id} failed`, err)
    }
  }

  function toggleCategory(category: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  function toggleFlag(targetId: string, flagName: string) {
    setSelectedFlags((prev) => {
      const current = { ...(prev[targetId] ?? {}) }
      if (current[flagName] === true) delete current[flagName]
      else current[flagName] = true
      return { ...prev, [targetId]: current }
    })
  }

  function selectFlag(targetId: string, flagName: string, option: string) {
    setSelectedFlags((prev) => {
      const current = { ...(prev[targetId] ?? {}) }
      if (option) current[flagName] = option
      else delete current[flagName]
      return { ...prev, [targetId]: current }
    })
  }

  // Cross-category drags can't happen structurally (each category has its
  // own separate SortableContext/DndContext), so newOrderIds is always
  // exactly this category's own ids in their new order.
  function handleReorderTargets(newOrderIds: string[]) {
    const prev = targets
    const next = applyOrderWithinPositions(targets, newOrderIds)
    setTargets(next)
    api.reorderTargets(next.map((t) => t.id)).catch((err) => {
      console.error('reorderTargets failed', err)
      setTargets(prev)
    })
  }

  const query = searchQuery.trim().toLowerCase()
  const filtered = query
    ? targets.filter(
        (t) => t.label.toLowerCase().includes(query) || t.id.toLowerCase().includes(query) || t.category.toLowerCase().includes(query),
      )
    : targets

  const grouped: Record<string, TargetStatus[]> = {}
  for (const t of filtered) {
    if (!grouped[t.category]) grouped[t.category] = []
    grouped[t.category].push(t)
  }

  // Categories default to first-occurrence order (whatever targets.yaml
  // happens to list them in); categoryOrder overrides that once you've
  // dragged one. A category not yet in categoryOrder (new, or never
  // reordered) sorts after everything that IS ordered - Array.sort is
  // stable, so ties keep their original relative order, same reasoning
  // as load_targets()'s target_order sort on the backend.
  const categoryRank = new Map(categoryOrder.map((c, i) => [c, i]))
  const orderedCategories = Object.keys(grouped).sort(
    (a, b) => (categoryRank.get(a) ?? categoryOrder.length) - (categoryRank.get(b) ?? categoryOrder.length),
  )

  // Reordering only makes sense against the natural (unfiltered) set, for
  // both categories and the targets within them - search results mix rows
  // from wherever they happen to be, so dragging while a search is active
  // is disabled rather than silently doing something surprising.
  const dragEnabled = !query

  // Closes every open target row through the real toggle (disconnects its
  // log websocket, same as closing it by hand) rather than just clearing
  // expandedTargets directly, then collapses every category on top.
  function collapseAll() {
    for (const id of [...expandedTargets]) toggleTarget(id)
    setCollapsedCategories(new Set(orderedCategories))
  }

  return (
    <div>
      <div className="params-toolbar">
        <input
          type="text"
          placeholder="Search targets…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button className="flag-toggle" onClick={collapseAll}>
          Collapse all
        </button>
        <button className="flag-toggle" onClick={resetAllConsoleHeights} title="Reset every drag-resized console back to its default height">
          Reset console height
        </button>
      </div>

      {query && filtered.length === 0 && <p className="hint">No targets match "{searchQuery}".</p>}

      <DndContext
        sensors={categorySensors}
        collisionDetection={closestCenter}
        onDragStart={(e) => setActiveCategory(String(e.active.id))}
        onDragEnd={(e: DragEndEvent) => {
          setActiveCategory(null)
          const { active, over } = e
          if (!over || active.id === over.id) return
          const oldIndex = orderedCategories.indexOf(String(active.id))
          const newIndex = orderedCategories.indexOf(String(over.id))
          if (oldIndex === -1 || newIndex === -1) return
          setCategoryOrder(arrayMove(orderedCategories, oldIndex, newIndex))
        }}
        onDragCancel={() => setActiveCategory(null)}
      >
        <SortableContext items={orderedCategories} strategy={verticalListSortingStrategy}>
          {orderedCategories.map((category) => (
            <CategoryBlock
              key={category}
              category={category}
              items={grouped[category]}
              isOpen={query !== '' || !collapsedCategories.has(category)}
              dragEnabled={dragEnabled}
              expandedTargets={expandedTargets}
              logLinesByTarget={logLinesByTarget}
              selectedFlags={selectedFlags}
              pending={pending}
              searchQuery={searchQuery}
              onToggleCategory={toggleCategory}
              onToggleTarget={toggleTarget}
              onToggleFlag={toggleFlag}
              onSelectFlag={selectFlag}
              onRunAction={runAction}
              onReorderTargets={handleReorderTargets}
              onClearLogs={clearLogs}
              onKillOrphan={killOrphan}
            />
          ))}
        </SortableContext>
        <DragOverlay>
          {activeCategory ? <CategoryDragPreview category={activeCategory} count={grouped[activeCategory]?.length ?? 0} /> : null}
        </DragOverlay>
      </DndContext>

      {depPrompt && (
        <DependencyDialog
          label={depPrompt.id}
          reason={depPrompt.deps.reason}
          missingTargets={depPrompt.deps.missing_targets}
          externalPrereqs={depPrompt.deps.external_prereqs}
          fromChain={depPrompt.fromChain}
          busy={pending.has(depPrompt.id)}
          onStartDeps={runDialogDeps}
          onStartAnyway={runDialogAnyway}
          onCancel={() => setDepPrompt(null)}
        />
      )}
      {chainFail && (
        <ChainFailureDialog
          label={chainFail.id}
          reason={chainFail.reason}
          closure={chainFail.closure}
          busy={pending.has(chainFail.id)}
          onRetry={runChainRetry}
          onStopAll={runChainStopAll}
          onCancel={() => setChainFail(null)}
        />
      )}
    </div>
  )
}
