import { markdownLanguage } from '@codemirror/lang-markdown'
import { parseResourceMarker, type ResourceMarker } from './resource-markers'

export type ResourceKind = 'png' | 'svg' | 'mermaid' | 'drawio'
/** Half-open ranges. UTF-16 is for editors; UTF-8 is for the canonical file bytes. */
export interface ResourceSpan {
  readonly from: number
  readonly to: number
  readonly byteFrom: number
  readonly byteTo: number
}
export interface Resource {
  /** Occurrence identity is revision-local; markerId is the persisted diagram identity. */
  readonly occurrenceId: string
  readonly markerId?: string
  readonly kind: ResourceKind
  readonly storage: 'external' | 'embedded'
  readonly span: ResourceSpan
  readonly raw: string
  readonly documentRevision: string
  /** Undefined until an external target has been read through the authorized host. */
  readonly sourceRevision?: string
  readonly target?: string
  readonly source?: string
  readonly dataUri?: string
  readonly metadataRaw?: string
  readonly sourceSpan?: ResourceSpan
}
export interface ResourceDocument {
  readonly source: string
  readonly revision: string
  readonly resources: readonly Resource[]
  readonly inertMarkers: readonly ResourceSpan[]
}
export interface ResourcePatch {
  readonly revision: string
  readonly span: ResourceSpan
  readonly expected: string
  readonly replacement: string
}

const encoder = new TextEncoder()
type Node = ReturnType<typeof markdownLanguage.parser.parse>['topNode']

export async function resourceRevision(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

function byteOffsets(source: string): number[] {
  const offsets = new Array<number>(source.length + 1)
  let byte = 0
  for (let i = 0; i < source.length; i++) {
    offsets[i] = byte
    const point = source.codePointAt(i)!
    if (point > 0xffff) {
      offsets[++i] = -1 // A patch must never split a surrogate pair.
      byte += 4
    } else byte += point < 0x80 ? 1 : point < 0x800 ? 2 : 3
  }
  offsets[source.length] = byte
  return offsets
}

function targetOf(node: Node, source: string): string | undefined {
  const url = node.getChild('URL')
  if (!url) return undefined // Reference-style links remain inert until resolved explicitly.
  const raw = source.slice(url.from, url.to).replace(/^<([^]*)>$/, '$1')
  // Decode CommonMark escapes/entities exactly once. Percent escapes remain for the host
  // to decode before path authorization; this parser never reads or fetches a target.
  return raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])|&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/g, (token, escaped: string | undefined) => {
    if (escaped) return escaped
    const textarea = document.createElement('textarea')
    textarea.innerHTML = token
    return textarea.value
  })
}

function dataUriBytes(uri: string): Uint8Array | null {
  const match = /^data:image\/(?:png|svg\+xml)(;base64)?,([^]*)$/i.exec(uri)
  if (!match) return null
  try {
    if (match[1]) {
      // Reject permissive decoders' partial payloads and noncanonical padding bits.
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(match[2])) return null
      const binary = atob(match[2])
      if (btoa(binary) !== match[2]) return null
      return Uint8Array.from(binary, c => c.charCodeAt(0))
    }
    const bytes: number[] = []
    for (let i = 0; i < match[2].length; i++) {
      if (match[2][i] === '%') {
        const hex = match[2].slice(i + 1, i + 3)
        if (!/^[\da-f]{2}$/i.test(hex)) return null
        bytes.push(parseInt(hex, 16)); i += 2
      } else {
        const code = match[2].charCodeAt(i)
        if (code > 0x7f) return null
        bytes.push(code)
      }
    }
    return new Uint8Array(bytes)
  } catch { return null }
}

/** Returns a fresh copy of the canonical embedded payload; external bytes need a host grant. */
export function embeddedResourceBytes(resource: Resource): Uint8Array | undefined {
  if (resource.storage !== 'embedded') return undefined
  if (resource.source !== undefined) return encoder.encode(resource.source)
  return resource.dataUri ? dataUriBytes(resource.dataUri) ?? undefined : undefined
}

