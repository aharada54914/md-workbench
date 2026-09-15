# Inactive existing-Document Save preflight

This is a host-only observation helper. It is not registered as an IPC command,
called by the current Save UI, or connected to private snapshot/journal storage.
It never creates a grant, writes a destination, stages a file or changes a tab.

## Authority and interface

`NativeState::preflight_document_save(label, generation, alias,
expected_grant_id, expected_disk_hash, candidate)` requires:

- The actual native document window's label and current generation.
- An exact requested/canonical alias already recorded by native selection in the
  current non-Save metadata map. The alias only selects metadata; it is never
  reopened as an ambient path. New spellings and Workspace-prefix fallback are
  not accepted. Both recorded requested and canonical aliases remain usable.
- The exact expected current grant ID, kind Document, with both READ and WRITE.
  A Resource, Workspace, Export or historical ID is not sufficient. Save Export
  selection stays in its separate map and does not replace Document READ.
- The core grant still existing for that caller with the same required kind and
  rights. Metadata alone cannot upgrade the retained grant's rights.

The native registry must remain locked throughout validation and the core call,
following the existing FileAccess lifecycle. This serializes native registry
reselection/revocation with the read; it does not lock out other filesystem users.

## Byte observation

`FileAccess::preflight_document_save` checks candidate length before reading or
copying it, then calls the existing bounded retained-handle `read` once, with an
empty relative path. Both before and candidate are limited to 64 MiB independently
(the returned byte payload totals at most 128 MiB; this is not a process-memory
or aggregate request budget). The caller already owns its candidate allocation.

The native helper hashes the exact read bytes using SHA-256 and compares the
32-byte expected disk hash. A mismatch returns `stale_disk` before copying the
candidate. Other failures preserve existing filesystem/permission errors. The
expected hash is a fixed-size native argument, not an unchecked text digest.

Successful `SavePreflightObservation` has private fields and immutable borrow
accessors for before bytes, candidate bytes and their native SHA-256 hashes. It
has no Serialize, Debug, Clone, grant ID, path, retained handle or commit method.
No UTF-8 decoding, BOM stripping, newline normalization or string round trip occurs.
An empty existing document is valid; a missing existing leaf is `file_not_found`,
not an implicitly authorized create/SaveAs operation.

The held parent protects against ambient parent path replacement. The final
regular leaf may legitimately have been atomically replaced since selection:
preflight observes the current leaf under that parent and requires its hash.
A symlink leaf is refused. There is no fallback to the display path if the held
leaf becomes missing or inaccessible.

## Explicit limits

- The result describes bytes read at preflight time; it does not retain future
  authority. Another process can change the document during or after the read.
  Reading one opened file is not itself a consistent filesystem snapshot.
- Expected-hash comparison rejects a stale observed baseline. It is not portable
  compare-and-swap, atomic conditional overwrite or evidence of a future commit.
  No native editor dirty revision is known or promised.
- This helper does not create PREPARED records or snapshots on either success or
  failure. No journal stages, queue, transaction owner, recovery action or cleanup
  are introduced. Snapshot/publication integration remains separate work.
- SaveAs, new documents, Workspace saves and exports are excluded. Current
  renderer Save and its remaining broad permissions are unchanged.
- A later consumer must design and verify publication, conflict/uncertainty,
  generation, resource completeness and UI adoption; retaining this observation
  cannot replace those checks.

## Verification

`cargo test --manifest-path src-tauri/Cargo.toml --lib native_files::save_preflight::tests`

The 17 tests cover stale hashes with no target/sibling changes; exact BOM/CRLF,
NUL and non-UTF-8 bytes; immutable observations after later writes/revocation;
generation reuse, cross-window and preview rejection; same-path reselection;
Save Export alias separation; Resource/Workspace rejection; independently checked
core rights/kinds; unselected spellings, revoked IDs and no ambient fallback;
recorded requested/canonical aliases; empty/missing/directory distinctions;
candidate exact-limit acceptance and overflow before read; oversized disk;
regular leaf replacement; symlink rejection; and retained parent replacement.

Local macOS execution passed all 17. The parent-replacement test exercises Unix
retained-directory behavior, or Windows' existing cap-std sharing protection when
rename is refused. Windows symlink tests require the same Developer Mode/privilege
as existing native security tests. Windows and Linux runtime results must be
reported by their actual CI runs; local success does not substitute for them.
