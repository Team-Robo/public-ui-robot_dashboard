import HintIcon from './HintIcon'
import Modal from './Modal'

interface Props {
  label: string
  reason: string
  missingTargets: string[]
  externalPrereqs: string[]
  // True when this prompt was opened by a chained start pausing mid-way: the
  // target deps are already up, so the only choice is resume ("Start this")
  // or Cancel - "Start all" is meaningless (nothing new to start).
  fromChain: boolean
  busy: boolean
  onStartDeps: () => void
  onStartAnyway: () => void
  onCancel: () => void
}

// In-app modal (styled like SettingsModal's confirm, not a browser
// window.confirm) shown by the Control tab when a Start hits an unmet
// `requires` condition. The overlay clicks-through to Cancel; the panel's
// own clicks stopPropagation so clicking INSIDE it never dismisses a choice.
// The meaning of "Start this" / "Start all" depends on WHICH kind of unmet
// dependency triggered the dialog - the hint has to name the actual
// situation instead of a one-size-fits-all blurb.
function situationHint(fromChain: boolean, hasTargets: boolean, hasExternal: boolean): string {
  if (fromChain) {
    return 'Start this resumes the paused chain from here, skipping this precondition.'
  }
  if (hasTargets && hasExternal) {
    return "Start this skips every unmet dependency below and starts only this target. Start all starts the missing target dependencies first - the ⚠ items still need to be satisfied yourself either way."
  }
  if (hasTargets) {
    return 'Start this starts only this target, skipping its unmet dependencies. Start all starts the missing dependencies below first, then this one.'
  }
  if (hasExternal) {
    return "Start this starts only this target. Its unmet condition isn't a target the dashboard can start for you, so there's nothing else it could start first."
  }
  return 'Start this starts only this target, ignoring its unmet condition.'
}

export default function DependencyDialog({ label, reason, missingTargets, externalPrereqs, fromChain, busy, onStartDeps, onStartAnyway, onCancel }: Props) {
  const hasTargets = missingTargets.length > 0
  const hasExternal = externalPrereqs.length > 0
  return (
    <Modal onClose={onCancel} ariaLabel={`Start ${label}?`}>
      <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
        Start {label}?
        <HintIcon text={situationHint(fromChain, hasTargets, hasExternal)} />
      </strong>

      <div style={{ background: 'var(--bg-subtle, rgba(255,255,255,0.04))', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.6rem 0.75rem', fontSize: '0.9rem' }}>
        <code style={{ color: 'var(--text-dim)' }}>{reason}</code>
        {hasTargets && (
          <div style={{ marginTop: '0.4rem' }}>
            <span className="hint">{fromChain ? 'paused before:' : `would start ${missingTargets.length}:`} </span>
            {missingTargets.map((id) => (
              <span key={id} className="badge badge-stopped" style={{ marginRight: '0.25rem' }}>
                {id}
              </span>
            ))}
          </div>
        )}
        {hasExternal && (
          <div
            style={{
              marginTop: '0.5rem',
              paddingTop: '0.5rem',
              borderTop: '1px solid var(--border)',
              color: 'var(--warning, #e0a800)',
              fontSize: '0.9rem',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
              ⚠ Must satisfy yourself:
              <HintIcon text="Only target dependencies are auto-managed. The dashboard can't start these, and starting the targets above may not make them appear on its own." />
            </span>
            <div style={{ marginTop: '0.3rem', display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
              {externalPrereqs.map((p) => (
                <span
                  key={p}
                  style={{
                    border: '1px solid var(--warning, #e0a800)',
                    color: 'var(--warning, #e0a800)',
                    borderRadius: '4px',
                    padding: '0.1rem 0.4rem',
                    fontSize: '0.85rem',
                  }}
                >
                  {p}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="action" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="action" onClick={onStartAnyway} disabled={busy}>
          {busy ? 'Starting…' : 'Start this'}
        </button>
        {/* Genuinely inapplicable when fromChain (target deps are already up)
            or when there's nothing to start_dependencies (missingTargets
            empty - the unmet condition is non-target-only) - hidden rather
            than rendered disabled with situational text, so the label
            itself never has to explain why it's there or not. */}
        {!fromChain && hasTargets && (
          <button className="action" onClick={onStartDeps} disabled={busy}>
            {busy ? 'Starting…' : 'Start all'}
          </button>
        )}
      </div>
    </Modal>
  )
}
