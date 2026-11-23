import { Fragment } from 'react'
import { ServiceEndpoint } from './api'
import Highlight from './Highlight'
import { countLeaves, subtreeMatches, TreeNode } from './namespaceTree'
import TerminalPane from './TerminalPane'

interface Props {
  nodes: TreeNode<ServiceEndpoint>[]
  depth: number
  collapsedGroups: Set<string>
  onToggleGroup: (prefix: string) => void
  searchQuery: string
  // Gated behind the tab-wide "advanced: send goals" toggle, same one
  // Actions uses - a service call has no live-stream or "watch other
  // clients" equivalent (ROS gives no caller-identity or call-log data for
  // services at all, unlike actions' status topic), so there's nothing to
  // show by default; sending is the only thing this panel ever does.
  sendingEnabled: boolean
  expandedServices: Set<string>
  onToggleExpand: (serviceName: string) => void
  requestInputByService: Record<string, string>
  onRequestInputChange: (serviceName: string, value: string) => void
  requestErrorByService: Record<string, string>
  callingServices: Set<string>
  responseByService: Record<string, string>
  onCallService: (serviceName: string) => void
}

// Same namespace-grouped browser as before when sendingEnabled is off
// (the common case) - rows only become clickable/expandable once sending
// is turned on, matching how the plain list looked prior to this feature.
export default function ServicesTreeView(props: Props) {
  const {
    nodes,
    depth,
    collapsedGroups,
    onToggleGroup,
    searchQuery,
    sendingEnabled,
    expandedServices,
    onToggleExpand,
    requestInputByService,
    onRequestInputChange,
    requestErrorByService,
    callingServices,
    responseByService,
    onCallService,
  } = props
  const query = searchQuery.trim().toLowerCase()
  const searching = query.length > 0

  const isVisible = (node: TreeNode<ServiceEndpoint>): boolean =>
    !searching ||
    subtreeMatches(node, (n) => {
      if (n.fullPrefix.toLowerCase().includes(query)) return true
      if (n.leaf === undefined) return false
      return n.leaf.types.some((t) => t.toLowerCase().includes(query))
    })

  const sorted = [...nodes].filter(isVisible).sort((a, b) => a.segment.localeCompare(b.segment))

  return (
    <>
      {sorted.map((node) => {
        const hasChildren = Object.keys(node.children).length > 0
        const groupExpanded = searching || !collapsedGroups.has(node.fullPrefix)
        const s = node.leaf
        const groupIndent = `${depth * 1.25}rem`
        const leafIndent = `${(depth + (hasChildren ? 1 : 0)) * 1.25}rem`
        const detailIndent = `${(depth + (hasChildren ? 1 : 0) + 1) * 1.25}rem`
        const detailsOpen = sendingEnabled && s !== undefined && expandedServices.has(s.name)
        const calling = s !== undefined && callingServices.has(s.name)

        return (
          <Fragment key={node.fullPrefix}>
            {hasChildren && (
              <div className="tree-row group" style={{ paddingLeft: groupIndent }} onClick={() => onToggleGroup(node.fullPrefix)}>
                <span className="tree-caret">{groupExpanded ? '▾' : '▸'}</span>{' '}
                <Highlight text={node.segment} query={searchQuery} />{' '}
                <span className="hint">
                  ({countLeaves(node)} service{countLeaves(node) === 1 ? '' : 's'})
                </span>
              </div>
            )}

            {s && (
              <>
                <div
                  className="tree-row leaf"
                  style={{ paddingLeft: leafIndent, cursor: sendingEnabled ? 'pointer' : 'default' }}
                  onClick={sendingEnabled ? () => onToggleExpand(s.name) : undefined}
                >
                  {sendingEnabled && <span className="tree-caret">{detailsOpen ? '▾' : '▸'}</span>} /
                  <Highlight text={s.name} query={searchQuery} /> <span className="hint">({s.types.join(', ')})</span>
                </div>

                {detailsOpen && (
                  <div style={{ paddingLeft: detailIndent, marginBottom: '0.75rem' }}>
                    <textarea
                      className="action-goal-input"
                      rows={3}
                      value={requestInputByService[s.name] ?? '{}'}
                      onChange={(e) => onRequestInputChange(s.name, e.target.value)}
                      disabled={calling}
                      spellCheck={false}
                    />
                    {requestErrorByService[s.name] && <div className="input-error">{requestErrorByService[s.name]}</div>}

                    <div style={{ margin: '0.4rem 0' }}>
                      <button className="action" onClick={() => onCallService(s.name)} disabled={calling}>
                        {calling ? 'Calling…' : 'Call'}
                      </button>
                    </div>

                    <TerminalPane
                      content={responseByService[s.name] ?? ''}
                      emptyHint="no call made yet"
                      height={140}
                      storageKey={`services.${s.name}`}
                    />
                  </div>
                )}
              </>
            )}

            {hasChildren && groupExpanded && (
              <ServicesTreeView {...props} nodes={Object.values(node.children)} depth={depth + 1} />
            )}
          </Fragment>
        )
      })}
    </>
  )
}
