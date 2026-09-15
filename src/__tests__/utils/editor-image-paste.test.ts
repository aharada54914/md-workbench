import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importPastedEditorImage } from '../../utils/editor-image-paste';
import { documentImageBytes, IMAGE_BYTE_LIMIT } from '../../services/documentImageBytes';
import { importImageBytes } from '../../services/imageImport';
vi.mock('../../services/imageImport', () => ({ importImageBytes: vi.fn() }));
const bytes = new Uint8Array([1, 2, 3]);
const file = (read = vi.fn(async () => bytes.buffer), size = bytes.length) => ({ size, type: 'image/png', name: 'pic.png', arrayBuffer: read } as unknown as File);
beforeEach(() => vi.resetAllMocks());
afterEach(() => documentImageBytes.disposeAll());
const context = () => ({ owner: documentImageBytes.createOwner(), path: '/docs/a.md', isCurrent: () => true, insert: vi.fn() });

describe('pasted image ownership', () => {
  it('checks size and reserves aggregate capacity before allocating the File buffer', async () => {
    const ctx = context(); const read = vi.fn(async () => bytes.buffer);
    await expect(importPastedEditorImage(file(read, IMAGE_BYTE_LIMIT + 1), ctx)).rejects.toThrow('image_too_large');
    for (let i = 0; i < 8; i++) documentImageBytes.reserve(ctx.owner);
    await expect(importPastedEditorImage(file(read), ctx)).rejects.toThrow('image_budget_exceeded');
    expect(read).not.toHaveBeenCalled(); expect(importImageBytes).not.toHaveBeenCalled();
  });
  it('holds its reservation across the pending file allocation and releases on rejection', async () => {
    const ctx = context(); const reservations = Array.from({ length: 7 }, () => documentImageBytes.reserve(ctx.owner));
    const read = vi.fn(async () => {
      expect(() => documentImageBytes.reserve(ctx.owner)).toThrow('image_budget_exceeded');
      throw new Error('read failed');
    });
    await expect(importPastedEditorImage(file(read, IMAGE_BYTE_LIMIT), ctx)).rejects.toThrow('read failed');
    documentImageBytes.reserve(ctx.owner).release(); reservations.forEach(r => r.release());
  });
  it('rejects a received buffer larger than the announced file size before import', async () => {
    const ctx = context();
    await expect(importPastedEditorImage(file(undefined, 1), ctx)).rejects.toThrow('image_too_large');
    expect(importImageBytes).not.toHaveBeenCalled();
  });
  it('commits before synchronous insertion then releases, passing the captured owner', async () => {
    const ctx = context(); const order: string[] = [];
    vi.mocked(importImageBytes).mockResolvedValue({ markdownPath: 'images/a.png', altText: 'a', prepared: { commit: () => order.push('commit'), release: () => order.push('release') } });
    ctx.insert.mockImplementation(() => { order.push('insert'); });
    await importPastedEditorImage(file(), ctx);
    expect(order).toEqual(['commit', 'insert', 'release']);
    expect(importImageBytes).toHaveBeenCalledWith(bytes, 'png', ctx.path, 'pic', expect.objectContaining({ owner: ctx.owner }));
    expect(ctx.insert).toHaveBeenCalledWith({ path: 'images/a.png', alt: 'a' });
  });
  it.each(['file', 'import'])('does not add a late result after %s changes the owner context', async stage => {
    let live = true; const ctx = { ...context(), isCurrent: () => live };
    const commit = vi.fn(), release = vi.fn();
    vi.mocked(importImageBytes).mockImplementation(async () => { live = false; return { markdownPath: 'images/a.png', altText: 'a', prepared: { commit, release } }; });
    const read = vi.fn(async () => { if (stage === 'file') live = false; return bytes.buffer; });
    await expect(importPastedEditorImage(file(read), ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.insert).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    if (stage === 'file') expect(importImageBytes).not.toHaveBeenCalled();
    else expect(release).toHaveBeenCalledOnce();
  });
  it('rejects a disposed owner before allocation', async () => {
    const ctx = context(); documentImageBytes.dispose(ctx.owner); const read = vi.fn(async () => bytes.buffer);
    await expect(importPastedEditorImage(file(read), ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
  it('releases the prepared result when insertion throws', async () => {
    const ctx = context(); const release = vi.fn(); ctx.insert.mockImplementation(() => { throw new Error('insert failed'); });
    vi.mocked(importImageBytes).mockResolvedValue({ markdownPath: 'images/a.png', altText: 'a', prepared: { commit: vi.fn(), release } });
    await expect(importPastedEditorImage(file(), ctx)).rejects.toThrow('insert failed');
    expect(release).toHaveBeenCalledOnce();
  });
});
