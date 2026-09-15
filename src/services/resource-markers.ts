/** Metadata is inert JSON, never executable HTML. Unknown fields stay in raw Markdown. */
export interface ResourceMarker {
  readonly v: 1
  readonly id: string
  readonly kind: 'mermaid' | 'drawio'
  readonly [field: string]: unknown
}

export const MAX_MARKER_BYTES = 16 * 1024

// JSON.parse discards duplicate keys. Check token structure before trusting its result,
// including escaped keys and duplicate keys inside future metadata objects.
function hasDuplicateKeys(json: string): boolean {
  const frames: Array<Set<string> | null> = []
  const tokens = json.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? []
  let previous = ''
  for (const token of tokens) {
    if (token === '{') frames.push(new Set())
    else if (token === '[') frames.push(null)
    else if (token === '}' || token === ']') frames.pop()
    else if (token.startsWith('"') && (previous === '{' || previous === ',')) {
      const keys = frames[frames.length - 1]
      if (keys) {
        const key: string = JSON.parse(token)
        if (keys.has(key)) return true
        keys.add(key)
      }
    }
    previous = token
  }
  return false
}

export function parseResourceMarker(raw: string): ResourceMarker | null {
  if (new TextEncoder().encode(raw).length > MAX_MARKER_BYTES) return null
  const match = /^<!--[ \t]*mdw-resource:([^]*?)[ \t]*-->[ \t\r]*$/.exec(raw)
  if (!match || /[<>]/.test(match[1])) return null
  try {
    const value: unknown = JSON.parse(match[1])
    if (hasDuplicateKeys(match[1]) || !value || typeof value !== 'object' || Array.isArray(value)) return null
    const marker = value as Record<string, unknown>
    if (marker.v !== 1 || typeof marker.id !== 'string' || !marker.id.trim()
      || (marker.kind !== 'mermaid' && marker.kind !== 'drawio')) return null
    return marker as ResourceMarker
  } catch {
    return null
  }
}
