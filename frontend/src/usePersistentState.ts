import { useEffect, useState } from 'react'

// Same lazy-init + write-back-on-change pattern already used ad hoc for
// pinned params and collapsed categories, generalized so new persisted
// settings (e.g. Graph tab's "advanced" toggle) don't each hand-roll their
// own localStorage get/set/try-catch.
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage disabled/full - setting just won't survive reload
    }
  }, [key, value])

  return [value, setValue] as const
}

// Same idea, for the very common case of a Set<string> tracking which
// rows/groups are expanded or collapsed (a plain JSON.stringify(Set) would
// serialize to "{}" - Sets aren't natively JSON-able - so this isn't just
// usePersistentState<Set<string>>, it needs its own array<->Set
// conversion on the way in and out).
export function usePersistentSet(key: string, initial: string[] = []) {
  const [value, setValue] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw !== null ? new Set(JSON.parse(raw) as string[]) : new Set(initial)
    } catch {
      return new Set(initial)
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify([...value]))
    } catch {
      // storage disabled/full - setting just won't survive reload
    }
  }, [key, value])

  return [value, setValue] as const
}

// Record<key, Set<string>> - a nested set map. Used by the Control/
// Visualization tabs' per-target launch-flag checkboxes ("device:=cpu",
// "use_fallback:=true", ...) AND the Params tab's collapsed param groups,
// both of which key a Set off some id. A Set isn't JSON-able
// (JSON.stringify(Set) === "{}"), so like usePersistentSet this needs its
// own Array<->Set round-trip, but on a per-id basis instead of a single flat
// set. Naming matches the state shapes it backs, so the setter still takes
// the same functional-update callbacks.
export function usePersistentStringSetMap(key: string) {
  const [value, setValue] = useState<Record<string, Set<string>>>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return {}
      const obj = JSON.parse(raw) as Record<string, string[]>
      const out: Record<string, Set<string>> = {}
      for (const [k, v] of Object.entries(obj)) out[k] = new Set(v)
      return out
    } catch {
      return {}
    }
  })

  useEffect(() => {
    try {
      const obj: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(value)) obj[k] = [...v]
      localStorage.setItem(key, JSON.stringify(obj))
    } catch {
      // storage disabled/full - setting just won't survive reload
    }
  }, [key, value])

  return [value, setValue] as const
}
