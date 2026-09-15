import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { nativeFs, MAX_NATIVE_READ_BYTES, type NativeGrant } from '../../services/nativeFs';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

describe('native document reads', () => {
  beforeEach(() => { invokeMock.mockReset(); });

  it.each(['grant', 'path'] as const)('preserves UTF-8 BOM, CRLF, Japanese and trailing spaces through the %s read', async (kind) => {
    const raw = '\uFEFF# 日本語\r\n\r\n本文  \r\n';
    invokeMock.mockResolvedValue(Array.from(new TextEncoder().encode(raw)));
    expect(await (kind === 'grant' ? nativeFs.readText('host-issued-id') : nativeFs.readPathText('/selected/日本語.md'))).toBe(raw);
    expect(invokeMock).toHaveBeenCalledWith(kind === 'grant' ? 'native_read_grant' : 'native_read_path', kind === 'grant'
      ? { id: 'host-issued-id', relative: '', limit: MAX_NATIVE_READ_BYTES }
      : { path: '/selected/日本語.md', limit: MAX_NATIVE_READ_BYTES });
  });

  it('rejects invalid UTF-8 without producing replacement characters for saving', async () => {
    invokeMock.mockResolvedValue([0xc3, 0x28]);
    await expect(nativeFs.readText('host-issued-id')).rejects.toThrow();
  });

  it('preserves a host permission failure without falling back to path-based access', async () => {
    const failure = { code: 'permission_required', message: 'revoked' };
    invokeMock.mockRejectedValue(failure);
    await expect(nativeFs.readText('revoked-id')).rejects.toBe(failure);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe('native_read_grant');
  });

  it('does not retry or widen access when a path read or directory listing is denied', async () => {
    const failure = { code: 'permission_required', message: 'native selection required' };
    invokeMock.mockRejectedValue(failure);
    await expect(nativeFs.readPathText('/unselected/file.md')).rejects.toBe(failure);
    await expect(nativeFs.listDirectory('/unselected')).rejects.toBe(failure);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(['native_read_path', 'native_list_directory']);
  });
});


describe('native file manager reveal', () => {
  beforeEach(() => { invokeMock.mockReset(); });

  it('passes the optional authority identity without obtaining a new grant', async () => {
    invokeMock.mockResolvedValue(undefined);
    await nativeFs.revealPath('/selected/note.md', 'issued-id');
    expect(invokeMock.mock.calls).toEqual([
      ['reveal_in_os', { path: '/selected/note.md', expectedGrantId: 'issued-id' }],
    ]);
  });

  it('preserves denial without retry, picker or filesystem fallback', async () => {
    const failure = { code: 'permission_required', message: 'revoked' };
    invokeMock.mockRejectedValue(failure);
    await expect(nativeFs.revealPath('/selected/note.md')).rejects.toBe(failure);
    expect(invokeMock.mock.calls).toEqual([
      ['reveal_in_os', { path: '/selected/note.md' }],
    ]);
  });
});

describe('native document image byte foundation', () => {
  beforeEach(() => { invokeMock.mockReset(); });

  it('returns only the host descriptor without selecting or deriving authority', async () => {
    const descriptor = { grantId: 'current-workspace-id' };
    invokeMock.mockResolvedValue(descriptor);

    expect(await nativeFs.resolveImageDocument('/selected/日本語.md')).toBe(descriptor);
    expect(invokeMock.mock.calls).toEqual([
      ['native_resolve_image_document', { documentPath: '/selected/日本語.md' }],
    ]);
  });

  it.each([{ bytes: [] }, { bytes: [0, 255, 0xc3, 0x28, 13, 10] }])('returns original binary bytes $bytes without text or image decoding', async ({ bytes }) => {
    invokeMock.mockResolvedValue(bytes);
    const relativePath = 'images/%2e%2e/%2f雪 (1)#literal.png';

    const result = await nativeFs.readDocumentImageBytes('/selected/日本語.md', 'current-id', relativePath);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual(bytes);
    expect(invokeMock.mock.calls).toEqual([
      ['native_read_document_image', {
        documentPath: '/selected/日本語.md',
        expectedDocumentGrantId: 'current-id',
        relativePath,
      }],
    ]);
  });

  it.each(['permission_required', 'invalid_grant_kind', 'file_too_large'] as const)(
    'preserves %s from both commands without retry, picker or fallback', async (code) => {
      const failure = { code, message: 'host rejected image access' };
      invokeMock.mockRejectedValue(failure);

      await expect(nativeFs.resolveImageDocument('/selected/doc.md')).rejects.toBe(failure);
      await expect(nativeFs.readDocumentImageBytes('/selected/doc.md', 'stale-id', 'images/a.png')).rejects.toBe(failure);

      expect(invokeMock.mock.calls).toEqual([
        ['native_resolve_image_document', { documentPath: '/selected/doc.md' }],
        ['native_read_document_image', {
          documentPath: '/selected/doc.md', expectedDocumentGrantId: 'stale-id', relativePath: 'images/a.png',
        }],
      ]);
    },
  );
});


describe('native document picker batch identities', () => {
  beforeEach(() => { invokeMock.mockReset(); });
  const grant = (path: string, id: string): NativeGrant => ({ path, id, kind: 'document', read: true, write: false });

  it('keeps the full selection sequence using the last returned identity without mutating the host response', async () => {
    const first = grant('/a.md', 'old-a'); const second = grant('/b.md', 'b'); const last = grant('/a.md', 'new-a');
    const selected = Object.freeze([first, second, last]);
    invokeMock.mockResolvedValue(selected);
    expect(await nativeFs.pickDocuments()).toEqual([last, second, last]);
    expect(selected).toEqual([first, second, last]);
    expect(invokeMock.mock.calls).toEqual([['native_pick_documents']]);
  });
  it('does not case-fold, decode or otherwise normalize returned paths', async () => {
    const selected = ['/A.md', '/a.md', '/%61.md'].map((path, index) => grant(path, String(index)));
    invokeMock.mockResolvedValue(selected);
    expect(await nativeFs.pickDocuments()).toEqual(selected);
  });
  it('does not replace a selected identity if its later read is denied', async () => {
    const last = grant('/a.md', 'new-a'); const failure = { code: 'permission_required' };
    invokeMock.mockResolvedValueOnce([grant('/a.md', 'old-a'), last]).mockRejectedValueOnce(failure);
    const [selected] = await nativeFs.pickDocuments();
    await expect(nativeFs.readPathText(selected.path, undefined, selected.id)).rejects.toBe(failure);
    expect(invokeMock.mock.calls).toEqual([
      ['native_pick_documents'], ['native_read_path', { path: '/a.md', limit: MAX_NATIVE_READ_BYTES, expectedGrantId: 'new-a' }],
    ]);
  });
});
