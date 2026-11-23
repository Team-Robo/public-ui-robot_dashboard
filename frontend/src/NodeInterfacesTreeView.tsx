import { Fragment } from 'react'
import { NodeInterfaces } from './api'
import Highlight from './Highlight'
import { buildNamespaceTree, countLeaves, subtreeMatches, TreeNode } from './namespaceTree'

interface Props {
  nodes: TreeNode<string>[]
  depth: number
  collapsedGroups: Set<string>
  onToggleGroup: (prefix: string) => void
  expandedLeaves: Set<string>
  onToggleLeaf: (fqn: string) => void
  interfacesByLeaf: Record<string, NodeInterfaces>
  loadingLeaves: Set<string>
  errorByLeaf: Record<string, string>
  searchQuery: string
}

function summarize(i: NodeInterfaces | undefined): string {
  if (!i) return 'node'
  const actionCount = i.action_servers.length + i.action_clients.length
  const actionPart = actionCount > 0 ? ` · ${actionCount} action${actionCount === 1 ? '' : 's'}` : ''
  return `${i.publishers.length} pub · ${i.subscribers.length} sub · ${i.services.length} srv · ${i.clients.length} client${i.clients.length === 1 ? '' : 's'}${actionPart}`
}

type NamedItem = { name: string; types: string[] }

// Same namespace-tree grouping the rest of the app already uses (Params
// tab, Graph tab's own node/topic browsers) - reused here rather than a
// flat list, so a node with several related custom services/topics under
// a shared prefix (e.g. /camera/set_exposure, /camera/get_calibration)
// groups visually instead of listing 1-per-line with no indication they're
// related. Singletons collapse back into one plain row automatically (the
// tree's own fast-forward rule), so this only ever shows a group when
// there's an actual group to show. No collapse state at this depth - lists
// here are small enough that always-expanded is simpler than adding yet
// another layer of expand/collapse tracking.
function InterfaceGroup({ nodes, query, depth }: { nodes: TreeNode<NamedItem>[]; query: string; depth: number }) {
  const sorted = [...nodes].sort((a, b) => a.segment.localeCompare(b.segment))
  return (
    <>
      {sorted.map((node) => {
        const hasChildren = Object.keys(node.children).length > 0
        return (
          <div key={node.fullPrefix} style={{ paddingLeft: `${depth * 1.1}rem` }}>
            {hasChildren ? (
              <>
                <div className="hint" style={{ fontWeight: 600 }}>
                  <Highlight text={node.segment} query={query} />/ ({countLeaves(node)})
                </div>
                <InterfaceGroup nodes={Object.values(node.children)} query={query} depth={depth + 1} />
              </>
            ) : (
              node.leaf && (
                <div>
                  <Highlight text={node.segment} query={query} /> <span className="hint">({node.leaf.types.join(', ')})</span>
                </div>
              )
            )}
          </div>
        )
      })}
    </>
  )
}

function InterfaceList({ title, items, query }: { title: string; items: NamedItem[]; query: string }) {
  const tree = buildNamespaceTree(items, (item) => item.name, '/')
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <div className="hint" style={{ fontWeight: 600 }}>
        {title} ({items.length})
      </div>
      {items.length === 0 && <div className="hint">none</div>}
      <InterfaceGroup nodes={tree} query={query} depth={0} />
    </div>
  )
}

