import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
import { nativeFs } from '../../services/nativeFs';
import { importImage } from '../../services/imageImport';

vi.mock('@tauri-apps/plugin-fs', () => ({ copyFile: vi.fn(), exists: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock('../../services/nativeFs', () => ({ nativeFs: { readPathBytes: vi.fn() } }));

const bytes = new Uint8Array([137, 80, 78, 71]);
const selection = () => ({ expectedGrantId: 'os-resource-id', isCurrent: () => true });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(nativeFs.readPathBytes).mockResolvedValue(bytes);
  vi.mocked(exists).mockResolvedValue(false);
  vi.mocked(mkdir).mockResolvedValue();
  vi.mocked(writeFile).mockResolvedValue();
  vi.mocked(copyFile).mockResolvedValue();
});

describe('importImage OS selection', () => {
  it('reads the captured grant and writes those bytes without an ambient source copy', async () => {
    const result = await importImage('/drop/a.png', '/docs/note.md', selection());
    expect(nativeFs.readPathBytes).toHaveBeenCalledWith('/drop/a.png', undefined, 'os-resource-id');
    expect(writeFile).toHaveBeenCalledWith('/docs/images/a.png', bytes);
    expect(copyFile).not.toHaveBeenCalled();
    expect(result).toEqual({ markdownPath: 'images/a.png', altText: 'a' });
  });

  it('uses collision suffixes while retaining the native source bytes', async () => {
    vi.mocked(exists).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await importImage('/drop/a.png', '/docs/note.md', selection()))
      .toEqual({ markdownPath: 'images/a (1).png', altText: 'a' });
    expect(writeFile).toHaveBeenCalledWith('/docs/images/a (1).png', bytes);
  });

  it.each([null, 'note.md'])('validates even when the document has no anchor: %s', async (docPath) => {
    expect(await importImage('/drop/a.png', docPath, selection()))
      .toEqual({ markdownPath: '/drop/a.png', altText: 'a' });
    expect(nativeFs.readPathBytes).toHaveBeenCalledTimes(1);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('propagates revoked/replaced selection failures without ambient fallback', async () => {
    vi.mocked(nativeFs.readPathBytes).mockRejectedValue({ code: 'permission_required' });
    await expect(importImage('/drop/a.png', '/docs/note.md', selection())).rejects.toEqual({ code: 'permission_required' });
    expect(copyFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('does no I/O when the session already ended', async () => {
    await expect(importImage('/drop/a.png', '/docs/note.md', { ...selection(), isCurrent: () => false }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(nativeFs.readPathBytes).not.toHaveBeenCalled();
  });

  it.each(['read', 'mkdir', 'exists', 'write'] as const)('stops after cancellation during %s', async (stage) => {
    let current = true;
    if (stage === 'read') vi.mocked(nativeFs.readPathBytes).mockImplementation(async () => { current = false; return bytes; });
    if (stage === 'mkdir') vi.mocked(mkdir).mockImplementation(async () => { current = false; });
    if (stage === 'exists') vi.mocked(exists).mockImplementation(async () => { current = false; return true; });
    if (stage === 'write') vi.mocked(writeFile).mockImplementation(async () => { current = false; });
    await expect(importImage('/drop/a.png', '/docs/note.md', { ...selection(), isCurrent: () => current }))
      .rejects.toMatchObject({ name: 'AbortError' });
    if (stage === 'read') expect(mkdir).not.toHaveBeenCalled();
    if (stage === 'read' || stage === 'mkdir') expect(exists).not.toHaveBeenCalled();
    if (stage !== 'write') expect(writeFile).not.toHaveBeenCalled();
    if (stage === 'exists') expect(exists).toHaveBeenCalledTimes(1);
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('keeps the legacy source-copy behavior when no selection is supplied', async () => {
    await importImage('/drop/a.png', '/docs/note.md');
    expect(copyFile).toHaveBeenCalledWith('/drop/a.png', '/docs/images/a.png');
    expect(nativeFs.readPathBytes).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('keeps legacy unsaved source links without starting new I/O', async () => {
    expect(await importImage('/drop/a.png', null)).toEqual({ markdownPath: '/drop/a.png', altText: 'a' });
    expect(nativeFs.readPathBytes).not.toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled();
  });
});
