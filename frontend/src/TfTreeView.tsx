import { Fragment } from 'react'
import { TfTreeNode } from './tfTree'

interface Props {
  nodes: TfTreeNode[]
  // Accumulated box-drawing connector-guide string from ancestors ('' at
  // the top level, so root frame(s) print bare rather than with a
  // dangling connector pointing at nothing). Each level appends '│ '
  // for a still-open ancestor branch (more siblings coming after it) or
  // '  ' once that ancestor was the last child of its own parent - same
  // algorithm schema.py's format_message_schema uses in Python (2 chars/
  // level rather than the tree(1)-standard 4, since ROS messages nest
  // deep enough that 4 made both this and the schema panel absurdly wide).
  prefix: string
}

// Box-drawing tree instead of plain indentation - parent/child was
// genuinely ambiguous to read as just nested padding once a frame had
// more than one child (camera_link/lidar_link both under base_link looked
// like a flat list, not a fork). Not a node-graph canvas: deliberately the
// same visual idiom as every other list in this tab (tree-row/tree-caret)
// rather than pulling in React Flow (already used by the BT tab) just for
// this - most robots' TF trees are small enough that a connected text tree
// reads just as clearly.
export default function TfTreeView({ nodes, prefix }: Props) {
  return (
    <>
      {nodes.map((n, i) => {
        const isLast = i === nodes.length - 1
        const branch = prefix === '' ? '' : isLast ? '└ ' : '├ '
        const childPrefix = prefix + (isLast ? '  ' : '│ ')
        return (
          <Fragment key={n.frame}>
            <div className="tree-row leaf tf-row" style={{ cursor: 'default' }}>
              <span className="tf-guide">
                {prefix}
                {branch}
              </span>
              {n.frame}
            </div>
            {n.children.length > 0 && <TfTreeView nodes={n.children} prefix={childPrefix} />}
          </Fragment>
        )
      })}
    </>
  )
}
