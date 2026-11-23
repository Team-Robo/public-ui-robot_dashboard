import HintIcon from './HintIcon'
import Modal from './Modal'

interface Props {
  label: string
  reason: string
  // The targets THIS chain attempt actually started (deps + the target,
  // never anything that predates it). "Stop all" tears down whichever of
  // these are currently running; "Cancel" leaves them.
  closure: string[]
  busy: boolean
  onRetry: () => void
  onStopAll: () => void
  onCancel: () => void
}

// Dedicated chain-failure popup, INDEPENDENT of the passive toast (which
// separately reports the specific node that crashed). A node in a chain we
// were opening failed to come up - the chain is aborted now (nothing further
// was started). Choices: Retry (re-open the chain), Stop all (roll back
// whatever it brought up), or Cancel (dismiss, leave running ones as-is).
export default function ChainFailureDialog({ label, reason, closure, busy, onRetry, onStopAll, onCancel }: Props) {
  return (
    <Modal onClose={onCancel} ariaLabel="Dependency chain failed to open">
      <strong>
        Dependency chain for {label} failed <HintIcon text="A dependency crashed coming up, so the chain stopped here - nothing further was started." />
      </strong>
      <div
        style={{
          background: 'var(--bg-subtle, rgba(255,255,255,0.04))',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '0.6rem 0.75rem',
          fontSize: '0.9rem',
        }}
      >
        <code style={{ color: 'var(--danger, #e5484d)' }}>{reason}</code>
        {closure.length > 0 && (
          <div style={{ marginTop: '0.4rem' }}>
            <span className="hint">started this round:</span>{' '}
            {closure.map((id) => (
              <span key={id} className="badge badge-stopped" style={{ marginRight: '0.25rem' }}>
                {id}
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="action" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
          <button className="action" onClick={onStopAll} disabled={busy}>
            {busy ? 'Stopping…' : 'Stop all'}
          </button>
          <HintIcon text="Stops only what this chain attempt started above - nothing that was already running beforehand." />
        </span>
        <button className="action" onClick={onRetry} disabled={busy}>
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    </Modal>
  )
}
