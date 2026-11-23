import { useRef, useState } from 'react'

// Folds `incoming` into `existing` by id - a matching id gets replaced in
// place (same position, so editing one entry via paste doesn't reshuffle
// the list), a new id gets appended. Shared by both config editors since
// it's genuinely generic, not domain-specific to targets or trees.
export function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const byId = new Map(existing.map((e) => [e.id, e]))
  for (const item of incoming) byId.set(item.id, item)
  return Array.from(byId.values())
}

interface Props<T extends { id: string }> {
  parse: (yamlText: string) => Promise<T[]>
  onMerge: (parsed: T[]) => void
  label: string // "target" | "tree" - used in copy only
}

// Paste and file-import share one control: loading a file just fills the
// same textarea a person would otherwise type/paste into, so there's one
// review-then-apply step regardless of how the YAML got there - nothing
// touches the editor's list until Apply, and nothing is saved to disk
// until the editor's own existing Save button afterward.
export default function YamlImportPanel<T extends { id: string }>({ parse, onMerge, label }: Props<T>) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  async function apply() {
    setBusy(true)
    setError(null)
    try {
      const parsed = await parse(text)
      onMerge(parsed)
      setText('')
      setOpen(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <button className="flag-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? 'Cancel paste/import' : `Paste or import ${label} YAML`}
      </button>
      {open && (
        <div style={{ marginTop: '0.5rem', maxWidth: '640px' }}>
          <p className="hint" style={{ marginTop: 0, marginBottom: '0.4rem' }}>
            A bare list, a single {label} pasted alone, or the whole file (top-level key included) all work.
            Matching ids replace in place; new ids get added. Nothing is written to disk until you Save {label}s
            below.
          </p>
          <textarea
            rows={9}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`- id: my_${label}\n  ...`}
            style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem' }}
          />
          <div style={{ marginTop: '0.4rem' }}>
            <button className="action" onClick={() => fileInputRef.current?.click()}>
              Load from file
            </button>
            <button className="action" onClick={apply} disabled={busy || !text.trim()}>
              {busy ? 'Applying…' : 'Apply to editor'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".yaml,.yml,text/yaml"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) file.text().then(setText)
              }}
            />
          </div>
          {error && <div className="input-error">{error}</div>}
        </div>
      )}
    </div>
  )
}
