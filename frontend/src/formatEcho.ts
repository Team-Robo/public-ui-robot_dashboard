// Flat, YAML-like rendering instead of JSON.stringify - no braces, no
// quoting on numbers/booleans, matching the format `ros2 topic echo`
// itself uses (it's YAML under the hood; a message is just a document).
export function formatEcho(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)

  if (value === null || value === undefined) return `${pad}null`

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    return value
      .map((v) =>
        v !== null && typeof v === 'object' ? `${pad}-\n${formatEcho(v, indent + 1)}` : `${pad}- ${formatScalar(v)}`,
      )
      .join('\n')
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // The backend's truncation marker for oversized arrays/byte fields
    // (images, point clouds) - render it as one readable line, not as a
    // nested object with its own braces.
    if (obj.__truncated__) {
      return `${pad}<truncated: ${obj.length} items, preview ${JSON.stringify(obj.preview)}>`
    }
    const entries = Object.entries(obj)
    if (entries.length === 0) return `${pad}{}`
    return entries
      .map(([k, v]) => {
        if (v !== null && typeof v === 'object') return `${pad}${k}:\n${formatEcho(v, indent + 1)}`
        return `${pad}${k}: ${formatScalar(v)}`
      })
      .join('\n')
  }

  return `${pad}${formatScalar(value)}`
}

function formatScalar(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value)
}

// Single-line messages (the common case - String, Bool, Int32, etc.) don't
// need a separator at all, each new line already reads as its own entry.
// Multi-line ones (nested fields) do, or consecutive entries visually
// blend into one block with no way to tell where one message ends and the
// next begins.
export function joinEchoMessages(messages: unknown[]): string {
  const formatted = messages.map((m) => formatEcho(m))
  return formatted.reduce((acc, curr, i) => {
    if (i === 0) return curr
    const prev = formatted[i - 1]
    const needsSeparator = prev.includes('\n') || curr.includes('\n')
    return `${acc}${needsSeparator ? '\n---\n' : '\n'}${curr}`
  }, '')
}
