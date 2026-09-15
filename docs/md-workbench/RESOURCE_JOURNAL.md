# Private Resource journal foundation — T08

ADR-0002 was approved by the user for proposal revision
`7bffca8d9ed224bab3a07313bada7a35d5eb80c2` on 2026-09-15.
The native `resources` module implements its in-memory metadata and recovery
classification foundation. It has no filesystem I/O or IPC and is not connected
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
There is no truncation, eviction, compaction, append I/O or disk reservation.

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
