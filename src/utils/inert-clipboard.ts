import type { Slice } from '@tiptap/pm/model';
import type { EditorProps, EditorView } from '@tiptap/pm/view';

export type ClipboardBlockedReason =
  | 'clipboard-unavailable' | 'clipboard-write-failed' | 'composing'
  | 'not-editable' | 'unsupported-paste' | 'unsupported-drop';

export interface InertClipboardOptions {
  /** Additional document/source ownership check; cannot override readonly. */
  canEdit?: (view: EditorView) => boolean;
  /** Only files the later handlePaste actually consumes may pass this guard. */
  hasHandledImageFile?: (data: DataTransfer) => boolean;
  onBlocked?: (reason: ClipboardBlockedReason) => void;
}

/**
 * Modern PM parses/serializes clipboard HTML in a createHTMLDocument document
 * without a browsing context. Keep that pipeline (including paste rules and
 * slice context), but never enter its live-DOM legacy clipboard fallbacks.
 * Schema/serializer hooks must themselves remain inert; this is not sanitizing.
 */
export function createInertClipboardHandlers(
  options: InertClipboardOptions = {},
): NonNullable<EditorProps['handleDOMEvents']> {
  const editable = (view: EditorView): boolean => view.editable && (options.canEdit?.(view) ?? true);
  function block(event: Event, reason: ClipboardBlockedReason): true {
    event.preventDefault();
    try { options.onBlocked?.(reason); }
    catch (error) { console.error('Clipboard notification failed', error); }
    return true;
  }
  function readableText(data: DataTransfer): boolean {
    return ['text/html', 'text/plain', 'Text', 'text/uri-list'].some(type => !!data.getData(type));
  }
  function copyOrCut(view: EditorView, event: ClipboardEvent, cut: boolean): true {
    // Returning true alone does not suppress the browser's native clipboard work.
    event.preventDefault();
    if (cut && !editable(view)) return block(event, 'not-editable');
    if (cut && view.composing) return block(event, 'composing');
    const state = view.state;
    if (state.selection.empty) return true;
    try {
      const data = event.clipboardData;
      if (!data) return block(event, 'clipboard-unavailable');
      const { dom, text } = view.serializeForClipboard(state.selection.content());
      // Only strings cross the boundary. Never attach `dom` to the live page.
      const html = dom.innerHTML;
      data.clearData();
      data.setData('text/html', html);
      data.setData('text/plain', text);
    } catch {
      return block(event, 'clipboard-write-failed');
    }
    // Clipboard/serializer hooks can be reentrant. A changed state must not cut
    // a different selection, even when the clipboard writes both succeeded.
    if (cut && !view.isDestroyed && view.state === state && editable(view)) {
      view.dispatch(state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
    }
    return true;
  }
  return {
    copy: (view, event) => copyOrCut(view, event, false),
    cut: (view, event) => copyOrCut(view, event, true),
    paste(view, event) {
      if (!editable(view)) return block(event, 'not-editable');
      if (view.composing) return block(event, 'composing');
      try {
        const data = event.clipboardData;
        if (!data) return block(event, 'clipboard-unavailable');
        if (readableText(data) || options.hasHandledImageFile?.(data)) return false;
      } catch { return block(event, 'clipboard-unavailable'); }
      return block(event, 'unsupported-paste');
    },
    dragstart(_view, event) {
      // PM uses the selected model slice and the inert serializer; its native
      // drag preview is the already-safe NodeView, not serialized image HTML.
      try { if (event.dataTransfer) return false; }
      catch { /* An inaccessible transfer must not enter browser fallback. */ }
      return block(event, 'clipboard-unavailable');
    },
    drop(view, event) {
      if (!editable(view)) return block(event, 'not-editable');
      try {
        const data = event.dataTransfer;
        if (data && (view.dragging || readableText(data))) return false;
      } catch { /* Keep malformed or file-only browser drops inert. */ }
      return block(event, 'unsupported-drop');
    },
  };
}

/** Last handlePaste branch, after application file/table handlers. An empty
 * result must be consumed so PM cannot fall back to live native capturePaste. */
export function consumeEmptyClipboardSlice(slice: Slice): boolean {
  return slice.size === 0;
}
