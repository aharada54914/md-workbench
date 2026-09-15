import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDirectoryFromFilePath, inlineMarkdownImages } from '../../utils/image-resolver';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile }));
beforeEach(() => {
  readFile.mockReset(); readFile.mockResolvedValue(new Uint8Array([1]));
});

const cases = [
  { name: 'POSIX directory', document: '/home/user/note.md', source: 'images/a.png', expected: '/home/user/images/a.png' },
  { name: 'POSIX root document', document: '/note.md', source: 'a.png', expected: '/a.png' },
  { name: 'POSIX root document nested image', document: '/note.md', source: 'images/a.png', expected: '/images/a.png' },
  { name: 'POSIX single-letter directory', document: '/a/note.md', source: 'b.png', expected: '/a/b.png' },
  { name: 'POSIX dot segments', document: '/docs/sub/note.md', source: '.././images/a.png', expected: '/docs/images/a.png' },
  { name: 'POSIX parent past root', document: '/docs/note.md', source: '../../../a.png', expected: '/a.png' },
  { name: 'Windows drive', document: 'C:\\docs\\note.md', source: 'images\\a.png', expected: 'C:/docs/images/a.png' },
  { name: 'Windows drive root', document: 'C:\\note.md', source: 'a.png', expected: 'C:/a.png' },
  { name: 'Windows parent past drive root', document: 'C:\\docs\\note.md', source: '../../../a.png', expected: 'C:/a.png' },
  { name: 'UNC directory', document: '\\\\server\\share\\docs\\note.md', source: '../images/a.png', expected: '//server/share/images/a.png' },
  { name: 'UNC parent past share root', document: '//server/share/docs/note.md', source: '../../../a.png', expected: '//server/share/a.png' },
  { name: 'absolute POSIX source', document: '/docs/note.md', source: '/images/a.png', expected: '/images/a.png' },
  { name: 'absolute drive source', document: '/docs/note.md', source: 'D:\\images\\a.png', expected: 'D:\\images\\a.png' },
];

describe('Marp image path resolution', () => {
  it.each(cases)('$name', async ({ document: documentPath, source, expected }) => {
    const baseDir = getDirectoryFromFilePath(documentPath);
    await inlineMarkdownImages(`![image](${source})`, baseDir);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(expected);
  });
});

it.each(['file:///images/a.png', '\\\\server\\share\\a.png'])('does not introduce new absolute path reads for %s in an unsaved document', async source => {
  const markdown = `![image](${source})`;
  expect(await inlineMarkdownImages(markdown)).toBe(markdown);
  expect(readFile).not.toHaveBeenCalled();
});
