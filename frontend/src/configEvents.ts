import type { ConfigDiff } from './api'

// SettingsModal is a sibling overlay to whatever tab happens to be
// mounted behind it (Control, Behavior Tree, ...) - there's no parent/
// child relationship to hand a "please refetch" callback through
// directly. Each tab that keeps its own independently-fetched copy of
// the target/tree list (fetched once on mount, never invalidated on its
// own) subscribes here instead, and re-fetches when notified - without
// this, saving in Settings applies live on the backend but the rest of
// the page just doesn't know to look again until a manual reload.
function makeChannel() {
  const listeners = new Set<() => void>()
  return {
    subscribe(cb: () => void): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    notify(): void {
      for (const cb of listeners) cb()
    },
  }
}

const targetsChannel = makeChannel()
const treesChannel = makeChannel()

export const onTargetsChanged = targetsChannel.subscribe
export const notifyTargetsChanged = targetsChannel.notify
export const onTreesChanged = treesChannel.subscribe
export const notifyTreesChanged = treesChannel.notify

// Shared by both reload sites (App.tsx's page-load effect, MiscTab's manual
// button) so a from-disk config reload that actually changed something -
// someone else's save, a hand-edit of ~/.dashboard_targets.yaml, a git pull
// on config/targets.yaml - surfaces as a toast instead of only being
// visible if you happen to go looking. Returns [] when nothing changed
// (added/removed/changed all empty), so callers can skip notifying.
export function describeConfigDiff(kind: string, diff: ConfigDiff): string[] {
  const parts: string[] = []
  if (diff.added.length) parts.push(`${diff.added.length} ${kind} added (${diff.added.join(', ')})`)
  if (diff.removed.length) parts.push(`${diff.removed.length} ${kind} removed (${diff.removed.join(', ')})`)
  if (diff.changed.length) parts.push(`${diff.changed.length} ${kind} changed (${diff.changed.join(', ')})`)
  return parts
}

// Same shape as describeConfigDiff but for code_changed - a colcon
// rebuild of a target's package, which touches neither targets.yaml nor
// any env var, so it's a genuinely separate signal from the config diff
// above (see config_routes.py's reload_live_config).
export function describeCodeChanged(ids: string[]): string[] {
  return ids.length ? [`${ids.length} target${ids.length > 1 ? 's' : ''} rebuilt (${ids.join(', ')})`] : []
}
