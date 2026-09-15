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

## Verification

Seventeen focused native tests cover strict parsing, limits, stage transitions,
non-mutating failures and recovery classification. The module makes no tested
claim about disk persistence or platform filesystem behavior.
