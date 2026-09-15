# Filesystem broker: host API contract

Implemented stages 1–2, 2026-09-15: the host core and native authority ingress.
Purpose-specific pickers, native open/drop custody and owned-grant reads are wired.
Existing broad filesystem permissions and legacy I/O commands still remain; T04 is
not complete until the migration in [the plan](FILESYSTEM_BROKER_PLAN.md) is done.

## Authority and lifecycle

`src-tauri/src/file_access.rs` exports crate-private Rust APIs only. None is a
Tauri command. Manage one `Mutex<FileAccess>` in the native host and hold its lock
through each operation: revocation then waits for in-flight I/O and no open file
handle escapes the registry. Derive caller labels from Tauri's injected window
or native events; never accept the caller label from renderer arguments.

| API | Contract |
| --- | --- |
| `register_window(window)` | Host calls after creating `main` or a `window-N` editor. Unknown and print/preview labels are rejected. |
| `grant_file_from_native_selection(window, path, kind, rights)` | Native picker/OS-open path only. Grants exactly one Document, Resource or Export file. Only Export may initially be missing. |
| `grant_directory_from_native_selection(window, path, kind, rights)` | Native picker/drop only; an explicitly selected Workspace or Resource directory. |
| `capture_native_file(path, kind, rights)` / `attach_native_file(window, held)` | Host-only opaque custody pins a native selection before an editor exists and can attach it to the eventual owner without reopening its path. |
| `transfer(source, target, id, rights)` | Source must own the grant; target must be registered; rights can only decrease. Creates a new target UUID and shares the retained anchor. |
| `revoke(window, id)` / `revoke_window(window)` | Remove a grant or the window and all its grants. A reused window label does not revive previous UUIDs. |
| `describe(window, id)` | Returns owned grant metadata. `selected_path` is for display/routing only; never reopen it with ambient filesystem APIs. |
| `read(window, id, relative, limit)` | Requires READ. Returns regular-file bytes unchanged, including BOM/CRLF. Caller limit cannot exceed 64 MiB and growth while reading is bounded. |
| `create_new(window, id, relative, bytes)` | Requires WRITE. Exclusive new-file creation, at most 64 MiB, then sync. Existing entries cannot be overwritten. |

`GrantId` is an opaque UUID with parse/display support. Knowing its string does
not authorize another window. `Rights` has READ, WRITE and READ_WRITE constants.
Grant kind and rights remain separate: a resource may be read-only; an export
may be write-only. `AccessError` distinguishes permission, invalid path/kind,
unsupported platform, oversized I/O and OS failures. Integration should map these
to structured frontend errors rather than interpreting an OS error string.

