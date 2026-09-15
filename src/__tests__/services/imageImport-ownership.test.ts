import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
import { nativeFs } from '../../services/nativeFs';
import { importImage, importImageBytes } from '../../services/imageImport';
import { documentImageBytes, IMAGE_BYTE_LIMIT } from '../../services/documentImageBytes';

vi.mock('@tauri-apps/plugin-fs', () => ({ copyFile: vi.fn(), exists: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: vi.fn(async () => '/app') }));
vi.mock('../../services/nativeFs', () => ({ nativeFs: { readBytes: vi.fn() } }));
const bytes = new Uint8Array([1, 2, 3]);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(nativeFs.readBytes).mockResolvedValue(bytes);
  vi.mocked(exists).mockResolvedValue(false);
});
afterEach(() => documentImageBytes.disposeAll());
const context = () => ({ owner: documentImageBytes.createOwner(), isCurrent: () => true });

describe('prepared ingress ownership', () => {
  it('retains unsaved dropped bytes only after explicit current-document commit', async () => {
    const ctx = context();
    const result = await importImage('/drop/a.png', null, { ...ctx, expectedGrantId: 'id' });
    expect(nativeFs.readBytes).toHaveBeenCalledWith('id', '', IMAGE_BYTE_LIMIT);
    expect(documentImageBytes.read(ctx.owner, result.markdownPath)).toBeUndefined();
    result.prepared!.commit(); result.prepared!.release();
    expect(documentImageBytes.read(ctx.owner, '/drop/a.png')).toEqual(bytes);
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('retains clipboard bytes with the unchanged appData destination and no native read', async () => {
    const ctx = context();
    const result = await importImageBytes(bytes, 'png', null, 'paste', ctx);
    expect(result.markdownPath).toMatch(/^\/app\/unsaved-images\/paste-\d+\.png$/);
    expect(writeFile).toHaveBeenCalledWith(result.markdownPath, bytes);
    result.prepared!.commit();
    expect(documentImageBytes.read(ctx.owner, result.markdownPath)).toEqual(bytes);
    expect(nativeFs.readBytes).not.toHaveBeenCalled();
  });

  it('rejects same unsaved path with changed bytes without changing the existing snapshot', async () => {
    const ctx = { ...context(), expectedGrantId: 'id' };
    (await importImage('/drop/a.png', null, ctx)).prepared!.commit();
    vi.mocked(nativeFs.readBytes).mockResolvedValue(new Uint8Array([9]));
    await expect(importImage('/drop/a.png', null, ctx)).rejects.toThrow('image_path_conflict');
    expect(documentImageBytes.read(ctx.owner, '/drop/a.png')).toEqual(bytes);
  });

  it.each(['read', 'mkdir', 'write'])('releases reservations and never returns a stale result after %s', async (stage) => {
    let live = true;
    const ctx = { ...context(), expectedGrantId: 'id', isCurrent: () => live };
    if (stage === 'read') vi.mocked(nativeFs.readBytes).mockImplementation(async () => { live = false; return bytes; });
    if (stage === 'mkdir') vi.mocked(mkdir).mockImplementation(async () => { live = false; });
    if (stage === 'write') vi.mocked(writeFile).mockImplementation(async () => { live = false; });
    await expect(importImage('/drop/a.png', '/docs/a.md', ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(documentImageBytes.read(ctx.owner, 'images/a.png')).toBeUndefined();
    const reservations = Array.from({ length: 8 }, () => documentImageBytes.reserve(ctx.owner));
    reservations.forEach(r => r.release());
  });

  it('does not turn clipboard cancellation into data URL fallback or a result', async () => {
    let live = true;
    const ctx = { ...context(), isCurrent: () => live };
    vi.mocked(writeFile).mockImplementation(async () => { live = false; throw new Error('disk'); });
    await expect(importImageBytes(bytes, 'png', null, 'paste', ctx)).rejects.toMatchObject({ name: 'AbortError' });
    for (let i = 0; i < 8; i++) documentImageBytes.reserve(ctx.owner);
  });

  it('rejects clipboard oversize and exhausted document budget before destination I/O', async () => {
    const ctx = context();
    await expect(importImageBytes(new Uint8Array(IMAGE_BYTE_LIMIT + 1), 'png', null, 'paste', ctx)).rejects.toThrow('image_too_large');
    for (let i = 0; i < 8; i++) documentImageBytes.reserve(ctx.owner);
    await expect(importImage('/a.png', null, { ...ctx, expectedGrantId: 'id' })).rejects.toThrow('image_budget_exceeded');
    expect(nativeFs.readBytes).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('rejects closed owners before any source read', async () => {
    const ctx = context(); documentImageBytes.dispose(ctx.owner);
    await expect(importImage('/a.png', null, { ...ctx, expectedGrantId: 'id' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(nativeFs.readBytes).not.toHaveBeenCalled();
  });
});
