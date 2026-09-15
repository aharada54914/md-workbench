# Marp image inlining

This T04 increment removes ambient filesystem reads from the Marp image-inlining
helper. It does not complete transactional Save, authorize export destinations,
or change authored Markdown. The [display boundary](MARP_DISPLAY_BOUNDARY.md)
separately prevents unavailable or unknown image syntax from fetching resources.

## Authority and source preservation

`inlineMarkdownImages` receives the current tab's image owner, document path and
authority revision. It replaces only the exact destination spans of recognized
direct Markdown images. BOM, newline spelling, alt text, titles, code and unknown
syntax retain their source spelling. Reference-style images are not resolved.

An exact source key in the current owner's imported-byte store can supply bytes,
including an imported absolute source. Another tab's bytes cannot supply them.
Otherwise only literal `images/...` and `<document-stem>.assets/...` references
can reach the native document-image reader. The helper obtains the document READ
grant and sends its expected ID on each image read. The descriptor lasts only for
that request. Absolute paths, dot traversal, URL schemes and other unsupported
references do not trigger native reads. Percent sequences are literal filenames;
the helper does not decode them or turn paths into authority.

Denied, revoked, missing or unsupported images retain their original source.
There is no plugin-fs, fetch, alternate-grant or path-normalization fallback.
The now-unused binary `fs:allow-read-file` capability is removed. The separate
text-read capability remains for existing Save verification and AI callers;
those paths still require the transactional filesystem-broker migration.
The shared format router accepts supported PNG, JPEG, GIF, WebP and SVG signatures;
this is not full image decoding or comprehensive content validation. BMP and ICO
are not supported by this route.

## Bounds

| Scope | Limit |
| --- | --- |
| One image read or owned-byte copy | 8 MiB |
| One output payload | 64 MiB |
| In-flight and displayed payloads in this renderer | 128 MiB |
| Recognized direct image occurrences per request | 128 |
| Outstanding image occurrences in this renderer | 256 |
| Concurrent requests in this renderer | 4 |
| Source key length | 4,096 UTF-16 code units |

Payload accounting uses UTF-16 string bytes and reserves another 8 MiB around
each native read or owned-byte lookup. Reads are sequential within a request.
Duplicate source keys share a read within that request, but every expanded
occurrence counts toward the output bound before base64 encoding. A request
that cannot reserve its initial payload, occurrence count or active slot returns
no output. An image that cannot fit leaves its destination unchanged.

These are engineering limits for this pipeline, not a total renderer heap,
native IPC JSON, transient encoding-copy or decoded-pixel bound. The separate
import/display stores have their own limits. Authored data URLs, reference-style
images and CSS are not covered by the native 8 MiB image-read promise; their
publication is governed by the display boundary.

## Lifetime

The composable clears the old display at the start of a request or context
change. It rejects late results after a newer request, source or tab change,
authority revision, owner disposal, leaving and returning to a context, or
unmount. An unresolved native read keeps its active slot until it settles.

Successful output carries an idempotent payload lease. The composable retires
that lease after Vue's next DOM update, and the preview replaces the iframe on
document changes so the old displayed document is removed before retirement.
An apply callback failure also clears and retires output. Callers of the helper
must likewise keep their lease until their rendered output is removed.

## Verification

- `image-resolver-markdown.test.ts`, `image-resolver-path.test.ts` and
  `image-resolver-lifecycle.test.ts`: exact spans, syntax preservation, platform
  document paths, grant IDs and no ambient fallback.
- `image-resolver-native.test.ts`: owned-byte isolation, denied reads, byte and
  occurrence limits, duplicate expansion, concurrent delayed reads, retained
  output leases and mutable-context invalidation.
- `useMarkdownImageInlining.test.ts`: latest-result and context lifecycle,
  disposal, authority refresh, callback failure and lease release.
- `marp-native-images.test.ts`: actual App live/presentation rendering through
  the grant-bound reader, no plugin-fs image read, and delayed old-document
  presentation results rejected after a tab switch.

Chromium verification does not establish native WebKit behavior or remove the
remaining filesystem broker and Save work.
