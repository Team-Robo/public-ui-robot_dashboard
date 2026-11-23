import { useRef, useState } from 'react'
import BatteryConfigEditor from './BatteryConfigEditor'
import { ConfigEditorHandle } from './ConfigEditorHandle'
import ShortcutsConfigEditor from './ShortcutsConfigEditor'
import TargetsConfigEditor from './TargetsConfigEditor'
import TreesConfigEditor from './TreesConfigEditor'
import { usePersistentState } from './usePersistentState'

interface Props {
  onClose: () => void
}

type Section = 'targets' | 'trees' | 'shortcuts' | 'battery'

// What closing/switching away is waiting on confirmation for - null means
// no confirm dialogue is showing (the common case: nothing unsaved, or
// nothing attempted yet).
type PendingAction = { kind: 'close' } | { kind: 'switch'; to: Section }

// Edits targets.yaml/behavior_trees.yaml through the dashboard itself
// instead of SSHing into the robot - see config_store.py's own module
// docstring for where these actually live (not the colcon-managed
// share/dashboard/config/ copy, a separate ~/.dashboard_*.yaml the GUI
// owns). Applies live on save, no restart.
export default function SettingsModal({ onClose }: Props) {
  // Persisted - re-opening Settings drops you back where you left off
  // instead of always defaulting to Targets, same as the top-level tab
  // and the Publish tab's own script instances already do.
  const [section, setSection] = usePersistentState<Section>('dashboard.settings.section', 'targets')
  const targetsRef = useRef<ConfigEditorHandle>(null)
  const treesRef = useRef<ConfigEditorHandle>(null)
  const batteryRef = useRef<ConfigEditorHandle>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)

  // Shortcuts has no save step at all (applies immediately) - nothing to
  // lose there, so it never blocks a close/switch.
  function activeHandle(): ConfigEditorHandle | null {
    if (section === 'targets') return targetsRef.current
    if (section === 'trees') return treesRef.current
    if (section === 'battery') return batteryRef.current
    return null
  }

  function requestClose() {
    if (activeHandle()?.isDirty()) {
      setPending({ kind: 'close' })
    } else {
      onClose()
    }
  }

  function requestSwitch(to: Section) {
    if (to === section) return
    if (activeHandle()?.isDirty()) {
      setPending({ kind: 'switch', to })
    } else {
      setSection(to)
    }
  }

  function resolvePending() {
    if (!pending) return
    if (pending.kind === 'close') onClose()
    else setSection(pending.to)
    setPending(null)
  }

  async function confirmSave() {
    setConfirmBusy(true)
    const ok = await activeHandle()?.save()
    setConfirmBusy(false)
    // A failed save leaves the dialogue open - the editor's own error
    // message (still visible underneath) says why, and closing/switching
    // anyway would silently throw that work away.
    if (ok) resolvePending()
  }

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          zIndex: 1000,
          display: 'flex',
          // Anchored from the top, not centered: tabs have different
          // heights, and centering made the title/tab row jump up and
          // down on every tab switch.
          alignItems: 'flex-start',
          justifyContent: 'center',
          paddingTop: '8vh',
        }}
        onClick={requestClose}
      >
        <div
          style={{
            background: 'var(--bg-panel)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            width: 'min(720px, 92vw)',
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.9rem 1.1rem',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <strong>Settings</strong>
            <span className="subtab-close" style={{ fontSize: '1.1rem' }} onClick={requestClose} title="close">
              ×
            </span>
          </div>

          <div style={{ display: 'flex', gap: '0.25rem', padding: '0.75rem 1.1rem 0' }}>
            <div className={`subtab-button${section === 'targets' ? ' active' : ''}`} onClick={() => requestSwitch('targets')}>
              Targets
            </div>
            <div className={`subtab-button${section === 'trees' ? ' active' : ''}`} onClick={() => requestSwitch('trees')}>
              Behavior Trees
            </div>
            <div className={`subtab-button${section === 'shortcuts' ? ' active' : ''}`} onClick={() => requestSwitch('shortcuts')}>
              Shortcuts
            </div>
            <div className={`subtab-button${section === 'battery' ? ' active' : ''}`} onClick={() => requestSwitch('battery')}>
              Battery
            </div>
          </div>

          <div style={{ padding: '1rem 1.1rem', overflowY: 'auto' }}>
            {section === 'targets' && <TargetsConfigEditor ref={targetsRef} />}
            {section === 'trees' && <TreesConfigEditor ref={treesRef} />}
            {section === 'shortcuts' && <ShortcutsConfigEditor />}
            {section === 'battery' && <BatteryConfigEditor ref={batteryRef} />}
          </div>
        </div>
      </div>

      {pending && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.4)',
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '1.25rem',
              width: 'min(360px, 88vw)',
            }}
          >
            <p style={{ marginTop: 0 }}>You have unsaved changes here.</p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="action" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button className="action" onClick={resolvePending}>
                Discard
              </button>
              <button className="action" onClick={confirmSave} disabled={confirmBusy}>
                {confirmBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
