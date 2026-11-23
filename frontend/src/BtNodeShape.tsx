import { Handle, Position, type NodeProps } from '@xyflow/react'
import { LIVE_POLL_INTERVAL_MS, type BtCategory, type BtFlowNode } from './btLayout'

const CATEGORY_COLOR: Record<BtCategory, string> = {
  control: '#4c8dff',
  decorator: '#e0a03c',
  leaf: '#3ecf6e',
  subtree: '#b47cf0',
}

const CATEGORY_RADIUS: Record<BtCategory, string> = {
  control: '4px',
  decorator: '999px',
  leaf: '6px',
  subtree: '4px',
}

const LIVE_STATUS_COLOR: Record<string, string> = {
  SUCCESS: '#3ecf6e',
  FAILURE: '#e0473f',
  RUNNING: '#4c8dff',
  IDLE: '#9aa1ac',
  SKIPPED: '#9aa1ac',
}

// Stub-edit mode's own palette - deliberately reuses SUCCESS/FAILURE's
// live-status colors (green/red) so "this leaf will report success" reads
// the same way a real SUCCESS status would, rather than inventing a third
// unrelated color scheme to learn. Neutral blue (same as the 'control'
// category's own color) marks "clickable in this mode, not stubbed yet" -
// applies to EVERY node while the mode is on, including non-leaves, which
// are shown but not individually clickable (only bulk-clickable via their
// leaf descendants).
const STUB_STATE_COLOR: Record<string, string> = {
  success: '#3ecf6e',
  failure: '#e0473f',
}
const STUB_NEUTRAL_COLOR = '#4c8dff'

// Opacity for a node confirmed off the tree's current execution path. A
// hard on/off, not a gradual ramp - see btLayout.ts's BtNodeData docstring
// on `reached`/`flash` for why: computeReachedThisTick() already knows for
// certain on the very first poll, so there's nothing to "become more sure
// of" over time that would justify fading in slowly.
const STALE_OPACITY = 0.35

export default function BtNodeShape({ data }: NodeProps<BtFlowNode>) {
  const color = data.stubEditMode
    ? (data.stubState && STUB_STATE_COLOR[data.stubState]) ?? STUB_NEUTRAL_COLOR
    : data.liveStatus
      ? LIVE_STATUS_COLOR[data.liveStatus] ?? CATEGORY_COLOR[data.category]
      : CATEGORY_COLOR[data.category]
  const ports = Object.entries(data.ports).filter(([k]) => k !== 'ID')

  const stalePolls = data.stalePolls ?? 0
  // No live data yet (pre-first-poll) reads as neutral/full, same as the
  // static view - only an actual "not reached" verdict dims a node.
  const opacity = data.liveStatus && data.reached === false ? STALE_OPACITY : 1
  const justChanged = data.flash === true

  return (
    <div
      style={{
        position: 'relative',
        border: `2px solid ${color}`,
        borderRadius: CATEGORY_RADIUS[data.category],
        background: '#1c1f26',
        color: '#e6e8eb',
        padding: '0.4rem 0.65rem',
        minWidth: 170,
        maxWidth: 220,
        fontSize: '0.75rem',
        fontFamily: 'ui-monospace, monospace',
        opacity,
        boxShadow: justChanged ? `0 0 10px ${color}` : undefined,
        transition: 'opacity 0.3s ease, box-shadow 0.3s ease',
      }}
    >
      {data.tickOrder !== undefined && (
        <div
          title="Simulated tick order, derived from BT.CPP's Sequence/Fallback semantics - not measured timing"
          style={{
            position: 'absolute',
            top: -9,
            left: -9,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: color,
            color: '#14161a',
            fontSize: '0.62rem',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
          }}
        >
          {data.tickOrder + 1}
        </div>
      )}
      <Handle type="target" position={Position.Top} style={{ background: color, border: 'none' }} />
      <div style={{ fontWeight: 700, color }}>{data.nodeType}</div>
      {data.label !== data.nodeType && <div style={{ opacity: 0.85 }}>{data.label}</div>}
      {ports.length > 0 && (
        <div style={{ opacity: 0.6, fontSize: '0.68rem', marginTop: '0.2rem' }}>
          {ports.map(([k, v]) => (
            <div key={k}>
              {k}={v}
            </div>
          ))}
        </div>
      )}
      {data.note && <div style={{ color: '#e0473f', fontSize: '0.68rem', marginTop: '0.2rem' }}>{data.note}</div>}
      {data.stubEditMode && data.stubState && (
        <div style={{ color, fontWeight: 600, fontSize: '0.68rem', marginTop: '0.2rem' }}>
          STUB: {data.stubState.toUpperCase()}
        </div>
      )}
      {data.liveStatus && (
        <div style={{ color, fontWeight: 600, fontSize: '0.68rem', marginTop: '0.2rem' }}>
          {data.liveStatus}
          {stalePolls > 0 && (
            <span style={{ opacity: 0.6, fontWeight: 400 }}> · {Math.round((stalePolls * LIVE_POLL_INTERVAL_MS) / 1000)}s</span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: color, border: 'none' }} />
    </div>
  )
}
