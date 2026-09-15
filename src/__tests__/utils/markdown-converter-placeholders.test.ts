import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { htmlToMarkdown, markdownToHtml } from '../../utils/markdown-converter';
import { canEditVisualSource, serializeVisualMarkdown } from '../../utils/visual-source';
import { mathNodeHtml } from '../../utils/math';
import { encodeSafeHtmlSource } from '../../utils/safe-html';
import { convertInlineToMarkdown } from '../../utils/html-to-markdown';
import { createSerializationContext } from '../../utils/serialization-placeholder';

const newBlockHtml = '<pre><code>NEW</code></pre>';
const newBlockMarkdown = '```\nNEW\n```';

describe('authored text cannot become a serialization placeholder', () => {
  it('preserves an accepted Visual source literal when a NEW code block is inserted', () => {
    const source = '`__PROTECTED_BLOCK_0__`';
    const editor = new Editor({ extensions: [StarterKit], content: markdownToHtml(source) });
    try {
      expect(canEditVisualSource(editor.getHTML(), source)).toBe(true);
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'codeBlock', content: [{ type: 'text', text: 'NEW' }],
      });
      expect(serializeVisualMarkdown(editor.getHTML(), source)).toBe(source + '\n\n' + newBlockMarkdown);
    } finally { editor.destroy(); }
  });

  it.each([
    ['plain', '__PROTECTED_BLOCK_0__'],
    ['entities', '&#95;&#95;PROTECTED_BLOCK_0&#95;&#95;'],
    ['split tags', '<span>__PROTECTED</span><span>_BLOCK_0__</span>'],
  ])('keeps %s user content next to a protected block', (_name, literal) => {
    expect(htmlToMarkdown(`<p>${literal}</p>${newBlockHtml}`))
      .toBe('__PROTECTED_BLOCK_0__\n\n' + newBlockMarkdown);
  });

  it('preserves a literal page-break marker while serializing a real page break', () => {
    expect(htmlToMarkdown('<p><code>__PAGE_BREAK_MARKER__</code></p><div class="page-break"></div>'))
      .toBe('`__PAGE_BREAK_MARKER__`\n\n<div style="page-break-after: always;"></div>');
  });

  it('does not recursively restore a block token written inside another block', () => {
    expect(htmlToMarkdown('<pre><code>__PROTECTED_BLOCK_1__</code></pre>' + newBlockHtml))
      .toBe('```\n__PROTECTED_BLOCK_1__\n```\n\n' + newBlockMarkdown);
  });

  it('keeps encoded safe HTML source, unknown literal syntax and exact math next to NEW', () => {
    const rawHtml = '<details><summary>__PROTECTED_BLOCK_0__</summary>opaque</details>';
    const math = '$`x_1^2`$';
    const html = `<div data-safe-html-block="${encodeSafeHtmlSource(rawHtml)}"></div>`
      + '<p>&lt;!-- unknown __PROTECTED_BLOCK_1__ --&gt;</p>'
      + `<p>${mathNodeHtml({ formula: 'x_1^2', source: math, display: false })}</p>` + newBlockHtml;
    expect(htmlToMarkdown(html)).toBe(rawHtml + '\n<!-- unknown __PROTECTED_BLOCK_1__ -->\n\n' + math + '\n\n' + newBlockMarkdown);
  });

  it.each([
    'MERMATH&#83;AVE0TOKEN',
    '<span>MERMATH</span><span>SAVE0TOKEN</span>',
  ])('keeps a math marker assembled during conversion: %s', literal => {
    const math = mathNodeHtml({ formula: 'x', source: '$x$', display: false });
    expect(htmlToMarkdown(`<p>${literal} ${math}</p>`)).toBe('MERMATHSAVE0TOKEN $x$');
  });
});


