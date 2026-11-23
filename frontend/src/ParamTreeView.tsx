import { Fragment } from 'react'
import { ParamDescriptor } from './api'
import Highlight from './Highlight'
import { subtreeMatches } from './namespaceTree'
import ParamValueEditor from './ParamValueEditor'
import { ParamTreeNode, countParams } from './paramTree'
import { validateEditValue } from './paramValue'

export type ParamFilter = 'all' | 'writable' | 'read_only'

interface Props {
  nodes: ParamTreeNode[]
  depth: number
  collapsed: Set<string>
  onToggle: (prefix: string) => void
  edits: Record<string, string>
  feedback: Record<string, string>
  onEditChange: (paramName: string, value: string) => void
  onSave: (p: ParamDescriptor) => void
  searchQuery: string
  filter: ParamFilter
  isPinned: (paramName: string) => boolean
  onTogglePin: (paramName: string) => void
}

function passesFilter(p: ParamDescriptor, filter: ParamFilter): boolean {
  if (filter === 'writable') return !p.read_only
  if (filter === 'read_only') return p.read_only
  return true
}

// Flattened into one <table>'s worth of <tr>s (not nested <table>s) so the
// Name/Type/Value/Set/Status columns stay aligned at every depth -
// indentation is done with padding-left on the Name cell instead.
export default function ParamTreeView(props: Props) {
  const { nodes, depth, collapsed, onToggle, edits, feedback, onEditChange, onSave, searchQuery, filter, isPinned, onTogglePin } = props
  const query = searchQuery.trim().toLowerCase()
  const searching = query.length > 0
  const filtering = filter !== 'all'

  const isVisible = (node: ParamTreeNode): boolean =>
    subtreeMatches(node, (n) => {
      if (n.leaf === undefined) return false
      const matchesSearch = !searching || n.fullPrefix.toLowerCase().includes(query)
      const matchesFilter = !filtering || passesFilter(n.leaf, filter)
      return matchesSearch && matchesFilter
    })

  const visible = nodes.filter(isVisible)
  const sorted = [...visible].sort((a, b) => a.segment.localeCompare(b.segment))

  return (
    <>
      {sorted.map((node) => {
        const hasChildren = Object.keys(node.children).length > 0
        const isExpanded = searching || filtering || !collapsed.has(node.fullPrefix)
        const indent = `${depth * 1.25}rem`
        const p = node.leaf

        return (
          <Fragment key={node.fullPrefix}>
            {hasChildren && (
              <tr className="param-group-row" onClick={() => onToggle(node.fullPrefix)}>
                <td style={{ paddingLeft: indent }}>
                  <span className="tree-caret">{isExpanded ? '▾' : '▸'}</span>{' '}
                  <Highlight text={node.segment} query={searchQuery} />
                </td>
                <td colSpan={4} className="hint">
                  {countParams(node)} parameter{countParams(node) === 1 ? '' : 's'}
                </td>
              </tr>
            )}

            {p &&
              (!filtering || passesFilter(p, filter)) &&
              (() => {
                const editValue = edits[p.name] ?? ''
                const validity = validateEditValue(p.type, editValue)
                return (
                  <tr className={feedback[p.name]?.startsWith('rejected') ? 'param-row rejected' : 'param-row'}>
                    <td style={{ paddingLeft: `${(depth + (hasChildren ? 1 : 0)) * 1.25}rem` }} title={p.description}>
                      {hasChildren ? '(this namespace)' : <Highlight text={node.segment} query={searchQuery} />}
                    </td>
                    <td>
                      {p.type}
                      {p.read_only && <span className="hint"> (read-only)</span>}
                    </td>
                    <td>
                      <ParamValueEditor
                        type={p.type}
                        value={editValue}
                        onChange={(v) => onEditChange(p.name, v)}
                        disabled={p.read_only}
                        valid={validity.valid}
                        message={validity.message}
                      />
                    </td>
                    <td>
                      <button className="action" disabled={p.read_only || !validity.valid} onClick={() => onSave(p)}>
                        Set
                      </button>
                      <button
                        className={`action${isPinned(p.name) ? ' active' : ''}`}
                        onClick={() => onTogglePin(p.name)}
                      >
                        {isPinned(p.name) ? 'Unpin' : 'Pin'}
                      </button>
                    </td>
                    <td className="hint">{feedback[p.name] ?? ''}</td>
                  </tr>
                )
              })()}

            {hasChildren && isExpanded && (
              <ParamTreeView {...props} nodes={Object.values(node.children)} depth={depth + 1} />
            )}
          </Fragment>
        )
      })}
    </>
  )
}
