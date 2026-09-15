# Source preservation and native open follow-up

2026-09-15; T05 / T06, R01 / R03 / R20, issue #36. This is a tested implementation slice, not completion of the full T04–T06 acceptance gates.

## Behavior

Raw Markdown remains authoritative across Source, Split, Visual, tab close, Save As, external reload and conflict selection. Diff hunks retain their original line endings. Visual editing is enabled only when the actual editor schema can reproduce the source exactly; otherwise an Edit source action preserves unsupported syntax. BOM, leading/trailing whitespace and line endings survive supported Visual edits. Heading separation, list paragraph boundaries and code fence endings no longer lose or append content during conversion.

Programmatic editor changes obey the same source guard as typing. Formula controls respect read-only state. Async image paste is bound to the original document identity, and different tabs cannot share Visual Undo history. The current per-tab editor recreation resets Visual Undo history when returning to a tab; toggling isolated preview within the same document preserves it.

Large documents retain the raw source of unmounted chunks. Tests edit one heading in a document over 1 MiB and compare the complete saved source, including its tail. Non-reversible list layout stays protected and remains editable in Source. Native cold/warm multi-file delivery is described in [NATIVE_OPEN_QUEUE.md](NATIVE_OPEN_QUEUE.md).

## Verification

- Full Vitest: 96 files, 1,405 tests passed.
- Type checking and production build passed; existing bundle-size and mixed-import warnings remain.
- Full Chromium: 78 passed, 1 pre-existing skipped test. An earlier full run exposed an asynchronous test-focus race; the test now waits for DOM focus before selecting and typing, and the complete suite passed again.
- Native queue: 12 Rust tests and 6 mocked IPC browser tests passed.
- Full native suite including the filesystem grant core: 212 tests passed on macOS.

Windows/Linux CI for this slice and packaged native multi-file acceptance must be verified separately. The earlier Resource contract revision passed Windows/Linux checks and Windows native smoke tests; those results do not establish this later revision.

## Remaining work and rollback

Initial file-open read-only lifecycle, native filesystem broker integration, broad permission removal, Windows 11 x64/IME/performance acceptance, and Resource/AI transactions remain separate work. Current frontend saves still use the existing temporary-file protocol and are not the planned native journal/CAS transaction. Revert native queue host and frontend changes together because their event/getter contract changed.

## Serialization placeholder correction — 2026-09-16

Visual edits next to authored strings such as `__PROTECTED_BLOCK_0__` or
`__INLINE_CODE_1__` could replace that original text with another block's content.
Conversion now keeps payloads in a per-conversion context and restores them in a
single traversal. Authored NULs and NULs produced by entity or URI decoding are
protected before further conversion; restored payloads are never scanned again.
Recursive list and inline conversion share that context. Footnote fallback HTML
uses a separate context, while encoded JSON definitions remain opaque. Math
source retains literal entities and whitespace. Inline restoration also keeps
the two spaces required for Markdown hard breaks.

The dedicated placeholder suite has 34 cases covering real TipTap block
insertion, split-tag/entity marker construction, replacement metacharacters,
math, lists, footnotes, and hard-break regressions. Two Chromium scenarios use
the actual application editor to insert block/inline code, save exact source
bytes through the mocked native boundary, and Undo back to the original source.
They do not establish native OS or IME acceptance. Final independent review and
exact-head CI are recorded in the implementation PR; earlier counts above refer
to their original integration revision.

Rollback this converter context together with its inline/list/footnote consumers;
there is no stored document migration. Reverting it restores the reproduced
placeholder collision defect.
