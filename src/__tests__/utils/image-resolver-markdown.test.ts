import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inlineMarkdownImages } from '../../utils/image-resolver';
import { documentImageBytes } from '../../services/documentImageBytes';

const { readFile, resolve } = vi.hoisted(() => ({ readFile: vi.fn(), resolve: vi.fn() }));
vi.mock('../../services/nativeFs', () => ({ nativeFs: { readDocumentImageBytes: readFile, resolveDocumentReadGrant: resolve } }));
const owner = () => documentImageBytes.createOwner();
async function render(markdown: string) {
  const result = await inlineMarkdownImages(markdown, { owner: owner(), path: '/docs/note.md', revision: 0 });
  result?.release(); return result?.markdown;
}
afterEach(() => documentImageBytes.disposeAll());
const image = '![sample](images/a.png)';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const uri = 'data:image/png;base64,iVBORw0KGgo=';
beforeEach(() => { readFile.mockReset(); readFile.mockResolvedValue(png); resolve.mockResolvedValue({ grantId: 'current' }); });

describe('literal image syntax never triggers reads or replacements', () => {
  it.each([
    ['backtick fence', `\`\`\`markdown\n${image}\n\`\`\``],
    ['tilde fence', `~~~markdown\n${image}\n~~~`],
    ['unclosed fence', `\`\`\`markdown\n${image}\n`],
    ['longer fence', `\`\`\`\`\n\`\`\`\n${image}\n\`\`\`\n\`\`\`\``],
    ['indented code', `    ${image}\n`],
    ['tab-indented code', `\t${image}\n`],
    ['quoted fence', `> ~~~\n> ${image}\n> ~~~`],
    ['list fence', `- example\n\n  ~~~\n  ${image}\n  ~~~`],
    ['inline code', `before \`${image}\` after`],
    ['multi-backtick span', `before \`\` one \` ${image} \`\` after`],
    ['multiline code span', `before \`line\n${image}\nend\` after`],
    ['escaped image', `\\${image}`],
    ['HTML comment', `<!-- ${image} -->`],
    ['HTML block', `<pre>\n${image}\n</pre>`],
    ['reference definition title', `[id]: images/other.png '${image}'`],
    ['reference-only image', '![sample][asset]\n\n[asset]: images/a.png'],
  ])('%s', async (_name, markdown) => {
    expect(await render(markdown)).toBe(markdown);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('only replaces the actual occurrence when code and an image share a destination', async () => {
    const markdown = `\uFEFF# 文書\r\n\r\n\`${image}\`\r\n\r\n${image}\r\n\r\n~~~\r\n${image}\r\n~~~\r\n`;
    const expected = markdown.replace(`\r\n\r\n${image}\r\n`, `\r\n\r\n![sample](${uri})\r\n`);
    expect(await render(markdown)).toBe(expected);
    expect(readFile).toHaveBeenCalledExactlyOnceWith('/docs/note.md', 'current', 'images/a.png');
  });
});

describe('existing image destination behavior and surrounding source', () => {
  it.each([
    '![sample](images/a.png "A title")',
    '![*formatted* alt](images/a.png)',
    '![escaped \\* text](images/a.png)',
    '![sample](  images/a.png   "A title"  )',
    '[![sample](images/a.png)](https://example.com)',
    '> ![sample](images/a.png)',
    '- ![sample](images/a.png)',
    '`unmatched backtick ![sample](images/a.png)',
    '\\\\![sample](images/a.png)',
  ])('changes only the destination span: %s', async markdown => {
    expect(await render(markdown)).toBe(markdown.replace('images/a.png', uri));
    expect(readFile).toHaveBeenCalledExactlyOnceWith('/docs/note.md', 'current', 'images/a.png');
  });

  it('keeps reference images and definitions unchanged while inlining direct images', async () => {
    const markdown = `![ref][asset]\n![asset][]\n![asset]\n\n[asset]: images/a.png "Reference"\n\n${image}`;
    expect(await render(markdown)).toBe(markdown.replace(image, `![sample](${uri})`));
    expect(readFile).toHaveBeenCalledExactlyOnceWith('/docs/note.md', 'current', 'images/a.png');
  });

  it.each([
    '![escaped \\] bracket](images/a.png)',
    '![sample](images/a(b).png)',
    '![sample](images/a\\(b\\).png)',
  ])('leaves destinations outside the existing supported syntax untouched: %s', async markdown => {
    expect(await render(markdown)).toBe(markdown);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('retains existing JPEG and SVG image handling', async () => {
    readFile.mockResolvedValueOnce(new Uint8Array([255, 216, 255])).mockResolvedValueOnce(new TextEncoder().encode('<svg></svg>'));
    const markdown = '![photo](images/a.jpg) ![vector](images/a.svg)';
    expect(await render(markdown)).toBe('![photo](data:image/jpeg;base64,/9j/) ![vector](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
    expect(readFile.mock.calls.map(([, , path]) => path)).toEqual(['images/a.jpg', 'images/a.svg']);
  });

  it('preserves escaped image text beside a real occurrence with the same destination', async () => {
    const markdown = `\\${image}\n\n${image}`;
    expect(await render(markdown)).toBe(`\\${image}\n\n![sample](${uri})`);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('keeps all source unchanged if a real image read fails', async () => {
    readFile.mockRejectedValue(new Error('not found'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const markdown = `before  ${image}  after\r\n\`${image}\``;
    expect(await render(markdown)).toBe(markdown);
    expect(readFile).toHaveBeenCalledExactlyOnceWith('/docs/note.md', 'current', 'images/a.png');
    warn.mockRestore();
  });
});
