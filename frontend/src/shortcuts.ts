// Site-wide keyboard shortcuts. Only one is wired up today (e-stop), but
// the registry/storage/matching machinery is generic so more can be added
// later without touching this file's shape.
//
// Combos are matched on e.code (physical key, e.g. "KeyE") rather than
// e.key - e.key reflects whatever character a modifier produces on the
// current OS/layout (e.g. macOS remaps Option+letter to accented
// characters), which would silently break a combo like ctrl+alt+e on some
// machines. e.code is layout-independent, so a combo recorded on one
// keyboard still fires on another.

export interface ShortcutDef {
  id: string
  label: string
  defaultCombo: string
}

export const SHORTCUTS: ShortcutDef[] = [{ id: 'estop', label: 'Trigger E-Stop', defaultCombo: 'ctrl+alt+KeyE' }]

const STORAGE_KEY = 'dashboard.shortcuts'

type ShortcutMap = Record<string, string>

function loadAll(): ShortcutMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ShortcutMap) : {}
  } catch {
    return {}
  }
}

function saveAll(map: ShortcutMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // storage disabled/full - the rebind just won't survive a reload
  }
}

// Always re-reads localStorage rather than caching, so a rebind made in
// Settings takes effect on the very next keypress with no extra plumbing
// to notify already-mounted listeners.
export function getCombo(id: string): string {
  const stored = loadAll()[id]
  if (stored) return stored
  return SHORTCUTS.find((s) => s.id === id)?.defaultCombo ?? ''
}

export function setCombo(id: string, combo: string): void {
  const all = loadAll()
  all[id] = combo
  saveAll(all)
}

export function resetCombo(id: string): void {
  const all = loadAll()
  delete all[id]
  saveAll(all)
}

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'])

// Returns null while only a modifier is held - a combo isn't complete
// until a non-modifier key joins it.
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(e.code)
  return parts.join('+')
}

export function comboMatches(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false
  return comboFromEvent(e) === combo
}

function prettyCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return code
}

export function formatCombo(combo: string): string {
  if (!combo) return '(unset)'
  return combo
    .split('+')
    .map((part) => (part === 'ctrl' || part === 'alt' || part === 'shift' || part === 'meta' ? part[0].toUpperCase() + part.slice(1) : prettyCode(part)))
    .join(' + ')
}
