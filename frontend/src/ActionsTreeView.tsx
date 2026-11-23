import { Fragment } from 'react'
import { ServiceEndpoint } from './api'
import { goalStatusLabel } from './actionStatus'
import { formatEcho } from './formatEcho'
import Highlight from './Highlight'
import { countLeaves, subtreeMatches, TreeNode } from './namespaceTree'
import TerminalPane from './TerminalPane'

export type ActionStreamEntry =
  | { type: 'accepted'; goalIdHex: string }
  | { type: 'feedback'; data: unknown }
  | { type: 'result'; status: number; data: unknown }
  | { type: 'rejected' }
  // Decoded off the action's raw status topic - every goal, any client,
  // status transitions only (no feedback content). Feeds the left/default
  // panel. Deliberately doesn't carry "mine" - the raw status topic and
  // your own goal's "accepted" push are two independent, unordered
  // deliveries, so whichever arrives first wouldn't yet know it's yours.
  // "mine" is derived at format time instead, against the current
  // myGoalIdByAction value, so it's correct on every render regardless of
  // arrival order.
  | { type: 'status'; goalIdHex: string; status: number }

interface Props {
  nodes: TreeNode<ServiceEndpoint>[]
  depth: number
  collapsedGroups: Set<string>
  onToggleGroup: (prefix: string) => void
  searchQuery: string
  expandedActions: Set<string>
  onToggleExpand: (actionName: string) => void
  allGoalsStatusByAction: Record<string, ActionStreamEntry[]>
  myGoalIdByAction: Record<string, string | undefined>
  sendingEnabled: boolean
  goalInputByAction: Record<string, string>
  onGoalInputChange: (actionName: string, value: string) => void
  goalErrorByAction: Record<string, string>
  activeGoalByAction: Record<string, string | undefined>
  statusByAction: Record<string, string>
  ownStreamByAction: Record<string, ActionStreamEntry[]>
  onSendGoal: (actionName: string) => void
  onCancelGoal: (actionName: string) => void
}

function formatEntry(e: ActionStreamEntry, myGoalId: string | undefined): string {
  switch (e.type) {
    case 'accepted':
      return `[accepted] tracked as ${e.goalIdHex}`
    case 'feedback':
      return `[feedback]\n${formatEcho(e.data)}`
    case 'result':
      return `[result: ${goalStatusLabel(e.status)}]\n${formatEcho(e.data)}`
    case 'rejected':
      return '[rejected]'
    case 'status':
      return `[goal ${e.goalIdHex}${e.goalIdHex === myGoalId ? ' (you)' : ''}] ${goalStatusLabel(e.status)}`
  }
}

// Two views of the same action, side by side once a row is expanded:
// - Left: every goal on this action, any client, status-only - always on
//   while expanded (same lifecycle as topics' hz/echo), the passive
//   "what's happening" overview.
// - Right: compose + send your own goal, with the detailed feed
//   (accepted/feedback/result) for just that goal - gated behind the
//   tab-wide "advanced: send goals" toggle (GraphTab's sendingEnabled),
//   since sending is the less common, more consequential action.
export default function ActionsTreeView(props: Props) {
  const {
    nodes,
    depth,
    collapsedGroups,
    onToggleGroup,
    searchQuery,
    expandedActions,
    onToggleExpand,
    allGoalsStatusByAction,
    myGoalIdByAction,
    sendingEnabled,
    goalInputByAction,
    onGoalInputChange,
    goalErrorByAction,
    activeGoalByAction,
    statusByAction,
    ownStreamByAction,
    onSendGoal,
    onCancelGoal,
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
        const a = node.leaf
        const groupIndent = `${depth * 1.25}rem`
        const leafIndent = `${(depth + (hasChildren ? 1 : 0)) * 1.25}rem`
        const detailIndent = `${(depth + (hasChildren ? 1 : 0) + 1) * 1.25}rem`
        const detailsOpen = a !== undefined && expandedActions.has(a.name)
        const goalId = a ? activeGoalByAction[a.name] : undefined
        const running = goalId !== undefined
        const myGoalId = a ? myGoalIdByAction[a.name] : undefined
        const allGoalsContent = a
          ? (allGoalsStatusByAction[a.name] ?? []).map((e) => formatEntry(e, myGoalId)).join('\n---\n')
          : ''
        const ownContent = a ? (ownStreamByAction[a.name] ?? []).map((e) => formatEntry(e, myGoalId)).join('\n---\n') : ''

        return (
          <Fragment key={node.fullPrefix}>
            {hasChildren && (
              <div className="tree-row group" style={{ paddingLeft: groupIndent }} onClick={() => onToggleGroup(node.fullPrefix)}>
                <span className="tree-caret">{groupExpanded ? '▾' : '▸'}</span>{' '}
                <Highlight text={node.segment} query={searchQuery} />{' '}
                <span className="hint">
                  ({countLeaves(node)} action{countLeaves(node) === 1 ? '' : 's'})
                </span>
              </div>
            )}

            {a && (
              <>
                <div className="tree-row leaf" style={{ paddingLeft: leafIndent }} onClick={() => onToggleExpand(a.name)}>
                  <span className="tree-caret">{detailsOpen ? '▾' : '▸'}</span> /
                  <Highlight text={a.name} query={searchQuery} /> <span className="hint">({a.types.join(', ')})</span>
                </div>

                {detailsOpen && (
                  <div style={{ paddingLeft: detailIndent, marginBottom: '0.75rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '280px' }}>
                      <div className="hint" style={{ marginBottom: '0.3rem' }}>
                        all goals (any client)
                      </div>
                      <TerminalPane
                        content={allGoalsContent}
                        emptyHint="no goal activity seen yet"
                        height={200}
                        storageKey={`actions.all.${a.name}`}
                      />
                    </div>

                    {sendingEnabled && (
                      <div style={{ flex: 1, minWidth: '280px' }}>
                        <textarea
                          className="action-goal-input"
                          rows={3}
                          value={goalInputByAction[a.name] ?? '{}'}
                          onChange={(e) => onGoalInputChange(a.name, e.target.value)}
                          disabled={running}
                          spellCheck={false}
                        />
                        {goalErrorByAction[a.name] && <div className="input-error">{goalErrorByAction[a.name]}</div>}

                        <div style={{ margin: '0.4rem 0' }}>
                          <button className="action" onClick={() => onSendGoal(a.name)} disabled={running}>
                            Send Goal
                          </button>
                          <button className="action" onClick={() => onCancelGoal(a.name)} disabled={!running}>
                            Cancel
                          </button>
                          <span className="hint" style={{ marginLeft: '0.5rem' }}>
                            {statusByAction[a.name] ?? 'idle'}
                          </span>
                        </div>

                        <TerminalPane
                          content={ownContent}
                          emptyHint="no goal sent yet"
                          height={160}
                          storageKey={`actions.own.${a.name}`}
                        />
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {hasChildren && groupExpanded && (
              <ActionsTreeView {...props} nodes={Object.values(node.children)} depth={depth + 1} />
            )}
          </Fragment>
        )
      })}
    </>
  )
}