/** Fence creation is reversible only when payload already ends at a line boundary. */
export function createDiagramFence(source: string, kind: 'mermaid' | 'drawio', options: {
  newline?: '\n' | '\r\n'
  existingFence?: string
} = {}): string {
  if (source && !source.endsWith('\n')) throw new Error('Diagram source requires an explicit trailing-newline conversion')
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoder.encode(source)) !== source) throw new Error('Invalid Unicode source')
  const existing = options.existingFence ?? '```'
  if (!/^(?:`{3,}|~{3,})$/.test(existing)) throw new Error('Invalid diagram fence')
  const marker = existing[0]
  const runs = source.match(marker === '`' ? /`+/g : /~+/g) ?? []
  const length = runs.reduce((longest, run) => Math.max(longest, run.length + 1), existing.length)
  const fence = marker.repeat(length)
  const newline = options.newline ?? '\n'
  return `${fence}${kind}${newline}${source}${fence}`
}

/** Decode strict UTF-8 while retaining a BOM and every original newline. No I/O. */
export async function parseResourceDocument(bytes: Uint8Array): Promise<ResourceDocument> {
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const revision = await resourceRevision(bytes)
  const offsets = byteOffsets(source)
  const span = (from: number, to: number): ResourceSpan => Object.freeze({ from, to, byteFrom: offsets[from], byteTo: offsets[to] })
  // The BOM is file metadata, not Markdown indentation. Keep parser offsets aligned.
  const tree = markdownLanguage.parser.parse(source.startsWith('\uFEFF') ? ' ' + source.slice(1) : source)
  const resources: Resource[] = []
  const inertMarkers: ResourceSpan[] = []
  const marked: Array<{ marker: ResourceMarker; resource: Resource; markerSpan: ResourceSpan }> = []
  const markerCounts = new Map<string, number>()
  const pendingHashes: Array<Promise<void>> = []
  const add = (node: Node, kind: ResourceKind, storage: Resource['storage'], extra: Partial<Resource>, payload?: Uint8Array) => {
    const resource: Resource = {
      occurrenceId: `${revision}:${node.from}`, kind, storage, span: span(node.from, node.to),
      raw: source.slice(node.from, node.to), documentRevision: revision, ...extra,
    }
    resources.push(resource)
    if (payload) pendingHashes.push(resourceRevision(payload).then(hash => { Object.assign(resource, { sourceRevision: hash }) }))
    return resource
  }
  tree.iterate({ enter(nodeRef) {
    const node = nodeRef.node
    if (node.name === 'Image') {
      const target = targetOf(node, source)
      if (!target) return
      const dataKind = /^data:image\/(png|svg\+xml)[;,]/i.exec(target)
      if (dataKind) {
        const payload = dataUriBytes(target)
        if (payload) add(node, dataKind[1].toLowerCase() === 'png' ? 'png' : 'svg', 'embedded', { dataUri: target }, payload)
      } else {
        const extension = /\.(png|svg)(?:[?#].*)?$/i.exec(target)
        if (extension) add(node, extension[1].toLowerCase() as ResourceKind, 'external', { target })
      }
    } else if (node.name === 'FencedCode' && node.parent?.name === 'Document') {
      const info = node.getChild('CodeInfo')
      const kind = info && source.slice(info.from, info.to)
      if (kind !== 'mermaid' && kind !== 'drawio') return
      const marks = node.getChildren('CodeMark')
      if (marks.length !== 2) return // Unclosed fences cannot be converted reversibly.
      const lineEnd = source.indexOf('\n', marks[0].to)
      const closeLine = source.lastIndexOf('\n', marks[1].from - 1) + 1
      if (lineEnd < 0 || closeLine < lineEnd + 1) return
      const from = lineEnd + 1
      const payload = source.slice(from, closeLine)
      add(node, kind, 'embedded', { source: payload, sourceSpan: span(from, closeLine) }, encoder.encode(payload))
    } else if (node.name === 'CommentBlock' && source.slice(node.from, node.to).includes('mdw-resource:')) {
      const markerSpan = span(node.from, node.to)
      const raw = source.slice(node.from, node.to)
      const marker = parseResourceMarker(raw)
      if (marker) markerCounts.set(marker.id, (markerCounts.get(marker.id) ?? 0) + 1)
      const paragraph = node.prevSibling
      const link = paragraph?.getChild('Link')
      const gap = paragraph ? source.slice(paragraph.to, node.from) : ''
      const target = link && targetOf(link, source)
      if (!marker || node.parent?.name !== 'Document' || paragraph?.name !== 'Paragraph' || !link || !target
        || source.slice(paragraph.from, paragraph.to).trim() !== source.slice(link.from, link.to)
        || !/^\s*$/.test(gap) || (gap.match(/\n/g)?.length ?? 0) > 1) {
        inertMarkers.push(markerSpan)
        return
      }
      const resource = add(node, marker.kind, 'external', {
        markerId: marker.id, target, metadataRaw: raw,
        span: span(paragraph.from, node.to), raw: source.slice(paragraph.from, node.to),
        occurrenceId: `${revision}:${paragraph.from}`,
      })
      marked.push({ marker, resource, markerSpan })
    }
  } })
  const duplicateResources = new Set<Resource>()
  for (const item of marked) {
    if (markerCounts.get(item.marker.id)! > 1) {
      duplicateResources.add(item.resource)
      inertMarkers.push(item.markerSpan)
    }
  }
  await Promise.all(pendingHashes)
  return Object.freeze({ source, revision,
    resources: Object.freeze(resources.filter(resource => !duplicateResources.has(resource)).map(resource => Object.freeze(resource))),
    inertMarkers: Object.freeze(inertMarkers.sort((a, b) => a.from - b.from)),
  })
}

/** No-edit serialization is byte-identical for every accepted UTF-8 document. */
export function resourceDocumentBytes(document: ResourceDocument): Uint8Array {
  return encoder.encode(document.source)
}

/** Reparse after every successful edit: offsets from a previous revision are invalid. */
export async function applyResourcePatch(document: ResourceDocument, patch: ResourcePatch): Promise<ResourceDocument> {
  if (document.revision !== patch.revision || await resourceRevision(resourceDocumentBytes(document)) !== patch.revision) {
    throw new Error('Resource revision conflict')
  }
  const { from, to, byteFrom, byteTo } = patch.span
  const offsets = byteOffsets(document.source)
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > document.source.length
    || offsets[from] < 0 || offsets[to] < 0 || offsets[from] !== byteFrom || offsets[to] !== byteTo
    || document.source.slice(from, to) !== patch.expected) throw new Error('Invalid resource patch span')
  const encoded = encoder.encode(patch.replacement)
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded) !== patch.replacement) throw new Error('Invalid Unicode replacement')
  const updated = document.source.slice(0, from) + patch.replacement + document.source.slice(to)
  return parseResourceDocument(encoder.encode(updated))
}
