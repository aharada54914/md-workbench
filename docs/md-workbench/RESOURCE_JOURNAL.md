# Private Resource journal foundation — T08

ADR-0002 was approved by the user for proposal revision
`7bffca8d9ed224bab3a07313bada7a35d5eb80c2` on 2026-09-15.
The native transaction and recovery modules implement the in-memory metadata and
classification foundation. Those modules have no filesystem I/O or IPC. The separate
inactive private store described below performs native I/O and is not connected
to Save. Existing saves still use the frontend temporary-file protocol.

## Validated metadata

`JournalRecord::parse_json` is the entry point for untrusted journal bytes.
It accepts one strict version 1 JSON record, with a canonical nonnil UUID,
document target, ordered asset targets and stage. Duplicate/unknown keys,
unknown stages, malformed UTF-8, trailing JSON and invalid digest forms fail.
SHA-256 values must be 64 lowercase hexadecimal characters; this module does
not compute hashes or authenticate supplied values.

Each target contains a display-only path, prior state (`Missing` or an old
hash), expected new hash and new byte length. Paths are never authority and
cannot restore a grant. An asset's prior state distinguishes a planned new
asset from an existing one; it does not authorize later deletion.

Limits are 64 KiB encoded journal bytes, 64 assets, 4096 UTF-8 bytes per
nonempty display path without control characters, and 64 MiB per new target.
Oversized values fail without truncation. Source and snapshot bytes are not
embedded in these records.

## Stage contract

The only transitions are `PREPARED` → `ASSET_DURABLE` →
`DOCUMENT_DURABLE` → `COMPLETED`. Every asset must be marked durable before
leaving `PREPARED`; even zero-asset saves traverse all stages. Skipping,
regression and late asset changes fail. A longer stage name that would exceed
the encoded size limit fails while retaining the previous record.

These are host-reported facts. The future storage adapter must perform and
verify the corresponding durability boundary before changing the stage.
Parsing a record cannot prove that a flush or publication actually occurred.

## Recovery observations

The host must reacquire current authority and inspect each target independently.
It supplies document and asset observations in the exact recorded order:
missing, hash plus byte length, or unavailable. Read/permission failures must
be unavailable, never missing.

- All expected new contents observed: `CommittedContentObserved`, including
  when the journal stage lags. Equal old/new hashes indicate matching contents,
  not evidence of publication or power-loss durability.
- Original document observed at an early stage with consistent assets:
  `OriginalRetained`. Already-created assets remain as evidence.
- Conflict, unexpectedly missing data, unavailable data, contradictory durable
  claims or incomplete assets beside a new document: `RecoveryRequired`.

Classification is repeatable and read-only. It performs no rollback, retry,
record update, overwrite or orphan deletion.

## Integration still required

Private storage and ACL validation, snapshot retention, actual hash computation,
source-revision checks, retained filesystem authority, publication ordering,
crash recovery and Save/Resource UI integration remain open T08 work. Current
wildcard renderer filesystem permissions must not be mistaken for isolation of
private records. The isolated native API probe succeeded with read-write
directory handles on Windows Server 2022 and Windows 11 ARM NTFS; read-only
handles returned access denied. See [recorded observations](storage-api-observations/README.md).
This establishes API support on those runners. Namespace durability, private
ACLs and recovery ordering still need evidence; a process-kill test alone does
not prove power-loss survival.

## Pure append-frame codec and metadata replay

`resources::journal_frame` wraps the existing strict `JournalRecord` JSON in a
fixed version 1 envelope. It operates on byte slices and vectors only. Integer
fields are little endian; UUID bytes use UUID order, not native struct layout.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 bytes | `MDWJFRM` followed by NUL |
| 8 | 4 bytes | Frame version, exactly 1 |
| 12 | 8 bytes | Consecutive global sequence, starting at 1 |
| 20 | 16 bytes | Nonnil transaction UUID, matching the JSON record |
| 36 | 4 bytes | Nonzero JSON byte length, at most 64 KiB |
| 40 | Declared length | Exact JSON bytes |
| After JSON | 32 bytes | SHA-256 of the entire fixed header and exact JSON bytes |
| After digest | 8 bytes | `MDWJEND` followed by NUL |

The maximum frame is 65,616 bytes, including 80 bytes of overhead. Lengths and
offsets are checked before payload allocation. The digest is checked before
strict JSON parsing. The marker is checked only at the declared end: marker text
inside a payload cannot terminate it. Neither the marker nor the checksum proves
that anything was flushed. SHA-256 detects corruption; it does not authenticate
records against an actor who can rewrite the checksum.

