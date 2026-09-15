# Native document polling subscriptions

This substrate supplies authorized reads for a future bounded polling scheduler.
It installs no OS watcher, timer, native polling loop, or filesystem event queue.
The existing frontend watcher and manual reload are not migrated by this slice.

## Contract

```ts
native_watch_subscribe({ path: string, expectedGrantId: string })
  // Promise<{ id: string, grantId: string }>
native_watch_read({ id: string, limit: number })
  // Promise<number[]> — original bytes
native_watch_unsubscribe({ id: string })
  // Promise<void>
```

Actual editor window identity is injected by Tauri, and each dispatched command
checks its captured generation again at execution. Only current Document READ
or Workspace READ metadata can subscribe; the expected grant ID is mandatory.
The same existing exact-file/longest Workspace resolver is used for subscription
and subsequent reads. Resource and Export grants cannot act as documents.
Subscribe requires a currently regular document through the retained grant.

Subscription records contain the owner, window generation, opaque UUID, selected
alias, current grant ID and relative document path. They contain no independently
retained file/directory authority. The selected alias is only used to confirm
the current metadata still resolves to that same grant and relative path; it is
never opened through ambient filesystem APIs. Every actual read rechecks that
binding, READ ownership and regular document type and uses existing retained
handles with nofollow checks under the registry lock. No historical grant or
renderer path can create or restore permission.

The subscription result contains no initial content. The future scheduler must
request an **immediate first read** and compare it with the document's open-time
source, then schedule further bounded reads. This catches an edit between open
and subscription installation. No renderer baseline is treated as filesystem
truth. The service wrappers provide no implicit scheduling or decoding.

## Bounds and lifecycle

- Maximum 128 live subscriptions per window.
- Maximum 1 MiB of stored alias plus relative-path UTF-8 bytes per window.
- Read limit is explicitly supplied, from 1 byte through the existing 64 MiB
  ceiling; oversize files fail without returning a successful prefix.
- One in-flight read reservation per subscription. It is reserved before the
  blocking worker is queued. A second outstanding read returns `watch_busy`.
  The actual read still rechecks subscription and generation after dispatch.
- Subscription quota failures return `watch_limit_exceeded`; they add no partial
  subscription. A successful unsubscribe releases its quota.

The future frontend scheduler must also bound global in-flight requests and
poll frequency; these host quotas do not establish polling latency or workload
performance acceptance. There is no backlogged sequence of change observations:
each authorized read returns the content seen during that read.

Missing authorized leaves return `file_not_found` and retain their subscription,
allowing deletion/recreation and same-name atomic replacement. Other filesystem,
type and size failures remain distinct and release the in-flight reservation.
Only native OS NotFound is deletion evidence; callers must not interpret
permission or decoding failures as deletion. Subscription installation while a
leaf is missing fails; it does not create a speculative watch.

A changed current grant/relative binding, revoked authority, or lost READ
permission terminates that token when checked. The caller must explicitly
subscribe again with a new valid current identity. Window destruction removes
all subscriptions before its grants. A reused window label has a new generation
and cannot use old tokens. Unsubscribe cancels queued work if it wins the registry
lock before the read. Already returned data still needs frontend session checks.

Unsubscribe is idempotent for valid UUIDs: unknown, removed and foreign IDs all
return success without removing another owner's subscription or retaining
tombstones. Malformed IDs reject with `permission_required`. Read never reveals
whether a foreign/forged token's path exists. Work already dispatched continues
to its state check even if its caller stops awaiting; a poisoned native registry
fails closed with `native_state_unavailable`.

## Required follow-up and limitations

Save As has no automatic READ adoption yet. Export WRITE or a renderer-provided
successful Save callback cannot authorize subscription. Until native Save
completion establishes current READ, an ungranted destination receives
`permission_required`. Frontend migration must make that failure visible and
must not retry through plugin-fs. The old subscription cannot be moved by path
alone, and shared tabs need coordinated release after their last owner closes.

The future UI scheduler must preserve existing session/revision guards, compare
original bytes using the pure document decoder, perform first-read and own-save
End/Abort catch-up reads, and suppress stale results after close/rebind. Backend
subscription IDs supplement those guards; they do not replace them.

Retained parent/name authority is not an inode snapshot or content transaction.
An atomic replacement or in-place edit may be observed. A replaced parent must
not redirect access outside the retained root; Windows retained handles may
prevent a parent rename. No parent-path OS watch, permission fallback, changed
Save/Undo contract, or broad plugin-permission removal occurs in this slice.
Actual packaged OS behavior and future scheduler performance remain unverified.

Native tests cover ownership, stale generation/selection, core revoke, queued
read cancellation, busy and quota bounds, byte/type errors, replacement and
recreation, Unix retained parent/link substitution and Windows junction rejection.
Service tests cover opaque contracts, exact bytes and typed errors with no retry
or fallback. This foundation alone does not complete T04/T05 acceptance.
