# Filesystem broker implementation plan — T04 / T05 / T08

Design handoff, 2026-09-15. This is not a security completion claim. The approved
v0.2 SECURITY.md requires native authorization for traversal, symlinks, junctions,
UNC and check/use races; preview must not receive filesystem IPC.

## Progress on 2026-09-16

The inventory below records the original migration targets; its old line numbers
are not a description of the current implementation. The retained-handle core,
native authority ingress, acknowledged window transfers, owned path reads and
bounded workspace trees and content search are implemented. Document and workspace Open actions
now use native pickers. See [FILESYSTEM_BROKER_API.md](FILESYSTEM_BROKER_API.md)
[NATIVE_DOCUMENT_OPEN.md](NATIVE_DOCUMENT_OPEN.md) and
[NATIVE_WORKSPACE_SEARCH.md](NATIVE_WORKSPACE_SEARCH.md) for their exact scope.

Mutation, classification/reveal, subscriptions/reload, images, exports,
AI writes, recovery and app-private grant restoration still need migration.
Broad plugin-fs permissions remain until those callers have moved. Native Windows
validation and the real packaged preview IPC probes are separate from browser
mock coverage; this progress does not satisfy the full T04 acceptance gate.

## Current entry points and impact

| Boundary | Current evidence | Required migration |
| --- | --- | --- |
| Direct frontend filesystem IPC | `src-tauri/capabilities/default.json:16` starts ten `**` grants | Remove these permissions after all callers use broker operations; no plugin-fs runtime-scope fallback |
| Workspace restore | `src-tauri/src/lib.rs:494` accepts arbitrary root and grants it recursively at line 512 | Require an existing window workspace grant; tree loading never grants authority |
| Workspace mutation/search | `src-tauri/src/lib.rs:526`, `:552`, `:573`, `:615`, `:650` | Inject actual caller window; authorize create parent, both rename endpoints, delete target, every search root |
| Path classification / reveal | `src-tauri/src/lib.rs:604`, `:807` | Require granted paths before metadata / OS reveal; native drop grants precede classification |
| Open-file registry | `src-tauri/src/lib.rs:61` accepts a claimed window label | Derive caller from Tauri; registry records UI ownership and cannot create a grant |
| Tab transfer / new windows | `src-tauri/src/lib.rs:196`, `:869`; `src/composables/useWindowManager.ts:16` | Verify sender grant, copy it only to host-created target, then emit/construct URL; query parameters are not authority |
| Document read | `src/services/documentText.ts:10`; `src/composables/useFileOperations.ts:109` | Broker byte read while preserving the current fatal UTF-8/BOM decoding contract |
| Document write | `src/composables/useFileOperations.ts:181` writes predictable `.tmp`, rereads, renames | One host save operation; frontend must not need sibling write/remove permission |
| Recovery / resources | `src/App.vue:1370`, `:1836` | Host-owned recovery records; resource source read and destination write grants |
| Watch/reload | `src/composables/useFileWatcher.ts:72` and documentText reader | Native window-owned subscription; each reload revalidates authority |
| Image read | `src/utils/image-resolver.ts:47`, `:66`; `src/composables/useAiPendingImages.ts:81` | Read only an explicit asset/workspace grant or approved document-relative resource scope |
| Image import | `src/services/imageImport.ts:34`, `:69` | Host derives asset target from authorized document; host owns collision-safe creation and app-private unsaved image storage |
| Export | `src/composables/useMarpExport.ts:91`, `src/composables/useDocxExport.ts:260` | Native save picker grants exact destination; broker writes exact bytes |
| AI apply / restore | `src/composables/useAiApply.ts:61`; `src/components/ai/AiPanel.vue:428`, `:439` | Same host save/CAS path as document editing; no direct origin write |
| AI snapshot export | `src-tauri/src/lib.rs:308`; `src-tauri/src/ai/snapshots.rs:139` | Require destination save grant before native write |
| Print webview | `src-tauri/src/lib.rs:131`; default capability window pattern `window-*` | Give print a label outside normal app window pattern and no privileged capability; deny broker by actual window identity |

Line numbers are anchors for this working tree and may move during integration.

## Minimal architecture

Add `src-tauri/src/file_access.rs` for a host-owned registry. Each grant contains
the actual window identity, native-selected canonical anchor, scope kind
(document, workspace, resource, export), separate read/write rights, and a live
handle/identity needed by the implementation to prevent substitution races.
Use exact-file grants for documents and exports, directory grants for explicitly
selected workspaces, and limited resource grants. A read-only scope never grants
write. A frontend path, window label, tab URL, recent entry, or access-map JSON
cannot add rights.

All externally callable operations receive Tauri's injected `Window`, not a
renderer-supplied caller label. Preview/print and unknown windows are rejected
before path processing. Revocation on close stops subscriptions; destroying a
window removes its grants. Transfer copies only the rights the caller already
has and cannot name a preview as the destination. Keep the existing source
window grant until its tab-close acknowledgement, so failed transfers do not
break the source tab.

The broker must not write its own authority ledger through the same renderer
filesystem API. If recent/session reopen is retained, store grants in app-private
native data only when a native user selection succeeds. A restore request may
reactivate only a matching native record. Existing localStorage paths without
such records must require a new native selection; importing all of them as
grants would recreate the arbitrary-root bug. Lost/moved or identity-changed
anchors require selection again.

## Trusted grant creation

