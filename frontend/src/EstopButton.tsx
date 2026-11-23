import { useEstop } from './EstopContext'

// Deliberately no confirmation dialog - see plan's E-stop section: a
// confirmation step is the wrong safety pattern here, the whole point is
// zero friction between "press" and "everything mission-critical stops."
// Trigger/busy state and the keyboard shortcut both live in EstopContext,
// shared with BigEstopButton - see that file for why.
export default function EstopButton() {
  const { busy, trigger } = useEstop()

  return (
    <button className="estop-button" onClick={trigger} disabled={busy}>
      {busy ? 'STOPPING...' : 'E-STOP'}
    </button>
  )
}
