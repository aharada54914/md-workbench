import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { markdownToHtml } from '../../utils/markdown-converter';
import { canEditVisualSource, serializeVisualMarkdown } from '../../utils/visual-source';
import { sourcePreservationExtension } from '../../extensions/SourcePreservationExtension';

describe('Visual source preservation', () => {
  it.each(['\n', '\r\n', '\r'])('keeps BOM, blank lines and trailing whitespace with %j', newline => {
    const source = '\uFEFF' + newline + '日本語の本文  ' + newline + '\t';
    const html = '<p>日本語の本文</p>';
    expect(serializeVisualMarkdown(html, source)).toBe(source);
    expect(serializeVisualMarkdown(html.replace('本文', '追記😀'), source))
      .toBe(source.replace('本文', '追記😀'));
  });

  it.each([
    '````unknown extra-info\nx\n````',
    '# One\r\n\r\nTwo\n\nThree',
    '# One\n\n\nTwo',
  ])('rejects non-reproducible source after actual schema parsing: %j', source => {
    const editor = new Editor({ extensions: [StarterKit], content: markdownToHtml(source) });
    expect(canEditVisualSource(editor.getHTML(), source), editor.getHTML()).toBe(false);
    editor.destroy();
  });

  it.each(['<!-- opaque -->\n\nText', '[text][ref]\n\n[ref]: https://example.com'])(
    'preserves syntax carried intact as literal text: %j', source => {
      const editor = new Editor({ extensions: [StarterKit], content: markdownToHtml(source) });
      expect(serializeVisualMarkdown(editor.getHTML(), source)).toBe(source);
      editor.destroy();
    },
  );

  it('rejects changes from programmatic commands as well as input', () => {
    let allowed = false;
    const editor = new Editor({
      extensions: [StarterKit, sourcePreservationExtension(() => allowed)],
      content: '<p>Original</p>',
    });
    editor.commands.insertContent('Rejected');
    expect(editor.getText()).toBe('Original');
    editor.commands.setContent('<p>Also rejected</p>');
    expect(editor.getText()).toBe('Original');
    allowed = true;
    editor.commands.insertContent('Allowed ');
    expect(editor.getText()).toContain('Allowed');
    editor.destroy();
  });

  it('does not duplicate an all-whitespace document envelope', () => {
    const source = '\uFEFF\r\n\t\r\n';
    expect(serializeVisualMarkdown('<p></p>', source)).toBe(source);
  });
});
