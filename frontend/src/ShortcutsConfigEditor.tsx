import { useEffect, useState } from 'react'
import { comboFromEvent, formatCombo, getCombo, resetCombo, setCombo, SHORTCUTS } from './shortcuts'

// One row per registered shortcut (just e-stop today). "Record" arms a
// one-shot listener for the next real key combo pressed - Escape alone
// cancels the recording instead of binding, since Escape-to-cancel is the
// expected way out of a "press a key" prompt in most apps.
function ShortcutRow({ id, label }: { id: string; label: string }) {
  const [combo, setLocalCombo] = useState(() => getCombo(id))
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      if (e.code === 'Escape') {
        setRecording(false)
        return
      }
      const next = comboFromEvent(e)
      if (next === null) return // bare modifier - keep waiting
      setCombo(id, next)
      setLocalCombo(next)
      setRecording(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [recording, id])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
      <span style={{ minWidth: '140px' }}>{label}</span>
      <code
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '0.2rem 0.5rem',
          minWidth: '160px',
          textAlign: 'center',
        }}
      >
        {recording ? 'press a key…' : formatCombo(combo)}
      </code>
      <button className="action" onClick={() => setRecording(true)} disabled={recording}>
        Record
      </button>
      <button
        className="action"
        onClick={() => {
          resetCombo(id)
          setLocalCombo(getCombo(id))
        }}
        disabled={recording}
      >
        Reset
      </button>
    </div>
  )
}

export default function ShortcutsConfigEditor() {
  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Applies immediately, no save step. Works from anywhere on the site, including while typing in a field.
      </p>
      {SHORTCUTS.map((s) => (
        <ShortcutRow key={s.id} id={s.id} label={s.label} />
      ))}
    </div>
  )
}
