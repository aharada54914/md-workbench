# Initial document reading lifecycle

Implementation scope: T04 initial reading and editor activation, 2026-09-15.

## Opening and activation

A file opened from a dialog, URL, native queue, workspace, or restored session
starts with its exact Markdown in `pendingMarkdown` and `originalMarkdown`.
Its HTML cache is empty, `editorMode` is null, and `readOnly` is true. File loading
does not convert Markdown to an editor representation.

The application waits for initial URL/native/session opening to settle before
mounting document content. A failed initial open releases this gate so the
remaining application and its event listeners remain usable. New unsaved tabs
start in Visual editing after this gate.

Each tab owns its editing mode and reading state:

- **Edit** activates Visual editing. Large documents use the existing bounded
  lazy editor; ordinary documents create their HTML cache on this explicit action.
- **Code** activates Source directly, without mounting Tiptap.
- **Code + Preview** activates Source with the existing document preview.
- **Isolated read-only preview** hides an already activated editor and disables
  document mutations. **Return to editor** resumes the same mounted instance,
  including its Undo history.

Switching tabs restores the target tab's own mode. Editor instances are keyed by
its tab ID, preventing Undo from applying another document's history. History is
retained during a same-tab reading toggle; tab changes may discard that tab's
editor history. Two document panes independently activate Visual editing; a
pane whose document has never been activated contains only the isolated preview.
The existing Source and Code + Preview layouts occupy the active document area.

## Reading boundary

An initially unread document mounts no Tiptap, CodeMirror, AI panel, diagram
editor, or editor image resolver. Its display is an iframe with an empty sandbox
attribute and a restrictive CSP. The inert renderer sanitizes Markdown output,
disables navigation, and does not fetch document assets. AI temporary recovery
reads begin only when editing is enabled; stale asynchronous results are ignored
when the active tab or its reading state changes.

Documents over 1,000,000 UTF-16 code units display escaped source in pages of
65,536 code units rather than converting or mounting the whole document. Page
boundaries preserve surrogate pairs. HTML display normalizes newlines visually;
the authoritative source remains unchanged. Paging never modifies saved bytes.

Save and Save As use authoritative source while reading. Original BOM, newline
separators, trailing whitespace, and unknown syntax survive unchanged. Activated
Visual editing retains the existing source-preservation guard: documents that
cannot be represented exactly direct edits to Source.

## Verification

`tests/e2e/readonly-lifecycle.test.ts` observes document engine mounts from startup,
checks that opening an image/Mermaid document reads only that document, verifies
exact Save As bytes, Source-only activation, tab and pane independence, bounded
large-file reading, and CRLF clipboard paste plus same-tab reading/Undo.

The existing Source, native-open, close, large-file, math, and Visual suites use
explicit activation where they exercise editing. CodeEditor component tests
cover source arrival between setup and mount, CRLF full replacement, and
rejection of programmatic edits while reading. Source tab-switch regression
verifies that another tab's Undo history cannot replace the current document.

Local integration validation on 2026-09-16: 1,411 Vitest tests passed, 85 Chromium
tests passed (one existing release-only skip), and type checking/production build
passed. Windows UI Automation now explicitly activates Edit before exercising
Visual/reading/Source transitions. The native CDP observer searches the isolated
frame as well as the upstream main document, verifies its actual embedding is
unobscured, and reads platform fonts through the native DOM inspection protocol.
Local Chromium checks passed for both document contexts and rejected an offscreen
iframe. These observer checks do not substitute for Windows glyph or IME results;
Windows packaged validation remains a PR CI requirement.

This lifecycle does not isolate code into a separate application process or add
filesystem authority. Native capability enforcement is tracked separately under
T05. Explicitly activated editors may load their existing editing resources;
returning to reading keeps those instances alive for same-document Undo.