`resources::journal_replay` accepts at most 64 MiB, 4096 frames and 1024 distinct
transactions, keeping only each transaction's latest validated record. It stops
at the first error and never searches for a later magic marker. Failure leaves
the preceding validated prefix available for diagnostics, not recovery execution.
Replay performs no truncation, eviction, compaction, append I/O or disk reservation.

The first record for an ID must be PREPARED with all assets PLANNED. Subsequent
records retain the same document and ordered asset targets, including display
labels, prior state, new digest and byte length. Asset state may only advance
while PREPARED; stage changes must follow the existing adjacent transitions.
Several assets may become durable in one record, including when advancing to
ASSET_DURABLE. No-op duplicates, stage skips/regressions and records after
COMPLETED fail. Transactions may interleave under the consecutive global sequence.

An incomplete final frame yields `IncompleteTail`, never a new stage. A malformed
complete frame, even at EOF, is invalid history. Unknown versions and exceeded
limits have separate outcomes. EOF at a frame boundary yields `CompletePrefix`:
**this does not certify complete historical storage**. Removing a whole suffix
is indistinguishable from a shorter valid stream; a partial old frame can also
look like a torn new append. Neither empty input nor an incomplete tail permits
automatic initialization, truncation or resumed append. A future storage protocol
must establish store identity and acknowledged extent independently before making
those decisions.

The result type is `MetadataOnlyHistory`; its snapshot state can only be
`Unverified`. A recorded COMPLETED stage cannot create a verified recovery/commit
result. Replay does not call the observation classifier or obtain permissions.
The existing JSON schema contains no snapshot references. A future versioned
reference format and private-storage verifier must bind transaction, target slot,
prior/candidate role, container identity, checked byte ranges and hashes before
recovery readiness can be assessed. Missing or unverified snapshots cannot be
treated as usable recovery evidence. Flush ordering and namespace durability
remain separate prerequisites, even after bytes have been verified.

## Verification

Focused native tests cover strict parsing, limits, stage transitions,
non-mutating failures and recovery classification, plus frame golden bytes,
every-byte mutation/truncation and bounded history replay. The modules make no
tested claim about disk persistence or platform filesystem behavior.


## Inactive private metadata store

`resources::private_store` is crate-private and has no IPC registration or Save
caller. The standalone native-storage diagnostic compiles this same source. It
adds fresh-session append I/O to the existing frame format; it does not change
that format, the transaction contract, or the recovery classifier.

A writer can only be constructed by exclusive native session creation. No caller
path selects the base, and a reopened UUID can only produce metadata observations,
never a writer or cleanup owner. Existing empty, torn, invalid, or complete-prefix
streams are never repaired, initialized, resumed or truncated. Append validates
bounded history progression and encoded size before writing. Short writes are
completed at the acknowledged offset; write or flush failure poisons the writer.
Only a successful file barrier followed by a returned receipt acknowledges a new
sequence/extent. An allocation abort after the barrier can leave an unacknowledged
frame; replay still supplies metadata only. There is no automatic retry of an
uncertain append, compaction or capacity reservation. The separately constrained
document snapshot extension is described below.

Windows resolves the actual process user's LocalAppData via the native known-folder
API, accepts local NTFS with persistent ACLs, retains every opened non-reparse
ancestor without delete sharing, and creates a new UUID directory and one journal
file with the protected process-user + SYSTEM DACL. The common strict ACL inspector
rejects broad, NULL, unprotected, foreign-owner and unexpected-entry forms. It
rejects SYSTEM and already enabled Backup/Restore privileges, without elevation
or privilege adjustment. File, private-directory and parent-directory flushes
must all return success during bootstrap; unsupported/error results are typed.

macOS resolves the actual account's home through `getpwuid_r`, then opens its
existing `Library/Application Support` components relative to retained directory
FDs. It requires local writable APFS, no symlink traversal, checked ownership and
permissions, private directory 0700/file 0600, and no private extended ACL. An
absent ACL is established through successful `fstatx_np` and security-property
presence inspection, not by treating an arbitrary ACL-query error as absence.
Read opens are nonblocking before same-FD regular-file/link checks, so a FIFO
replacement cannot wait indefinitely. File flush uses fsync plus F_FULLFSYNC;
bootstrap also fsyncs the private directory and parent. Advisory locks reject
cooperating concurrent readers while the fresh writer is live.

