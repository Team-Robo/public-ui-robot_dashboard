import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as yaml from 'js-yaml'
import { api, FullTargetConfig, TargetFlag, TargetFlagOption } from './api'
import { ConfigEditorHandle } from './ConfigEditorHandle'
import { notifyTargetsChanged } from './configEvents'
import Dropdown from './Dropdown'
import HintIcon from './HintIcon'
import { usePersistentState } from './usePersistentState'
import YamlImportPanel, { mergeById } from './YamlImportPanel'

function blankTarget(): FullTargetConfig {
  return {
    id: '',
    label: '',
    category: '',
    kind: 'run',
    package: '',
    executable: '',
    launch_file: null,
    cmd: null,
    args: [],
    flags: [],
    env: {},
    cwd: null,
    autostart: false,
    ready_node_name: null,
    ready_timeout_sec: 10.0,
    estop_exempt: false,
    requires: null,
  }
}

// Keep in sync with dashboard/supervisor/conditions.py's _ATOMIC_KINDS
// (+ 'all'/'any'/'not'/'target', which that set doesn't itself include).
// This copy only drives instant inline validation while typing - save-time
// validate() there is the actual authority, so drift here can only ever
// produce a wrong/missing inline hint, never let something unsafe save.
const REQUIRES_KINDS = new Set([
  'all', 'any', 'not', 'target', 'node', 'topic', 'service', 'action',
  'device', 'file', 'env', 'platform', 'usb', 'custom', 'flag',
])

// Client-side mirror of supervisor/conditions.validate()'s *shape* checks
// (unknown kinds, bad arity, over-nesting). Referenced target-id existence is
// NOT checked here - that needs the whole set and is enforced on save.
function validateRequiresNode(expr: unknown, depth: number): string | null {
  if (depth > 64) return 'expression is nested too deeply'
  if (typeof expr !== 'object' || expr === null || Array.isArray(expr)) {
    return 'each predicate must be a YAML mapping like { target: webcam_publisher }'
  }
  const keys = Object.keys(expr)
  if (keys.length !== 1) return 'each predicate must have exactly one key'
  const kind = keys[0]
  const arg = (expr as Record<string, unknown>)[kind]
  if (kind === 'all' || kind === 'any') {
    if (!Array.isArray(arg) || arg.length === 0) return `'${kind}' needs a non-empty list`
    for (const sub of arg) {
      const err = validateRequiresNode(sub, depth + 1)
      if (err) return err
    }
    return null
  }
  if (kind === 'not') {
    const list = Array.isArray(arg) ? arg : [arg]
    for (const sub of list) {
      const err = validateRequiresNode(sub, depth + 1)
      if (err) return err
    }
    return null
  }
  if (!REQUIRES_KINDS.has(kind)) return `unknown predicate '${kind}'`
  return null
}

