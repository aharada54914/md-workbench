import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { SafeImage } from '../../extensions/SafeImage';
import type { DocumentImageDisplay } from '../../services/documentImageDisplay';

const editors: Editor[] = [];
afterEach(() => { editors.forEach(editor => editor.destroy()); editors.length = 0; });
function setup() {
  const release = vi.fn();
  const provider: DocumentImageDisplay = {
    attach: vi.fn((image, source, onStatus) => {
      expect(image.hasAttribute('src')).toBe(false);
      expect(image.hasAttribute('srcset')).toBe(false);
      expect(source).toBeTruthy();
      onStatus?.('unavailable');
      return { dispose: release };
    }), refresh: vi.fn(), dispose: vi.fn(),
  };
  const editor = new Editor({ extensions: [StarterKit, SafeImage.configure({ provider })], content: {
    type: 'doc', content: [{ type: 'image', attrs: { src: 'file:///private/image.png', alt: 'Authored alt', title: 'Title', 'data-original-src': 'images/original.png' } }],
  } });
  editors.push(editor);
  return { editor, provider, release };
}
describe('SafeImage actual TipTap NodeView', () => {
  it('keeps original attributes in the model and unavailable DOM carries no raw source', () => {
    const { editor, provider } = setup();
    const image = editor.view.dom.querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    expect(image.hasAttribute('data-original-src')).toBe(false);
    expect(image.alt).toBe('Authored alt (Image unavailable)');
    expect(provider.attach).toHaveBeenCalledTimes(1);
    expect(editor.getJSON().content![0]!.attrs).toMatchObject({ src: 'file:///private/image.png', alt: 'Authored alt', title: 'Title', 'data-original-src': 'images/original.png' });
  });
  it('releases previous binding on source update and on destroy without changing authored attrs', () => {
    const { editor, provider, release } = setup();
    editor.commands.command(({ tr }) => { tr.setNodeMarkup(0, undefined, { ...tr.doc.nodeAt(0)!.attrs, src: 'images/new.png' }); return true; });
    expect(release).toHaveBeenCalledTimes(1); expect(provider.attach).toHaveBeenCalledTimes(2);
    expect(editor.getJSON().content![0]!.attrs!.src).toBe('images/new.png');
    editor.destroy(); expect(release).toHaveBeenCalledTimes(2);
  });
});
