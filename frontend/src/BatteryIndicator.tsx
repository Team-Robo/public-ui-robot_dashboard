import { useEffect, useState } from 'react'
import { api, BatteryStatus } from './api'

const POLL_MS = 3000

const LEVEL_COLOR: Record<BatteryStatus['level'], string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  critical: 'var(--danger)',
  unknown: 'var(--text-dim)',
}

function tooltip(s: BatteryStatus): string {
  const lines = [`topic ${s.topic}`]
  if (s.data === null) {
    lines.push('no battery data received')
  } else {
    if (s.data.percentage !== null) lines.push(`${s.data.percentage.toFixed(0)} %`)
    if (s.data.voltage !== null) lines.push(`${s.data.voltage.toFixed(1)} V`)
    if (s.data.current !== null) lines.push(`${s.data.current.toFixed(1)} A`)
    lines.push(s.stale ? `STALE - last data ${s.data.age_sec.toFixed(0)} s ago` : `updated ${s.data.age_sec.toFixed(0)} s ago`)
  }
  lines.push(`monitor: ${s.monitor.state}${s.monitor.message ? ` (${s.monitor.message})` : ''}`)
  return lines.join('\n')
}

// Header battery readout - the monitor's sensor_msgs/BatteryState, polled.
// Grey (never green/red) whenever the data is missing or stale, so an old
// reading can't look like a healthy one. Hidden when disabled in Settings ->
// Battery, and until the first reading arrives.
export default function BatteryIndicator() {
  const [status, setStatus] = useState<BatteryStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = () =>
      api
        .getBattery()
        .then((s) => !cancelled && setStatus(s))
        .catch(() => !cancelled && setStatus(null))
    poll()
    const interval = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Hidden until a first reading has ever arrived - on a machine that isn't
  // the robot (no monitor, no BMS) there is nothing to show, and a permanent
  // grey "—" would just be noise. Once it HAS been seen, a later stall stays
  // visible (grey) rather than vanishing, since that is a real problem.
  if (!status || !status.enabled || status.data === null) return null

  const pct = status.data?.percentage ?? null
  const volts = status.data?.voltage ?? null
  const label = status.stale || status.data === null ? '—' : pct !== null ? `${pct.toFixed(0)}%` : volts !== null ? `${volts.toFixed(1)} V` : '—'
  const color = LEVEL_COLOR[status.level]
  // The bar fills in proportion to the charge; empty whenever the value isn't
  // trustworthy (no data, stale, or no percentage), same as the grey border.
  const fill = !status.stale && pct !== null ? Math.min(100, Math.max(0, pct)) : 0

  return (
    <span
      title={tooltip(status)}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '5rem',
        height: '2rem',
        border: `1px solid ${color}`,
        borderRadius: '6px',
        overflow: 'hidden',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        cursor: 'default',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: `${fill}%`,
          background: color,
          opacity: 0.45,
          transition: 'width 0.6s ease, background 0.3s ease',
        }}
      />
      <span style={{ position: 'relative', padding: '0 0.7rem' }}>{label}</span>
    </span>
  )
}
