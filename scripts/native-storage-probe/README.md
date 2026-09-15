# Windows storage API probe

This independent diagnostic measures API return values. It does not activate the
editor's journal or Save code, and does not establish power-loss durability,
namespace persistence, production private-root authority, process isolation, or recovery guarantees.

## Run

From the repository root, with Rust installed:

```text
cargo test --locked --manifest-path scripts/native-storage-probe/Cargo.toml
cargo run --quiet --locked --manifest-path scripts/native-storage-probe/Cargo.toml
```

No arguments are accepted. On Windows the probe exclusively creates one UUID
directory under the OS temporary directory, then creates a fixed child directory
and a bounded synthetic BOM/CRLF file. It queries the filesystem through the open
directory handle. Only NTFS proceeds to the API matrix. The temp location is a
diagnostic location, not a model for private journal provisioning or authority.

The matrix records:

- `cap-std 4.0.3` read-only directory open and `FlushFileBuffers` baseline.
- Explicit directory opens requesting `GENERIC_READ | GENERIC_WRITE`,
  `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT`, and only
  `FILE_SHARE_READ | FILE_SHARE_WRITE` (no delete sharing).
- Exclusive synthetic file creation, `write_all`, and native `FlushFileBuffers`.
- Native flushes on the empty child directory and its parent, which contains
  both the new child and the synthetic file.

File creation/flush is an independent control and still runs when a read/write
directory open fails. A failed operation is never retried with weaker access or
sharing flags. Directory metadata rejects reparse points. There is no privileged
volume flush, elevation, write-through substitution, or product fallback.

Cleanup occurs after test handles close and removes only entries this run created,
using retained parents and nonrecursive removals. A cleanup failure is reported
and may leave a disposable `mdw-storage-probe-<UUID>` directory in the OS temp
directory. A killed process may also leave its fixture. The probe writes no user
document contents and does not enumerate or recursively delete temp directories.

## Output and exit codes

Standard output is one JSON object plus LF, together at most 16 KiB. It includes
`schema_version: 1`, `scope: "api_support_only"`, platform, filesystem type/flags,
requested directory access/share/flags, and 28 ordered operation results, plus an optional process-token elevation boolean. No user
path, UUID, volume label/serial, error message, or file content is emitted.

Each `outcome.status` is one of:

- `success`: that specific operation returned success.
- `rejected`: the designated negative fixture was rejected for its exact expected
  policy reason; API failures never count as this result.
- `win32_error`: numeric `code` captured from the failing call.
- `probe_error`: fixed reason enum; inspection or I/O could not produce the
  required observation. This is not evidence of unsupported directory flush.
- `skipped`: `prerequisite_failed`, `non_ntfs`, or `unsupported_platform`.

Exit 0 means a valid measurement report was emitted, including reports with API
errors or skipped operations. **It does not mean directory flush is supported.**
Exit 1 means report validation/output failed; exit 2 means invalid arguments.
Non-Windows runs emit only `unsupported_platform` skips and touch no fixtures.
CI should retain the JSON even when an API is unsupported, inspect each outcome,
and attach runner OS/build/architecture separately for interpretation.

## Validation and evidence limits

Pure tests check the bounded schema, error/success/skip distinction, fixed
operation order, and rejection of path-like/unbounded filesystem metadata.
Windows-specific tests check Win32 code preservation and the requested flags.
Cross-compilation checks types and ABI declarations; it does not execute Win32.
Run the executable on real Windows to obtain measurements. Successful API returns
still need separate namespace-durability research and crash/power-loss evidence
before a journal durability claim. The disposable ACL checks below do not replace cross-user access tests or
production ancestry/hostile-substitution validation.

Microsoft documents the write-access requirement and the zero/nonzero result
contract for [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).
Filesystem metadata is queried with [GetVolumeInformationByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew).


## Disposable private ACL controls

After the NTFS query, an independent slice additionally requires persistent ACL
support. It reads **TokenUser from the actual process token**, records only whether
the token is elevated, and refuses a SYSTEM user or a token with already enabled
Backup/Restore privileges. It never changes token privileges, elevates, or falls
back to a weaker open. An elevated token without these enabled privileges can run;
this is reported and does not substitute for a foreign-user access experiment.

Within the exclusively created disposable root, a new no-delete-sharing handle
pins the parent. A child directory and synthetic file are created with explicit
security attributes at creation: owner is the process user, protected DACL, and
exactly user + SYSTEM full-control allow ACEs. Directory ACEs have OI/CI flags;
file ACEs have no inheritance flags. Handles are non-inheritable and opened with
OPEN_REPARSE_POINT. Inspection queries the retained object's owner/DACL, rejects
reparse/type mismatches and multi-link files, and accepts only this strict form.
SID values and handle-derived paths are used in memory only, never in JSON.

Empty broad-Everyone, null-DACL, and unprotected-DACL file fixtures are each
created under that already verified private directory. The null-DACL fixture's
in-memory descriptor is marked protected before creation so inherited parent
ACEs cannot replace the intended NULL DACL. The same inspector must
reject each for its designated policy reason, without repairing its ACL. A real
junction is created using FSCTL_SET_REPARSE_POINT, targeting another disposable
child in this run. Reopening the junction itself with OPEN_REPARSE_POINT must be
rejected on handle metadata before ACL acceptance. No writes go through the
junction; a retained target sentinel is checked unchanged. Fixture-creation or
inspection API failure is recorded separately from expected rejection.

Cleanup removes only entries this run created, nonrecursively and in reverse
creation order after handles close. This deliberate fixture cleanup is not an
adoption/repair/deletion policy for an existing production object. The temporary
parent's ancestry is not validated as a production private root; same-user races,
renderer permissions, foreign-token access, and durability remain separate work.

CI retains the JSON before checking these positive/negative ACL controls. Failed
or skipped ACL controls fail that dedicated CI step; unsupported directory-flush
results remain observations. On non-Windows, all operations remain skipped. The
ACL API and descriptor-policy tests execute only on the two Windows runners;
cross-checking their Rust types on macOS is not execution evidence.

Primary API contracts used by this slice:

- [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation)
  supplies process-user, elevation and enabled-privilege information with TOKEN_QUERY.
  The fixed-size [TOKEN_ELEVATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_elevation)
  query uses a typed buffer and validates its returned length; it does not rely
  on a NULL-buffer sizing call returning ERROR_INSUFFICIENT_BUFFER. Windows tests
  exercise each token-information class separately without logging identity data.
- [CreateDirectoryW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createdirectoryw)
  and [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
  accept creation security attributes; existing objects are never repaired by them.
- [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
  queries a handle with READ_CONTROL and returns an allocated descriptor, freed with LocalFree.
- [GetSecurityDescriptorControl](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-getsecuritydescriptorcontrol)
  exposes the protected-DACL bit.
- [SetSecurityDescriptorControl](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setsecuritydescriptorcontrol)
  marks only the null fixture's in-memory descriptor protected before creation;
  [the inheritance algorithm](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dtyp/0f0c6ffc-f57d-47f8-a6c8-63889e874e24)
  excludes the parent ACL when the supplied ACL is protected.
- [FSCTL_SET_REPARSE_POINT](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_reparse_point)
  and [REPARSE_DATA_BUFFER](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer)
  define the mount-point fixture and its byte offsets.
