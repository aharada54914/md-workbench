import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { DOMParser as ModelParser } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { htmlToMarkdown } from '../../utils/markdown-converter';
import { parseEditorHtml, parseEditorHtmlSlice, serializeEditorHtml, serializeEditorFragment } from '../../utils/editor-image-dom';

const AuthoredImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-original-src': {
        default: null,
        parseHTML: element => element.getAttribute('data-original-src'),
        renderHTML: attrs => attrs['data-original-src'] ? { 'data-original-src': attrs['data-original-src'] } : {},
      },
    };
  },
});
const extensions = [StarterKit, AuthoredImage, Table, TableRow, TableCell, TableHeader];
const schema = getSchema(extensions);
const editors: Editor[] = [];
function editorWith(html: string): Editor {
  const editor = new Editor({
    extensions,
    content: html,
    onBeforeCreate({ editor }) {
      if (typeof editor.options.content === 'string') {
        editor.options.content = parseEditorHtml(editor.options.content, editor.schema).toJSON();
      }
    },
  });
  editors.push(editor);
  return editor;
}
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); vi.restoreAllMocks(); });

describe('inert editor HTML conversion with actual TipTap schemas', () => {
  it.each([
    'images/a%20b.png', '/private/a.png', 'C:\\images\\a.png',
    'file:///private/a.png', 'https://example.invalid/a.png',
  ])('retains authored image attributes through initial JSON and serialization: %s', src => {
    const editor = editorWith(`<p>before</p><img src="${src}" alt="A &amp; B" title="Title" data-original-src="${src}"><p>after</p>`);
    const json = editor.getJSON();
    expect(json.content?.[1]).toMatchObject({ type: 'image', attrs: { src, alt: 'A & B', title: 'Title', 'data-original-src': src } });
    const result = serializeEditorHtml(editor.state.doc);
    expect(result).toBe(editor.getHTML());
    expect(parseEditorHtml(result, schema).toJSON()).toEqual(json);
    expect(result).not.toContain('blob:');
    expect(htmlToMarkdown(result)).toBe(htmlToMarkdown(editor.getHTML()));
  });

  it('passes only an inert owner fragment to the ProseMirror parser without browser DOMParser', () => {
    const browserParser = vi.spyOn(window.DOMParser.prototype, 'parseFromString');
    const parser = ModelParser.fromSchema(schema);
    const parse = vi.spyOn(parser, 'parse');
    const create = vi.spyOn(document, 'createElement');
    const result = parseEditorHtml('<img src="images/a.png" srcset="https://example.invalid/a 2x">', schema);
    const fragment = parse.mock.calls[0][0];
    expect(fragment.nodeType).toBe(Node.DOCUMENT_FRAGMENT_NODE);
    expect(fragment.ownerDocument).not.toBe(document);
    expect(fragment.ownerDocument?.defaultView).toBeNull();
    expect(fragment.isConnected).toBe(false);
    expect(browserParser).not.toHaveBeenCalled();
    expect(create.mock.calls.map(call => call[0])).toEqual(['template']);
    expect(result.firstChild?.attrs.src).toBe('images/a.png');
    expect(result.firstChild?.attrs.srcset).toBeUndefined();
  });

  it('creates image serialization DOM only in the template owner document', () => {
    const doc = parseEditorHtml('<img src="images/a.png" alt="image">', schema);
    const create = vi.spyOn(Document.prototype, 'createElement');
    expect(serializeEditorHtml(doc)).toContain('src="images/a.png"');
    const imageCalls = create.mock.calls.flatMap((call, index) => call[0] === 'img' ? [index] : []);
    expect(imageCalls).toHaveLength(1);
    for (const index of imageCalls) {
      const owner = create.mock.contexts[index] as Document;
      expect(owner).not.toBe(document);
      expect(owner.defaultView).toBeNull();
    }
  });

  it('preserves rich schema content, whitespace and getHTML semantics', () => {
    const html = '<h2>Title</h2>\n<p><strong>Bold</strong> <em>italic</em><br>line</p>\n<blockquote><p>quote</p></blockquote><ul><li><p>item</p></li></ul><pre><code>  a\n b</code></pre><table><tbody><tr><th>Head</th><td>Cell</td></tr></tbody></table>';
    const legacy = new Editor({ extensions, content: html });
    editors.push(legacy);
    const current = editorWith(html);
    expect(current.getJSON()).toEqual(legacy.getJSON());
    expect(serializeEditorHtml(current.state.doc)).toBe(legacy.getHTML());
  });

  it('preserves installed TipTap formatting-whitespace cleanup and parse options', () => {
    const html = '<p>a\n  <strong>b</strong>\nc\n d</p><pre><code>x\n  y</code></pre>';
    const legacy = new Editor({ extensions, content: html, parseOptions: { preserveWhitespace: 'full' } });
    editors.push(legacy);
    expect(parseEditorHtml(html, schema, { preserveWhitespace: 'full' }).toJSON()).toEqual(legacy.getJSON());
    expect(parseEditorHtml('', schema).toJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('supports later JSON setContent and Undo/Redo without rewriting sources', () => {
    const editor = editorWith('<p>first</p>');
    editor.commands.setContent(parseEditorHtml('<p>second</p><img src="images/later.png">', editor.schema).toJSON());
    const expected = editor.getJSON();
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.insertContentAt(1, 'changed ');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(expected);
    expect(editor.commands.redo()).toBe(true);
    expect(serializeEditorHtml(editor.state.doc)).toContain('src="images/later.png"');
  });

  it('returns a genuine open Slice for later clipboard and insertion integration', () => {
    const editor = editorWith('<p>before</p>');
    const slice = parseEditorHtmlSlice('<p><strong>selected</strong></p><img src="images/copied.png">', editor.schema);
    expect(slice.openStart).toBe(1);
    expect(slice.openEnd).toBe(0);
    expect(slice.content.lastChild?.attrs.src).toBe('images/copied.png');
    expect(serializeEditorFragment(slice.content, schema)).toBe('<p><strong>selected</strong></p><img src="images/copied.png">');
    editor.view.dispatch(editor.state.tr.replaceSelection(slice));
    expect(serializeEditorHtml(editor.state.doc)).toContain('src="images/copied.png"');
  });
});
