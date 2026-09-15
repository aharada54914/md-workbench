import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inlineMarkdownImages, INLINE_REQUEST_BYTES, INLINE_REQUEST_IMAGES, INLINE_WINDOW_IMAGES, INLINE_WINDOW_BYTES } from '../../utils/image-resolver';
import { documentImageBytes, IMAGE_BYTE_LIMIT } from '../../services/documentImageBytes';
const { read, resolve, ambient } = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), ambient: vi.fn() }));
vi.mock('../../services/nativeFs', () => ({ nativeFs: { readDocumentImageBytes: read, resolveDocumentReadGrant: resolve } }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: ambient }));
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const context = () => ({ owner: documentImageBytes.createOwner(), path: '/docs/note.md', revision: 0 });
beforeEach(() => { vi.clearAllMocks(); read.mockResolvedValue(png); resolve.mockResolvedValue({ grantId: 'current' }); });
afterEach(() => documentImageBytes.disposeAll());
it('never performs the previously ambient absolute-path read', async () => {
  const result = await inlineMarkdownImages('![private](/private/secret.png)', context());
  expect(ambient).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  expect(result?.markdown).toBe('![private](/private/secret.png)'); result?.release();
});
it.each(['images/import.png', '/app/unsaved-images/import.png', 'C:/app/unsaved-images/import.png', '//server/share/import.png'])(
  'uses the exact owned import snapshot %s without a native read', async source => {
  const ctx = { ...context(), path: null };
  const reservation = documentImageBytes.reserve(ctx.owner, png.length);
  reservation.prepare(source, png).commit();
  const result = await inlineMarkdownImages(`![a](${source})`, ctx);
  expect(result?.markdown).toContain('data:image/png;base64,iVBORw0KGgo=');
  expect(read).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
  const foreign = await inlineMarkdownImages(`![a](${source})`, { ...context(), path: null });
  expect(foreign?.markdown).toBe(`![a](${source})`); result?.release(); foreign?.release();
});
it('fails closed on revoked authority and never falls back to ambient reads', async () => {
  read.mockRejectedValue({ code: 'permission_required' });
  const result = await inlineMarkdownImages('![a](images/a.png)', context());
  expect(read).toHaveBeenCalledExactlyOnceWith('/docs/note.md', 'current', 'images/a.png');
  expect(result?.markdown).toBe('![a](images/a.png)'); expect(ambient).not.toHaveBeenCalled(); result?.release();
});
it.each([new Uint8Array(IMAGE_BYTE_LIMIT + 1), new Uint8Array([1, 2, 3])])('rejects oversized or invalid image bytes', async bytes => {
  read.mockResolvedValue(bytes);
  const result = await inlineMarkdownImages('![a](images/a.png)', context());
  expect(result?.markdown).toBe('![a](images/a.png)'); result?.release();
});
it('bounds duplicate base64 expansion before constructing the expanded output', async () => {
  const bytes = new Uint8Array(1024 * 1024); bytes.set(png); read.mockResolvedValue(bytes);
  const markdown = Array.from({ length: 30 }, () => '![a](images/a.png)').join(' ');
  const result = await inlineMarkdownImages(markdown, context());
  expect(result?.markdown).toBe(markdown); expect(read).toHaveBeenCalledTimes(1); result?.release();
});
it('rejects excessive source bytes and references before issuing native reads', async () => {
  expect(await inlineMarkdownImages('x'.repeat(INLINE_REQUEST_BYTES / 2 + 1), context())).toBeUndefined();
  expect(await inlineMarkdownImages('![a](images/a.png) '.repeat(INLINE_REQUEST_IMAGES + 1), context())).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});
it('retains output entry reservations until explicit idempotent release', async () => {
  const leases = [];
  for (let i = 0; i < INLINE_WINDOW_IMAGES / INLINE_REQUEST_IMAGES; i++) {
    leases.push(await inlineMarkdownImages('![a](images/a.png) '.repeat(INLINE_REQUEST_IMAGES), context()));
  }
  expect(leases.every(Boolean)).toBe(true);
  expect(await inlineMarkdownImages('![a](images/a.png)', context())).toBeUndefined();
  leases[0]?.release(); leases[0]?.release();
  const accepted = await inlineMarkdownImages('![a](images/a.png)', context());
  expect(accepted).toBeDefined(); accepted?.release(); leases.forEach(result => result?.release());
});
it('holds four native slots until stale reads settle, then admits new work', async () => {
  let finish!: (value: Uint8Array) => void;
  read.mockReturnValue(new Promise<Uint8Array>(res => { finish = res; }));
  let current = true;
  const jobs = Array.from({ length: 4 }, () => inlineMarkdownImages('![a](images/a.png)', context(), () => current));
  await Promise.resolve(); expect(read).toHaveBeenCalledTimes(4);
  current = false;
  expect(await inlineMarkdownImages('![a](images/a.png)', context())).toBeUndefined();
  finish(png); expect(await Promise.all(jobs)).toEqual([undefined, undefined, undefined, undefined]);
  read.mockResolvedValue(png);
  const accepted = await inlineMarkdownImages('![a](images/a.png)', context());
  expect(accepted).toBeDefined(); accepted?.release();
});
it('does not read after owner disposal or after stale grant resolution', async () => {
  const ctx = context(); documentImageBytes.dispose(ctx.owner);
  expect(await inlineMarkdownImages('![a](images/a.png)', ctx)).toBeUndefined();
  let finish!: (value: { grantId: string }) => void;
  resolve.mockReturnValue(new Promise(res => { finish = res; }));
  let current = true;
  const pending = inlineMarkdownImages('![a](images/a.png)', context(), () => current);
  current = false; finish({ grantId: 'obsolete' });
  expect(await pending).toBeUndefined(); expect(read).not.toHaveBeenCalled();
});

it('counts retained base64 output against the renderer byte budget until release', async () => {
  const bytes = new Uint8Array(1024 * 1024); bytes.set(png); read.mockResolvedValue(bytes);
  const markdown = '![a](images/a.png) '.repeat(21);
  const first = await inlineMarkdownImages(markdown, context());
  const second = await inlineMarkdownImages(markdown, context());
  expect(first?.markdown).toContain('data:image/png;'); expect(second?.markdown).toContain('data:image/png;');
  const remaining = INLINE_WINDOW_BYTES - 2 * (first!.markdown.length + second!.markdown.length);
  const input = 'x'.repeat(Math.floor(remaining / 2) + 1);
  expect(await inlineMarkdownImages(input, context())).toBeUndefined();
  first?.release(); second?.release();
  const accepted = await inlineMarkdownImages('no image', context());
  expect(accepted?.markdown).toBe('no image'); accepted?.release();
});

it.each(['owner', 'path', 'revision'] as const)('rejects a mutable %s context after a native read starts', async field => {
  let finish!: (value: Uint8Array) => void;
  read.mockReturnValue(new Promise<Uint8Array>(res => { finish = res; }));
  const ctx = context();
  const work = inlineMarkdownImages('![a](images/a.png)', ctx);
  await Promise.resolve(); expect(read).toHaveBeenCalledOnce();
  if (field === 'owner') ctx.owner = documentImageBytes.createOwner();
  if (field === 'path') ctx.path = '/other.md';
  if (field === 'revision') ctx.revision += 1;
  finish(png); const result = await work;
  result?.release(); expect(result).toBeUndefined();
});
