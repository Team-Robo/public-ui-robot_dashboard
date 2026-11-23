import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'
import { BtNode } from './api'

export type BtCategory = 'control' | 'decorator' | 'leaf' | 'subtree'

// Shared with the live-status poll loop, and with BtNodeShape for
// converting a staleness count back into "Ns ago" for display.
export const LIVE_POLL_INTERVAL_MS = 1000

// Recording polls much faster than the calm live view, so it can catch
// transitions between polls that a human watching the 1Hz view would miss.
// 50ms = 20Hz, 2x oversampling of bt_main.cpp's own 10Hz tick loop
// (`rclcpp::Rate rate(10)`) - fast enough that no single tick's snapshot
// should ever fall entirely between two polls. This does NOT capture the
// sub-tick internal traversal order within one tick (root -> Sequence ->
// leaf -> back up) - that's not observable via the ZMQ STATUS feed at any
// poll rate, since it only ever reports the tree's state at the instant
// you ask, not a trace of how it got there. What it does capture: every
// distinct tick-to-tick state the tree actually passed through, so a
// transition too fast to see live can be scrubbed back to afterward.
export const RECORD_POLL_INTERVAL_MS = 50
// Hard cap so a forgotten "stop recording" can't grow the buffer forever.
export const MAX_RECORD_FRAMES = 1200 // 60s at RECORD_POLL_INTERVAL_MS

// Storage/UI value for a stubbed leaf - absent (undefined) means "normal,
// not stubbed" (never itself a value in the map, see StubEdit's own
// comments in BehaviorTreeTab.tsx). Cycle order used everywhere a click
// advances state: undefined -> 'success' -> 'failure' -> undefined.
export type StubState = 'success' | 'failure'

export interface BtNodeData extends Record<string, unknown> {
  label: string
  nodeType: string
  ports: Record<string, string>
  category: BtCategory
  // Stable per-instance address (see BtNode.full_path's own comment) -
  // only leaves ever have a meaningful stubState, but every node carries
  // its own fullPath so a control-node click can enumerate its leaf
  // descendants' paths without a second tree walk.
  fullPath: string
  // Only ever set (to 'success'/'failure') while stub-edit mode is on -
  // undefined the rest of the time, including for non-leaf nodes, which
  // are never individually stubbable.
  stubState?: StubState
  // True on every node while stub-edit mode is active (regardless of
  // category or stubState) - BtNodeShape needs this to distinguish "not
  // stubbed, not in this mode at all" (normal category color) from "not
  // stubbed, but this mode IS on" (the neutral blue that signals
  // clickability), which stubState alone (undefined either way) can't.
  stubEditMode?: boolean
  note?: string
  // Set only in live/recording/playback modes, via deriveLiveStates() -
  // absent entirely in the static (B1) view.
  liveStatus?: string
  // Was this node on the tree's current execution path as of the last
  // poll, per computeReachedThisTick(). This is a direct, confident
  // per-poll answer (not an inference that needs multiple polls to trust)
  // so it drives opacity as a hard on/off, not a gradual fade - see
  // BtNodeShape for why a gradual ramp was wrong here.
  reached?: boolean
  // True only on the poll where this node either (a) just came back onto
  // the active path after not being on it, or (b) is still on the path
  // but its status value just changed (e.g. SUCCESS->FAILURE). Drives the
  // one-shot glow. A node that's steadily reached with an unchanging
  // result does NOT flash every poll - that would be constant noise for
  // any node that's simply healthy.
  flash?: boolean
  // Consecutive polls this node has NOT been reached. Purely a display
  // number now (the "· Ns" label = "off the active path for Ns") - it no
  // longer drives opacity, see BtNodeShape.
  stalePolls?: number
  // This node's position in the DERIVED (not measured) call order for the
  // tick that produced the current status snapshot - see
  // walkExecutionOrder()'s docstring in btLayout.ts for why this is a
  // sound reconstruction, not a guess, and what it can't tell you (real
  // wall-clock/microsecond timing). Undefined for unreached nodes - they
  // weren't part of this tick's call sequence.
  tickOrder?: number
}

export type BtFlowNode = Node<BtNodeData, 'btNode'>

const NODE_WIDTH = 190

