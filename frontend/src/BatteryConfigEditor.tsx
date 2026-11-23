import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { api, BatteryConfig, BatteryStatus } from './api'
import { ConfigEditorHandle } from './ConfigEditorHandle'

const MONITOR_COLOR: Record<BatteryStatus['monitor']['state'], string> = {
  running: 'var(--ok)',
  stopped: 'var(--text-dim)',
  disabled: 'var(--text-dim)',
  exited: 'var(--warn)',
  failed: 'var(--danger)',
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.55rem' }}>
      <span style={{ minWidth: '170px' }} title={hint}>
        {label}
      </span>
      {children}
    </div>
  )
}

// Everything here is the hardcoded battery plumbing, in one place: the topic
// the header indicator reads, the BMS topic and hdas_msg install the monitor
// needs, and the thresholds. Saving applies live (the monitor is restarted if
// anything it uses changed). See battery.py.
const BatteryConfigEditor = forwardRef<ConfigEditorHandle>(function BatteryConfigEditor(_props, ref) {
  const [config, setConfig] = useState<BatteryConfig | null>(null)
  const [status, setStatus] = useState<BatteryStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savedRef = useRef<string | null>(null)

  useEffect(() => {
    api
      .getBatteryConfig()
      .then((c) => {
        setConfig(c)
        savedRef.current = JSON.stringify(c)
      })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = () => api.getBattery().then((s) => !cancelled && setStatus(s)).catch(() => {})
    poll()
    const interval = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  async function save(): Promise<boolean> {
    if (!config) return false
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const saved = await api.putBatteryConfig(config)
      setConfig(saved)
      savedRef.current = JSON.stringify(saved)
      setMessage('Saved and applied.')
      return true
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''))
      return false
    } finally {
      setSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({
    isDirty: () => config !== null && JSON.stringify(config) !== savedRef.current,
    save,
  }))

  if (error && !config) return <div className="input-error">{error}</div>
  if (!config) return <p className="hint">loading…</p>

  const set = (patch: Partial<BatteryConfig>) => setConfig({ ...config, ...patch })
  const num = (v: string, fallback: number) => (v.trim() === '' || Number.isNaN(Number(v)) ? fallback : Number(v))
  const wide = { flex: 1 } as const

  return (
    <div>
      <Row label="Show in header" hint="on by default; the indicator stays hidden until the first battery reading arrives, so it never shows on a machine without the robot">
        <input type="checkbox" checked={config.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span className="hint">hidden until a reading arrives</span>
      </Row>
      <Row label="Spawn battery monitor" hint="the dashboard runs `ros2 run battery_monitor battery_monitor` with the values below">
        <input type="checkbox" checked={config.spawn_monitor} onChange={(e) => set({ spawn_monitor: e.target.checked })} />
      </Row>
      <Row label="Battery state topic" hint="sensor_msgs/BatteryState - the monitor's output and the header indicator's input">
        <input type="text" style={wide} value={config.state_topic} onChange={(e) => set({ state_topic: e.target.value })} />
      </Row>
      <Row label="BMS topic" hint="hdas_msg/Bms published by Galaxea HDAS - the monitor's input">
        <input type="text" style={wide} value={config.bms_topic} onChange={(e) => set({ bms_topic: e.target.value })} />
      </Row>
      <Row label="hdas_msg install path" hint="root of Galaxea's hdas_msg install; its python and lib dirs are put on the monitor's path">
        <input type="text" style={wide} value={config.hdas_msg_path} onChange={(e) => set({ hdas_msg_path: e.target.value })} />
      </Row>
      <Row label="Capital mode" hint="how Bms.capital is read - units are unverified, so check against the robot's own battery display">
        <select value={config.capital_mode} onChange={(e) => set({ capital_mode: e.target.value as BatteryConfig['capital_mode'] })}>
          <option value="auto">auto (percent only if 0-100)</option>
          <option value="percent">percent</option>
          <option value="raw">raw (no percentage)</option>
        </select>
      </Row>
      <Row label="Warn below (%)">
        <input type="number" value={config.warn_pct} onChange={(e) => set({ warn_pct: num(e.target.value, config.warn_pct) })} />
      </Row>
      <Row label="Critical below (%)">
        <input type="number" value={config.critical_pct} onChange={(e) => set({ critical_pct: num(e.target.value, config.critical_pct) })} />
      </Row>
      <Row label="Stale after (s)">
        <input type="number" value={config.stale_sec} onChange={(e) => set({ stale_sec: num(e.target.value, config.stale_sec) })} />
      </Row>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.9rem 0 0.4rem' }}>
        <button className="action" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="action"
          onClick={() => api.restartBatteryMonitor().then(() => setMessage('Monitor restarted.')).catch((e) => setError(String(e)))}
          disabled={!config.spawn_monitor}
        >
          Restart monitor
        </button>
        {message && <span className="hint">{message}</span>}
      </div>
      {error && <div className="input-error">{error}</div>}

      {status && (
        <div style={{ marginTop: '1rem' }}>
          <div>
            Monitor:{' '}
            <strong style={{ color: MONITOR_COLOR[status.monitor.state] }}>{status.monitor.state}</strong>
            {status.monitor.message && <span className="hint"> — {status.monitor.message}</span>}
          </div>
          {status.monitor.log.length > 0 && (
            <pre
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                padding: '0.5rem',
                maxHeight: '160px',
                overflow: 'auto',
                fontSize: '0.78rem',
                whiteSpace: 'pre-wrap',
              }}
            >
              {status.monitor.log.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})

export default BatteryConfigEditor