describe('inline code and delimiter boundaries', () => {
  it('preserves an accepted heading literal when another inline code span is inserted', () => {
    const source = '# `__INLINE_CODE_1__`';
    const editor = new Editor({ extensions: [StarterKit], content: markdownToHtml(source) });
    try {
      expect(canEditVisualSource(editor.getHTML(), source)).toBe(true);
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, [
        { type: 'text', text: ' ' },
        { type: 'text', text: 'NEW', marks: [{ type: 'code' }] },
      ]);
      expect(serializeVisualMarkdown(editor.getHTML(), source)).toBe(source + ' `NEW`');
    } finally { editor.destroy(); }
  });

  it('keeps literal replacement metacharacters in inline code', () => {
    expect(convertInlineToMarkdown("<code>$& $` $' $$</code>")).toBe("`$& $` $' $$`");
  });

  it('passes block identity through nested list conversion', () => {
    const html = '<ul><li><p>Outer</p><ul><li><p>__PROTECTED_BLOCK_0__</p>' + newBlockHtml + '</li></ul></li></ul>';
    expect(htmlToMarkdown(html)).toBe('- Outer\n  - __PROTECTED_BLOCK_0__\n    ```\n    NEW\n    ```');
  });

  it.each([
    ['literal', '\uE000BLOCK0TOKEN', '\uE000BLOCK0TOKEN'],
    ['entity', '&#xE000;BLOCK0TOKEN', '\uE000BLOCK0TOKEN'],
    ['split entity', '<span>&#xE</span><span>000;BLOCK0TOKEN</span>', '\uE000BLOCK0TOKEN'],
    ['nested entity', '&#38;#xE000;BLOCK0TOKEN', '&#xE000;BLOCK0TOKEN'],
  ])('preserves %s authored private-use characters', (_name, html, expected) => {
    expect(htmlToMarkdown('<p>' + html + '</p>' + newBlockHtml)).toBe(expected + '\n\n' + newBlockMarkdown);
  });

  it('inspects percent-encoded raw attributes before math substitution', () => {
    const raw = '<p>\uE000MATH0TOKEN</p>';
    const html = `<div data-safe-html-block="${encodeSafeHtmlSource(raw)}"></div>`
      + `<p>${mathNodeHtml({ formula: 'x', source: '$x$', display: false })}</p>`;
    expect(htmlToMarkdown(html)).toBe(raw + '\n$x$');
  });

  it('preserves a marker assembled by removing list label contents', () => {
    const html = '<ul><li>&#xE<label>removed</label>000;BLOCK0TOKEN</li></ul>' + newBlockHtml;
    expect(htmlToMarkdown(html)).toBe('- \uE000BLOCK0TOKEN\n\n' + newBlockMarkdown);
  });

  it.each(['\0MDWB0TOKEN', '&#0;MDWB0TOKEN', '&#x0;MDWB0TOKEN'])('preserves NUL token-like text %j in a list', literal => {
    expect(htmlToMarkdown('<ul><li>' + literal + '</li></ul>' + newBlockHtml))
      .toBe('- \0MDWB0TOKEN\n\n' + newBlockMarkdown);
  });

  it('does not reinterpret URI-decoded token-like text during combined math restoration', () => {
    const raw = '<p>\0MDWI0TOKEN</p>';
    const html = `<div data-safe-html-block="${encodeSafeHtmlSource(raw)}"></div>`
      + `<p>${mathNodeHtml({ formula: 'x', source: '$x$', display: false })}</p>`;
    expect(htmlToMarkdown(html)).toBe(raw + '\n$x$');
  });

  it('does not reinterpret token-like text in a decoded footnote', () => {
    const definitions = encodeURIComponent(JSON.stringify([{ label: '1', content: '\0MDWI0TOKEN' }]));
    const html = `<p>${mathNodeHtml({ formula: 'x', source: '$x$', display: false })}</p>`
      + `<section data-footnotes data-definitions="${definitions}"></section>`;
    expect(htmlToMarkdown(html)).toBe('$x$\n\n[^1]: \0MDWI0TOKEN');
  });

  it('restores rendered fallback footnote math before appending definitions', () => {
    const formula = mathNodeHtml({ formula: 'x', source: '$x$', display: false });
    const html = '<p>Body</p><section data-footnotes><li data-footnote-id="1"><p>'
      + formula + '</p></li></section>';
    expect(htmlToMarkdown(html)).toBe('Body\n\n[^1]: $x$');
  });

  it('keeps literal NUL and replacement syntax in standalone inline code', () => {
    expect(convertInlineToMarkdown('<code>\0MDWI0TOKEN $&</code> <code>NEW</code>'))
      .toBe('`\0MDWI0TOKEN $&` `NEW`');
  });

  it('supports every private-use candidate without interpreting authored text', () => {
    const all = Array.from({ length: 0xF8FF - 0xE000 + 1 }, (_, index) => String.fromCharCode(0xE000 + index)).join('');
    expect(htmlToMarkdown(`<p>${all}</p>${newBlockHtml}`)).toBe(all + '\n\n' + newBlockMarkdown);
  });

  it.each([
    '&' + 'amp;'.repeat(30_000) + '#xE000;',
    '%' + '25'.repeat(30_000) + 'EE%80%80',
  ])('bounds deeply nested encoding inspection', source => {
    const start = performance.now();
    const tokens = createSerializationContext();
    expect(tokens.decode(source).length).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});


it('retains inline-only line hardbreak whitespace', () => {
  const html = '<p>  <code>x</code><br>next</p>';
  expect(htmlToMarkdown(html)).toBe('  `x`  \nnext');
});

it('retains math-only line hardbreak whitespace', () => {
  const html = '<p>  ' + mathNodeHtml({ formula: 'x', source: '$x$', display: false }) + '<br>next</p>';
  expect(htmlToMarkdown(html)).toBe('  $x$  \nnext');
});


it.each(['&#0;', '&amp;', '&lt;'])('preserves literal entity %s in rendered fallback footnote math', formula => {
  const source = `$${formula}$`;
  const html = '<p>Body</p><section data-footnotes><li data-footnote-id="1"><p>'
    + mathNodeHtml({ formula, source, display: false }) + '</p></li></section>';
  expect(htmlToMarkdown(html)).toBe(`Body\n\n[^1]: ${source}`);
});

it('keeps entity-authored fallback footnote tokens separate from math payloads', () => {
  const math = mathNodeHtml({ formula: 'x', source: '$x$', display: false });
  const html = '<section data-footnotes><li data-footnote-id="1"><p>'
    + '&amp;#0;MDWI0TOKEN ' + math + '</p></li></section>';
  expect(htmlToMarkdown(html)).toBe('\n\n[^1]: \0MDWI0TOKEN $x$');
});
