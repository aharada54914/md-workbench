import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inlineMarkdownImages } from '../../utils/image-resolver';
import { documentImageBytes } from '../../services/documentImageBytes';
const { read, resolve } = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn() }));
vi.mock('../../services/nativeFs', () => ({ nativeFs: { readDocumentImageBytes: read, resolveDocumentReadGrant: resolve } }));
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
beforeEach(() => { vi.clearAllMocks(); read.mockResolvedValue(png); resolve.mockResolvedValue({ grantId: 'current' }); });
afterEach(() => documentImageBytes.disposeAll());
it('never reuses a previous document read or grant for the same path', async () => {
  read.mockResolvedValueOnce(png).mockResolvedValueOnce(new Uint8Array([...png, 2]));
  resolve.mockResolvedValueOnce({ grantId: 'old' }).mockResolvedValueOnce({ grantId: 'new' });
  const context = { owner: documentImageBytes.createOwner(), path: '/shared.md', revision: 0 };
  const first = await inlineMarkdownImages('![a](images/a.png)', context);
  const second = await inlineMarkdownImages('![a](images/a.png)', { ...context, revision: 1 });
  expect(second?.markdown).not.toBe(first?.markdown);
  expect(read.mock.calls.map(([, id]) => id)).toEqual(['old', 'new']);
  first?.release(); second?.release();
});
it('shares duplicate reads within a request without changing external or authored data destinations', async () => {
  const markdown = '![a](images/same.png) ![b](images/same.png) ![c](https://example.com/a.png) ![d](data:image/png;base64,AQ==)';
  const result = await inlineMarkdownImages(markdown, { owner: documentImageBytes.createOwner(), path: '/deck.md', revision: 0 });
  expect(read).toHaveBeenCalledTimes(1);
  expect(result?.markdown.match(/data:image\/png;base64,iVBORw0KGgo=/g)).toHaveLength(2);
  expect(result?.markdown).toContain('https://example.com/a.png');
  expect(result?.markdown).toContain('data:image/png;base64,AQ==');
  result?.release();
});
