import { useEstop } from './EstopContext'

// The "just in case" button - lives in OperationsSplit's right column.
// Same trigger/busy state as the header's EstopButton (via EstopContext),
// just rendered huge so it's an easy target in a panic, not a separate
// action.
export default function BigEstopButton() {
  const { busy, trigger } = useEstop()

  return (
    <button className="estop-button-giant" onClick={trigger} disabled={busy}>
      {busy ? 'STOPPING…' : 'E-STOP'}
    </button>
  )
}