// BtNodeShape's actual rendered height is NOT constant - it grows with one
// line per port, plus optional label/note lines - but dagre needs a height
// per node up front to compute rank spacing. Feeding it a fixed constant
// made every rank's gap sized for the smallest node (a bare "Sequence"),
// so anything with several ports (a SubTree call with 5+ remapped ports,
// GetNameAndDrink's port list, ...) rendered taller than dagre allotted and
// visually overlapped the rank below it. These estimates mirror
// BtNodeShape's own CSS (padding, font sizes, margins) closely enough to
// avoid that - they don't need to be pixel-exact, just never an
// underestimate for a node with real content.
//
// One port line can ALSO wrap to several lines on its own, and the first
// version of this only ever budgeted PORT_LINE_HEIGHT once per port,
// regardless of how long its value was - fine for a short one, badly wrong
// for e.g. PickLine's own `options` port (a pipe-separated list of full
// sentences, 285 characters in hri_challenge.xml's own guest-greeting
// line) which wraps to ~10 real lines in a ~199px-wide monospace box, not
// the 1 line this assumed. Confirmed live: that single underestimate was
// enough to throw off dagre's rank-height budget for its whole rank,
// which cascaded into large blank gaps in OTHER, correctly-sized parts of
// that same rank and visual overlap where the actual (correctly wrapping)
// box outgrew the slot dagre had planned for it. PORT_CHARS_PER_LINE is a
// rough monospace estimate (content width ~199px at 0.68rem, "key=value"
// counted together since that's how BtNodeShape renders it) - doesn't
// need to be pixel-exact, just never an underestimate.
const BASE_HEIGHT = 34 // padding + the nodeType header line
const LABEL_LINE_HEIGHT = 16 // instance label, when it differs from nodeType
const PORT_BLOCK_MARGIN = 4
const PORT_LINE_HEIGHT = 14
const PORT_CHARS_PER_LINE = 30
const NOTE_BLOCK_HEIGHT = 18
const MIN_NODE_HEIGHT = 44

function estimateNodeHeight(data: BtNodeData): number {
  let height = BASE_HEIGHT
  if (data.label !== data.nodeType) height += LABEL_LINE_HEIGHT
  const ports = Object.entries(data.ports).filter(([k]) => k !== 'ID')
  if (ports.length > 0) {
    const wrappedLines = ports.reduce(
      (sum, [k, v]) => sum + Math.max(1, Math.ceil((k.length + 1 + v.length) / PORT_CHARS_PER_LINE)),
      0,
    )
    height += PORT_BLOCK_MARGIN + wrappedLines * PORT_LINE_HEIGHT
  }
  if (data.note) height += NOTE_BLOCK_HEIGHT
  return Math.max(height, MIN_NODE_HEIGHT)
}

// Structural heuristic, not name-based: BT.CPP convention is 2+ children =
// control flow (Sequence/Fallback/Parallel/...), exactly 1 child =
// decorator (Inverter/Repeat/...), 0 children = a leaf (Action or
// Condition - XML alone can't tell those apart, that needs the node's
// actual C++ registration). SubTree is tagged explicitly by the backend
// parser regardless of child count.
function categorize(node: BtNode): BtCategory {
  if (node.type === 'SubTree') return 'subtree'
  if (node.children.length >= 2) return 'control'
  if (node.children.length === 1) return 'decorator'
  return 'leaf'
}

