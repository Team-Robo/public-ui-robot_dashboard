import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as yaml from 'js-yaml'
import { api, BtTreeConfig } from './api'
import { ConfigEditorHandle } from './ConfigEditorHandle'
import { notifyTreesChanged } from './configEvents'
import { usePersistentState } from './usePersistentState'
import YamlImportPanel, { mergeById } from './YamlImportPanel'

function blankTree(): BtTreeConfig {
  return { id: '', label: '', package: '', tree_file: '', target_id: null, groot2_port: null, stub_leaves: {}, mission_control: false }
}

// behavior_trees.yaml's list of registered trees - which XML files the BT
// tab knows about, not the tree structure itself (that's the actual XML,
// edited separately). Applies live on save (TreeRegistry.reload()), no
// restart needed - unlike targets there's no running-process state to
// worry about protecting, a tree registration is just metadata.
//
// forwardRef + useImperativeHandle - see TargetsConfigEditor's identical
// pattern / ConfigEditorHandle.ts for why.
const TreesConfigEditor = forwardRef<ConfigEditorHandle>(function TreesConfigEditor(_props, ref) {
  const [trees, setTrees] = useState<BtTreeConfig[] | null>(null)
  // Persisted - same reasoning as TargetsConfigEditor's identical field.
  const [expandedId, setExpandedId] = usePersistentState<string | null>('dashboard.settings.trees.expandedId', null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  // See TargetsConfigEditor's identical field - sent back on save so the
  // backend can tell a stale save from a current one.
  const [version, setVersion] = useState<string | null>(null)
  const savedSnapshotRef = useRef<string | null>(null)

  function load() {
    api
      .getConfigTrees()
      .then(({ data, version: v }) => {
        setTrees(data)
        setVersion(v)
        savedSnapshotRef.current = JSON.stringify(data)
      })
      .catch((err) => setError(String(err)))
  }

  useEffect(load, [])

  function updateTree(index: number, patch: Partial<BtTreeConfig>) {
    setTrees((prev) => prev && prev.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  }

  function addTree() {
    setTrees((prev) => [...(prev ?? []), blankTree()])
    setExpandedId('')
  }

  function removeTree(index: number) {
    setTrees((prev) => prev && prev.filter((_, i) => i !== index))
  }

  function exportTrees() {
    if (!trees) return
    const blob = new Blob([yaml.dump({ trees })], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'behavior_trees.yaml'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function save(): Promise<boolean> {
    if (!trees) return false
    const ids = trees.map((t) => t.id)
    if (ids.some((id) => !id.trim())) {
      setError('every tree needs a non-empty id')
      return false
    }
    if (new Set(ids).size !== ids.length) {
      setError('tree ids must be unique')
      return false
    }
    setError(null)
    setSaving(true)
    setSaveMessage(null)
    try {
      const { data: result, version: newVersion } = await api.putConfigTrees(trees, version)
      if (result.conflict) {
        setSaveMessage('Someone else changed this since you loaded it - your changes were merged in (nothing deleted), reloading the current version…')
        load()
        notifyTreesChanged()
        return true
      }
      setVersion(newVersion)
      savedSnapshotRef.current = JSON.stringify(trees)
      notifyTreesChanged()
      setSaveMessage('Saved and applied.')
      return true
    } catch (err) {
      setError(String(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({
    isDirty: () => trees !== null && JSON.stringify(trees) !== savedSnapshotRef.current,
    save,
  }))

  if (error && !trees) return <div className="input-error">{error}</div>
  if (!trees) return <p className="hint">loading…</p>

  return (
    <div>
      {trees.map((t, i) => {
        const isOpen = expandedId === t.id
        return (
          <div key={i} className="tree-row leaf" style={{ marginBottom: '0.3rem', cursor: 'default' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
              onClick={() => setExpandedId(isOpen ? null : t.id)}
            >
              <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
              <strong>{t.label || t.id || '(unnamed tree)'}</strong>
              <span className="hint">{t.id || '<no id>'}</span>
            </div>

            {isOpen && (
              <div style={{ marginTop: '0.5rem', paddingLeft: '1.5rem', display: 'grid', gap: '0.4rem', maxWidth: '480px' }}>
                <label>
                  id
                  <input type="text" value={t.id} onChange={(e) => updateTree(i, { id: e.target.value })} style={{ width: '100%' }} />
                </label>
                <label>
                  label
                  <input type="text" value={t.label} onChange={(e) => updateTree(i, { label: e.target.value })} style={{ width: '100%' }} />
                </label>
                <label>
                  package
                  <input type="text" value={t.package} onChange={(e) => updateTree(i, { package: e.target.value })} style={{ width: '100%' }} />
                </label>
                <label>
                  tree_file (relative to the package's share dir)
                  <input
                    type="text"
                    value={t.tree_file}
                    onChange={(e) => updateTree(i, { tree_file: e.target.value })}
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  target_id (optional - correlates with a targets.yaml entry)
                  <input
                    type="text"
                    value={t.target_id ?? ''}
                    onChange={(e) => updateTree(i, { target_id: e.target.value || null })}
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  groot2_port (optional)
                  <input
                    type="number"
                    value={t.groot2_port ?? ''}
                    onChange={(e) => updateTree(i, { groot2_port: e.target.value ? Number(e.target.value) : null })}
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={t.mission_control}
                    onChange={(e) => updateTree(i, { mission_control: e.target.checked })}
                  />{' '}
                  mission_control (Run / Next step / Cancel bar - hri_bt_main trees only)
                </label>

                <button className="action" onClick={() => removeTree(i)} style={{ marginTop: '0.4rem' }}>
                  Delete tree
                </button>
              </div>
            )}
          </div>
        )
      })}

      <div style={{ margin: '0.75rem 0' }}>
        <button className="flag-toggle" onClick={addTree} style={{ marginRight: '0.4rem' }}>
          + Add tree
        </button>
        <button className="flag-toggle" onClick={exportTrees}>
          Export YAML
        </button>
      </div>

      <YamlImportPanel<BtTreeConfig>
        parse={api.parseTreesYaml}
        onMerge={(parsed) => setTrees((prev) => mergeById(prev ?? [], parsed))}
        label="tree"
      />

      {error && <div className="input-error">{error}</div>}
      {saveMessage && <div className="hint">{saveMessage}</div>}
      <button className="action" onClick={() => save()} disabled={saving}>
        {saving ? 'Saving…' : 'Save trees'}
      </button>
    </div>
  )
})

export default TreesConfigEditor
