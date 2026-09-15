# Imported image byte preparation

This is the current-window preparation layer used by editor image imports. The editor display boundary is described in [DOCUMENT_IMAGE_DISPLAY.md](DOCUMENT_IMAGE_DISPLAY.md). Destination writes still use the existing implementation; this does not complete T04/T10.

## Ownership and bounds

`documentImageBytes` creates opaque owners for actual live Tab objects. `getTabImageOwner(tab)` refuses tabs outside the live split-view inventory; identical IDs or file paths do not recover another document's snapshots. Pane moves and Save As of the same object preserve ownership. Close/remove releases immediately; a post-flush inventory check also releases owners after wholesale state replacement without breaking synchronous pane moves.

Limits include pending reservations: 8 MiB per image, 64 MiB and 128 entries per document, 128 MiB across the window. Native file size is unknown before the read, so each pending Resource read conservatively reserves 8 MiB and shrinks to the received size. Concurrent reads may be refused despite their eventual small size. Zero-byte entries count toward the entry limit. Releasing/disposal is idempotent.

Snapshots use exact authored paths only as keys for already-held bytes. No lookup grants filesystem access. Input/output copies prevent callers mutating stored content. Byte-identical repeated paths reuse the committed snapshot; different bytes at an existing/pending path fail with `image_path_conflict`. Entry/byte exhaustion fails with `image_budget_exceeded`; per-image or invalid sizes fail with `image_too_large`. This narrow frontend service uses ordinary Error messages, not native IPC error codes.

## Import lifecycle

`importImage` uses the selected Resource ID through `nativeFs.readBytes(id, '', 8 MiB)`. Selection guard checks apply before/after I/O. Optional `ImageImportSelection.owner` reserves retention capacity before reading. Destination writes still use the existing plugin implementation; no new fallback read or grant is introduced.

`importImageBytes` accepts optional fifth argument `{ owner, isCurrent }`, checks the received byte limit before destination work, and copies clipboard bytes before awaiting. The Editor clipboard adapter captures the live owner and current-target predicate, checks File.size, and reserves before File.arrayBuffer. It releases that allocation reservation immediately before the synchronous importImageBytes reservation handoff; no await separates the two. The received-byte check also rejects results larger than the declared File.size.

A successful owned import returns `{ markdownPath, altText, prepared }`. `prepared` holds bytes under a reservation but does not expose them to display. Its consumer checks the current target, calls `commit()` immediately before synchronous insertion, and calls `release()` in all paths. An uncommitted release discards the snapshot/reservation; after commit release does nothing. Commit is single-use. Completed snapshots remain until document close so Undo and editor recreation can recover them. There are no Blob URLs here.

`useImageDrop` captures an optional visual `imageOwner` / code `activeImageOwner()` and propagates it through selection. Its finally/cancellation paths release all unadopted preparations, including earlier batch items when a later item becomes stale. Commit or insertion exceptions can leave already committed snapshots until document close; they remain bounded and cannot authorize new I/O. Imports are not a transactional batch and destination files already written are not rolled back.

## Integration and limits

- EditorPane/SplitContainer supply the actual visual target owner; App supplies the active owner for code-view imports. Save As preserves the owner. Opening a new document in a reused empty Tab disposes its old owner. Native same-path reselection increments a transient display revision while retaining imported bytes.
- Editor clipboard passes captured owner/isCurrent as the fifth importImageBytes argument, commits before synchronous model insertion, and releases on every failure/cancellation.
- Optional legacy callers preserve existing behavior without retaining bytes. Their paths do not become authorized display fallback sources.
- The inert editor NodeView uses `read(owner, authoredPath)` for committed imports. Its separate display provider owns Blob URLs; editor parsing, serialization and clipboard boundaries preserve authored paths. Marp and export readers are separate paths.
- Native grant revocation prevents future reads, not retrieval of already imported bytes in the owning live document. Pending results cannot install after document disposal.
- No persistence, restart recovery, cross-window byte transfer, Save As relocation, image validation/decoder, SVG policy, URL decoding, destination collision safety, or filesystem permission removal is implemented. Cross-window transfer is blocked while the source Tab has committed snapshots or pending import reservations, including snapshots retained for Undo. The check runs before transfer and after each asynchronous handoff step so the source stays open if an import starts meanwhile. Saving does not clear this restriction. Moving the same Tab between panes in the same window retains its owner and is allowed.
