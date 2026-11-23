import { useCallback, useState } from 'react'

// Remembers the *current* in-progress text per namespace (service/action
// name) across a refresh - not a history of past sends, just "what was I
// typing here." Capped at the 100 most-recently-touched namespaces so a
// long-running dashboard doesn't accumulate an unbounded pile of drafts
// for every service/action anyone's ever glanced at; touching a namespace
// (typing into it) moves it back to "recently used" and can evict the
// least-recently-touched one once the cap is hit.
const MAX_NAMESPACES = 100

function load(key: string): Map<string, string> {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return new Map()
    return new Map(JSON.parse(raw) as [string, string][])
  } catch {
    return new Map()
  }
}

function save(key: string, map: Map<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(map.entries())))
  } catch {
    // storage disabled/full - this draft just won't survive a reload
  }
}

export function useDraftStore(storageKey: string) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(load(storageKey)))

  const setDraft = useCallback(
    (namespace: string, value: string) => {
      setDrafts((prev) => {
        const map = new Map(Object.entries(prev))
        map.delete(namespace) // re-insert so it lands at the "most recent" end
        map.set(namespace, value)
        while (map.size > MAX_NAMESPACES) {
          const oldest = map.keys().next().value
          if (oldest === undefined) break
          map.delete(oldest)
        }
        save(storageKey, map)
        return Object.fromEntries(map)
      })
    },
    [storageKey],
  )

  return [drafts, setDraft] as const
}