// Flattens the recursive tree into React Flow's node/edge lists, then runs
// dagre once to compute an initial top-to-bottom layout (the caller owns
// node state after this - dragging moves them freely, this is just a
// starting point).
//
// Node ids: prefer BT.CPP's own `_uid` when present (live/B2+ mode, where
// the live-status poll needs to look nodes up by uid to attach status),
// falling back to a child-index path (e.g. "0-1-0") for the static B1 case
// where the source XML never has `_uid` - path ids also guarantee
// uniqueness even with repeated instance names like two "Speak" leaves.
export function buildFlowGraph(
  root: BtNode,
  stubLeaves: Record<string, StubState> = {},
): { nodes: BtFlowNode[]; edges: Edge[]; leafPathsById: Record<string, string[]> } {
  const nodes: BtFlowNode[] = []
  const edges: Edge[] = []
  // this node's id -> full_path of every leaf in its OWN subtree
  // (itself, if it's a leaf) - precomputed here (one walk) rather than
  // re-derived on every stub-edit click against the raw BtNode tree, and
  // exposed by REACT FLOW id (uid-or-path) since that's what a click
  // handler actually has to key off of.
  const leafPathsById: Record<string, string[]> = {}

  function walk(node: BtNode, path: string, parentId: string | null) {
    const id = node.uid != null ? String(node.uid) : path
    leafPathsById[id] = collectLeafPaths(node)
    nodes.push({
      id,
      type: 'btNode',
      position: { x: 0, y: 0 },
      data: {
        label: node.instance_name,
        nodeType: node.type,
        ports: node.ports,
        category: categorize(node),
        fullPath: node.full_path,
        stubState: stubLeaves[node.full_path],
        note: node.note,
      },
    })
    if (parentId !== null) {
      edges.push({ id: `${parentId}->${id}`, source: parentId, target: id })
    }
    node.children.forEach((child, i) => walk(child, `${path}-${i}`, id))
  }

  walk(root, '0', null)

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 56 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: estimateNodeHeight(n.data) })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)

  for (const n of nodes) {
    const pos = g.node(n.id)
    n.position = { x: pos.x - NODE_WIDTH / 2, y: pos.y - estimateNodeHeight(n.data) / 2 }
  }

  return { nodes, edges, leafPathsById }
}

// Every LEAF (category 'leaf') full_path in the subtree rooted at `node`,
// inclusive of `node` itself if it happens to be a leaf. Used both for
// "is this node individually stubbable" (a 1-element result) and for a
// control/decorator/subtree node's bulk-toggle click (its own descendants).
export function collectLeafPaths(node: BtNode): string[] {
  if (categorize(node) === 'leaf') return [node.full_path]
  return node.children.flatMap(collectLeafPaths)
}

const STUB_CYCLE: (StubState | undefined)[] = [undefined, 'success', 'failure']

export function nextStubState(current: StubState | undefined): StubState | undefined {
  return STUB_CYCLE[(STUB_CYCLE.indexOf(current) + 1) % STUB_CYCLE.length]
}

