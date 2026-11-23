import { useEffect, useMemo, useState } from 'react'
import { api, ParamDescriptor } from '../api'
import { buildNamespaceTree, collectGroupPrefixes } from '../namespaceTree'
import NodeTreeView from '../NodeTreeView'
import { ParamFilter } from '../ParamTreeView'
import { parseEditString, valueToEditString } from '../paramValue'
import PinnedParamsPanel from '../PinnedParamsPanel'
import { usePersistentSet, usePersistentState, usePersistentStringSetMap } from '../usePersistentState'

const PIN_STORAGE_KEY = 'dashboard.pinnedParams'

function pinKey(fqn: string, paramName: string): string {
  return `${fqn}::${paramName}`
}

// All state below is scoped per node FQN (Record<fqn, ...>) rather than a
// single flat map - now that any number of nodes can be expanded at once
// (not just one "selected" node), two different nodes sharing a param name
// or namespace prefix must not clobber each other's edit/collapse state.
export default function ParamsTab() {
  const [nodes, setNodes] = useState<string[]>([])
  // Persisted - which namespace groups/nodes you left expanded survives a
  // reload. Safe to persist plainly here (unlike Control tab's target
  // expand, which has a live log websocket tied to it) - toggleLeaf below
  // doesn't fetch anything, every node's params are already eager-loaded.
  const [collapsedGroups, setCollapsedGroups] = usePersistentSet('dashboard.params.collapsedGroups')
  const [expandedLeaves, setExpandedLeaves] = usePersistentSet('dashboard.params.expandedLeaves')
  const [loadingLeaves, setLoadingLeaves] = useState<Set<string>>(new Set())
  const [errorByLeaf, setErrorByLeaf] = useState<Record<string, string>>({})
  const [paramsByLeaf, setParamsByLeaf] = useState<Record<string, ParamDescriptor[]>>({})
  // Collapsed param groups per leaf - persisted like the Control tab's
  // collapsed categories (and the Graph tab's collapsed sections), so a
  // tidy workspace stays tidy across reloads instead of resorting every time.
  const [collapsedParamGroupsByLeaf, setCollapsedParamGroupsByLeaf] = usePersistentStringSetMap('dashboard.params.collapsedParamGroups')
  const [editsByLeaf, setEditsByLeaf] = useState<Record<string, Record<string, string>>>({})
  const [feedbackByLeaf, setFeedbackByLeaf] = useState<Record<string, Record<string, string>>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [paramFilter, setParamFilter] = usePersistentState<ParamFilter>('dashboard.params.filter', 'all')
  const [pinnedKeys, setPinnedKeys] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(PIN_STORAGE_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    api.listNodes().then(setNodes).catch((err) => console.error('listNodes failed', err))
  }, [])

  useEffect(() => {
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(pinnedKeys))
  }, [pinnedKeys])

  const tree = useMemo(() => buildNamespaceTree(nodes, (n) => n, '/'), [nodes])
  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys])
  const pinnedEntries = useMemo(
    () =>
      pinnedKeys.map((key) => {
        const idx = key.indexOf('::')
        return { fqn: key.slice(0, idx), paramName: key.slice(idx + 2) }
      }),
    [pinnedKeys],
  )

  async function fetchParams(fqn: string) {
    if (paramsByLeaf[fqn] || loadingLeaves.has(fqn)) return
    setLoadingLeaves((prev) => new Set(prev).add(fqn))
    try {
      const result = await api.listParameters(fqn)
      setParamsByLeaf((prev) => ({ ...prev, [fqn]: result }))
      const initialEdits: Record<string, string> = {}
      for (const p of result) initialEdits[p.name] = valueToEditString(p.value)
      setEditsByLeaf((prev) => ({ ...prev, [fqn]: initialEdits }))
    } catch (err) {
      setErrorByLeaf((prev) => ({ ...prev, [fqn]: String(err) }))
    } finally {
      setLoadingLeaves((prev) => {
        const next = new Set(prev)
        next.delete(fqn)
        return next
      })
    }
  }

  // Eager-fetch every node's params as soon as the node list is known (and
  // again whenever it changes, e.g. a new node appears) - NOT lazy-on-expand.
  // Lazy-loading meant search and pins each needed their own "oh also fetch
  // eagerly for this case" effect, and the pinned panel had no way to tell
  // "still loading" apart from "genuinely gone," so a pin flashed "not
  // currently available" on every fresh page load even for a node that was
  // running fine. At the scale this dashboard actually runs at (a handful
  // of nodes, not a fleet), eager-loading everything costs nothing and
  // removes the whole bug class instead of patching around it. The tree
  // still starts collapsed - expand/collapse is a view state independent of
  // whether the data's already in memory.
  useEffect(() => {
    for (const fqn of nodes) fetchParams(fqn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes])

  function toggleGroup(prefix: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })
  }

  function toggleLeaf(fqn: string) {
    // No fetch here anymore - every node's params are already eager-loaded
    // (see the effect above). This just toggles the view's expand state.
    setExpandedLeaves((prev) => {
      const next = new Set(prev)
      if (next.has(fqn)) next.delete(fqn)
      else next.add(fqn)
      return next
    })
  }

  function isPinned(fqn: string, paramName: string): boolean {
    return pinnedSet.has(pinKey(fqn, paramName))
  }

  function togglePin(fqn: string, paramName: string) {
    const key = pinKey(fqn, paramName)
    setPinnedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  function unpinAll() {
    setPinnedKeys([])
  }

  function toggleParamGroup(fqn: string, prefix: string) {
    setCollapsedParamGroupsByLeaf((prev) => {
      const nodeSet = new Set(prev[fqn] ?? [])
      if (nodeSet.has(prefix)) nodeSet.delete(prefix)
      else nodeSet.add(prefix)
      return { ...prev, [fqn]: nodeSet }
    })
  }

  function editParam(fqn: string, paramName: string, value: string) {
    setEditsByLeaf((prev) => ({ ...prev, [fqn]: { ...(prev[fqn] ?? {}), [paramName]: value } }))
  }

  async function saveParam(fqn: string, p: ParamDescriptor) {
    const raw = editsByLeaf[fqn]?.[p.name] ?? ''
    const value = parseEditString(p.type, raw)
    try {
      const result = await api.setParameter(fqn, p.name, value, p.type_id)
      setFeedbackByLeaf((prev) => ({
        ...prev,
        [fqn]: { ...(prev[fqn] ?? {}), [p.name]: result.ok ? 'saved' : `rejected: ${result.reason}` },
      }))
      if (result.ok) {
        setParamsByLeaf((prev) => ({
          ...prev,
          [fqn]: (prev[fqn] ?? []).map((row) => (row.name === p.name ? { ...row, value } : row)),
        }))
      }
    } catch (err) {
      setFeedbackByLeaf((prev) => ({ ...prev, [fqn]: { ...(prev[fqn] ?? {}), [p.name]: `error: ${String(err)}` } }))
    }
  }

  // Pure display state on both sides - params are already eager-loaded
  // regardless of expand state (see the effect above), so there's no
  // subscription/fetch to tear down here, just the tree's own view state.
  function collapseAll() {
    setCollapsedGroups(new Set(collectGroupPrefixes(tree)))
    setExpandedLeaves(new Set())
  }

  return (
    <div>
      {pinnedEntries.length > 0 && (
        <div className="pinned-panel">
          <div className="pinned-header">
            <h3>Pinned ({pinnedEntries.length})</h3>
            <button className="action" onClick={unpinAll}>
              Unpin all
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Value</th>
                <th></th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <PinnedParamsPanel
                entries={pinnedEntries}
                paramsByLeaf={paramsByLeaf}
                loadingLeaves={loadingLeaves}
                errorByLeaf={errorByLeaf}
                edits={editsByLeaf}
                feedback={feedbackByLeaf}
                onEditChange={editParam}
                onSave={saveParam}
                onUnpin={togglePin}
              />
            </tbody>
          </table>
        </div>
      )}

      <div className="params-toolbar">
        <input
          type="text"
          placeholder="Search nodes and params…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button className="flag-toggle" onClick={collapseAll}>
          Collapse all
        </button>
        <div className="bool-toggle">
          <button type="button" className={`bool-btn${paramFilter === 'all' ? ' active' : ''}`} onClick={() => setParamFilter('all')}>
            All
          </button>
          <button
            type="button"
            className={`bool-btn${paramFilter === 'writable' ? ' active' : ''}`}
            onClick={() => setParamFilter('writable')}
          >
            Writable
          </button>
          <button
            type="button"
            className={`bool-btn${paramFilter === 'read_only' ? ' active' : ''}`}
            onClick={() => setParamFilter('read_only')}
          >
            Read-only
          </button>
        </div>
      </div>

      {nodes.length === 0 && <p className="hint">No nodes on the graph yet.</p>}
      {nodes.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Value</th>
              <th></th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <NodeTreeView
              nodes={tree}
              depth={0}
              collapsedGroups={collapsedGroups}
              onToggleGroup={toggleGroup}
              expandedLeaves={expandedLeaves}
              onToggleLeaf={toggleLeaf}
              loadingLeaves={loadingLeaves}
              errorByLeaf={errorByLeaf}
              paramsByLeaf={paramsByLeaf}
              collapsedParamGroupsByLeaf={collapsedParamGroupsByLeaf}
              onToggleParamGroup={toggleParamGroup}
              editsByLeaf={editsByLeaf}
              feedbackByLeaf={feedbackByLeaf}
              onEditChange={editParam}
              onSaveParam={saveParam}
              searchQuery={searchQuery}
              paramFilter={paramFilter}
              isPinned={isPinned}
              onTogglePin={togglePin}
            />
          </tbody>
        </table>
      )}
    </div>
  )
}
