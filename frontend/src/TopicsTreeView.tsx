import { Fragment } from 'react'
import { HzResult, TopicInfo } from './api'
import { joinEchoMessages } from './formatEcho'
import Highlight from './Highlight'
import { countLeaves, subtreeMatches, TreeNode } from './namespaceTree'
import TerminalPane from './TerminalPane'

interface Props {
  nodes: TreeNode<TopicInfo>[]
  depth: number
  collapsedGroups: Set<string>
  onToggleGroup: (prefix: string) => void
  searchQuery: string
  expandedTopics: Set<string>
  onToggleExpand: (topicName: string) => void
  hzByTopic: Record<string, HzResult>
  echoMessagesByTopic: Record<string, unknown[]>
}

// Headline = the real `ros2 topic hz` (what the publisher is doing); the
// bracket = what this dashboard's own subscription received. They differ when
// the backend drops messages or the link is lossy - that gap is the point.
function formatHz(result: HzResult | undefined): string {
  if (!result) return 'measuring…'
  if (result.error) return result.error
  const received =
    result.rate_hz != null
      ? `${result.rate_hz.toFixed(2)} Hz`
      : result.sample_count === 0
        ? 'no messages'
        : `${result.sample_count} sample`
  if (result.ros2_hz != null) return `${result.ros2_hz.toFixed(2)} Hz (received ${received})`
  if (result.ros2_error) return `ros2 hz unavailable: ${result.ros2_error} (received ${received})`
  return `measuring… (received ${received})`
}

// Expanding a topic IS starting Hz + Echo, collapsing IS stopping them -
// GraphTab's onToggleExpand drives both, so this view only displays
// results, it doesn't carry separate start/stop controls.
export default function TopicsTreeView(props: Props) {
  const { nodes, depth, collapsedGroups, onToggleGroup, searchQuery, expandedTopics, onToggleExpand, hzByTopic, echoMessagesByTopic } =
    props
  const query = searchQuery.trim().toLowerCase()
  const searching = query.length > 0

  const isVisible = (node: TreeNode<TopicInfo>): boolean =>
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
        const t = node.leaf
        const groupIndent = `${depth * 1.25}rem`
        const leafIndent = `${(depth + (hasChildren ? 1 : 0)) * 1.25}rem`
        const detailIndent = `${(depth + (hasChildren ? 1 : 0) + 1) * 1.25}rem`
        const detailsOpen = t !== undefined && expandedTopics.has(t.name)
        const messages = t ? echoMessagesByTopic[t.name] ?? [] : []

        return (
          <Fragment key={node.fullPrefix}>
            {hasChildren && (
              <div className="tree-row group" style={{ paddingLeft: groupIndent }} onClick={() => onToggleGroup(node.fullPrefix)}>
                <span className="tree-caret">{groupExpanded ? '▾' : '▸'}</span>{' '}
                <Highlight text={node.segment} query={searchQuery} />{' '}
                <span className="hint">
                  ({countLeaves(node)} topic{countLeaves(node) === 1 ? '' : 's'})
                </span>
              </div>
            )}

            {t && (
              <>
                <div className="tree-row leaf" style={{ paddingLeft: leafIndent }} onClick={() => onToggleExpand(t.name)}>
                  <span className="tree-caret">{detailsOpen ? '▾' : '▸'}</span> /
                  <Highlight text={t.name} query={searchQuery} />{' '}
                  <span className="hint">
                    ({t.types.join(', ')}) · {t.publisher_count} pub
                    {t.fake_publish_count > 0 && (
                      <span
                        className="fake-publish-count"
                        title="This dashboard has an active fake-publish session on this topic right now (Publish tab) - that many of the publishers above are synthetic, not a real upstream source."
                      >
                        {' '}
                        ({t.fake_publish_count} fake)
                      </span>
                    )}{' '}
                    · {t.subscriber_count} sub
                  </span>
                  {t.qos_mismatch && (
                    <span
                      className="qos-mismatch-badge"
                      title="A subscriber here requests a stricter QoS (reliability/durability) than some publisher offers - DDS silently drops those messages, no error anywhere."
                    >
                      ⚠ QoS mismatch
                    </span>
                  )}
                </div>

                {detailsOpen && (
                  <div style={{ paddingLeft: detailIndent, marginBottom: '0.75rem' }}>
                    <div className="hint" style={{ marginBottom: '0.4rem' }}>
                      {formatHz(hzByTopic[t.name])}
                    </div>
                    <TerminalPane
                      content={messages.length === 0 ? '' : joinEchoMessages(messages)}
                      emptyHint="waiting for a message… (max 5/sec forwarded)"
                      height={140}
                      storageKey={`topics.echo.${t.name}`}
                    />
                  </div>
                )}
              </>
            )}

            {hasChildren && groupExpanded && (
              <TopicsTreeView {...props} nodes={Object.values(node.children)} depth={depth + 1} />
            )}
          </Fragment>
        )
      })}
    </>
  )
}