// Bulk click on a control/decorator/subtree node: advance ALL its leaf
// descendants together, one step past whichever state is currently the
// MAJORITY among them - not a blind "set everything to X", so clicking a
// mixed-state group moves it toward consensus first, then keeps cycling
// as a block once it's uniform. Ties broken by cycle order (undefined
// beats success beats failure) - an arbitrary but deterministic choice,
// documented here since there's no "correct" tie-break otherwise.
export function bulkCycleStubState(
  current: Record<string, StubState>,
  paths: string[],
): Record<string, StubState> {
  const counts = new Map<StubState | undefined, number>()
  for (const p of paths) {
    const s = current[p]
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  let majority: StubState | undefined = undefined
  let best = -1
  for (const s of STUB_CYCLE) {
    const c = counts.get(s) ?? 0
    if (c > best) {
      best = c
      majority = s
    }
  }
  const next = nextStubState(majority)
  const result = { ...current }
  for (const p of paths) {
    if (next === undefined) delete result[p]
    else result[p] = next
  }
  return result
}

// Computes which nodes were structurally part of THIS tick's execution
// path, using BT.CPP's own documented (not reverse-engineered) short-
// circuit semantics for Sequence/Fallback: a Sequence stops ticking at the
// first non-SUCCESS child, a Fallback stops at the first non-FAILURE child
// - children after that point were never reached this tick.
//
// This exists because "did the status byte change since last poll" (the
// original staleness signal) can't tell "genuinely re-executed with the
// same result" apart from "frozen, not touched this round" - a healthily
// steady tree (e.g. a demo with constant input, re-succeeding identically
// every tick) looked like it was dying, when it was actually working fine.
// Reachability fixes that: a node on the active path is always "fresh"
// regardless of whether its result repeated, and a node confidently
// determined to be off the active path is always "stale" immediately,
// without waiting for polls to accumulate.
//
// Only Sequence/Fallback are modelled - anything else (Parallel, custom
// control nodes like WithGaze, decorators, leaves, SubTree) defaults to
// "every child was reached." That's a deliberate safe default: it can only
// under-detect staleness (a rare false "fresh"), never mis-report a node
// that's genuinely executing as stale.
//
// This same walk also assigns each reached node a sequential `order` index
// - not a guess or a measurement, but the literal call order BT.CPP's
// tick() makes: a control node always ticks its children in XML/
// declaration order, and Sequence/Fallback's short-circuit rule (used
// above for reachability) is exactly what determines which children get
// ticked at all. So for a tree built only from these two control types,
// this order IS the real traversal order for whichever tick produced the
// given status snapshot - reconstructed after the fact from the tree
// structure + the resulting statuses, not observed directly (the wire
// protocol carries no timing or ordering data at all). It answers "in
// what order would this have happened" with certainty; it cannot answer
// "how many microseconds apart" - there's no way to recover that from a
// point-in-time snapshot, recorded or not. Order is only assigned within
// nodes actually reached this tick - a skipped/stale node wasn't part of
// the call sequence at all, so it gets no order.
function walkExecutionOrder(
  root: BtNode,
  statusByUid: Record<string, { current: string }>,
): { reached: Set<number>; order: Map<number, number> } {
  const reached = new Set<number>()
  const order = new Map<number, number>()
  let counter = 0

  function statusOf(node: BtNode): string | undefined {
    return node.uid != null ? statusByUid[String(node.uid)]?.current : undefined
  }

  function walk(node: BtNode, isReached: boolean) {
    if (isReached && node.uid != null) {
      reached.add(node.uid)
      order.set(node.uid, counter++)
    }

    if (!isReached) {
      for (const child of node.children) walk(child, false)
      return
    }

    if ((node.type === 'Sequence' || node.type === 'Fallback') && node.children.length > 0) {
      const stopStatus = node.type === 'Sequence' ? 'SUCCESS' : 'FAILURE'
      let stillGoing = true
      for (const child of node.children) {
        walk(child, stillGoing)
        if (stillGoing && statusOf(child) !== stopStatus) stillGoing = false
      }
    } else {
      for (const child of node.children) walk(child, true)
    }
  }

  walk(root, true)
  return { reached, order }
}

export function computeReachedThisTick(root: BtNode, statusByUid: Record<string, { current: string }>): Set<number> {
  return walkExecutionOrder(root, statusByUid).reached
}

export interface BtNodeLiveState {
  liveStatus: string
  reached: boolean
  flash: boolean
  stalePolls: number
  tickOrder?: number
}

// (reached, status) as of the last frame this node was seen, purely to
// detect the two events worth flashing for - carried forward frame to
// frame by the caller (poll loop or playback replay).
export interface BtTrackedState {
  reached: boolean
  status: string
}

// Pure per-frame state derivation, shared by the live poll loop AND
// playback (which replays a recorded buffer through this same function
// frame-by-frame at stop-time). Keeping this in one place matters: flash
// and reached must mean the same thing whether you're watching them happen
// in real time or scrubbing back through a recording afterward - see
// BehaviorTreeTab.tsx for both call sites.
export function deriveLiveStates(
  root: BtNode,
  status: Record<string, { current: string }>,
  prevTracked: Record<string, BtTrackedState>,
  prevStalePolls: Record<string, number>,
): { states: Record<string, BtNodeLiveState>; tracked: Record<string, BtTrackedState>; stalePolls: Record<string, number> } {
  const { reached: reachedSet, order } = walkExecutionOrder(root, status)
  const states: Record<string, BtNodeLiveState> = {}
  const tracked: Record<string, BtTrackedState> = {}
  const stalePolls: Record<string, number> = {}

  for (const [uidStr, s] of Object.entries(status)) {
    const isReached = reachedSet.has(Number(uidStr))
    const prev = prevTracked[uidStr]
    const flash = isReached && (prev === undefined || !prev.reached || prev.status !== s.current)
    tracked[uidStr] = { reached: isReached, status: s.current }
    stalePolls[uidStr] = isReached ? 0 : (prevStalePolls[uidStr] ?? 0) + 1
    states[uidStr] = {
      liveStatus: s.current,
      reached: isReached,
      flash,
      stalePolls: stalePolls[uidStr],
      tickOrder: isReached ? order.get(Number(uidStr)) : undefined,
    }
  }

  return { states, tracked, stalePolls }
}
