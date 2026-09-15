# Native document image byte reads

This foundation reads original bytes from two conventional image directories
using existing document authority. It does not decode images, validate formats or
SVG, establish safe display behavior, or activate frontend image rendering.

## IPC contract

Both commands derive the caller from the injected editor window. They capture
its generation before dispatch and recheck that generation under the native
registry lock, which remains held through resolution and handle-based I/O.

```ts
native_resolve_image_document({ documentPath: string })
  // Promise<{ grantId: string }>

native_read_document_image({
  documentPath: string,
  expectedDocumentGrantId: string,
  relativePath: string,
})
  // Promise<number[]> — original file bytes
```

`documentPath` only looks up existing current metadata: the normal exact-file
READ binding takes precedence over the longest owned Workspace READ prefix.
The selected binding must be Document or Workspace and its document leaf must
currently be a regular file. Both descriptor and byte commands perform these
checks; descriptor returns only the ID. Resource bindings are rejected without
falling back to a broader workspace. Separate Save/Export grants cannot supply
document authority. No older grants, renderer-selected parent, ambient
canonicalization, or plugin fallback are consulted.

Every byte read requires the descriptor's `expectedDocumentGrantId` to match the
current normal resolution. Grant IDs do not create authority. Window destruction,
replacement generation, or a changed current binding rejects an old request.
Frontend tab/session lifecycle checks remain necessary before displaying results.

## Literal filesystem paths and allowed children

`relativePath` is a strict filesystem-relative path, **not a URL or Markdown
destination**. It uses `/` separators and is never percent-decoded. A caller
that accepts URL syntax must parse and decode it before this boundary; the host
does not repeat that decoding. For example, `images/%2e%2e/%2fsecret.png` names
literal percent-bearing components; it cannot become `../` or an absolute path
at any later host stage. URL schemes, fragments and query syntax receive no URL
interpretation. A `#` or `%` in a portable filename remains literal.

The first component must be exactly `images` or the native document's final
filename stem followed by `.assets`, with at least one following component.
`notes/report.md` therefore permits `notes/images/...` and
`notes/report.assets/...`. It does not permit `report.md.assets`, another
document's asset directory, a sibling document, or the parent directory itself.
Nested workspace documents use their own retained parent, not the workspace root.

All components pass the existing portable path policy: no absolute paths,
dot/parent segments, empty components, backslashes, alternate data stream
syntax, reserved device names, or trailing dots/spaces. Relative paths are
limited to 4,096 UTF-8 bytes and 50 components, including the asset-root component.

## I/O and limits

The document parent is derived from the existing retained grant. Directory walks
open one child at a time with nofollow and verify directory metadata. Document
and image leaves must be regular files; symlinks, Windows reparse points,
junctions and special objects are rejected. Leaves are opened read-only with
nofollow and nonblocking behavior and their opened metadata is checked again.

The fixed byte limit is 8 MiB. Metadata is checked before allocation, and reads
stop after at most 8 MiB plus one byte so concurrent growth cannot bypass the
limit. An oversize file is rejected, never returned as a successful prefix.
The result is original bytes with no MIME inference or content transformation.

No directory grant is returned or retained in the registry. There is no
enumeration, write, image import, export, arbitrary resource picker, or grant
persistence in this API. A grant anchors a parent and a name, not an immutable
document/image inode or a filesystem snapshot. Namespace replacement cannot
redirect traversal through a symlink, but a regular leaf replacement and file
changes during a read are not an identity or content transaction.

Failures use the existing typed `NativeCommandError` (`permission_required`,
`invalid_grant_kind`, `invalid_path`, `file_not_found`, `file_too_large`, or the
existing filesystem/platform error). There is no weaker fallback after failure.

## Verification scope

Core tests cover original bytes, native stems, nested document parents, READ and
purpose restrictions, portable paths, literal encoded traversal, exact byte
limits and concurrent growth, symlinks/special objects, retained parent
substitution on Unix, and junction rejection on Windows. Native state tests
cover current IDs, caller/generation isolation, exact/longest precedence,
Resource/Export rejection and regular-document validation in both commands.
Windows cross-compilation is not Windows runtime verification; actual native CI
remains required. This slice alone does not complete T04/T05 or image display
acceptance.
