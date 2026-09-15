import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorProps } from '@tiptap/pm/view';
import { createInertClipboardHandlers, consumeEmptyClipboardSlice } from '../../utils/inert-clipboard';
import type { InertClipboardOptions } from '../../utils/inert-clipboard';

const editors: Editor[] = [];
const SafeImage = Image.extend({ addNodeView() { return () => ({ dom: document.createElement('span') }); } });
function makeEditor(props: EditorProps = {}, options: InertClipboardOptions = {}) {
  const editor = new Editor({
    extensions: [StarterKit, SafeImage],
    editorProps: {
      handleDOMEvents: createInertClipboardHandlers(options),
      handlePaste: (_view, _event, slice) => consumeEmptyClipboardSlice(slice),
      ...props,
    },
    content: { type: 'doc', content: [
      { type: 'image', attrs: { src: 'images/authored.png' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'tail' }] },
    ] },
  });
  document.body.appendChild(editor.view.dom);
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
  editors.push(editor);
  return editor;
}
function transfer(initial: Record<string, string> = {}) {
  const contents = new Map(Object.entries(initial));
  const data = {
    getData: vi.fn((type: string) => contents.get(type) ?? ''),
    clearData: vi.fn(() => contents.clear()),
    setData: vi.fn((type: string, value: string) => { contents.set(type, value); }),
    types: Object.keys(initial),
    files: [],
    items: [],
  };
  return { data: data as unknown as DataTransfer, contents, setData: data.setData };
}
function dragEvent(type: string, data: DataTransfer | null = null): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: data });
  return event as DragEvent;
}
function clipboardEvent(type: string, data: DataTransfer | null = null): ClipboardEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  return event as ClipboardEvent;
}
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('inert clipboard fallback boundaries with actual ProseMirror', () => {
  it('prevents missing-data copy instead of adopting authored images into the live document', () => {
    const editor = makeEditor();
    const event = clipboardEvent('copy');
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('img[src]')).toBeNull();
  });
  it('does not delete a selection when cut cannot write clipboard data', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    editor.view.dom.dispatchEvent(clipboardEvent('cut'));
    expect(editor.getJSON()).toEqual(before);
  });
  it('prevents native paste during composition before the late paste handler', () => {
    const editor = makeEditor();
    editor.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(editor.view.composing).toBe(true);
    const event = clipboardEvent('paste');
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it('copies authored src and PM slice metadata without a live image, preserving copied hooks', () => {
    const transformCopied = vi.fn(slice => slice);
    const editor = makeEditor({ transformCopied, clipboardTextSerializer: () => 'custom text' });
    const { data, contents } = transfer();
    const before = editor.getJSON();
    const event = clipboardEvent('copy', data);
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(contents.get('text/html')).toContain('src="images/authored.png"');
    expect(contents.get('text/html')).toContain('data-pm-slice="0 0 []"');
    expect(contents.get('text/plain')).toBe('custom text');
    expect(transformCopied).toHaveBeenCalledOnce();
    expect(editor.getJSON()).toEqual(before);
    expect(document.querySelector('img[src]')).toBeNull();
  });
  it('cuts only after successful writes and keeps Undo available', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    const { data, contents } = transfer();
    editor.view.dom.dispatchEvent(clipboardEvent('cut', data));
    expect(contents.get('text/html')).toContain('images/authored.png');
    expect(editor.getJSON().content?.map(node => node.type)).toEqual(['paragraph']);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });
  it('retains the model when the second clipboard format write fails', () => {
    const onBlocked = vi.fn();
    const editor = makeEditor({}, { onBlocked });
    const before = editor.getJSON();
    const { data, setData } = transfer();
    setData.mockImplementation(type => { if (type === 'text/plain') throw new Error('denied'); });
    editor.view.dom.dispatchEvent(clipboardEvent('cut', data));
    expect(editor.getJSON()).toEqual(before);
    expect(onBlocked).toHaveBeenCalledWith('clipboard-write-failed');
    expect(document.querySelector('img[src]')).toBeNull();
  });
  it('retains the model after a serializer error', () => {
    const editor = makeEditor({ transformCopied: () => { throw new Error('bad serializer'); } });
    const before = editor.getJSON();
    const event = clipboardEvent('cut', transfer().data);
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });
  it('does not cut a changed selection after a reentrant clipboard write', () => {
    const editor = makeEditor();
    const { data, setData } = transfer();
    setData.mockImplementation(() => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)));
    });
    editor.view.dom.dispatchEvent(clipboardEvent('cut', data));
    expect(editor.getJSON().content?.[0].type).toBe('image');
    expect(editor.state.selection.empty).toBe(true);
  });
  it('permits copy but consumes cut and paste in readonly state', () => {
    const editor = makeEditor();
    editor.setEditable(false);
    const before = editor.getJSON();
    const { data, contents } = transfer();
    editor.view.dom.dispatchEvent(clipboardEvent('copy', data));
    expect(contents.get('text/html')).toContain('images/authored.png');
    for (const kind of ['cut', 'paste']) {
      const event = clipboardEvent(kind, data);
      editor.view.dom.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(editor.getJSON()).toEqual(before);
  });
  it('preserves normal rich paste hooks, marks and authored image attrs', () => {
    const observer = vi.fn(() => false);
    const transform = vi.fn((html: string) => html.replace('before', 'after'));
    const editor = makeEditor({ transformPastedHTML: transform });
    editor.registerPlugin(new Plugin({ props: { handleDOMEvents: { paste: observer } } }));
    const event = clipboardEvent('paste', transfer({
      'text/html': '<p><strong>before</strong></p><img src="../raw.png">',
    }).data);
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(observer).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledOnce();
    const json = editor.getJSON();
    expect(JSON.stringify(json)).toContain('"type":"bold"');
    expect(JSON.stringify(json)).toContain('after');
    expect(JSON.stringify(json)).toContain('../raw.png');
    expect(document.querySelector('img[src]')).toBeNull();
  });
  it('consumes a nonempty HTML input parsed into an empty slice without legacy capturePaste', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    const event = clipboardEvent('paste', transfer({ 'text/html': '<meta name="nothing">' }).data);
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
  });
  it('lets an explicitly handled image file reach the later file handler with an empty slice', () => {
    const handler = vi.fn(() => true);
    const editor = makeEditor({ handlePaste: handler }, { hasHandledImageFile: () => true });
    const event = clipboardEvent('paste', transfer().data);
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]).toBeDefined();
  });
  it.each(['empty', 'unsupported', 'inaccessible'])('blocks %s clipboard data before late paste handling', kind => {
    const handler = vi.fn(() => false);
    const editor = makeEditor({ handlePaste: handler });
    const data = transfer(kind === 'unsupported' ? { 'application/octet-stream': 'raw' } : {}).data;
    if (kind === 'inaccessible') vi.spyOn(data, 'getData').mockImplementation(() => { throw new Error('denied'); });
    const event = clipboardEvent('paste', data);
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
  it('does not edit when the additional document guard rejects ownership', () => {
    const editor = makeEditor({}, { canEdit: () => false });
    const before = editor.getJSON();
    for (const kind of ['cut', 'paste']) {
      const event = clipboardEvent(kind, transfer({ 'text/plain': 'replace' }).data);
      editor.view.dom.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(editor.getJSON()).toEqual(before);
  });
  it('preserves normal drag serialization and blocks a missing transfer', () => {
    const editor = makeEditor();
    // jsdom has no layout/elementFromPoint; target the selected model image.
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 0, inside: 0 });
    const { data, contents } = transfer();
    const event = dragEvent('dragstart', data);
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(contents.get('text/html')).toContain('images/authored.png');
    expect(editor.view.dragging).not.toBeNull();
    expect(document.querySelector('img[src]')).toBeNull();
    const missing = dragEvent('dragstart');
    editor.view.dom.dispatchEvent(missing);
    expect(missing.defaultPrevented).toBe(true);
  });
  it('blocks unsupported browser drops before plugin handlers or navigation', () => {
    const handler = vi.fn(() => false);
    const editor = makeEditor({ handleDrop: handler });
    const before = editor.getJSON();
    for (const data of [null, transfer({ 'application/octet-stream': 'raw' }).data]) {
      const event = dragEvent('drop', data);
      editor.view.dom.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(before);
  });
});
