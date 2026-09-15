# Imported image byte preparation

This is a current-window preparation layer, not the native image display cutover or completion of T04/T10. Existing image rendering and destination writes remain unchanged.

## Ownership and bounds

`documentImageBytes` creates opaque owners for actual live Tab objects. `getTabImageOwner(tab)` refuses tabs outside the live split-view inventory; identical IDs or file paths do not recover another document's snapshots. Pane moves and Save As of the same object preserve ownership. Close/remove releases immediately; a post-flush inventory check also releases owners after wholesale state replacement without breaking synchronous pane moves.

Limits include pending reservations: 8 MiB per image, 64 MiB and 128 entries per document, 128 MiB across the window. Native file size is unknown before the read, so each pending Resource read conservatively reserves 8 MiB and shrinks to the received size. Concurrent reads may be refused despite their eventual small size. Zero-byte entries count toward the entry limit. Releasing/disposal is idempotent.

Snapshots use exact authored paths only as keys for already-held bytes. No lookup grants filesystem access. Input/output copies prevent callers mutating stored content. Byte-identical repeated paths reuse the committed snapshot; different bytes at an existing/pending path fail with `image_path_conflict`. Entry/byte exhaustion fails with `image_budget_exceeded`; per-image or invalid sizes fail with `image_too_large`. This narrow frontend service uses ordinary Error messages, not native IPC error codes.

## Import lifecycle

`importImage` uses the selected Resource ID through `nativeFs.readBytes(id, '', 8 MiB)`. Selection guard checks apply before/after I/O. Optional `ImageImportSelection.owner` reserves retention capacity before reading. Destination writes still use the existing plugin implementation; no new fallback read or grant is introduced.

`importImageBytes` accepts optional fifth argument `{ owner, isCurrent }`, checks the received byte limit before destination work, and copies clipboard bytes before awaiting. The existing Editor caller has not yet been wired to this argument. The caller still must check File.size and reserve before File.arrayBuffer in the later clipboard integration; the received-byte check cannot undo an already-large allocation.

A successful owned import returns `{ markdownPath, altText, prepared }`. `prepared` holds bytes under a reservation but does not expose them to display. Its consumer checks the current target, calls `commit()` immediately before synchronous insertion, and calls `release()` in all paths. An uncommitted release discards the snapshot/reservation; after commit release does nothing. Commit is single-use. Completed snapshots remain until document close so Undo and editor recreation can recover them. There are no Blob URLs here.

`useImageDrop` captures an optional visual `imageOwner` / code `activeImageOwner()` and propagates it through selection. Its finally/cancellation paths release all unadopted preparations, including earlier batch items when a later item becomes stale. Commit or insertion exceptions can leave already committed snapshots until document close; they remain bounded and cannot authorize new I/O. Imports are not a transactional batch and destination files already written are not rolled back.

## Remaining wiring and limits

- EditorPane/SplitContainer now supply the actual visual target owner. App must supply `activeImageOwner: () => getTabImageOwner(activeTab.value)` for code-view imports. App and Editor were not edited in this slice.
- Editor clipboard must pass captured owner/isCurrent as the fifth importImageBytes argument, commit before model insertion, and release on every failure/cancellation. File.size/reservation-before-allocation is still required.
- Optional legacy callers preserve existing behavior without retaining bytes. Their paths do not become authorized display fallback sources.
- The later inert NodeView/native reader uses `read(owner, authoredPath)` for committed imports; this slice does not change the editor or Marp readers. Initial raw-src DOM fetch remains pending inert parse/serialize and display integration.
- Native grant revocation prevents future reads, not retrieval of already imported bytes in the owning live document. Pending results cannot install after document disposal.
- No persistence, restart recovery, cross-window byte transfer, Save As relocation, image validation/decoder, SVG policy, URL decoding, destination collision safety, or filesystem permission removal is implemented. Cross-window transfer must not claim these in-memory snapshots transfer with the file.
