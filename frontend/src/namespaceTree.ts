// Generic version of the fast-forward namespace tree - used for both ROS2
// parameter names (dot-separated) and node names (slash-separated). Same
// GitHub-style collapsing rule either way: a node only fast-forwards into
// its child when it has exactly one child AND holds no leaf value itself.

export interface TreeNode<T> {
  segment: string
  fullPrefix: string
  leaf?: T
  children: Record<string, TreeNode<T>>
}

export function buildNamespaceTree<T>(
  items: T[],
  getPath: (item: T) => string,
  separator: string,
): TreeNode<T>[] {
  const root: TreeNode<T> = { segment: '', fullPrefix: '', children: {} }

  for (const item of items) {
    const parts = getPath(item).split(separator).filter((p) => p.length > 0)
    let node = root
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}${separator}${part}` : part
      if (!node.children[part]) {
        node.children[part] = { segment: part, fullPrefix: prefix, children: {} }
      }
      node = node.children[part]
    }
    node.leaf = item
  }

  return Object.values(root.children).map((n) => collapseNode(n, separator))
}

function collapseNode<T>(node: TreeNode<T>, separator: string): TreeNode<T> {
  let current = node
  while (current.leaf === undefined && Object.keys(current.children).length === 1) {
    const onlyChild = Object.values(current.children)[0]
    current = {
      segment: `${current.segment}${separator}${onlyChild.segment}`,
      fullPrefix: onlyChild.fullPrefix,
      leaf: onlyChild.leaf,
      children: onlyChild.children,
    }
  }

  const collapsedChildren: Record<string, TreeNode<T>> = {}
  for (const child of Object.values(current.children)) {
    const collapsedChild = collapseNode(child, separator)
    collapsedChildren[collapsedChild.fullPrefix] = collapsedChild
  }
  return { ...current, children: collapsedChildren }
}

export function countLeaves<T>(node: TreeNode<T>): number {
  let count = node.leaf !== undefined ? 1 : 0
  for (const child of Object.values(node.children)) count += countLeaves(child)
  return count
}

// Every group node's prefix (has children, isn't itself a leaf) across one
// or more trees - what a "Collapse all" button needs to mark every branch
// closed, without the caller having to already know the full set of
// namespace prefixes that currently exist.
export function collectGroupPrefixes<T>(trees: TreeNode<T>[]): string[] {
  const prefixes: string[] = []
  function walk(node: TreeNode<T>) {
    if (node.leaf === undefined && Object.keys(node.children).length > 0 && node.fullPrefix) {
      prefixes.push(node.fullPrefix)
    }
    for (const child of Object.values(node.children)) walk(child)
  }
  for (const t of trees) walk(t)
  return prefixes
}

// True if this node OR any descendant satisfies `predicate` - used to decide
// whether a branch survives search/filter (a group with zero matching
// descendants renders nothing, one with any match stays visible and gets
// force-expanded so the match is actually reachable, not just present).
export function subtreeMatches<T>(node: TreeNode<T>, predicate: (node: TreeNode<T>) => boolean): boolean {
  if (predicate(node)) return true
  for (const child of Object.values(node.children)) {
    if (subtreeMatches(child, predicate)) return true
  }
  return false
}
