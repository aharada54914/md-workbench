import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inlineMarkdownImages } from '../../utils/image-resolver';
import { documentImageBytes } from '../../services/documentImageBytes';
const { read, resolve, ambient } = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), ambient: vi.fn() }));
vi.mock('../../services/nativeFs', () => ({ nativeFs: { readDocumentImageBytes: read, resolveDocumentReadGrant: resolve } }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: ambient }));
beforeEach(() => {
  vi.clearAllMocks(); read.mockResolvedValue(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  resolve.mockResolvedValue({ grantId: 'selected' });
});
afterEach(() => documentImageBytes.disposeAll());
async function render(path: string | null, source: string) {
  const result = await inlineMarkdownImages(`![image](${source})`, { owner: documentImageBytes.createOwner(), path, revision: 0 });
  result?.release(); return result?.markdown;
}
it.each(['/home/user/note.md', '/note.md', 'C:\\docs\\note.md', 'C:\\note.md', '\\\\server\\share\\note.md', '//server/share/note.md'])(
  'passes the original document identity and literal relative path: %s', async path => {
    expect(await render(path, 'images/a.png')).toContain('data:image/png;');
    expect(resolve).toHaveBeenCalledExactlyOnceWith(path);
    expect(read).toHaveBeenCalledExactlyOnceWith(path, 'selected', 'images/a.png');
    expect(ambient).not.toHaveBeenCalled();
  });
it('accepts only the current document asset directory', async () => {
  expect(await render('/docs/my.note.md', 'my.note.assets/a.png')).toContain('data:');
  expect(read).toHaveBeenCalledExactlyOnceWith('/docs/my.note.md', 'selected', 'my.note.assets/a.png');
});
it.each(['../images/a.png', 'images/../a.png', './images/a.png', 'images//a.png', '../../../a.png', '/images/a.png',
  'D:\\images\\a.png', 'D:/images/a.png', '\\\\server\\share\\a.png', '//server/share/a.png', 'file:///images/a.png',
  'https://example.com/a.png', 'http://example.com/a.png', 'blob:other', 'a.png', 'other.assets/a.png', 'images/a.png?x', 'images/a.png#x',
  'images\\a.png'])(
  'does not authorize, normalize or fallback for %s', async source => {
    expect(await render('/docs/note.md', source)).toBe(`![image](${source})`);
    expect(resolve).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(ambient).not.toHaveBeenCalled();
  });
it('cannot read a relative file for an unsaved document', async () => {
  expect(await render(null, 'images/a.png')).toBe('![image](images/a.png)');
  expect(read).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
});
