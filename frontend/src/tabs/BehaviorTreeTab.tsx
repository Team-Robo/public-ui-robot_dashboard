import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, BtLiveStatus, BtNode, BtTreeConfig } from '../api'
import { onTreesChanged } from '../configEvents'
import {
  buildFlowGraph,
  bulkCycleStubState,
  BtTrackedState,
  deriveLiveStates,
  LIVE_POLL_INTERVAL_MS,
  MAX_RECORD_FRAMES,
  RECORD_POLL_INTERVAL_MS,
  StubState,
} from '../btLayout'
import BtNodeShape from '../BtNodeShape'
import MissionControls from '../MissionControls'
import { usePersistentState } from '../usePersistentState'

const nodeTypes = { btNode: BtNodeShape }

// Custom fit-view/fullscreen icons instead of React Flow's default fit-view
// button (also corner-bracket-shaped) - the two looked identical enough
// side by side to be genuinely confusing about which button did what.
// Diagonal arrows = fit the tree to the view; brackets = fullscreen.
function FitViewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

function FullscreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

// B1: static tree structure parsed from each declared tree's XML, rendered
// as an actual draggable node graph (React Flow + dagre for the initial
// layout) rather than an indented text tree - deliberately closer to
// Groot2's own presentation than the rest of this app's tree views.
// Multiple trees are first-class here (config/behavior_trees.yaml is its
// own file, not metadata bolted onto targets.yaml), each independently
// expandable, since this workspace already has 2 (main_tree, hri_challenge)
// and there's no reason to assume there's only ever one.
//
// B2+: "Go Live" fetches the tree fresh from its running Groot2Publisher
// (uid-annotated - see btLayout.ts) and polls status. See groot2_client.py's
// module docstring for the stale-status trap this works around: a node's
// wire status is indistinguishable between "just re-ticked with the same
// result" and "wasn't ticked this round, showing a frozen last value."
//
// First attempt compared each poll's status byte to the previous one
// (unchanged = stale). Wrong: a healthily steady tree (e.g. this demo with
// constant input) re-succeeds identically every tick, so EVERY node faded
// out immediately even though nothing was actually wrong - it made a
// working tree look like it was dying. Fixed by computing structural
// reachability instead (computeReachedThisTick, in btLayout.ts) - using
// BT.CPP's own documented Sequence/Fallback short-circuit semantics to
// determine which nodes were genuinely on this tick's execution path.
// A node on the path is always fresh, regardless of whether its result
// repeated; a node confidently off the path is always stale immediately.
//
// Record/playback: the 1Hz live view is too slow to catch a transition
// that happens between polls - bt_main.cpp ticks at 10Hz, so anything that
// changes and changes back within under a second is invisible live.
// "Record" polls at RECORD_POLL_INTERVAL_MS (20Hz, 2x the tree's own tick
// rate) into a raw buffer, capped at MAX_RECORD_FRAMES so a forgotten
// "stop" can't grow it forever. At "Stop Recording", that raw buffer gets
// collapsed down to STEPS - only the frames where something actually
// changed, dropping the (usually large majority of) identical polls in
// between. Playback then steps/scrubs through transitions one at a time,
// each labelled with how long that state held before the next change -
// "what did the tree actually do", not "here's 200 near-identical frames."
//
// This still does NOT reconstruct the sub-tick internal traversal order
// (root -> Sequence -> leaf -> back up within one tick) - that's not
// observable via the ZMQ STATUS feed at any poll rate, it only ever
// reports state at the instant asked, never a trace of how it got there.
// What CAN be derived, though, and is: for whichever tick produced a given
// step's snapshot, BT.CPP's own Sequence/Fallback semantics (documented,
// not reverse-engineered - same rule computeReachedThisTick already uses)
// fully determine the order children were ticked in. walkExecutionOrder()
// in btLayout.ts reconstructs that order after the fact and BtNodeShape
// renders it as small numbered badges on the reached nodes for the current
// step - a genuine, derived "what order did this happen in" answer, with
// an honest limit: it's logical/causal order, not measured wall-clock
// timing, and it's only guaranteed correct for Sequence/Fallback control
// nodes (everything else defaults to reached-but-unordered, same caveat
// computeReachedThisTick already carries).
export default function BehaviorTreeTab() {
  const [trees, setTrees] = useState<BtTreeConfig[]>([])
  // Persisted - which tree's static graph panel is open, same "which
  // sub-page am I viewing" category as the top-level tab. Deliberately
  // NOT the same for BtGraph's own live/recording/playback `mode` further
  // down - that's tied to an in-memory websocket/frame-buffer session
  // that doesn't survive a reload anyway, so persisting it would just
  // leave the UI pointed at a session that no longer exists.
  const [expandedTree, setExpandedTree] = usePersistentState<string | null>('dashboard.bt.expandedTree', null)
  const [structureByTree, setStructureByTree] = useState<Record<string, BtNode>>({})
  const [errorByTree, setErrorByTree] = useState<Record<string, string>>({})
  const [loadingTree, setLoadingTree] = useState<string | null>(null)

  useEffect(() => {
    function refresh() {
      api.listBtTrees().then(setTrees).catch((err) => console.error('listBtTrees failed', err))
    }
    refresh()
    // See ControlTab's identical subscription - Settings applies live on
    // the backend, but this list was only fetched once on mount.
    return onTreesChanged(refresh)
  }, [])

  function toggleTree(id: string) {
    setExpandedTree((prev) => (prev === id ? null : id))
  }

  // Fetches whichever tree is currently expanded - not just from a click
  // (toggleTree just flips the id), also from expandedTree starting out
  // already set on mount, since it's now persisted. A click and a
  // restored-from-reload id need the exact same "make sure its structure
  // is loaded" handling, so this is the one place that does it.
  useEffect(() => {
    if (!expandedTree || structureByTree[expandedTree] || loadingTree === expandedTree) return
    let cancelled = false
    setLoadingTree(expandedTree)
    api
      .getBtTreeStructure(expandedTree)
      .then((result) => {
        if (!cancelled) setStructureByTree((prev) => ({ ...prev, [expandedTree]: result.root }))
      })
      .catch((err) => {
        if (!cancelled) setErrorByTree((prev) => ({ ...prev, [expandedTree]: String(err) }))
      })
      .finally(() => {
        if (!cancelled) setLoadingTree(null)
      })
    return () => {
      cancelled = true
    }
  }, [expandedTree])

  return (
    <div>
      {trees.length === 0 && <p className="hint">No behavior trees configured (see config/behavior_trees.yaml).</p>}
      {trees.length > 0 && (
        <div className="params-toolbar">
          <button className="flag-toggle" onClick={() => setExpandedTree(null)}>
            Collapse all
          </button>
        </div>
      )}
      {trees.map((t) => {
        const isOpen = expandedTree === t.id
        const structure = structureByTree[t.id]
        return (
          <div key={t.id} style={{ marginBottom: '1rem' }}>
            <div className="tree-row group" onClick={() => toggleTree(t.id)}>
              <span className="tree-caret">{isOpen ? '▾' : '▸'}</span> {t.label}{' '}
              <span className="hint">
                ({t.package}/{t.tree_file})
              </span>
            </div>
            {isOpen && t.mission_control && <MissionControls />}
            {isOpen && (
              <div style={{ height: '580px', border: '1px solid var(--border)', borderRadius: '6px', marginTop: '0.5rem' }}>
                {loadingTree === t.id && <p className="hint" style={{ padding: '1rem' }}>Loading…</p>}
                {errorByTree[t.id] && <p className="hint" style={{ padding: '1rem' }}>{errorByTree[t.id]}</p>}
                {structure && (
                  <ReactFlowProvider>
                    <BtGraph treeId={t.id} staticRoot={structure} initialStubLeaves={t.stub_leaves} />
                  </ReactFlowProvider>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

type Mode = 'static' | 'live' | 'recording' | 'playback' | 'stub-edit'

interface RecordedFrame {
  tMs: number
  status: BtLiveStatus
}

type NodeStates = ReturnType<typeof deriveLiveStates>['states']

// One entry per DISTINCT state the tree passed through during a recording
// - not one entry per raw poll. `durationMs` is how long this state held
// before the next step (or before recording stopped, for the last step).
interface PlaybackStep {
  tMs: number
  durationMs: number
  states: NodeStates
}

// True if any node's (reached, status) pair differs between two derived
// state maps - i.e. whether `b` is worth showing as its own step, or is
// just a repeat of `a`. stalePolls/flash/tickOrder are derived FROM
// reached+status, so comparing those two fields alone is sufficient and
// avoids double-counting the same underlying change.
function statesDiffer(a: NodeStates, b: NodeStates): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const x = a[k]
    const y = b[k]
    if (!x || !y || x.reached !== y.reached || x.liveStatus !== y.liveStatus) return true
  }
  return false
}

// How fast playback auto-advances (Play button) - deliberately slower than
// the recording rate itself, so a burst of transitions that happened in
// under a second live can actually be watched, not just scrubbed.
const PLAYBACK_STEP_MS = 150

function BtGraph({
  treeId,
  staticRoot,
  initialStubLeaves,
}: {
  treeId: string
  staticRoot: BtNode
  initialStubLeaves: Record<string, StubState>
}) {
  // Display mode ('static' authoring vs 'live' recording/playback vs
  // 'stub-edit') - a preference, persists across reloads rather than
  // snapping back to authoring. Declared before stubLeaves/initialStatic
  // below since both need this MOUNT-TIME value to correctly restore a
  // stub-edit session that survives a refresh, not just remember that the
  // toolbar should say "Exit Stub Edit" while the graph itself renders
  // like nothing was ever selected (confirmed live: that mismatch is
  // exactly what happened before mode and stubLeaves/stubEditMode were
  // reconciled at initial render, not just after a click).
  const [mode, setMode] = usePersistentState<Mode>('dashboard.bt.mode', 'static')
  // Per-leaf stub selection (keyed by full_path, see BtNode's own comment).
  // Persisted (localStorage, per-tree key) rather than a plain useState -
  // confirmed live as a real bug otherwise: an in-progress, unsaved
  // selection was silently gone on a refresh/tab close, exactly the kind
  // of lost work this exists to prevent stubbing FROM causing. Lives
  // independently of `mode` and of the backend's last-SAVED value: leaving
  // stub-edit mode only switches the DISPLAY back to normal coloring, and
  // reloading restores the draft from localStorage, not from
  // initialStubLeaves - "Save Stub Rules" is the only thing that pushes it
  // to the backend. Seeded from initialStubLeaves the first time only (no
  // existing localStorage entry yet); deliberately NOT re-synced whenever
  // the initialStubLeaves prop reference changes afterward (it used to be,
  // via an effect - removed, since that re-sync fired on ordinary re-
  // fetches too and was the other half of the same lost-work bug: it
  // could silently stomp a fresh unsaved draft with the older saved value
  // moments after mount).
  const [stubLeaves, setStubLeaves] = usePersistentState<Record<string, StubState>>(
    `dashboard.bt.stubDraft.${treeId}`,
    initialStubLeaves,
  )
  const initialStatic = useMemo(() => {
    const g = buildFlowGraph(staticRoot, stubLeaves)
    if (mode !== 'stub-edit') return g
    return { ...g, nodes: g.nodes.map((n) => ({ ...n, data: { ...n.data, stubEditMode: true } })) }
    // Mount-time snapshot only, deliberately - recomputing on every
    // stubLeaves/mode change would blow away any manual node dragging by
    // rebuilding the whole dagre layout from scratch. Later updates go
    // through setNodes directly (enterStubEdit, handleStubNodeClick, the
    // stubLeaves-sync effect below), never back through this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticRoot])
  const [nodes, setNodes, onNodesChange] = useNodesState(initialStatic.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialStatic.edges)
  const { fitView } = useReactFlow()
  const [stubSaving, setStubSaving] = useState(false)
  const [stubSaveError, setStubSaveError] = useState<string | null>(null)
  // Whether the current draft differs from the backend's last-saved value -
  // computed fresh at mount (not just "false until the next click") so a
  // restored unsaved draft correctly shows "unsaved changes" immediately,
  // not only after you touch another node.
  const [stubDirty, setStubDirty] = useState(
    () => JSON.stringify(stubLeaves) !== JSON.stringify(initialStubLeaves),
  )
  const leafPathsByIdRef = useRef<Record<string, string[]>>(initialStatic.leafPathsById)
  // The poll loop below is async - by the time an in-flight
  // getBtLiveStatus() call resolves, `mode` may have already moved on
  // (e.g. Stop Recording -> playback). Reading the *state* `mode` inside
  // that callback would still see whatever value was captured in the
  // closure when the tick started, not the current one, so a straggler
  // response would overwrite playback with stale live data right after
  // stopping. This ref is updated synchronously on every render instead,
  // so the callback can check the real current mode after its await.
  const modeRef = useRef<Mode>(mode)
  modeRef.current = mode
  const [liveError, setLiveError] = useState<string | null>(null)
  const [recordFrameCount, setRecordFrameCount] = useState(0)
  const [playback, setPlayback] = useState<{ steps: PlaybackStep[]; index: number } | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  // The uid-annotated tree fetched when going live - computeReachedThisTick
  // needs the actual structure (parent/child + node types) on every poll,
  // not just the flattened React Flow nodes. Stays populated across
  // live/recording/playback (structure doesn't change mid-run); only
  // cleared when returning to the static view.
  const liveRootRef = useRef<BtNode | null>(null)
  const trackedRef = useRef<Record<string, BtTrackedState>>({})
  const stalePollsRef = useRef<Record<string, number>>({})
  const recordedFramesRef = useRef<RecordedFrame[]>([])
  const recordStartRef = useRef(0)

  // Fullscreen via the browser's own Fullscreen API on the graph's wrapper
  // div - large trees genuinely benefit from the extra space. Tracks
  // document.fullscreenElement (not just a local toggle) since the
  // browser's own Esc key exits fullscreen without going through our
  // button, and the button's icon/label needs to reflect that.
  const graphWrapperRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Deliberately a file, not a live sync between devices - two people
  // recording the same tree would otherwise stomp on each other's session
  // with no warning. Export/Import makes sharing a recording an explicit
  // action instead of ambient background state.
  const importInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === graphWrapperRef.current)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement === graphWrapperRef.current) {
      document.exitFullscreen()
    } else {
      graphWrapperRef.current?.requestFullscreen()
    }
  }

  function applyNodeStates(states: NodeStates) {
    setNodes((prevNodes) =>
      prevNodes.map((n) => {
        const s = states[n.id]
        if (!s) return n
        return {
          ...n,
          data: { ...n.data, liveStatus: s.liveStatus, reached: s.reached, flash: s.flash, stalePolls: s.stalePolls, tickOrder: s.tickOrder },
        }
      }),
    )
  }

  function resetToStatic() {
    setMode('static')
    setLiveError(null)
    setPlayback(null)
    setIsPlaying(false)
    liveRootRef.current = null
    trackedRef.current = {}
    stalePollsRef.current = {}
    recordedFramesRef.current = []
    const g = buildFlowGraph(staticRoot)
    setNodes(g.nodes)
    setEdges(g.edges)
  }

  // Stub-edit mode: a separate authoring view over the SAME static
  // structure (never the live one - stub selections have to exist before
  // a run starts, there's nothing to click on a running tree that would
  // make sense here), where every node is clickable and colored by
  // stubState instead of category/live-status. Reuses resetToStatic() to
  // leave - "exit" just means "go back to normal static coloring," it
  // does not discard stubLeaves (see that state's own comment above).
  function enterStubEdit() {
    setMode('stub-edit')
    setLiveError(null)
    const g = buildFlowGraph(staticRoot, stubLeaves)
    leafPathsByIdRef.current = g.leafPathsById
    setNodes(g.nodes.map((n) => ({ ...n, data: { ...n.data, stubEditMode: true } })))
    setEdges(g.edges)
  }

  // One handler for both a single leaf (its own 1-element leaf list) and a
  // control/decorator/subtree node (all its leaf descendants) - see
  // bulkCycleStubState's own comment for why a plain click and a bulk
  // click can share the exact same majority-then-advance logic.
  function handleStubNodeClick(id: string) {
    const paths = leafPathsByIdRef.current[id]
    if (!paths || paths.length === 0) return
    setStubLeaves((prev) => bulkCycleStubState(prev, paths))
    setStubDirty(true)
    setStubSaveError(null)
  }

  // Sets every leaf back to normal in one click, instead of cycling each
  // one individually 1-3 times to land back on "unstubbed" - the coloring
  // effect below picks this up the same way any other stubLeaves change
  // does, no separate re-render path needed.
  function clearAllStubs() {
    if (Object.keys(stubLeaves).length === 0) return
    setStubLeaves({})
    setStubDirty(true)
    setStubSaveError(null)
  }

  // Re-colors the graph whenever stubLeaves changes while the mode is
  // active - mirrors applyNodeStates' shape, but keyed by fullPath (stored
  // in each node's own data, not by id, since fullPath - not the React
  // Flow id - is what stubLeaves is actually keyed on).
  useEffect(() => {
    if (mode !== 'stub-edit') return
    setNodes((prevNodes) =>
      prevNodes.map((n) => ({ ...n, data: { ...n.data, stubState: stubLeaves[n.data.fullPath] } })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stubLeaves, mode])

  // Read-merge-write against the SAME config domain/version pattern every
  // other config-GUI save in this app uses (Settings' targets/trees
  // editors) - fetches the current version fresh right before writing
  // (not the version this tab happened to load with, which could be stale
  // if Settings was also open) rather than tracking X-Config-Version
  // through this whole tab just for one save button.
  async function saveStubLeaves() {
    setStubSaving(true)
    setStubSaveError(null)
    try {
      const { data: allTrees, version } = await api.getConfigTrees()
      const updated = allTrees.map((t) => (t.id === treeId ? { ...t, stub_leaves: stubLeaves } : t))
      await api.putConfigTrees(updated, version)
      setStubDirty(false)
    } catch (err) {
      setStubSaveError(String(err))
    } finally {
      setStubSaving(false)
    }
  }

  async function startLive() {
    try {
      const result = await api.getBtLiveStructure(treeId)
      liveRootRef.current = result.root
      trackedRef.current = {}
      stalePollsRef.current = {}
      const g = buildFlowGraph(result.root)
      setNodes(g.nodes)
      setEdges(g.edges)
      setLiveError(null)
      setMode('live')
    } catch (err) {
      setLiveError(String(err))
    }
  }

  // Reuses whatever live-structure is already loaded (from a prior "Go
  // Live" or recording) rather than re-fetching, so hopping straight from
  // live into recording doesn't cause a graph flicker. Fetches fresh only
  // if starting cold from the static view.
  async function startRecording() {
    try {
      if (!liveRootRef.current) {
        const result = await api.getBtLiveStructure(treeId)
        liveRootRef.current = result.root
        const g = buildFlowGraph(result.root)
        setNodes(g.nodes)
        setEdges(g.edges)
      }
      trackedRef.current = {}
      stalePollsRef.current = {}
      recordedFramesRef.current = []
      recordStartRef.current = performance.now()
      setRecordFrameCount(0)
      setPlayback(null)
      setIsPlaying(false)
      setLiveError(null)
      setMode('recording')
    } catch (err) {
      setLiveError(String(err))
    }
  }

  // Replays the raw recorded status snapshots through deriveLiveStates
  // exactly once, sequentially (same derivation function the live poll
  // uses, so "flash"/"reached" mean the same thing live or in a
  // recording), then collapses that into STEPS - keeping a frame only when
  // it differs from the last kept one. A steady tree recorded for 10s at
  // 20Hz produces ~200 raw polls but often just 1 step (nothing changed);
  // a tree that transitions a few times produces one step per transition,
  // each carrying how long the prior state held. This is what actually
  // answers "what did the tree do", not "here are all the polls."
  function stopRecording() {
    const liveRoot = liveRootRef.current
    const frames = recordedFramesRef.current
    if (!liveRoot || frames.length === 0) {
      setMode('live')
      return
    }
    let tracked: Record<string, BtTrackedState> = {}
    let stale: Record<string, number> = {}
    const steps: PlaybackStep[] = []
    for (const f of frames) {
      const derived = deriveLiveStates(liveRoot, f.status, tracked, stale)
      tracked = derived.tracked
      stale = derived.stalePolls
      const last = steps[steps.length - 1]
      if (last && !statesDiffer(last.states, derived.states)) {
        last.durationMs = f.tMs - last.tMs
      } else {
        steps.push({ tMs: f.tMs, durationMs: 0, states: derived.states })
      }
    }
    // index 0, not the last step - landing on the final (usually steady/
    // idle) frame looked indistinguishable from still being live, since
    // nothing about it visually differs from the tree's current state.
    // Starting at the actual first recorded transition is both what "1st
    // step" means and what makes playback obviously distinct from live.
    setPlayback({ steps, index: 0 })
    setMode('playback')
  }

  const RECORDING_FILE_KIND = 'robohome-bt-recording'

  // Plain JSON download, not a backend upload - the recording never leaves
  // this browser unless the user explicitly hands the file to someone
  // (Slack, email, USB, whatever channel they'd already use). No new
  // server-side storage, no "who can see this" question to answer.
  function exportRecording() {
    if (!playback) return
    const payload = {
      kind: RECORDING_FILE_KIND,
      version: 1,
      treeId,
      exportedAt: new Date().toISOString(),
      steps: playback.steps,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bt-recording-${treeId}-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function importRecording(file: File) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      setLiveError('not valid JSON')
      return
    }
    const record = parsed as { kind?: string; treeId?: string; steps?: PlaybackStep[] }
    if (record.kind !== RECORDING_FILE_KIND || !Array.isArray(record.steps) || record.steps.length === 0) {
      setLiveError('not a BT recording file')
      return
    }
    // Still loads it - the node ids just won't match anything on this
    // tree's graph, which reads as "nothing highlights while scrubbing"
    // rather than a hard failure, so surfacing why is more useful than
    // silently blocking it.
    setLiveError(
      record.treeId && record.treeId !== treeId
        ? `warning: recorded for tree "${record.treeId}", not "${treeId}" - states likely won't match this tree's nodes`
        : null,
    )
    try {
      if (!liveRootRef.current) {
        const result = await api.getBtLiveStructure(treeId)
        liveRootRef.current = result.root
        const g = buildFlowGraph(result.root)
        setNodes(g.nodes)
        setEdges(g.edges)
      }
    } catch (err) {
      setLiveError(`failed to load tree structure for playback: ${String(err)}`)
      return
    }
    setPlayback({ steps: record.steps, index: 0 })
    setIsPlaying(false)
    setMode('playback')
  }

  function resumeLive() {
    trackedRef.current = {}
    stalePollsRef.current = {}
    setPlayback(null)
    setIsPlaying(false)
    setLiveError(null)
    setMode('live')
  }

  function stepTo(index: number) {
    setPlayback((prev) => (prev ? { ...prev, index: Math.max(0, Math.min(prev.steps.length - 1, index)) } : prev))
  }
  function stepBack() {
    setIsPlaying(false)
    setPlayback((prev) => (prev ? { ...prev, index: Math.max(0, prev.index - 1) } : prev))
  }
  function stepForward() {
    setIsPlaying(false)
    setPlayback((prev) => (prev ? { ...prev, index: Math.min(prev.steps.length - 1, prev.index + 1) } : prev))
  }

  // Live/recording poll loop - both modes hit the same status endpoint and
  // run the same derivation, differing only in interval and in recording
  // also buffering the raw snapshot for later playback.
  useEffect(() => {
    if (mode !== 'live' && mode !== 'recording') return
    const intervalMs = mode === 'recording' ? RECORD_POLL_INTERVAL_MS : LIVE_POLL_INTERVAL_MS
    const interval = setInterval(async () => {
      const liveRoot = liveRootRef.current
      if (!liveRoot) return
      try {
        const status = await api.getBtLiveStatus(treeId)
        // Re-check after the await - mode may have moved on (e.g. Stop
        // Recording) while this request was in flight. A straggler
        // response landing after that must not overwrite playback.
        if (modeRef.current !== 'live' && modeRef.current !== 'recording') return
        const { states, tracked, stalePolls } = deriveLiveStates(liveRoot, status, trackedRef.current, stalePollsRef.current)
        trackedRef.current = tracked
        stalePollsRef.current = stalePolls
        applyNodeStates(states)
        setLiveError(null)

        if (modeRef.current === 'recording') {
          const tMs = performance.now() - recordStartRef.current
          recordedFramesRef.current.push({ tMs, status })
          const count = recordedFramesRef.current.length
          setRecordFrameCount(count)
          if (count >= MAX_RECORD_FRAMES) stopRecording()
        }
      } catch (err) {
        setLiveError(String(err))
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, intervalMs)
    return () => clearInterval(interval)
  }, [mode, treeId])

  // Applies whichever step the slider/step buttons point at.
  useEffect(() => {
    if (mode !== 'playback' || !playback) return
    const step = playback.steps[playback.index]
    if (!step) return
    applyNodeStates(step.states)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, playback])

  // Slow-motion auto-advance while "Play" is toggled on.
  useEffect(() => {
    if (!isPlaying || mode !== 'playback') return
    const interval = setInterval(() => {
      setPlayback((prev) => {
        if (!prev) return prev
        if (prev.index >= prev.steps.length - 1) {
          setIsPlaying(false)
          return prev
        }
        return { ...prev, index: prev.index + 1 }
      })
    }, PLAYBACK_STEP_MS)
    return () => clearInterval(interval)
  }, [isPlaying, mode])

  const currentStep = playback?.steps[playback.index]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '0.4rem 0.6rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        {mode === 'static' && (
          <>
            <button className="action" onClick={startLive}>
              Go Live
            </button>
            <button className="action" onClick={startRecording}>
              Record
            </button>
            <button className="action" onClick={() => importInputRef.current?.click()}>
              Import Recording
            </button>
            <button className="action" onClick={enterStubEdit}>
              Stub Edit{stubDirty ? ' *' : ''}
            </button>
          </>
        )}
        {mode === 'stub-edit' && (
          <>
            <button className="action active" onClick={resetToStatic}>
              Exit Stub Edit
            </button>
            <button
              className="action"
              onClick={clearAllStubs}
              disabled={stubSaving || Object.keys(stubLeaves).length === 0}
              title="Set every leaf back to normal"
            >
              Clear All
            </button>
            <button className="action" onClick={saveStubLeaves} disabled={stubSaving || !stubDirty}>
              {stubSaving ? 'Saving…' : 'Save Stub Rules'}
            </button>
            {!stubSaveError && (
              <span className="hint">
                click a leaf to cycle normal → succeed → fail; click a control node to cycle all its leaves
                together{stubDirty ? ' · unsaved changes' : ''}
              </span>
            )}
            {stubSaveError && <span className="hint">save failed: {stubSaveError}</span>}
          </>
        )}
        {mode === 'live' && (
          <>
            <button className="action active" onClick={resetToStatic}>
              Stop Live
            </button>
            <button className="action" onClick={startRecording}>
              Record
            </button>
            {!liveError && (
              <span className="hint">polling every {LIVE_POLL_INTERVAL_MS / 1000}s · dimmed = not on the tree's current active path</span>
            )}
          </>
        )}
        {mode === 'recording' && (
          <>
            <button className="action active" onClick={stopRecording}>
              Stop Recording
            </button>
            {!liveError && (
              <span className="hint">
                recording at {Math.round(1000 / RECORD_POLL_INTERVAL_MS)}Hz · {recordFrameCount} frames ·{' '}
                {((recordFrameCount * RECORD_POLL_INTERVAL_MS) / 1000).toFixed(1)}s
                {recordFrameCount >= MAX_RECORD_FRAMES - 1 ? ' · cap reached, stopping' : ''}
              </span>
            )}
          </>
        )}
        {mode === 'playback' && playback && currentStep && (
          <>
            <button className="action" onClick={resumeLive}>
              Resume Live
            </button>
            <button className="action" onClick={resetToStatic}>
              Exit
            </button>
            <button className="action" onClick={startRecording}>
              Re-record
            </button>
            <button className="action" onClick={exportRecording}>
              Export Recording
            </button>
            {playback.steps.length > 1 ? (
              <>
                <button className="action" onClick={stepBack} disabled={playback.index === 0}>
                  ◀ Step
                </button>
                <button className="action" onClick={() => setIsPlaying((p) => !p)}>
                  {isPlaying ? 'Pause' : 'Play'}
                </button>
                <button className="action" onClick={stepForward} disabled={playback.index === playback.steps.length - 1}>
                  Step ▶
                </button>
                <input
                  type="range"
                  min={0}
                  max={playback.steps.length - 1}
                  value={playback.index}
                  onChange={(e) => {
                    setIsPlaying(false)
                    stepTo(Number(e.target.value))
                  }}
                  style={{ width: '220px' }}
                />
                <span className="hint">
                  transition {playback.index + 1}/{playback.steps.length} · t=+{(currentStep.tMs / 1000).toFixed(2)}s · held{' '}
                  {(currentStep.durationMs / 1000).toFixed(2)}s · numbered badges = derived tick order, not measured timing
                </span>
              </>
            ) : (
              <span className="hint">no transitions during this recording - the tree stayed in one state the whole time</span>
            )}
          </>
        )}
        {liveError && <span className="hint">{liveError}</span>}
        <input
          ref={importInputRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // lets re-selecting the same file re-trigger onChange
            if (file) importRecording(file)
          }}
        />
      </div>
      <div ref={graphWrapperRef} style={{ flex: 1, minHeight: 0, background: isFullscreen ? 'var(--bg)' : undefined }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_event, node) => {
            if (mode === 'stub-edit') handleStubNodeClick(node.id)
          }}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          // This is a read-only visualization of a tree that's authored by
          // hand in XML, not a graph editor - there's no onConnect handler,
          // so dragging between handles (React Flow's default affordance)
          // was a dead-end interaction that didn't do anything. Disabling
          // it outright rather than leaving a control that looks live but
          // isn't. Node dragging stays on (nodesDraggable, untouched) -
          // repositioning for a clearer layout is a real, working feature.
          nodesConnectable={false}
        >
          <Background />
          <Controls showFitView={false}>
            <ControlButton onClick={() => fitView({ padding: 0.1 })} title="Fit view">
              <FitViewIcon />
            </ControlButton>
            <ControlButton onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              <FullscreenIcon />
            </ControlButton>
          </Controls>
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  )
}
