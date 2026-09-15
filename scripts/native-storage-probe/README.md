# Native storage API probe

This independent diagnostic measures API return values. It does not activate the
editor's journal or Save code, and does not establish power-loss durability,
namespace persistence, production private-root authority, process isolation, or recovery guarantees.

## Run

From the repository root, with Rust installed:

```text
cargo test --locked --manifest-path scripts/native-storage-probe/Cargo.toml
cargo run --quiet --locked --manifest-path scripts/native-storage-probe/Cargo.toml
```

The default API-support mode accepts no arguments. On Windows the probe exclusively creates one UUID
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


## Inactive shared metadata-store consumer

On macOS or Windows, run `cargo run --quiet --locked --manifest-path
scripts/native-storage-probe/Cargo.toml -- --metadata` to exercise the product's
crate-private `resources::private_store` source directly. The existing no-argument
API report remains separate. This mode creates only one new synthetic UUID session
in the actual native account's application-data directory, appends four existing
journal frames, closes the writer, reopens in this process and a fresh child, then
performs nonrecursive owned-session cleanup. It never uses user document content,
registers IPC, calls Save, repairs an existing store, or resumes an old writer.

Output is a separate bounded JSON object with `scope: inactive_metadata_store`,
sequence/validated extent, typed failures and cleanup outcome. No paths, IDs,
SIDs or content are logged. Exit 0 requires the four-record observation and
successful cleanup; failures exit 1. The internal `--metadata-read <UUID>` consumer
can only independently validate/replay an existing session; it cannot append or
acquire cleanup ownership. CI exercises Windows Server 2022, Windows 11 ARM and
macOS 15. Cross-compilation alone does not validate native API behavior.

All results retain namespace `unestablished` and snapshots `unverified`. A flush
return and fresh-process read are not power-loss evidence; the optional kill-at-boundary slice below measures process termination only. Failed bootstrap or abrupt termination can leave a
synthetic session. The diagnostic does not enumerate/remove such leftovers or
weaken security to clean them up. Same-user hostile native mutation is excluded;
macOS locks are advisory and final unlink operations cannot defeat that actor.
See RESOURCE_JOURNAL.md for the full inactive boundary.

Primary native contracts additionally used here:

- [SHGetKnownFolderPath](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shgetknownfolderpath)
  resolves the process user's application-data location; returned memory is freed
  with CoTaskMemFree.
- [Apple ACL descriptor acquisition](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_file.c)
  and [security-property presence](https://github.com/apple-oss-distributions/Libc/blob/main/gen/filesec.c)
  explain why missing ACL properties must be distinguished from a failed FD query.
- [Apple fsync](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html)
  and [fcntl](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)
  describe fsync and F_FULLFSYNC; successful calls do not certify namespace durability.


## Explicit process-termination diagnostic

Build with `--features private-store-probe` and run `--metadata-kill`. This feature
is absent from both crates' default features. Its shared-code seams only cap the
first append fragment and invoke an installed diagnostic callback. Normal product
builds contain neither these callbacks nor process/stdio/environment hooks.
All process creation, handshake waiting and termination is in this standalone
consumer. No environment variable enables this behavior.

Each boundary first runs a normal continue-to-completion control, then a second
child is terminated while blocked at the identical handshake:

| Boundary | Reached point | Exact post-termination observation |
| --- | --- | --- |
| bootstrap | New private directory and empty file checked, before first bootstrap file flush | Empty byte stream, metadata sequence 0 |
| partial_append | Exactly 17 frame bytes written, before any append flush | Exact 17-byte prefix, incomplete tail, sequence 0 |
| flushed_before_ack | Frame file barrier returned, before writer state/receipt update | Exact full frame, metadata sequence 1 |
| after_ack | Append returned its receipt to the diagnostic caller | Exact full frame, metadata sequence 1 |

The parent receives a bounded boundary/UUID handshake over a private child pipe,
validates the boundary and canonical UUID, then acts only on its retained Child
handle. No PID or path from a message selects a termination target. The child is
confirmed live before termination, and exit is reaped with a deadline. macOS also
checks SIGKILL exit status. Handshake/read/exit waits have 15-second bounds; timeout,
closed/malformed messages and unexpected exits fail the case. The successful
control continues from the handshake, checks the complete synthetic frame, and
cleans its own session using its existing ownership.

A separately spawned reader independently revalidates the native base/root and
compares bounded exact bytes using a feature-only equality method; it also checks
the existing MetadataOnlyHistory result. It gains no writer, cleanup ownership or
verified snapshot. The two complete-frame observations explicitly do not prove
whether any acknowledgement or namespace survived a system crash.

The report has `scope: process_kill_visibility_only`, per-boundary/control pass
results and a residual-synthetic-store flag. Paths, UUIDs and contents stay out of
the emitted report. **Four killed synthetic sessions intentionally remain** per
successful run. This consumer does not enumerate or remove them, assign cleanup
ownership to the observer, or recursively clean any directory. A failed handshake
conservatively reports possible residual storage. Use disposable CI runners for
repeated experiments. These are process-visibility tests, not power-loss,
namespace durability, renderer-isolation or recovery certification.

Rust's [Child contract](https://doc.rust-lang.org/std/process/struct.Child.html)
requires explicit termination/reaping; Child itself has no automatic Drop cleanup.
The diagnostic wrapper applies that lifecycle only to children it created.

Windows CI invokes the native consumer directly from PowerShell. MSYS2's
[`set_cygwin_privileges`](https://github.com/msys2/msys2-runtime/blob/master/winsup/cygwin/sec_helper.cc)
enables backup/restore privileges during process initialization; invoking through
that shell can therefore violate this probe's token policy. The primitive keeps
rejecting these tokens. Typed `windows_security` failures retain their operation
and exact bounded policy reason, without logging SIDs or privilege lists.
Run 35012508629 reported only the earlier generic `unsafe/permissions`; the shell
explanation remains a hypothesis until the direct native invocation is measured.


### Inactive document snapshots

`cargo run --manifest-path scripts/native-storage-probe/Cargo.toml --features private-store-probe -- --snapshot-kill`
uses the same inactive product snapshot primitive and bounded child supervisor.
It runs four normal controls plus four actual child terminations: before the bundle,
after an exact 17-byte prefix, after snapshot file/root barriers, and after PREPARED.
Separate observer processes compare exact synthetic snapshot and journal bytes.
Only the final boundary has a bound document snapshot; metadata still reports
Unverified and namespace remains Unestablished. The bounded JSON contains no source,
path or session UUID. Four killed synthetic sessions remain and are explicitly
reported. No scan, adopted cleanup owner or recursive cleanup is available.

This is one document/one transaction/no assets, with no Save or IPC integration,
no recovered writer, no RecoveryReady state and no power-loss certification.
Run directly through PowerShell on Windows, preserving the strict native token policy.