1. **Open/save/workspace/resource dialogs:** expose purpose-specific native picker
   commands. Use `tauri_plugin_dialog::DialogExt` in Rust with the actual caller
   as parent; record selection in the broker before returning the selected path.
   The plugin's current frontend dialog grants use app-global plugin-fs scope,
   so calling `fs_scope().is_allowed()` cannot prove window ownership or rights.
2. **Initial CLI / second instance / macOS Opened:** validate ingress and create
   main-window document grants before `queue_open_files` emits a notification.
   Preserve the ordered queue behavior introduced for T05.
3. **Native drag/drop:** handle `WindowEvent::DragDrop(Drop)` on the host, grant
   dropped files/folders to that actual app window, then allow classification.
   Do not grant from a JavaScript event payload or `classify_paths` argument.
4. **Tab transfer / new window:** verify sender and target as above, install
   target rights before the target frontend loads the file.
5. **Derived assets:** derive `<document>.assets` from the authorized document
   in Rust. Legacy `images/` compatibility and other relative images need a
   bounded resource-read contract, not a generic recursive parent write grant.
   Absolute references and escaping references require explicit asset selection.

An unavailable grant should produce a typed `permission_required` result so the
UI can offer its existing picker. Do not silently widen scope or endlessly retry.
Cancelling that picker must leave the document and previous grants unchanged.

## Path and operation rules

- Resolve native path components, not string prefixes. Reject relative requests,
  device paths, Windows alternate data streams and unexpected volume/share
  changes. Native-selected UNC roots are permitted only within that exact share
  and directory grant; a UNC-looking string alone is never authority.
- Existing targets require canonical containment and safe handle-based opening.
  New targets require an authorized existing parent handle plus one validated
  basename. Reject `.`/`..`, separators and platform-invalid basenames.
- Do not stop at `canonicalize` followed by `std::fs::write(path)`: a symlink,
  junction or renamed parent can change between those operations. Anchor actual
  I/O to verified directory/file handles and reject traversal/reparse escapes.
  If a platform cannot enforce this operation, return an unsupported/permission
  error; a post-write check is too late.
- Save should take expected source revision/bytes and new bytes in one command.
  It validates authority and revision, uses an exclusive unpredictable sibling
  temporary file, verifies/syncs, and replaces through the authorized parent.
  Cleanup removes only the temporary file created by that operation. Host-owned
  journal/recovery metadata is required for full T08 crash acceptance.
- Workspace rename checks both ends and prevents overwriting unrelated data;
  creation uses exclusive create. Recursive deletion must remain handle-bounded.
  Search/tree enumeration must revalidate descendant entries, not just the root.
- Watch registers only granted paths, emits to its owning window, and cannot
  grant read rights. File replacement notifications trigger a fresh checked read.

## Implementation order for shared-worktree coordination

1. Independently add registry/path-policy code and native unit tests, with no
   product wiring. This is the smallest safe first patch and defines contracts
   for the frontend integration. It is not a completed security boundary.
2. Add native picker/OS-open/drop/transfer authority sources and app-private
   restoration. Coordinate `App.vue`, `useWorkspace`, `useWindowManager` first.
3. Add broker operations and a thin `src/services/nativeFs.ts` adapter; migrate
   documentText, file operations, watcher, images, exports and AI apply together.
   Keep byte preservation and typed permission/conflict errors consistent.
4. Guard all custom host workspace/export commands and separate the print
   capability. Remove direct plugin-fs frontend permissions only after the
   migration inventory has no remaining privileged caller.
5. Run native denial and positive acceptance tests. Do not mark T04/T05 complete
   merely because mocks or canonicalization unit tests pass.

## Required evidence

Native tests must deny ungranted paths, cross-window grant theft, forged caller
labels/transfers, localStorage restore escalation, sibling-prefix traversal,
absolute/UNC/ADS bypass, symlink/junction targets and parent-swap races. Save
tests cover exclusive temporary creation, read-only scope, expected-revision
conflict and unchanged bytes on failure. Also verify positive dialog, CLI,
cold/warm multiple open, native drop, session reopen, transfer, asset import,
export and watch behavior on Windows/macOS. Preview negative IPC tests must
exercise real capabilities/commands; current frontend mocks cannot prove denial.

AI subprocess authority is adjacent but separate: `ai::process::file_tools`
currently authorizes from `req.access_map`/document paths supplied in the request.
The T19/T20 work must intersect those requests with host grants before any tool
or subprocess launch; this broker alone does not make Ask read-only or isolate
provider CLIs.

## T08 save boundary: deferred until prerequisites pass

Stage 1 does not expose overwrite. Portable `cap_std::Dir::rename` atomically
replaces a name but cannot condition that replacement on expected bytes/inode.
A final hash read followed by rename can miss a non-cooperating external writer;
host revision serialization is not a filesystem CAS. See the OS
[rename contract](https://man7.org/linux/man-pages/man2/rename.2.html).
Likewise, checking a temporary name's identity before unlinking it does not make
cleanup atomic against name substitution. Retain ambiguous temporary objects for
recovery instead of risking deletion of another file.

T08 must implement the approved private snapshot/journal stages after T04/T05/T07
acceptance. Distinguish pre-commit failure from replacement already committed but
not confirmed durable (for example directory-sync failure). A failure after commit
cannot truthfully promise unchanged original bytes; never automatically roll back
over an externally changed hash. Document OS/local-filesystem and external-writer
limits explicitly. No replacement API was added in this stage.
