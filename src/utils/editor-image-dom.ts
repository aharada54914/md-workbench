import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import type { Fragment, Node as ModelNode, ParseOptions, Schema, Slice } from '@tiptap/pm/model';

/**
 * Template contents belong to a document without a browsing context. Never
 * attach or adopt these nodes into the editor's active document. This is a DOM
 * conversion boundary, not HTML sanitization or protection from schema hooks.
 */
function inertTemplate(): HTMLTemplateElement {
  return document.createElement('template');
}

function parseRoot(html: string): DocumentFragment {
  const template = inertTemplate();
  template.innerHTML = html;
  // Match installed TipTap elementFromString's formatting-whitespace cleanup.
  // Keep this independent of the browser DOMParser used by that utility.
  const removeFormattingWhitespace = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && child.nodeValue && /^(\n\s\s|\n)$/.test(child.nodeValue)) {
        node.removeChild(child);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        removeFormattingWhitespace(child);
      }
    }
  };
  removeFormattingWhitespace(template.content);
  return template.content;
}

/** Use .toJSON() for initial content / setContent so TipTap does not reparse HTML. */
export function parseEditorHtml(html: string, schema: Schema, options?: ParseOptions): ModelNode {
  return DOMParser.fromSchema(schema).parse(parseRoot(html), options);
}

/** Preserves open slice depths for a later clipboard / insertion integration. */
export function parseEditorHtmlSlice(html: string, schema: Schema, options?: ParseOptions): Slice {
  return DOMParser.fromSchema(schema).parseSlice(parseRoot(html), options);
}

/** Same HTML-string representation as getHTML; no display URLs or model edits. */
export function serializeEditorFragment(fragment: Fragment, schema: Schema): string {
  const inertDocument = inertTemplate().content.ownerDocument;
  const container = inertDocument.createElement('div');
  DOMSerializer.fromSchema(schema).serializeFragment(fragment, { document: inertDocument }, container);
  return container.innerHTML;
}

export function serializeEditorHtml(doc: ModelNode): string {
  return serializeEditorFragment(doc.content, doc.type.schema);
}
