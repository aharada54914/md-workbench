import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { SafeHtmlBlockExtension } from '../../extensions/SafeHtmlBlockExtension';
import { serializeEditorHtml } from '../../utils/editor-image-dom';
import { encodeSafeHtmlSource } from '../../utils/safe-html';
const editors: Editor[] = [];
afterEach(() => { editors.forEach(editor => editor.destroy()); editors.length = 0; vi.restoreAllMocks(); });

describe('safe HTML image display boundary', () => {
  it('removes image source in the inert document before adoption and delegates literal src', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    const unsafe: string[] = [];
    vi.spyOn(Element.prototype, 'innerHTML', 'set').mockImplementation(function(this: Element, html: string) {
      if (this.ownerDocument === document && this.tagName !== 'TEMPLATE' && html.includes('<img')) unsafe.push(html);
      descriptor.set!.call(this, html);
    });
    const dispose = vi.fn();
    const attach = vi.fn((img: HTMLImageElement) => { expect(img.getAttribute('src')).toBeNull(); return { dispose }; });
    const raw = '<p><a href="https://example.test"><img src="images/a.png" alt="A" title="T" width="80"></a></p>';
    const editor = new Editor({ extensions: [StarterKit, SafeHtmlBlockExtension.configure({ provider: { attach } })], content: { type: 'doc', content: [{ type: 'safeHtmlBlock', attrs: { raw } }] } });
    editors.push(editor);
    expect(unsafe).toEqual([]);
    expect(attach).toHaveBeenCalledWith(expect.any(HTMLImageElement), 'images/a.png', expect.any(Function));
    const img = editor.view.dom.querySelector('img')!;
    expect(img.getAttribute('src')).toBeNull(); expect(img.alt).toBe('A'); expect(img.width).toBe(80);
    expect(editor.getJSON().content![0].attrs!.raw).toBe(raw);
    expect(serializeEditorHtml(editor.state.doc)).toContain(encodeSafeHtmlSource(raw));
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('shows unavailable status without a provider and never installs an authored src', () => {
    const editor = new Editor({ extensions: [StarterKit, SafeHtmlBlockExtension], content: { type: 'doc', content: [{ type: 'safeHtmlBlock', attrs: { raw: '<img src="images/a.png">' } }] } });
    editors.push(editor);
    expect(editor.view.dom.querySelector('img')!.getAttribute('src')).toBeNull();
    expect(editor.view.dom.querySelector('[role="status"]')!.textContent).toContain('unavailable');
  });
});