Every append receipt retains `NamespaceDurability::Unestablished` and
`SnapshotVerification::Unverified`. Successful native API returns and fresh-process
reopen are observations, not proof that a newly created namespace survives power
loss. Complete suffix loss remains undetectable from this format alone. No
COMPLETED metadata record establishes commit/recovery eligibility. Hostile
same-user native processes, advisory-lock bypass and renderer isolation are outside
this primitive's guarantee. In particular, macOS cleanup's final path unlink is
not safe against a hostile same-user namespace race; cleanup is limited to the
current diagnostic's exclusively created synthetic entries and is nonrecursive.
Failed bootstrap may leave such an entry; there is no scan/adopt/delete fallback.

Scoped checks cover fake-backend short/zero/partial writes, flush failure and
poisoning, invalid transitions, changed extents, incomplete tails and complete
suffix loss. Real macOS tests use only owned synthetic sessions for ACL/mode,
symlink/hardlink/FIFO/replacement rejection, locking, flush and cleanup. The
three-platform diagnostic appends four records and observes them in a new process.
The optional `private-store-probe` build now injects actual child-process
termination after checked empty-file creation, after an exact 17-byte append
prefix, after file flush before acknowledgement, and after acknowledgement.
Normal controls continue through each same seam and clean their owned session.
Killed cases use an independent metadata-only reader with exact-byte comparison;
no reader obtains a writer or cleanup owner. Each successful run explicitly leaves
four synthetic sessions. No scan or recursive cleanup is performed. This explicit
feature is default-off, with process/stdio waiting only in the standalone consumer.
The observed process-visibility results do not establish power-loss or namespace
durability, and do not promote snapshots from Unverified.


## Inactive one-document snapshot extension

`SnapshotSession::create` accepts exactly one PREPARED transaction, one document,
and no assets. It validates old/new hashes, presence and sizes before native
creation. Missing old content is distinct from an existing empty file. Each byte
payload is limited to 64 MiB and their checked total to 128 MiB. Content is opaque:
BOM, CRLF, trailing whitespace and non-UTF-8 bytes are neither decoded nor normalized.

The exclusive-created fixed leaf is `<canonical-transaction-uuid>.document-snapshot.v1`.
No caller-supplied path, directory scan, generic filename or offset table is accepted.
Its envelope is eight ASCII bytes `MDWSNP01`, a little-endian u32 JSON header length
(up to 4096), a strict version-1 JSON header, then exact before and after payloads.
The header binds the private session UUID, transaction UUID, document slot and
before/after roles with presence, lengths and SHA-256 hashes. Missing before data
has no payload; after data must be present. Unknown/duplicate fields, wrong binding,
wrong hashes, oversized declarations, truncation and trailing bytes are rejected.
The existing journal-frame wire format and ADR are unchanged.

The one-shot order is snapshot write → file barrier → retained private-root barrier
→ same-handle exact readback/hash check → append the PREPARED journal record. The
handle remains held through that append. Partial or zero writes, failed barriers,
and failed readback do not append PREPARED. An uncertain journal append is not an
acknowledgement. The one-shot result offers no later stage advancement or retry.
After the session has been created, failure retains its creator cleanup owner;
a bootstrap failure retains the underlying primitive's possible-residual limit.
The owner tracks only its one exclusive-created snapshot identity. Cleanup checks
it before bounded deletion and never deletes an unknown extra entry recursively.

`PrivateSession::inspect_document_snapshot` independently validates a reopened root
and requires the actual complete journal to contain exactly one PREPARED record.
It opens the fixed snapshot leaf, then verifies its binding and bytes. Empty, torn,
invalid, multiple-transaction or later-stage history cannot produce this result.
`VerifiedDocumentSnapshotBytes` means the bytes matched at inspection time only;
metadata histories and append receipts still carry `SnapshotVerification::Unverified`
and namespace durability remains `Unestablished`. No snapshot result invokes recovery,
certifies commit, reacquires destination authority, registers IPC or changes Save.
Undetectable complete suffix loss, same-user hostile mutation and power-loss limits
remain as documented above.

Focused tests exercise schema/payload rejection, every-byte truncation, partial and
Interrupted writes, file/root barrier failure, readback failure, and native roundtrip.
The explicit `--snapshot-kill` diagnostic reuses the owned-child supervisor at four
boundaries: before snapshot creation, after its exact 17-byte prefix, after snapshot
barriers before PREPARED, and after PREPARED acknowledgement. Normal controls verify
bytes and clean their own sessions. A separate process observes killed cases, checks
exact journal/snapshot prefixes and accepts verified document bytes only in the final
case. Metadata remains Unverified in every case. Four killed synthetic sessions are
reported as retained; no observer receives cleanup ownership. Process kill is not a
power-loss test. Windows Server 2022, Windows 11 ARM and macOS CI must independently
validate this increment; earlier metadata-only CI does not cover snapshot behavior.
