import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { nativeFs, MAX_NATIVE_READ_BYTES } from '../../services/nativeFs';

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
