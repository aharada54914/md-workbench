# Native document-open migration (T04)

Implemented 2026-09-16. This slice moves document opening to the native filesystem
broker described in [FILESYSTEM_BROKER_API.md](FILESYSTEM_BROKER_API.md).

- Both the application Open action and `useFileOperations.openFile` use
  `nativeFs.pickDocuments()`, then open the returned paths in selection order.
  Cancellation leaves tabs untouched; a failed read does not stop later files.
- Path, recent-file, session, and document-link opens use `readPathText` with
  existing host authority. No path string or frontend fallback grants access.
  `permission_required` displays a toast asking the user to select the file again.
- Native reads complete before tab creation/replacement. A concurrent completed
  open is reused; edits made while reading are retained. Failed reads or tab
  creation do not notify watchers or register a nonexistent open document.
- Exact decoded UTF-8 source (BOM, CRLF, trailing whitespace included) remains the
  read-only document's source. POSIX roots, Windows drive paths, and UNC shares
  remain intact when resolving document links.

## Verification

`useFileOperations.test.ts` covers denied path/session/link input, native picker
cancellation/errors/order, source retention, pending edits, concurrent opens and
failed tab creation. `document-link-path.test.ts` covers 14 root/path cases.

`native-document-open.test.ts` exercises actual UI Open/recent/session actions,
permission toasts, native reselection, multi-open order, cancellation, failed
selection continuation, registration and BOM/CRLF Save As. The shared mock issues
read authority only at explicit picker and host queue/transfer ingress; file
existence does not authorize reads. Existing queue, transfer ACK, initial reading,
and save E2E remain regression coverage.

## Scope

The browser tests mock native IPC and are not evidence of operating-system dialog
or filesystem confinement behavior. Save, conflict, temporary-file verification,
recovery, and reload reads retain their existing implementation in this slice.
Remaining legacy filesystem callers and native platform verification are tracked
separately; this migration does not claim the entire T04 boundary is complete.