function textToRequires(text: string): { value: Record<string, unknown> | null; error: string | null } {
  if (!text.trim()) return { value: null, error: null }
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (e) {
    return { value: null, error: `invalid YAML: ${e}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: null, error: 'must be a YAML mapping like { all: [...] } or { target: webcam_publisher }' }
  }
  const keys = Object.keys(parsed)
  if (keys.length !== 1) {
    return { value: null, error: 'must have exactly one top-level key (all / any / not / an atomic predicate)' }
  }
  const err = validateRequiresNode(parsed, 0)
  if (err) return { value: null, error: err }
  return { value: parsed as Record<string, unknown>, error: null }
}

const REQUIRES_HINT =
  'Boolean start precondition - things that should ALL be true before you start (all / any / not, plus leaves: target / node / topic / service / action / device / file / env / platform / usb / custom / flag). Prefer target: <id> for anything the dashboard should auto-start. A non-target leaf (device:/topic:/...) is a prerequisite that must already hold - "Start dependencies too" only starts the target list, it never invents a device/topic. For a topic, either require it to be live or (better) depend on the target that publishes it. flag: <name> checks THIS target\'s own flag (e.g. `any: [not: {flag: use_gpu}, target: gpu_driver]` - only require gpu_driver when use_gpu is toggled on). blank = none.'

function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return env
}

// Everything targets.yaml can express, editable without SSHing into the
// robot to hand-edit YAML - see config_store.py/config_routes.py for the
// backend half (comment-preserving write, applied live via
// ProcessManager.reload_targets(), no restart needed). Deletion only
// takes effect on Save, and only if the backend agrees - it refuses to
// drop a target that's currently running, reported back via
// skipped_removals rather than silently ignored.
//
// forwardRef + useImperativeHandle so SettingsModal can ask "is there
// unsaved work here" and trigger a save before closing/switching away -
// see ConfigEditorHandle.ts.
const TargetsConfigEditor = forwardRef<ConfigEditorHandle>(function TargetsConfigEditor(_props, ref) {
  const [targets, setTargets] = useState<FullTargetConfig[] | null>(null)
  // Persisted - reopening Settings drops you back on the same row instead
  // of collapsed. Safe: this only ever reveals fresh GET-fetched fields
  // (the drafts that could make a restored-open row misleading - envDrafts/
  // argsDrafts - reset every load regardless), never stale unsaved edits.
  const [expandedId, setExpandedId] = usePersistentState<string | null>('dashboard.settings.targets.expandedId', null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  // The version this editor's current `targets` was loaded from - sent
  // back on save so the backend can tell whether someone else (another
  // device, another tab) changed things underneath this one. See
  // config_routes.py's conflict handling for what happens when it's stale.
  const [version, setVersion] = useState<string | null>(null)
  // What was last loaded from, or saved to, the server - compared against
  // current `targets` to answer isDirty(). Not state: changing it should
  // never itself trigger a re-render.
  const savedSnapshotRef = useRef<string | null>(null)
  // The env textarea's raw typed text, keyed by row index - kept separate
  // from t.env (the parsed Record used for save/dirty-tracking) because
  // textToEnv() drops any line without an "=" yet. If the textarea's
  // value were derived straight from t.env, typing "G" of "KEY=..." would
  // parse to {} and immediately re-render the box back to empty - every
  // keystroke before you reach "=" would get wiped. This draft is the
  // display source of truth while editing; t.env stays in sync on every
  // change for save purposes, it's just not read back for display.
  const [envDrafts, setEnvDrafts] = useState<Record<number, string>>({})
  // Same reasoning as envDrafts, for the args textarea's trailing/blank
  // lines getting stripped by filter(Boolean) before you can type into them.
  const [argsDrafts, setArgsDrafts] = useState<Record<number, string>>({})
  // The requires YAML textarea's raw typed text + its last client-side parse
  // error, keyed by row index (same reason as envDrafts/argsDrafts: deriving
  // the textarea from t.requires would wipe an incomplete edit; and the
  // parsed value is only committed to t.requires once it validates).
  const [requiresDrafts, setRequiresDrafts] = useState<Record<number, string>>({})
  const [requiresErrors, setRequiresErrors] = useState<Record<number, string | null>>({})

  function load() {
    api
      .getConfigTargets()
      .then(({ data, version: v }) => {
        setTargets(data)
        setVersion(v)
        savedSnapshotRef.current = JSON.stringify(data)
        setEnvDrafts({})
        setArgsDrafts({})
        setRequiresDrafts({})
        setRequiresErrors({})
      })
      .catch((err) => setError(String(err)))
  }

  useEffect(load, [])

  function updateTarget(index: number, patch: Partial<FullTargetConfig>) {
    setTargets((prev) => prev && prev.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  }

  function addTarget() {
    setTargets((prev) => [...(prev ?? []), blankTarget()])
    setExpandedId('') // the new blank target has id '' until edited
  }

  function removeTarget(index: number) {
    setTargets((prev) => prev && prev.filter((_, i) => i !== index))
  }

  function exportTargets() {
    if (!targets) return
    const blob = new Blob([yaml.dump({ targets })], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'targets.yaml'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function save(): Promise<boolean> {
    if (!targets) return false
    const ids = targets.map((t) => t.id)
    if (ids.some((id) => !id.trim())) {
      setError('every target needs a non-empty id')
      return false
    }
    if (new Set(ids).size !== ids.length) {
      setError('target ids must be unique')
      return false
    }
    const invalidRequiresIndex = Object.entries(requiresErrors).find(([, err]) => err)
    if (invalidRequiresIndex) {
      const [idxStr, err] = invalidRequiresIndex
      const label = targets[Number(idxStr)]?.id || `row ${Number(idxStr) + 1}`
      setError(`"${label}"'s requires field is invalid (${err}) - fix or clear it before saving`)
      return false
    }
    setError(null)
    setSaving(true)
    setSaveMessage(null)
    try {
      const { data: result, version: newVersion } = await api.putConfigTargets(targets, version)
      if (result.conflict) {
        // Someone else saved since this editor loaded - additions/updates
        // went through, but nothing was deleted, and this editor's own
        // view is no longer trustworthy (it might be missing whatever
        // the other save added). Reload for real rather than trusting
        // local state, so what's shown actually matches what's on disk.
        setSaveMessage('Someone else changed this since you loaded it - your changes were merged in (nothing deleted), reloading the current version…')
        load()
        notifyTargetsChanged()
        return true
      }
      setVersion(newVersion)
      savedSnapshotRef.current = JSON.stringify(targets)
      notifyTargetsChanged()
      setSaveMessage(
        result.skipped_removals && result.skipped_removals.length > 0
          ? `Saved - but couldn't remove [${result.skipped_removals.join(', ')}]: still running. Stop it first, then save again.`
          : 'Saved and applied.',
      )
      return true
    } catch (err) {
      setError(String(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({
    isDirty: () => targets !== null && JSON.stringify(targets) !== savedSnapshotRef.current,
    save,
  }))

  if (error && !targets) return <div className="input-error">{error}</div>
  if (!targets) return <p className="hint">loading…</p>

  return (
    <div>
      {targets.map((t, i) => {
        const isOpen = expandedId === t.id
        return (
          <div key={i} className="tree-row leaf" style={{ marginBottom: '0.3rem', cursor: 'default' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
              onClick={() => setExpandedId(isOpen ? null : t.id)}
            >
              <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
              <strong>{t.label || t.id || '(unnamed target)'}</strong>
              <span className="hint">
                {t.id || '<no id>'} · {t.category || '<no category>'}
              </span>
            </div>

            {isOpen && (
              <div style={{ marginTop: '0.5rem', paddingLeft: '1.5rem', display: 'grid', gap: '0.4rem', maxWidth: '520px' }}>
                <label>
                  id
                  <input type="text" value={t.id} onChange={(e) => updateTarget(i, { id: e.target.value })} style={{ width: '100%' }} />
                </label>
                <label>
                  label
                  <input type="text" value={t.label} onChange={(e) => updateTarget(i, { label: e.target.value })} style={{ width: '100%' }} />
                </label>
                <label>
                  category
                  <input
                    type="text"
                    value={t.category}
                    onChange={(e) => updateTarget(i, { category: e.target.value })}
                    style={{ width: '100%' }}
                  />
                </label>
                <div>
                  <div className="hint" style={{ marginBottom: '0.2rem' }}>kind</div>
                  <Dropdown
                    value={t.kind}
                    onChange={(v) => updateTarget(i, { kind: v as 'run' | 'launch' | 'windows' })}
                    options={[
                      { value: 'run', label: 'run' },
                      { value: 'launch', label: 'launch' },
                      { value: 'windows', label: 'windows' },
                    ]}
                  />
                </div>
                {t.kind === 'windows' ? (
                  <label>
                    cmd (one argv element per line - runs on the native Windows companion, not ros2 run/launch)
                    <textarea
                      rows={2}
                      value={(t.cmd ?? []).join('\n')}
                      onChange={(e) =>
                        updateTarget(i, { cmd: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
                      }
                      style={{ width: '100%' }}
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      package
                      <input
                        type="text"
                        value={t.package ?? ''}
                        onChange={(e) => updateTarget(i, { package: e.target.value })}
                        style={{ width: '100%' }}
                      />
                    </label>
                    {t.kind === 'run' ? (
                      <label>
                        executable
                        <input
                          type="text"
                          value={t.executable ?? ''}
                          onChange={(e) => updateTarget(i, { executable: e.target.value })}
                          style={{ width: '100%' }}
                        />
                      </label>
                    ) : (
                      <label>
                        launch_file
                        <input
                          type="text"
                          value={t.launch_file ?? ''}
                          onChange={(e) => updateTarget(i, { launch_file: e.target.value })}
                          style={{ width: '100%' }}
                        />
                      </label>
                    )}
                  </>
                )}
                <label>
                  args (one per line)
                  <textarea
                    rows={2}
                    value={argsDrafts[i] ?? t.args.join('\n')}
                    onChange={(e) => {
                      const text = e.target.value
                      setArgsDrafts((prev) => ({ ...prev, [i]: text }))
                      updateTarget(i, { args: text.split('\n').map((s) => s.trim()).filter(Boolean) })
                    }}
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  env (KEY=value, one per line)
                  <textarea
                    rows={2}
                    value={envDrafts[i] ?? envToText(t.env)}
                    onChange={(e) => {
                      const text = e.target.value
                      setEnvDrafts((prev) => ({ ...prev, [i]: text }))
                      updateTarget(i, { env: textToEnv(text) })
                    }}
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  cwd (optional)
                  <input
                    type="text"
                    value={t.cwd ?? ''}
                    onChange={(e) => updateTarget(i, { cwd: e.target.value || null })}
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  ready_node_name (optional - fully-qualified, e.g. /pose_estimation_node)
                  <input
                    type="text"
                    value={t.ready_node_name ?? ''}
                    onChange={(e) => updateTarget(i, { ready_node_name: e.target.value || null })}
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  ready_timeout_sec
                  <input
                    type="number"
                    value={t.ready_timeout_sec}
                    onChange={(e) => updateTarget(i, { ready_timeout_sec: Number(e.target.value) })}
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    requires (YAML - boolean start precondition)
                    <HintIcon text={REQUIRES_HINT} />
                  </span>
                  <textarea
                    rows={3}
                    value={requiresDrafts[i] ?? (t.requires ? yaml.dump(t.requires).trimEnd() : '')}
                    onChange={(e) => {
                      const text = e.target.value
                      setRequiresDrafts((prev) => ({ ...prev, [i]: text }))
                      const { value, error } = textToRequires(text)
                      setRequiresErrors((prev) => ({ ...prev, [i]: error }))
                      // Only commit on a VALID parse (error === null covers
                      // both "successfully parsed" and "legitimately
                      // cleared" - textToRequires returns {value: null,
                      // error: null} for blank text). While mid-edit typing
                      // produces invalid YAML, t.requires must stay at its
                      // last-good value, not go null - this field is a
                      // safety precondition; a transiently-invalid keystroke
                      // must never silently delete it (see save()'s own
                      // requiresErrors guard for the second half of this).
                      if (!error) {
                        updateTarget(i, { requires: value })
                      }
                    }}
                    placeholder={'all:\n  - target: webcam_publisher'}
                    style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                  />
                </label>
                {requiresErrors[i] && <div className="input-error">{requiresErrors[i]}</div>}
                <label>
                  <input type="checkbox" checked={t.autostart} onChange={(e) => updateTarget(i, { autostart: e.target.checked })} />{' '}
                  autostart
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={t.estop_exempt}
                    onChange={(e) => updateTarget(i, { estop_exempt: e.target.checked })}
                  />{' '}
                  estop_exempt (won't be stopped by the e-stop button)
                </label>

                <div>
                  <div className="hint" style={{ marginBottom: '0.3rem' }}>
                    flags (widgets shown in Control/Visualization tabs) - pick a type first, the
                    fields below change to match what it needs
                  </div>
                  {t.flags.map((f, fi) => {
                    const flagType = f.type ?? 'toggle'
                    const updateFlag = (patch: Partial<TargetFlag>) =>
                      updateTarget(i, { flags: t.flags.map((x, xi) => (xi === fi ? { ...x, ...patch } : x)) })
                    const removeFlag = () => updateTarget(i, { flags: t.flags.filter((_, xi) => xi !== fi) })
                    const options = f.options ?? []
                    const updateOption = (oi: number, patch: Partial<TargetFlagOption>) =>
                      updateFlag({ options: options.map((o, oxi) => (oxi === oi ? { ...o, ...patch } : o)) })
                    const addOption = () => updateFlag({ options: [...options, { name: '', label: '', arg: '' }] })
                    const removeOption = (oi: number) => updateFlag({ options: options.filter((_, oxi) => oxi !== oi) })

                    return (
                      <div key={fi} className="flag-editor-row">
                        <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.3rem' }}>
                          <Dropdown
                            value={flagType}
                            onChange={(v) => {
                              const nextType = v as 'toggle' | 'select' | 'text'
                              // Switching type: don't leave stale data from
                              // the PREVIOUS type sitting around unseen - arg
                              // only means something for toggle/text, options
                              // only for select.
                              updateFlag({
                                type: nextType,
                                arg: nextType === 'select' ? undefined : f.arg,
                                options: nextType === 'select' ? (options.length ? options : [{ name: '', label: '', arg: '' }]) : [],
                              })
                            }}
                            style={{ width: '18%' }}
                            options={[
                              { value: 'toggle', label: 'toggle' },
                              { value: 'select', label: 'select' },
                              { value: 'text', label: 'text' },
                            ]}
                          />
                          <input
                            type="text"
                            placeholder="name"
                            value={f.name}
                            onChange={(e) => updateFlag({ name: e.target.value })}
                            style={{ width: '20%' }}
                          />
                          <input
                            type="text"
                            placeholder={flagType === 'toggle' ? 'label (button text)' : 'label (optional)'}
                            value={f.label ?? ''}
                            onChange={(e) => updateFlag({ label: e.target.value || undefined })}
                            style={{ width: '25%' }}
                          />
                          {flagType !== 'select' && (
                            <input
                              type="text"
                              placeholder={flagType === 'text' ? 'arg template, e.g. -p rate_hz:={value}' : 'arg (e.g. debug:=true)'}
                              value={f.arg ?? ''}
                              onChange={(e) => updateFlag({ arg: e.target.value })}
                              style={{ width: '32%' }}
                            />
                          )}
                          <span className="subtab-close" onClick={removeFlag} title="remove flag">
                            ×
                          </span>
                        </div>

                        {flagType === 'text' && (
                          <input
                            type="text"
                            placeholder="input hint shown to the operator (optional)"
                            value={f.placeholder ?? ''}
                            onChange={(e) => updateFlag({ placeholder: e.target.value })}
                            style={{ width: '100%' }}
                          />
                        )}

                        {flagType === 'select' && (
                          <div style={{ marginLeft: '1rem' }}>
                            <div className="hint" style={{ marginBottom: '0.2rem' }}>
                              options (each becomes one dropdown choice; an implicit "None" is always
                              available too)
                            </div>
                            {options.map((o, oi) => (
                              <div key={oi} style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.2rem' }}>
                                <input
                                  type="text"
                                  placeholder="name"
                                  value={o.name}
                                  onChange={(e) => updateOption(oi, { name: e.target.value })}
                                  style={{ width: '20%' }}
                                />
                                <input
                                  type="text"
                                  placeholder="label"
                                  value={o.label}
                                  onChange={(e) => updateOption(oi, { label: e.target.value })}
                                  style={{ width: '30%' }}
                                />
                                <input
                                  type="text"
                                  placeholder="arg (e.g. -p device:=cuda:0)"
                                  value={o.arg}
                                  onChange={(e) => updateOption(oi, { arg: e.target.value })}
                                  style={{ width: '40%' }}
                                />
                                <span className="subtab-close" onClick={() => removeOption(oi)} title="remove option">
                                  ×
                                </span>
                              </div>
                            ))}
                            <button className="flag-toggle" onClick={addOption}>
                              + option
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  <button
                    className="flag-toggle"
                    onClick={() => updateTarget(i, { flags: [...t.flags, { name: '', label: '', arg: '', type: 'toggle', options: [] }] })}
                  >
                    + flag
                  </button>
                </div>

                <button className="action" onClick={() => removeTarget(i)} style={{ marginTop: '0.4rem' }}>
                  Delete target
                </button>
              </div>
            )}
          </div>
        )
      })}

      <div style={{ margin: '0.75rem 0' }}>
        <button className="flag-toggle" onClick={addTarget} style={{ marginRight: '0.4rem' }}>
          + Add target
        </button>
        <button className="flag-toggle" onClick={exportTargets}>
          Export YAML
        </button>
      </div>

      <YamlImportPanel<FullTargetConfig>
        parse={api.parseTargetsYaml}
        onMerge={(parsed) => {
          setTargets((prev) => mergeById(prev ?? [], parsed))
          // A row's env/args draft (see envDrafts/argsDrafts above) holds
          // raw typed text that wins over the derived value on every
          // render - if a paste/import overrides that same row's id, the
          // stale draft would otherwise keep showing (and re-committing
          // over) the freshly merged data instead of what was just pasted.
          setEnvDrafts({})
          setArgsDrafts({})
          setRequiresDrafts({})
          setRequiresErrors({})
        }}
        label="target"
      />

      {error && <div className="input-error">{error}</div>}
      {saveMessage && <div className="hint">{saveMessage}</div>}
      <button className="action" onClick={() => save()} disabled={saving}>
        {saving ? 'Saving…' : 'Save targets'}
      </button>
    </div>
  )
})

export default TargetsConfigEditor
