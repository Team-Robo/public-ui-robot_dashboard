export interface TfTreeNode {
  frame: string
  children: TfTreeNode[]
}

// TF is a genuine parent/child graph (frame_id -> child_frame_id), not a
// '/'-delimited namespace string like everything else this app trees out -
// buildNamespaceTree doesn't apply here, hence a small dedicated builder.
// Roots are frames that are never seen as a child (typically just 'map' or
// 'odom'). A cycle guard is deliberate, not defensive-programming
// leftover: a misconfigured TF tree (a frame reparented into its own
// subtree) is a real, real-world bug this view should surface rather than
// hang rendering on.
export function buildTfTree(links: Record<string, string>): TfTreeNode[] {
  const childrenOf: Record<string, string[]> = {}
  const allFrames = new Set<string>()
  for (const [child, parent] of Object.entries(links)) {
    allFrames.add(child)
    allFrames.add(parent)
    ;(childrenOf[parent] ??= []).push(child)
  }
  const rendered = new Set<string>()

  function build(frame: string, ancestors: Set<string>): TfTreeNode {
    if (ancestors.has(frame)) {
      return { frame: `${frame} (cycle - check your TF tree)`, children: [] }
    }
    rendered.add(frame)
    const nextAncestors = new Set(ancestors).add(frame)
    return {
      frame,
      children: (childrenOf[frame] ?? []).sort().map((c) => build(c, nextAncestors)),
    }
  }

  const roots = [...allFrames].filter((f) => !(f in links)).sort()
  const result = roots.map((r) => build(r, new Set()))

  // A frame every one of whose ancestors also has a parent (a pure cycle,
  // no legitimate root) never gets visited above and would otherwise just
  // vanish instead of being flagged - surface it anyway, picking one
  // arbitrary entry point per still-unvisited cluster.
  for (const f of [...allFrames].sort()) {
    if (!rendered.has(f)) result.push(build(f, new Set()))
  }

  return result
}
