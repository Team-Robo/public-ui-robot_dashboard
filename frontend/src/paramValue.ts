export const ARRAY_TYPES = new Set(['bool_array', 'integer_array', 'double_array', 'string_array'])

export function valueToEditString(value: unknown): string {
  if (Array.isArray(value)) return value.join(',')
  return String(value)
}

export function parseEditString(type: string, raw: string): unknown {
  if (type === 'bool') return raw === 'true'
  if (type === 'integer') return parseInt(raw, 10)
  if (type === 'double') return parseFloat(raw)
  if (type === 'string') return raw
  if (ARRAY_TYPES.has(type)) {
    const elementType = type.replace('_array', '')
    const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (elementType === 'bool') return parts.map((p) => p === 'true')
    if (elementType === 'integer') return parts.map((p) => parseInt(p, 10))
    if (elementType === 'double') return parts.map((p) => parseFloat(p))
    return parts
  }
  return raw
}

export interface Validity {
  valid: boolean
  message?: string
}

const VALID: Validity = { valid: true }
const INTEGER_RE = /^-?\d+$/
const DOUBLE_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

// Frontend-only guardrails so a bad value never even reaches the "Set"
// button - the backend's read_only/rejection handling is a separate,
// already-existing layer for things only ROS2 itself can reject.
export function validateEditValue(type: string, raw: string): Validity {
  const trimmed = raw.trim()

  if (type === 'bool') {
    return trimmed === 'true' || trimmed === 'false' ? VALID : { valid: false, message: 'must be true or false' }
  }
  if (type === 'integer') {
    return INTEGER_RE.test(trimmed) ? VALID : { valid: false, message: 'must be a whole number, e.g. 42 or -3' }
  }
  if (type === 'double') {
    return DOUBLE_RE.test(trimmed) ? VALID : { valid: false, message: 'must be a number, e.g. 3.14 or -1' }
  }
  if (type === 'string') {
    return VALID
  }
  if (ARRAY_TYPES.has(type)) {
    const elementType = type.replace('_array', '')
    const parts = trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    for (const part of parts) {
      const result = validateEditValue(elementType, part)
      if (!result.valid) return { valid: false, message: `each comma-separated value ${result.message ?? 'is invalid'}` }
    }
    return VALID
  }
  return VALID
}
