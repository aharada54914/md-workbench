# Resource parser and revision contract

Task: T07 / issue #17. Requirements: R07, R08, R09, R19.

## ADR-0002 approval

On **2026-09-15**, the user explicitly answered **「この保存形式案を承認する」**
in the continuing implementation task. The approved proposal is
[RESOURCE_FORMAT.md v0.2](https://github.com/aharada54914/md-workbench/blob/7bffca8d9ed224bab3a07313bada7a35d5eb80c2/docs/md-workbench/RESOURCE_FORMAT.md):

- External assets default to `<document-stem>.assets/`.
- PNG/SVG use ordinary Markdown images or embedded data URIs.
- Embedded Mermaid/draw.io use their respective code fences.
- External diagram source uses a normal standalone link followed immediately by a
  versioned `mdw-resource` JSON comment. The link is the only path authority.

This records the storage-format approval only. It does not approve a release,
arbitrary external paths, overwrites, or GUI/AI capabilities.

## Implemented API

`src/services/resource-document.ts` parses strict UTF-8 bytes using the existing
CodeMirror Markdown parser. It does not read files, fetch URLs, or render payloads.

- `parseResourceDocument(bytes)` returns an immutable source snapshot, SHA-256
  document revision, resources, and inert marker spans.
- Every resource has an exact raw span with half-open UTF-16 editor offsets and
  UTF-8 byte offsets. Its occurrence ID is local to that document revision.
  A marker ID is persisted and must be unique across parsed markers.
- Embedded `sourceRevision` is SHA-256 of canonical payload bytes, including its
  BOM, trailing newline, and original line endings. External `sourceRevision` is
  absent until the host obtains authorized asset bytes; the Markdown link hash is
  never represented as an asset hash.
- `embeddedResourceBytes(resource)` returns fresh canonical payload bytes.
  PNG/SVG MIME and editable metadata validation belongs to T10/T11; recognizing a
  data URI or filename does not prove valid or safe image content.
- `resourceDocumentBytes(document)` reproduces every accepted UTF-8 source byte
  without edits, including BOM and mixed newlines. Invalid UTF-8 is rejected.
- `applyResourcePatch(document, patch)` checks the expected revision, exact old
  text, UTF-16 boundaries, and UTF-8 offsets, applies only that range, and reparses
  the document. Stale offsets, mismatched content, and split surrogate pairs fail.
  This is an in-memory candidate operation; it supplies no filesystem CAS or
  authorization guarantee. T08 must enforce those separately.
- `createDiagramFence` preserves a safe existing fence or lengthens it beyond
  payload marker runs. It preserves payload bytes and refuses to silently add a
  trailing newline to source that lacks one.

Targets retain percent escapes for the host to decode **before** authorization.
CommonMark punctuation escapes and HTML entities are decoded once. Paths are not
trusted or granted by parsing, including absolute paths and remote URLs.

## Conservative cases

Unknown versions, duplicate JSON keys (including escaped/nested duplicates),
invalid schema/JSON, literal `<`/`>` inside JSON, and metadata larger than 16 KiB
remain inert original text. Unknown fields remain byte-identical in metadata raw
text. Every duplicate marker ID is inert, including when one occurrence is an
orphan marker. No `mdw-resource` comment grants execution capability.

Only a top-level standalone inline-link paragraph immediately followed by its
marker binds as an external diagram. Blank lines, multiple links, accompanying
prose, nested quote/list markers, and reference-style links remain ordinary raw
Markdown. Reference-style images likewise stay ordinary Markdown at this stage.
Closed top-level `mermaid`/`drawio` fences with no additional info string are
recognized. Nested or unclosed fences stay raw; code inside a larger outer fence
never becomes a resource. These fallbacks do not rewrite or discard content.

## Acceptance evidence

`src/__tests__/services/resource-document.test.ts` covers all four types in both
storage modes, exact CRLF/LF/BOM preservation, Japanese and astral characters,
duplicate diagrams, unknown fields/versions, malformed and oversized markers,
Markdown structure and escaped destinations, malformed data URIs, invalid UTF-8,
canonical payload hashes, safe fences, stale patches, and shifted UTF-16/UTF-8
offsets after editing.

Validation commands:

```sh
pnpm test:run src/__tests__/services/resource-document.test.ts
pnpm exec vue-tsc --noEmit
```

Local result on 2026-09-15: **38 tests passed, 0 failed**, and TypeScript checking
passed. Coverage percentage was not measured. A jsdom/Node typed-array realm
difference in one assertion was corrected to compare byte values; production
payload bytes were unchanged.

Rollback: remove the two new service modules and their tests/documentation. No
existing save path or editor imports them yet, and no persisted files are migrated.
Transactions, conversion UI, actual image validation, and native OS integration
remain separate T08+ work.