Exact-file operations use an empty relative path. Directory operations use clean
UTF-8 slash-separated paths such as `images/chart.png`. A relative path cannot
contain `.`/`..`, empty segments, backslashes, absolute/UNC/device prefixes, ADS
colons, control characters, Windows reserved basenames (including COM/LPT with superscript ¹, ², ³) or trailing
dots/spaces. These device aliases follow the
[Microsoft filename rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
The portable naming policy deliberately rejects names that are unsafe on another
supported platform. Native selections must be absolute. A canonical UNC selection
is permitted only from the native authority source; operation input cannot choose
a new share. Non-UTF-8 selections require a future explicit frontend contract.

## How authorization reaches real I/O

Native selection canonicalization chooses the anchor. The host then opens the
native root and walks each directory component with `open_dir_nofollow`, retaining
a `cap_std::fs::Dir`. Exact-file grants retain a parent handle plus one basename;
directory grants retain the selected directory handle. Each operation walks
intermediate names relative to those handles without following symlinks. The final
read uses `FollowSymlinks::No` and checks metadata on the opened handle. Exclusive
creation uses `create_new` with the same nofollow policy. No operation performs
`canonicalize` followed by an ambient path open.

The implementation uses pinned cap-std/cap-fs-ext 4.0.3. Their documented
[Dir API](https://docs.rs/cap-std/4.0.3/cap_std/fs/struct.Dir.html) and
[nofollow extension](https://docs.rs/cap-fs-ext/4.0.3/cap_fs_ext/trait.DirExt.html)
provide the handle operations. Do not substitute `Dir::from_std_file`: Windows
requires directory handles without delete sharing. The dependency implementation
also opens Windows reparse points before checking nofollow and prevents pinned
directory renames. Keep the native junction test in Windows CI.

Authority follows the retained directory object if it is renamed on Unix; it does
not follow a replacement symlink at the old path. On Windows an open capability
directory may prevent that rename. An explicitly selected symlink resolves at
grant creation, but later symlink aliases are rejected even when they point inside
the same grant. Native selection authority begins when the host obtains the
anchor; path-only dialogs do not provide an earlier immutable file identity.
Ordinary hard links and mount points are filesystem entries, not symlink escapes;
this contract does not isolate against an actor able to alter filesystem mounts.

Windows, macOS and Linux are supported. Grant creation and I/O fail closed on
other targets. The existing AI path checker (`ai/process/file_tools.rs`) was not
reused because its canonicalized `PathBuf` is later reopened by ambient APIs.

## Remaining integration and operations

- Migrate frontend callers to the stage 2 native APIs below. A recent/localStorage
  path, Markdown reference, tab URL or renderer-supplied access map must never call
  a native-selection API. Existing renderer dialogs are not broker authority.
- Restore authority only from a validated native private record or ask for a new
  selection. Transfer rights before target frontend reads and revoke the source
  after a successful close acknowledgement.
- Implement overwrite/CAS, journal/recovery, rename/delete, directory enumeration,
  directory creation and watch using retained handles. These APIs are deliberately
  absent; a caller must not emulate them with `GrantInfo.selected_path`.
- `create_new` can leave its newly created partial file after an I/O failure. It
  does not attempt unsafe path-based cleanup. Save and export completion semantics
  need a host transaction/recovery implementation before using it for those flows.
- Derive resource destinations from authorized documents without exposing a generic
  parent-directory write grant. Add bounds appropriate to each operation.
- Migrate all frontend/custom command I/O and AI tool authorization, then remove
  wildcard permissions and verify print/preview denial through actual IPC.

## Verification

`cargo test --manifest-path src-tauri/Cargo.toml file_access::tests` exercises actual
filesystem I/O, not mocks: raw bytes, exact-file bounds, ownership, transfer,
revocation, rights, exclusive export, path aliases, symlink leaf/parent replacement,
bounded reads and a concurrent Unix parent/symlink swap with outside-file checks.
Windows adds a real junction test; its symlink tests require an elevated runner or
Developer Mode and intentionally fail if fixtures cannot be created.

Native Windows/Linux execution and packaged native IPC/UX acceptance remain
required; their results are not inferred from a macOS run. No coverage percentage
was measured.

## Stage 2 command and event contract

The host registers the actual main/editor window it creates and revokes it on
native destruction. Picker callbacks capture a generation token; closing/reusing
a label cannot apply a stale result. No renderer command registers a window or
accepts a caller label. Nonblocking native dialogs are parented to the caller.
Cancellation creates no grants; a failed multi-selection rolls back its new grants.
All application custom IPC additionally requires the actual webview label to equal
its host-registered editor window label. Print, unknown, unregistered and child
webviews are denied before command dispatch. The print label is `print-preview`,
outside the editor capability patterns `main` and `window-*`; its HTML is served
by the existing memory-backed custom protocol without custom IPC.

`NativeGrant = { id: string, path: string, kind: "document" | "workspace" |
"resource" | "export", read: boolean, write: boolean }`. `path` is metadata only.

| Command arguments | Result | Authority |
| --- | --- | --- |
| `native_pick_documents()` | `NativeGrant[]`, cancel `[]` | Selected exact files, Document READ_WRITE. |
| `native_pick_save_destination()` | `NativeGrant` or `null` | Selected exact destination, Export WRITE; no file is created. |
| `native_pick_workspace()` | `NativeGrant` or `null` | Selected directory, Workspace READ_WRITE. |
| `native_pick_resource()` | `NativeGrant` or `null` | Selected exact file, Resource READ. |
| `native_get_grant({path})` | `NativeGrant` or `null` | Existing caller-owned metadata lookup only; no disk I/O or new grant. |
| `native_read_grant({id, relative, limit})` | `number[]` | Reads bytes through the owned grant on a blocking worker; `relative: ""` for an exact file, limit at most 67108864. |
| `native_read_path({path, limit})` | `number[]` | Existing caller-owned exact READ metadata first, otherwise the most specific owned Workspace READ prefix. Uses retained-handle reads; limit at most 67108864. |
| `read_workspace_tree({root})` | Existing `WorkspaceNode` tree (`name`, `path`, `kind`, `children`, `modified`). | Caller-owned Workspace READ only; typed errors, bounded retained-handle traversal. |
| `native_list_directory({path, limit})` | `{entries: {name, isDirectory}[], omitted}` | Direct children of an owned Workspace READ root or subdirectory; at most 10000 scanned entries. |

Grant metadata retains the latest non-Save selection per caller and native alias,
with Save/Export destinations stored separately. `native_get_grant` prefers the
non-Save entry and falls back to an Export entry only when no non-Save entry
exists. This changes the previous last-selection behavior: Document → Save now
returns Document metadata. Save callers must use the Export UUID returned by the
Save picker. Save selection cannot hide an existing READ binding, supply READ,
or combine its WRITE rights with another grant. A later Document/Resource
selection still replaces the current non-Save binding; old grant history is not
searched. Equal path strings may refer to different retained directories after
native reselection. Window revocation removes both metadata sets.

Commands reject `{code, message}`. Branch on `code`, one of
`permission_required`, `invalid_path`, `invalid_grant_kind`,
`unsupported_platform`, `file_too_large`, `file_not_found`, `native_state_unavailable`,
`dialog_unavailable`, `filesystem_error`. `message` is diagnostic text.
`file_not_found` reflects the OS NotFound error, not a parsed diagnostic string.
Read operations validate ownership before opening a file: an unowned missing path
still returns `permission_required`. Permission, decoding and other I/O failures
must not be interpreted as deletion. An exact-file grant retains its parent and
leaf name, so a normal atomic replacement or delete/recreate in that same parent
is read using the existing grant; it does not pin the original file contents.
There is no create/overwrite/rename/delete IPC in this stage.

Path read/list commands run on a blocking worker and revalidate the captured
caller generation while holding the native registry lock through I/O. They do not
canonicalize, reopen ambient paths, create grants, recover hidden grant history,
or accept grant ownership from renderer arguments. Lookup recognizes original
native-selection aliases and canonical metadata aliases. Windows slash/backslash
routing spellings are equivalent; case and device aliases are not broadened.
Workspace matching requires a full directory boundary and chooses the longest
owned prefix. Equal-length roots prefer the requested native spelling (including
its child-path prefix), then stable alias order; a separator-equivalent re-selection
does not silently switch the earlier alias to a different retained directory.
Remaining relative components are passed unchanged to core policy,
which rejects traversal and symlinks; failed operations never fall back to another
filesystem API. A more specific pinned workspace keeps referring to its original
directory object if its old path is replaced on Unix.

Directory results contain names, not newly authorized paths. They are sorted with
directories first, then by name. `omitted` counts symlinks, special files and names
outside the portable policy. Limits count all scanned entries including omissions;
an exceeded count rejects with `file_too_large` instead of returning a silently
partial list. List access is intentionally restricted to Workspace grants in this
IPC stage even though the host core can also list Resource directories.

### Workspace tree migration

`read_workspace_tree` no longer grants filesystem scope from its `root` string,
including roots restored from local storage. Native workspace selection must
already have granted READ access to the actual caller window. The command captures
that window's generation, revalidates on a blocking worker, and keeps the native
registry lock through the entire walk. A closed/reused window cannot use queued work.

Root lookup chooses one existing Workspace grant; every recursive directory list
uses that grant's retained handle and a validated relative path. Absolute node
paths are display/routing metadata, never I/O authority. The tree is not an atomic
filesystem snapshot: concurrent rename/removal can reject the operation, and errors
never switch to ambient I/O or a different grant. Symlinks/junctions, special files
and nonportable names are omitted by the core's nofollow enumeration.

Limits are 50,000 total scanned entries, 10,000 per directory, and directory depth
50 with the requested root at depth 0 (files within depth 50 remain visible).
The returned tree also has a conservative 32 MiB JSON budget. Before creating each
node, including the requested root, the host reserves six times its name/path UTF-8
byte lengths plus 256 bytes for keys, values and punctuation. Checked arithmetic
rejects overflow; the shared budget rejects an over-limit tree with `file_too_large`
before returning any partial result. Actual serialized bytes may be smaller.
Hidden names, non-document files and omitted entries count toward scanning limits;
hidden directories are not entered. Exceeding any limit rejects the entire request
with `file_too_large`, and other I/O failures reject with `filesystem_error` rather
than returning a partial successful tree.

The existing DTO and UI filters remain: dot-prefixed names and `node_modules` are
hidden, folders are shown, and files use Markdown (`md`, `markdown`, `mdx`) or image
(`png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, `bmp`) extensions without case sensitivity.
Folders precede files, then names sort without case sensitivity. An explicitly
selected hidden root remains usable. `modified` is milliseconds since Unix epoch
(or 0 when unavailable), read from nofollow entry metadata or the opened directory
handle. Host-only directory metadata additions do not change `native_list_directory`'s
JSON shape. Create, search, reveal, save and broad plugin permissions remain separate
migration work; this step does not complete the filesystem security issue.

**Save integration boundary:** Save/Export metadata is separate from the current
Document/Resource/Workspace binding, so selecting a destination cannot interrupt
READ or transfer. Future Save operations must use the selected Export UUID; equal
path text does not mean its retained directory matches the document's READ grant.
Actual save/overwrite IPC migration remains separate work.

CLI, second instance and macOS Opened capture Document READ_WRITE anchors in a
host-only pending map. The existing ordered queue and getters remain compatible.
Before notifying/draining, the host attaches pending anchors to the registered
queue owner. Getter delivery releases pending custody; the owner's grant remains.
Queue capture/enqueue and drain/acknowledgement are serialized. If the owner closes
before delivery, its grants are revoked and the retained anchor can be attached to
the next registered editor. There is no path recanonicalization during reassignment.
A malformed/missing native request remains in the legacy queue for existing error
UI but receives no grant. Once a getter returns, later window closure does not
requeue those acknowledged files; frontend acknowledgement is future work.

Native drops grant only to their actual registered window: directories become
Workspace READ_WRITE, Markdown files Document READ_WRITE, other files Resource
READ. The host emits `native-file-grants` with `NativeGrant[]` after completing the
grant operation and `native-file-errors` with `{path,error}[]` for failures. OS-open
errors use the same error event when a live owner exists. The legacy Tauri drop
event is not a guarantee that grant creation finished; migrated callers should
use the host grant event, or query after queue delivery. Errors without a live
owner remain represented by the legacy queued request rather than a replayable
error event.

## Window registry and transfer boundary

The open-file registry is caller-owned routing metadata, never filesystem authority.
Register/unregister commands derive their owner from the injected native window;
obsolete renderer `windowLabel` / `sourceWindow` arguments cannot choose an owner.
Several windows can temporarily own the same path; lookup prefers the caller's
registration, then the lowest live editor label. Destroying a window removes only
its metadata and capabilities.

`transfer_tab_to_window({filePath, targetWindow})` requires the actual caller's
existing exact-file READ grant and an already registered target. It copies the
retained anchor with unchanged rights; neither a registry entry nor a path string
creates authority. Source grants stay valid. The returned Promise resolves only
when the actual target acknowledges successfully opening the file. Failed opening,
60 seconds without acknowledgement, or destruction of either participant rejects
the transfer and revokes its copy. Source tab removal belongs after this success.

| Command arguments | Result | Contract |
| --- | --- | --- |
| `native_get_pending_transfers()` | `{id, file_path, source_window, target_window}[]` | Ordered, non-destructive lookup restricted to the actual target and its current host generation. |
| `native_ack_tab_transfer({id, success})` | `void` | Consumes one pending UUID only for its actual target generation; source generation must still be live. |

The `tab-transfer` event carries that same DTO as a wakeup hint. Register its
listener before fetching pending requests, and fetch from the host after each
wakeup. Do not open directly from the event payload or remove pending items on
lookup. Target code acknowledges after the open result is known; it must not
acknowledge a cancelled, denied or failed read as success. Window command errors
remain strings: `permission_required`, `transfer_not_found`, `transfer_open_failed`,
`transfer_timeout`, `transfer_window_closed`, `transfer_cancelled`,
`transfer_grant_changed`, `transfer_in_progress`, or diagnostic native errors. An expired/already acknowledged UUID cannot be acknowledged again.

Only one transfer to the same target and canonical document may be pending. A
duplicate, including a native selection alias, rejects with `transfer_in_progress`
without modifying the first transfer or existing target metadata.

One host lock decides acknowledgement, timeout and destruction. If a successful
ACK wins that lock as the timer fires, the waiting sender receives success.
Success ACK also requires the current target path READ binding to resolve to the copied UUID. A native
Document/Resource reselection that supersedes it rejects with
`transfer_grant_changed`, retains the source, and preserves the newer target
selection through rollback. Save selection does not supersede READ and therefore
does not cause this rejection. This is conservative: a superseded binding is
rejected even if the target previously read the copied grant successfully. Failed
transfers roll back only their capability and nonce-owned temporary routing entry;
concurrent normal registrations and other pending transfers remain intact. A later
native selection cannot be erased by a delayed rollback. Cancelling the invoke
future also releases pending custody. This is a delivery acknowledgement, not a
filesystem save transaction or an acknowledgement of source tab closure.

`create_new_window({filePath})` starts a hidden `about:blank` webview, activates its
host reservation, enqueues a transfer of existing sender authority, then navigates
to the trusted host-configured application URL. Application code cannot race ahead
of registration. The new frontend retrieves pending transfers at startup; there is
no file query parameter causing a duplicate open. A file window stays hidden until
successful target ACK, then is shown and its label returned; this prevents timeout
rollback from discarding unrelated user edits made during the wait. Without a
file, the window is shown and returned immediately after startup.
Failed preparation/navigation/show/ACK or invoke cancellation revokes target grants,
removes metadata and destroys the new window. A destroyed reservation cannot
reactivate. Native configured URL resolution mirrors the pinned desktop Tauri
implementation because its resolver is private.

Recent/workspace restoration still needs explicit broker integration; old
access-map and plugin-FS behavior must not be used as authorization evidence.

Native state tests cover lookup isolation, cancellation/batch failure, stale
callbacks, fixed picker rights, pending reassignment, re-selection after a prior
resource grant, DTO/error serialization, and a real Unix parent-symlink swap.
Window tests additionally cover caller ownership, stable routing, attenuated
exact-file copy, directory/write-only rejection, rollback isolation, stale window
generations, blank-window reservations and retained Unix parent handles.
Additional ACK tests cover non-destructive ordered delivery, ownership and reused
labels, false ACK, both participant destructions, timeout, simultaneous ACK/expiry,
nonce-specific routing cleanup and source capability retention. Full native test
results are recorded with the implementation handoff; packaged GUI acceptance is
still required on every supported OS.
Actual native picker interaction, drop ordering and closed-window behavior still
require packaged tests on each supported OS.

The native path-command regression suite covers ownership, raw BOM/CRLF bytes,
original/canonical aliases, direct-child DTOs and bounds, clean relative paths,
exact/most-specific grant selection, stale generations, the write-only metadata
constraint, and retained Unix directory objects. Windows adds a native/frontend
separator and unselected UNC regression, plus two spellings re-selected against
different retained roots; actual Windows execution remains required.
The macOS full native suite passed 261 tests after the read/list command addition
and equivalent-alias selection regression fix.

The workspace migration adds tests for unselected/persisted/foreign roots, READ
and grant-kind restrictions, hidden-root selection, filtering/sorting/mtime/DTO,
total scan and real depth bounds, stale generations, retained Unix roots, and
Windows junction/separator handling. Output-size boundary, JSON escaping and overflow regressions are also covered.
The macOS native suite passes 271 tests;
Windows/Linux native and packaged UI execution remain CI acceptance work.
