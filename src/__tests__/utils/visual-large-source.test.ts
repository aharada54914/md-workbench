import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { htmlToMarkdown, markdownToHtml } from '../../utils/markdown-converter';
import { serializeVisualMarkdown } from '../../utils/visual-source';

const source = [
  '# Section header', '',
  'A paragraph with **bold**, *italic*, `code` and a [link](https://example.com).', '',
  '- list item one', '  continuation line under the item',
  '- list item two', '  more continuation', '',
  '```js', 'const x = 1;', '```', '', '',
].join('\n');

describe('known Markdown Visual preservation', () => {
  it.each([1, 2, 3, 4, 5, 6])('separates h%i from the following paragraph', level => {
    expect(htmlToMarkdown(`<h${level}>Heading</h${level}><p>Body</p>`)).toBe(`${'#'.repeat(level)} Heading\n\nBody`);
  });

  it.each(['', ' class="language-js"'])('does not append a blank code line for %j', attributes => {
    expect(htmlToMarkdown(`<pre><code${attributes}>code\n</code></pre>`)).toBe('```' + (attributes ? 'js' : '') + '\ncode\n```');
  });

  it('keeps list paragraph boundaries and continuation indentation', () => {
    expect(htmlToMarkdown('<ul><li><p>First</p><p>Second</p></li></ul>')).toBe('- First\n  Second');
  });

  it('keeps known headings, inline marks, list continuations and fences after actual schema parsing', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: markdownToHtml(source.repeat(100)),
    });
    expect(serializeVisualMarkdown(editor.getHTML(), source.repeat(100))).toBe(source.repeat(100));
    editor.destroy();
  });
});