// Data is eager-loaded up front for every node (see GraphTab) - expand/
// collapse here is purely a view state, not a fetch trigger. Learned that
// lesson the hard way on the Params tab's pinned panel: conflating "not
// fetched yet" with "not available" produces misleading UI.
export default function NodeInterfacesTreeView(props: Props) {
  const {
    nodes,
    depth,
    collapsedGroups,
    onToggleGroup,
    expandedLeaves,
    onToggleLeaf,
    interfacesByLeaf,
    loadingLeaves,
    errorByLeaf,
    searchQuery,
  } = props

  const query = searchQuery.trim().toLowerCase()
  const searching = query.length > 0

  const isVisible = (node: TreeNode<string>): boolean =>
    !searching ||
    subtreeMatches(node, (n) => {
      if (n.fullPrefix.toLowerCase().includes(query)) return true
      if (n.leaf === undefined) return false
      const i = interfacesByLeaf[n.leaf]
      if (!i) return false
      const names = [...i.publishers, ...i.subscribers]
        .map((e) => e.topic)
        .concat([...i.services, ...i.clients, ...i.action_servers, ...i.action_clients].map((e) => e.name))
      return names.some((n2) => n2.toLowerCase().includes(query))
    })

  const sorted = [...nodes].filter(isVisible).sort((a, b) => a.segment.localeCompare(b.segment))

  return (
    <>
      {sorted.map((node) => {
        const hasChildren = Object.keys(node.children).length > 0
        const groupExpanded = searching || !collapsedGroups.has(node.fullPrefix)
        const fqn = node.leaf
        const leafExpanded = fqn !== undefined && (searching || expandedLeaves.has(fqn))
        const groupIndent = `${depth * 1.25}rem`
        const leafIndent = `${(depth + (hasChildren ? 1 : 0)) * 1.25}rem`
        const detailIndent = `${(depth + (hasChildren ? 1 : 0) + 1) * 1.25}rem`

        return (
          <Fragment key={node.fullPrefix}>
            {hasChildren && (
              <div className="tree-row group" style={{ paddingLeft: groupIndent }} onClick={() => onToggleGroup(node.fullPrefix)}>
                <span className="tree-caret">{groupExpanded ? '▾' : '▸'}</span>{' '}
                <Highlight text={node.segment} query={searchQuery} />{' '}
                <span className="hint">
                  ({countLeaves(node)} node{countLeaves(node) === 1 ? '' : 's'})
                </span>
              </div>
            )}

            {fqn !== undefined && (
              <>
                <div className="tree-row leaf" style={{ paddingLeft: leafIndent }} onClick={() => onToggleLeaf(fqn)}>
                  <span className="tree-caret">{leafExpanded ? '▾' : '▸'}</span> /
                  <Highlight text={fqn} query={searchQuery} /> <span className="hint">{summarize(interfacesByLeaf[fqn])}</span>
                </div>
                {leafExpanded && (
                  <div style={{ paddingLeft: detailIndent, marginBottom: '0.75rem' }}>
                    {loadingLeaves.has(fqn) && <p className="hint">Loading…</p>}
                    {errorByLeaf[fqn] && <p className="hint">{errorByLeaf[fqn]}</p>}
                    {interfacesByLeaf[fqn] && (
                      <>
                        <InterfaceList title="Publishers" items={interfacesByLeaf[fqn].publishers.map((p) => ({ name: p.topic, types: p.types }))} query={searchQuery} />
                        <InterfaceList title="Subscribers" items={interfacesByLeaf[fqn].subscribers.map((p) => ({ name: p.topic, types: p.types }))} query={searchQuery} />
                        <InterfaceList title="Services" items={interfacesByLeaf[fqn].services} query={searchQuery} />
                        <InterfaceList title="Clients" items={interfacesByLeaf[fqn].clients} query={searchQuery} />
                        <InterfaceList title="Action Servers" items={interfacesByLeaf[fqn].action_servers} query={searchQuery} />
                        <InterfaceList title="Action Clients" items={interfacesByLeaf[fqn].action_clients} query={searchQuery} />
                        {interfacesByLeaf[fqn].has_parameters && (
                          <p className="hint">Has ROS2 parameters - see Params tab (standard get/set/list/describe services hidden here).</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            {hasChildren && groupExpanded && (
              <NodeInterfacesTreeView {...props} nodes={Object.values(node.children)} depth={depth + 1} />
            )}
          </Fragment>
        )
      })}
    </>
  )
}
