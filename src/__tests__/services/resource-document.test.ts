import { describe, expect, it } from 'vitest'
import { createHash, webcrypto } from 'node:crypto'
import { applyResourcePatch, createDiagramFence, embeddedResourceBytes, parseResourceDocument, resourceDocumentBytes, type ResourceSpan } from '../../services/resource-document'
import { MAX_MARKER_BYTES, parseResourceMarker } from '../../services/resource-markers'

// jsdom's Crypto omits SubtleCrypto; production WebViews provide it in secure contexts.
Object.defineProperty(globalThis.crypto, 'subtle', { value: webcrypto.subtle, configurable: true })
const encode = (source: string) => new TextEncoder().encode(source)
const parse = (source: string) => parseResourceDocument(encode(source))
const marker = (id: string, kind = 'mermaid') => `<!-- mdw-resource:{"v":1,"id":"${id}","kind":"${kind}"} -->`
const sha = (source: string | Uint8Array) => createHash('sha256').update(source).digest('hex')
const range = (source: string, from: number, to: number): ResourceSpan => ({
  from, to, byteFrom: encode(source.slice(0, from)).length, byteTo: encode(source.slice(0, to)).length,
})

describe('Resource document contract (T07 / R07, R08, R09, R19)', () => {
  it('parses all four resource kinds in external and embedded forms without I/O', async () => {
    const source = [
      '![日本語](./設計.assets/picture.png "題名")',
      '![図](<./設計.assets/a b.svg>)',
      '![PNG](data:image/png;base64,iVBORw0KGgo=)',
      '![SVG](data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E)',
      '', '```mermaid', 'flowchart LR', '  A[開始] --> B[終了]', '```',
      '', '~~~drawio', '<mxfile><diagram id="日本"/></mxfile>', '~~~',
      '', '[図のソース](./設計.assets/flow(1).mmd)', marker('flow'),
      '', '[構成](./設計.assets/system.drawio)', marker('system', 'drawio'),
    ].join('\r\n')

    const document = await parse(source)

    expect(document.resources.map(item => [item.kind, item.storage])).toEqual([
      ['png', 'external'], ['svg', 'external'], ['png', 'embedded'], ['svg', 'embedded'],
      ['mermaid', 'embedded'], ['drawio', 'embedded'], ['mermaid', 'external'], ['drawio', 'external'],
    ])
    expect(document.resources[1].target).toBe('./設計.assets/a b.svg')
    expect(document.resources[6].target).toBe('./設計.assets/flow(1).mmd')
    expect(document.resources[4].source).toBe('flowchart LR\r\n  A[開始] --> B[終了]\r\n')
    expect(document.resources[2].sourceRevision).toBe(sha(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])))
    expect(document.resources[3].sourceRevision).toBe(sha('<svg></svg>'))
    expect(document.resources[6].sourceRevision).toBeUndefined()
    // jsdom Uint8Array and Node TextEncoder use separate realms; compare bytes.
    expect(Array.from(embeddedResourceBytes(document.resources[3])!)).toEqual(Array.from(encode('<svg></svg>')))
    expect(embeddedResourceBytes(document.resources[4])).toEqual(encode(document.resources[4].source!))
    expect(embeddedResourceBytes(document.resources[6])).toBeUndefined()
    expect(document.inertMarkers).toEqual([])
    expect(resourceDocumentBytes(document)).toEqual(encode(source))
  })

  it('retains UTF-8 BOM, mixed newlines, comments, Japanese and non-BMP characters byte for byte', async () => {
    const source = '\uFEFF見出し😀\r\n\r\n![図](./a.png)\n\n<!-- arbitrary unknown -->\r\n\n```mermaid\r\n%% 日本語😀\nA-->B\r\n```\r\n'
    const document = await parse(source)

    expect(document.source).toBe(source)
    expect(document.revision).toBe(sha(encode(source)))
    expect(resourceDocumentBytes(document)).toEqual(encode(source))
    for (const resource of document.resources) {
      expect(resource.raw).toBe(source.slice(resource.span.from, resource.span.to))
      expect(resource.span).toEqual(range(source, resource.span.from, resource.span.to))
      expect(new TextDecoder().decode(encode(source).slice(resource.span.byteFrom, resource.span.byteTo))).toBe(resource.raw)
    }
    expect(document.resources[0].span.byteFrom).toBeGreaterThan(document.resources[0].span.from)
  })

  it.each([
    '{"v":2,"id":"x","kind":"mermaid"}',
    '{"v":"1","id":"x","kind":"mermaid"}',
    '{"v":1,"id":"x","kind":"unknown"}',
    '{"v":1,"id":" ","kind":"mermaid"}',
    '{"v":1,"id":"x","kind":"mermaid",}',
    '{"v":2,"v":1,"id":"x","kind":"mermaid"}',
    '{"v":1,"id":"x","kind":"mermaid","\\u0069d":"y"}',
    '{"v":1,"id":"x","kind":"mermaid","future":{"x":1,"x":2}}',
    '{"v":1,"id":"x","kind":"mermaid","future":"<unsafe>"}',
    'null', '[]',
  ])('keeps invalid metadata inert: %s', async json => {
    const source = `[source](./x.mmd)\n<!-- mdw-resource:${json} -->`
    const document = await parse(source)

    expect(document.resources).toEqual([])
    expect(document.inertMarkers).toHaveLength(1)
    expect(resourceDocumentBytes(document)).toEqual(encode(source))
  })

  it('keeps oversized metadata inert and preserves escaped unknown fields exactly', async () => {
    const future = '{"v":1,"id":"x","kind":"mermaid","future":{"text":"\\u003c日本語\\u003e","items":["a","a"]}}'
    const source = `[source](./x.mmd)\n<!-- mdw-resource:${future} -->`
    const document = await parse(source)

    expect(document.resources[0].metadataRaw).toBe(`<!-- mdw-resource:${future} -->`)
    expect(parseResourceMarker(`<!-- mdw-resource:{"v":1,"id":"x","kind":"mermaid","future":"${'あ'.repeat(MAX_MARKER_BYTES)}"} -->`)).toBeNull()
  })

  it.each([
    `[a](./a.mmd) [b](./b.mmd)\n${marker('x')}`,
    `prefix [a](./a.mmd)\n${marker('x')}`,
    `[a](./a.mmd) suffix\n${marker('x')}`,
    `[a](./a.mmd)\n\n${marker('x')}`,
    `> [a](./a.mmd)\n> ${marker('x')}`,
    `![a](./a.mmd)\n${marker('x')}`,
    `[a][ref]\n${marker('x')}\n\n[ref]: ./a.mmd`,
    `${marker('x')}\n[a](./a.mmd)`,
    `[a](./a.mmd)\n${marker('x')} ${marker('y')}`,
  ])('does not bind ambiguous or unsupported marker placement', async source => {
    const document = await parse(source)
    expect(document.resources).toEqual([])
    expect(resourceDocumentBytes(document)).toEqual(encode(source))
  })

  it('invalidates every occurrence of duplicate persisted IDs while keeping repeated images distinct', async () => {
    const source = `[a](./a.mmd)\n${marker('same')}\n\n[b](./b.drawio)\n${marker('same', 'drawio')}\n\n![a](./a.png) ![a](./a.png)`
    const document = await parse(source)

    expect(document.resources).toHaveLength(2)
    expect(document.resources.map(resource => resource.kind)).toEqual(['png', 'png'])
    expect(new Set(document.resources.map(resource => resource.occurrenceId)).size).toBe(2)
    expect(document.inertMarkers).toHaveLength(2)
  })

  it('does not let an orphan duplicate marker share the identity of an active diagram', async () => {
    const document = await parse(`[a](./a.mmd)\n${marker('same')}\n\ntext\n\n${marker('same')}`)
    expect(document.resources).toEqual([])
    expect(document.inertMarkers).toHaveLength(2)
  })

  it('uses safe fences without changing diagram payload, BOM, or line endings', async () => {
    const payload = '\uFEFF%% 日本語 ` `````\r\nflowchart LR\nA-->B\r\n'
    const rendered = createDiagramFence(payload, 'mermaid', { newline: '\r\n', existingFence: '````' })
    const document = await parse(rendered)
    expect(rendered.startsWith('``````mermaid\r\n')).toBe(true)
    expect(document.resources[0].source).toBe(payload)
    expect(document.resources[0].sourceRevision).toBe(sha(payload))
    expect(createDiagramFence('A-->B\n', 'mermaid', { existingFence: '~~~~' })).toBe('~~~~mermaid\nA-->B\n~~~~')
    expect(createDiagramFence('', 'drawio')).toBe('```drawio\n```')
    expect(() => createDiagramFence('A-->B', 'mermaid')).toThrow('explicit trailing-newline')
    expect(() => createDiagramFence('\uD800\n', 'mermaid')).toThrow('Unicode')
    expect(() => createDiagramFence('', 'mermaid', { existingFence: 'bad' })).toThrow('fence')
  })

  it('uses Markdown structure for nested fences, escaped destinations and links in code', async () => {
    const source = '````text\n```mermaid\nA-->B\n```\n![hidden](./hidden.png)\n````\n\n`![code](./code.svg)`\n\n![visible](./a\\(b\\).png?x=1&amp;y=2)\n\n[plain](./x.mmd)'
    const document = await parse(source)

    expect(document.resources).toHaveLength(1)
    expect(document.resources[0].target).toBe('./a(b).png?x=1&y=2')
  })

  it('decodes escapes and HTML entities once, leaving percent decoding for authorization', async () => {
    const source = '![x](./a\\&amp;b%20c.png)\n![x](./a&amp;amp;b.svg)'
    const document = await parse(source)
    expect(document.resources.map(resource => resource.target)).toEqual(['./a&amp;b%20c.png', './a&amp;b.svg'])
  })

  it.each(['```mermaid\nA-->B', '```mermaid extra\nA-->B\n```', '> ```mermaid\n> A-->B\n> ```'])('leaves nonreversible or unsupported fences untouched', async source => {
    expect((await parse(source)).resources).toEqual([])
  })

  it.each(['data:image/png;base64,%%%','data:image/png;base64,AB==','data:image/svg+xml,%ZZ','data:image/svg+xml,非ASCII'])('does not accept malformed data URI payloads', async uri => {
    expect((await parse(`![bad](${uri})`)).resources).toEqual([])
  })

  it('rejects invalid UTF-8 rather than saving replacement characters', async () => {
    await expect(parseResourceDocument(new Uint8Array([0xc3, 0x28]))).rejects.toThrow()
  })

  it('patches only the selected occurrence and reparses spans after an edit', async () => {
    const source = '\uFEFF先頭😀\r\n\r\n![a](./a.png)\r\n\r\n![a](./a.png)\r\n末尾'
    const document = await parse(source)
    const first = document.resources[0]
    const updated = await applyResourcePatch(document, {
      revision: document.revision, span: first.span, expected: first.raw,
      replacement: '![もっと長い図](./b.svg)',
    })

    expect(updated.source).toBe(source.replace(first.raw, '![もっと長い図](./b.svg)'))
    expect(updated.resources[1].span.from).toBeGreaterThan(document.resources[1].span.from)
    expect(updated.resources[1].span).toEqual(range(updated.source, updated.resources[1].span.from, updated.resources[1].span.to))
    expect(updated.resources[1].raw).toBe(document.resources[1].raw)
    expect(document.source).toBe(source)
    await expect(applyResourcePatch(updated, { revision: document.revision, span: first.span, expected: first.raw, replacement: '' })).rejects.toThrow('revision conflict')
  })

  it('rejects wrong expected content, byte offsets, split surrogate pairs, and invalid replacement Unicode', async () => {
    const source = '😀\n\n![a](./a.png)'
    const document = await parse(source)
    const item = document.resources[0]
    const patch = { revision: document.revision, span: item.span, expected: item.raw, replacement: '' }
    await expect(applyResourcePatch(document, { ...patch, expected: 'different' })).rejects.toThrow('span')
    await expect(applyResourcePatch(document, { ...patch, span: { ...item.span, byteFrom: 0 } })).rejects.toThrow('span')
    await expect(applyResourcePatch(document, { ...patch, span: range(source, 1, 2), expected: source.slice(1, 2) })).rejects.toThrow('span')
    await expect(applyResourcePatch(document, { ...patch, replacement: '\uD800' })).rejects.toThrow('Unicode')
  })
})
