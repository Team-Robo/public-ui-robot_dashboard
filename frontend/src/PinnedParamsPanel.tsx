import { ParamDescriptor } from './api'
import ParamValueEditor from './ParamValueEditor'
import { validateEditValue } from './paramValue'

export interface PinEntry {
  fqn: string
  paramName: string
}

interface Props {
  entries: PinEntry[]
  paramsByLeaf: Record<string, ParamDescriptor[]>
  loadingLeaves: Set<string>
  errorByLeaf: Record<string, string>
  edits: Record<string, Record<string, string>>
  feedback: Record<string, Record<string, string>>
  onEditChange: (fqn: string, paramName: string, value: string) => void
  onSave: (fqn: string, p: ParamDescriptor) => void
  onUnpin: (fqn: string, paramName: string) => void
}

// Flat, non-recursive - unlike the tree, pins aggregate across nodes so
// there's no shared namespace to group by. Reuses the same edits/feedback
// state as the tree rows (not a separate copy), so editing here or in the
// tree stays in sync if both happen to be visible at once.
export default function PinnedParamsPanel({
  entries,
  paramsByLeaf,
  loadingLeaves,
  errorByLeaf,
  edits,
  feedback,
  onEditChange,
  onSave,
  onUnpin,
}: Props) {
  return (
    <>
      {entries.map(({ fqn, paramName }) => {
        const key = `${fqn}::${paramName}`
        const p = paramsByLeaf[fqn]?.find((row) => row.name === paramName)

        if (!p) {
          // Distinguish "still fetching, hang on" from "genuinely not
          // there" - conflating these was exactly the bug: every pin used
          // to flash "not currently available" on every page load, even
          // for a node that was running fine, just because the fetch
          // hadn't resolved yet.
          let status: string
          if (loadingLeaves.has(fqn)) status = 'loading…'
          else if (errorByLeaf[fqn]) status = errorByLeaf[fqn]
          else if (paramsByLeaf[fqn]) status = 'no longer exists on this node'
          else status = 'not currently available'

          return (
            <tr key={key} className="param-row">
              <td>
                <span className="hint">/{fqn}</span> {paramName}
              </td>
              <td colSpan={3} className="hint">
                {status}
              </td>
              <td>
                <button className="action" onClick={() => onUnpin(fqn, paramName)}>
                  Unpin
                </button>
              </td>
            </tr>
          )
        }

        const editValue = edits[fqn]?.[paramName] ?? ''
        const validity = validateEditValue(p.type, editValue)

        return (
          <tr key={key} className={feedback[fqn]?.[paramName]?.startsWith('rejected') ? 'param-row rejected' : 'param-row'}>
            <td title={p.description}>
              <span className="hint">/{fqn}</span> {paramName}
            </td>
            <td>
              {p.type}
              {p.read_only && <span className="hint"> (read-only)</span>}
            </td>
            <td>
              <ParamValueEditor
                type={p.type}
                value={editValue}
                onChange={(v) => onEditChange(fqn, paramName, v)}
                disabled={p.read_only}
                valid={validity.valid}
                message={validity.message}
              />
            </td>
            <td>
              <button className="action" disabled={p.read_only || !validity.valid} onClick={() => onSave(fqn, p)}>
                Set
              </button>
              <button className="action" onClick={() => onUnpin(fqn, paramName)}>
                Unpin
              </button>
            </td>
            <td className="hint">{feedback[fqn]?.[paramName] ?? ''}</td>
          </tr>
        )
      })}
    </>
  )
}
