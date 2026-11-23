// Tiny, dependency-free notification store feeding NotificationCenter.
// The point is a single, robust "needs attention" channel the UI can hook
// into from anywhere: call notify() and a non-intrusive toast slides in on
// the side, auto-dismisses, and is click-to-dismiss. The automatic target-
// state watcher (App.tsx) is its first consumer; future ones (a service call
// failing, a BT node throwing, a fake-publish error, ...) just call notify()
// too - no per-feature UI needed.

export type NotifySeverity = 'info' | 'warn' | 'error'

export interface AppNotification {
  id: number
  title: string
  message?: string
  severity: NotifySeverity
  createdAt: number
  // null = stick around until dismissed. undefined (default) -> autoDismissMs.
  autoDismissMs: number | null
}

type Listener = (items: AppNotification[]) => void

// Keep at most this many queued - the height cap in NotificationCenter is the
// real limit on what's on screen, this just stops the array growing unbounded
// behind it. Older ones fall off as new ones arrive (auto-stack, capped).
const MAX_VISIBLE = 12
const DEFAULT_DISMISS_MS = 6000

let items: AppNotification[] = []
let nextId = 1
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l([...items])
}

export function notify(opts: {
  title: string
  message?: string
  severity?: NotifySeverity
  autoDismissMs?: number | null
}): number {
  const id = nextId++
  const autoDismissMs = opts.autoDismissMs === undefined ? DEFAULT_DISMISS_MS : opts.autoDismissMs
  const note: AppNotification = {
    id,
    title: opts.title,
    message: opts.message,
    severity: opts.severity ?? 'info',
    createdAt: Date.now(),
    autoDismissMs,
  }
  // Keep only the most recent MAX_VISIBLE, oldest dropped - the side panel
  // must stay non-intrusive, not turn into a log.
  items = [...items.slice(-(MAX_VISIBLE - 1)), note]
  emit()
  if (note.autoDismissMs) setTimeout(() => dismiss(id), note.autoDismissMs)
  return id
}

export function dismiss(id: number): void {
  const next = items.filter((n) => n.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

// Returns an unsubscribe. Fires the listener immediately with the current
// items so a freshly-mounted NotificationCenter shows any backlog.
export function subscribeNotifications(cb: Listener): () => void {
  listeners.add(cb)
  cb([...items])
  return () => {
    listeners.delete(cb)
  }
}
