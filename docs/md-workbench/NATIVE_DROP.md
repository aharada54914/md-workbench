# Native drop delivery

## Contract

Only a Tauri host `RunEvent::WindowEvent` containing OS `DragDropEvent::Drop`
creates drop grants. Enter/over/leave/cancel events create no grants or queue items.
The previous renderer-callable `classify_paths` command and its handler were
removed. A renderer cannot supply paths, a window label, or a generation to the
new drain command.

`native_take_drops()` has no payload arguments and returns:

```ts
type NativeDrop = {
  id: string
  grants: NativeGrant[]
  errors: { path: string; error: string }[]
  position: { x: number; y: number }
}
```

`NativeGrant` is the broker's existing `{id,path,kind,read,write}` DTO. Position is
the OS event's physical cursor position (f64), relative to the window/webview,
without conversion to CSS pixels. The frontend applies its device-pixel conversion
where needed.

The host classifies and grants each native path under its actual registered editor
window generation. Folders receive Workspace READ_WRITE, `.md`, `.markdown`, `.txt`, and `.mermark` files (case-insensitive) Document
READ_WRITE, and other files Resource READ. Individual failures are retained as
errors, and successful files remain usable when another file in the same drop
fails. Grants and errors each preserve their input order. Empty path lists are
no-ops. There is no all-or-nothing transaction across a partially valid drop.

The host enqueues the completed drop before emitting `native-drops-pending` with
no data payload. This event is a wakeup hint. The frontend registers the listener,
then drains once during startup and again on notifications. Events arriving before
listener registration are preserved in the queue. Ordinary partial drop failures
are returned only in the queued DTO, avoiding a second `native-file-errors`
notification for those same failures. `native-file-grants` is no longer emitted
for drops.

## Window isolation and lifecycle

The command derives ownership from its actual Tauri `Window`; the existing custom
IPC guard also rejects preview, unregistered and child-webview callers. The host
holds the native registry lock through grant issuance and enqueue; drain verifies
the caller's current generation under the same lock. Each drop also records its
issuing generation. A window cannot drain another window's events. Revoke clears
that window's queue alongside its grants. Reusing a label cannot deliver the old
window's drops. If stale queued generations remain despite missed cleanup, they
are discarded at drain.

Draining removes the caller's queued entries in FIFO order. A second drain is
empty unless another native drop arrived. It does not create grants, query ambient
filesystem paths, or transfer authority to another window. Errors from an
unregistered/stale caller are `permission_required`; a poisoned state lock yields
`native_state_unavailable`. These command errors remain strings.

## Reselection before drain

Before returning each queued grant, the host requires all of the following:

- The current non-Save metadata for its canonical path still has that UUID.
- The current path READ resolver selects the same UUID with no relative suffix.
- The core still recognizes that UUID for the actual caller.

An item that fails those checks moves to errors with `drop_grant_changed`, and its
path is not returned as a usable grant. The host does not restore the old UUID or
replace newer metadata. This prevents a pending drop from silently opening a new
retained directory at the same path after native reselection. Two queued drops of
the same path may therefore return a superseded error for the first and the current
grant for the second. A later Save selection is separate metadata and does not
invalidate the pending READ grant.

After draining, consumers pass the returned grant ID as `expectedGrantId` to
`native_read_path({path, limit, expectedGrantId?})` or
`read_workspace_tree({root, expectedGrantId?})`. Both commands accept an optional
string; omitted/null retains the existing path resolution behavior. When supplied,
the host compares that UUID with the normal current READ resolver result under the
same registry lock used for I/O. A mismatch or malformed UUID returns the typed
`permission_required` error. It never searches older grants or falls back to a
workspace grant after a mismatch. The read or recursive tree traversal retains
the resolved UUID throughout its operation. Save export metadata does not change
that READ identity. This closes the reselection gap across frontend awaits after
drain, while preserving caller and generation isolation.

The drain is not an acknowledgement of frontend processing: window closure or
navigation after drain does not requeue items. File writing and transfer
transactions are separate.

## Bounds and overflow

Each registered window retains at most 16 pending drops. A drop contains at most
128 paths and at most 256 KiB of total UTF-8 path bytes (the native path's lossy UTF-8
representation, summed across paths). Exact limits are accepted. Empty lists do
not occupy a slot.

Bounds are checked before path classification or grant creation. Queue overflow
rejects with `drop_queue_full`; path count/byte overflow rejects with
`drop_too_large`. Rejected drops do not change existing grants or queued events.
The host emits one `native-file-errors` item with an empty path and the rejection
reason, avoiding serialization of the oversized rejected input. This exceptional
notification uses the existing frontend error channel and is not itself queued.
Grant issuance remains synchronous under the host registry lock; the finite input
bounds do not provide an I/O time deadline for slow filesystem providers.

## Verification

The frontend registers its listener before the initial drain, serializes batches,
and retains a live session predicate through document reads, workspace opens,
image imports and workspace refresh. Stop/restart invalidates pending work; late
read results cannot insert content, reopen tabs or adopt workspace trees. A write
already dispatched before stop can finish on disk. Image insertion also checks
the captured editor/pane and document identity after asynchronous imports.

Browser tests cover startup delivery, mixed document/workspace input, forged event
payloads and preservation of the expected source grant. Their native transport is
mocked. Packaged OS drop interaction remains a separate acceptance test.

`native_files_drop_tests.rs` covers early delivery, ordered/single drain, partial
results/position DTO, cross-window and forbidden caller isolation, revoke/reuse,
stale generations, queue/path bounds, no grant mutation on rejection, Save versus
non-Save reselection, repeated same-path drops, revoked UUIDs, and Unix retained
parent replacement. `native_files_drop_read_tests.rs` covers supported extensions,
post-drain document/workspace reselection, optional expected IDs, Save metadata,
no workspace fallback, and caller/generation isolation. Frontend integration tests are maintained with the drop
consumer. The ambient classification command is absent from the invoke handler.
