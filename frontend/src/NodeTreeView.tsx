import { Fragment } from 'react'
import { ParamDescriptor } from './api'
import Highlight from './Highlight'
import { countLeaves, subtreeMatches, TreeNode } from './namespaceTree'
import { buildParamTree } from './paramTree'
import ParamTreeView, { ParamFilter } from './ParamTreeView'

const EMPTY_SET = new Set<string>()

interface Props {
  nodes: TreeNode<string>[]
  depth: number
  collapsedGroups: Set<string>
  onToggleGroup: (prefix: string) => void
  expandedLeaves: Set<string>
  onToggleLeaf: (fqn: string) => void
  loadingLeaves: Set<string>
  errorByLeaf: Record<string, string>
  paramsByLeaf: Record<string, ParamDescriptor[]>
  collapsedParamGroupsByLeaf: Record<string, Set<string>>
  onToggleParamGroup: (fqn: string, prefix: string) => void
  editsByLeaf: Record<string, Record<string, string>>
  feedbackByLeaf: Record<string, Record<string, string>>
  onEditChange: (fqn: string, paramName: string, value: string) => void
  onSaveParam: (fqn: string, p: ParamDescriptor) => void
  searchQuery: string
  paramFilter: ParamFilter
  isPinned: (fqn: string, paramName: string) => boolean
  onTogglePin: (fqn: string, paramName: string) => void
}

// Node namespaces (/) and their parameters (.) rendered as ONE recursive
// tree, not a namespace picker feeding a separate table - a node is just a
// leaf that, when expanded, reveals its own (also collapsible) parameter
// tree nested underneath. Reuses ParamTreeView unmodified for that nested
// part - same rows, same editing behavior, just re-parented deeper in the
// same <table>.
export default function NodeTreeView(props: Props) {
  const {
    nodes,
    depth,
    collapsedGroups,
    onToggleGroup,
    expandedLeaves,
    onToggleLeaf,
    loadingLeaves,
    errorByLeaf,
    paramsByLeaf,
    collapsedParamGroupsByLeaf,
    onToggleParamGroup,
    editsByLeaf,
    feedbackByLeaf,
    onEditChange,
    onSaveParam,
    searchQuery,
    paramFilter,
    isPinned,
    onTogglePin,
  } = props

  const query = searchQuery.trim().toLowerCase()
  const searching = query.length > 0

  // A node leaf "matches" search either by its own name/namespace, or by
  // any of its (already-fetched) parameter names - ParamsTab eager-fetches
  // every node's params as soon as a search starts, specifically so this
  // can actually see them rather than only matching whatever happened to
  // already be expanded.
  const isVisible = (node: TreeNode<string>): boolean =>
    !searching ||
    subtreeMatches(node, (n) => {
      if (n.fullPrefix.toLowerCase().includes(query)) return true
      if (n.leaf === undefined) return false
      return (paramsByLeaf[n.leaf] ?? []).some((p) => p.name.toLowerCase().includes(query))
    })

  const sorted = [...nodes].filter(isVisible).sort((a, b) => a.segment.localeCompare(b.segment))

  return (
    <>
      {sorted.map((node) => {
        const hasChildren = Object.keys(node.children).length > 0
        const isGroupExpanded = searching || !collapsedGroups.has(node.fullPrefix)
        const groupIndent = `${depth * 1.25}rem`
        const fqn = node.leaf
        const leafIndent = `${(depth + (hasChildren ? 1 : 0)) * 1.25}rem`
        const paramIndent = `${(depth + (hasChildren ? 1 : 0) + 1) * 1.25}rem`
        const leafExpanded = fqn !== undefined && (searching || expandedLeaves.has(fqn))

        return (
          <Fragment key={node.fullPrefix}>
            {hasChildren && (
              <tr className="param-group-row" onClick={() => onToggleGroup(node.fullPrefix)}>
                <td style={{ paddingLeft: groupIndent }}>
                  <span className="tree-caret">{isGroupExpanded ? '▾' : '▸'}</span>{' '}
                  <Highlight text={node.segment} query={searchQuery} />
                </td>
                <td colSpan={4} className="hint">
                  {countLeaves(node)} node{countLeaves(node) === 1 ? '' : 's'}
                </td>
              </tr>
            )}

            {fqn !== undefined && (
              <>
                <tr className="param-group-row" onClick={() => onToggleLeaf(fqn)}>
                  <td style={{ paddingLeft: leafIndent }}>
                    <span className="tree-caret">{leafExpanded ? '▾' : '▸'}</span> /
                    <Highlight text={fqn} query={searchQuery} />
                  </td>
                  <td colSpan={4} className="hint">
                    {paramsByLeaf[fqn] ? `${paramsByLeaf[fqn].length} parameter${paramsByLeaf[fqn].length === 1 ? '' : 's'}` : 'node'}
                  </td>
                </tr>

                {leafExpanded && loadingLeaves.has(fqn) && (
                  <tr>
                    <td style={{ paddingLeft: paramIndent }} colSpan={5} className="hint">
                      Loading…
                    </td>
                  </tr>
                )}
                {leafExpanded && errorByLeaf[fqn] && (
                  <tr>
                    <td style={{ paddingLeft: paramIndent }} colSpan={5} className="hint">
                      {errorByLeaf[fqn]}
                    </td>
                  </tr>
                )}
                {leafExpanded && paramsByLeaf[fqn] && paramsByLeaf[fqn].length === 0 && (
                  <tr>
                    <td style={{ paddingLeft: paramIndent }} colSpan={5} className="hint">
                      No parameters, or no reachable parameter interface.
                    </td>
                  </tr>
                )}
                {leafExpanded && paramsByLeaf[fqn] && paramsByLeaf[fqn].length > 0 && (
                  <ParamTreeView
                    nodes={buildParamTree(paramsByLeaf[fqn])}
                    depth={depth + (hasChildren ? 1 : 0) + 1}
                    collapsed={collapsedParamGroupsByLeaf[fqn] ?? EMPTY_SET}
                    onToggle={(prefix) => onToggleParamGroup(fqn, prefix)}
                    edits={editsByLeaf[fqn] ?? {}}
                    feedback={feedbackByLeaf[fqn] ?? {}}
                    onEditChange={(paramName, value) => onEditChange(fqn, paramName, value)}
                    onSave={(p) => onSaveParam(fqn, p)}
                    searchQuery={searchQuery}
                    filter={paramFilter}
                    isPinned={(paramName) => isPinned(fqn, paramName)}
                    onTogglePin={(paramName) => onTogglePin(fqn, paramName)}
                  />
                )}
              </>
            )}

            {hasChildren && isGroupExpanded && (
              <NodeTreeView {...props} nodes={Object.values(node.children)} depth={depth + 1} />
            )}
          </Fragment>
        )
      })}
    </>
  )
}
