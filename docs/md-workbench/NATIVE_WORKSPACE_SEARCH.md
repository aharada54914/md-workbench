# Native workspace content search

`search_workspace_content({ roots, query })` keeps its existing IPC name and
success DTO: `Array<{ path: string, line: number, snippet: string }>`.
Failures now use the native broker error DTO `{ code, message }`.

## Authority and I/O

The host injects the actual caller window and captures its editor generation
before dispatching a blocking worker. The worker checks that generation again
and holds the native registry lock for the search. All requested roots must
resolve to an existing caller-owned **Workspace READ** grant before the first
filesystem operation. Root strings, restored settings, exact document grants,
resource grants, and another window's grants never create search authority.
An empty trimmed query returns an empty array without filesystem I/O; caller
generation and input-size checks still apply.

Each root resolves once to its existing original/canonical alias metadata and a
retained directory grant. Nested paths use clean relative components with that
same grant throughout traversal. The host uses `FileAccess.list_directory` and
`FileAccess.read`; there is no ambient `exists`, `metadata`, `read_dir`,
`canonicalize`, or `File::open` on renderer-provided paths. Absolute result paths
are display/routing metadata only. Windows separator alias behavior matches
`native_read_path`; aliases do not mint or expand grants.

The directory core omits symlinks/junctions, nonregular entries, invalid UTF-8
names and nonportable names, and refuses symlink traversal in supplied relative
roots. The read core reopens files through the retained parent with nofollow,
so a file replaced between enumeration and reading cannot redirect the read.
Root or child replacement can produce an error; there is no ambient fallback.
The returned content is not an atomic snapshot of the filesystem.

## Search behavior

- Case-insensitive ASCII substring search; the query is trimmed.
- `.md`, `.markdown`, `.mdx`, with case-insensitive extensions.
- Hidden children (names starting with `.`) and `node_modules` are omitted.
  A natively selected hidden root is still searchable.
- One-based line numbers, using Rust UTF-8 line splitting.
- Snippets are trimmed and limited to 240 Unicode characters, plus an ellipsis
  only when characters remain.
- Invalid UTF-8 content and files larger than 512 KiB are excluded. Unlike the
  old implementation, oversized files do **not** contribute prefix matches.
  The size check and bounded read use the retained file handle.
- Other directory/file I/O failures reject the entire request instead of
  silently dropping unreadable results.
- Roots are processed in request order, with the directory core's stable
  directories-first ordering. Duplicate/overlapping roots remain separate
  requests and consume the same shared bounds; results are not deduplicated.

## Bounds

| Bound | Maximum |
| --- | ---: |
| Requested roots | 32 |
| Total root strings, UTF-8 bytes | 128 KiB |
| Untrimmed query, UTF-8 bytes | 4,096 |
| Directory depth, each requested root at zero | 50 |
| Scanned entries in one directory | 10,000 |
| Scanned entries across all roots | 50,000 |
| Eligible Markdown files visited, including excluded content | 5,000 |
| Bytes read per file | 512 KiB |
| Matching lines across all roots | 200 |
| Conservative JSON response allocation budget | 32 MiB |
| Cooperative worker time budget | 4 seconds |

Hidden, ignored, unsafe and symlink entries consume the scan budget before
filtering. Exactly reaching a count bound can succeed if the rest of the search
completes without another counted item. The next file, entry or hit beyond the
bound rejects the whole request with `file_too_large`, rather than returning an
unmarked partial success. Exceeding input, depth, output or time bounds uses
the same typed error. Oversized file exclusion is the deliberate per-file
eligibility rule above, not partial prefix search.

Every hit reserves `(path UTF-8 bytes + snippet UTF-8 bytes) * 6 + 256` checked
bytes before creating its result DTO; two bytes cover the result array. This
conservatively covers JSON escaping, keys, line numbers and punctuation.
Overflow or insufficient budget rejects the whole request.

Time checks run before/after each filesystem operation, for each entry and
line, and before returning. The four-second budget starts inside the worker
once it acquires the registry lock. It does not include queue/lock wait, and
it cannot interrupt a blocked OS filesystem call; this is not a hard deadline.
The existing registry lock also serializes concurrent authority changes with
this search. An operation already holding the lock completes or fails before
window revocation takes effect.

## Verification and remaining integration

`native_files_search_tests.rs` covers unselected/cross-window/wrong-kind grants,
prevalidating all roots, stale generations, filters/DTO/Unicode snippets,
file/hit/entry/depth/input/output/time boundaries, excluded content, retained
root replacement, symlink refusal and Windows junction/separator handling.
The shared directory and file-access tests cover handle-relative traversal and
replacement safety. Windows-specific tests require Windows CI.

The quick switcher displays distinct permission, limit and general failure
messages. Exactly 200 successful hits no longer produce a truncation warning.
Changing the query or workspace roots immediately invalidates pending results;
short/empty queries and unmount also prevent stale results from appearing.
The component regression suite covers these errors, exact-limit success and
responses arriving during the next query debounce.
This host change does not migrate watch/reload, reveal, classification, writes
or saved grant restoration, and does not remove the remaining broad plugin
filesystem permissions. T04 remains incomplete until those boundaries migrate.
