import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { nativeFs, MAX_NATIVE_READ_BYTES } from '../../services/nativeFs';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

describe('native document reads', () => {
  beforeEach(() => { invokeMock.mockReset(); });

  it('preserves UTF-8 BOM, CRLF, Japanese and trailing spaces through the grant read', async () => {
    const raw = '\uFEFF# 日本語\r\n\r\n本文  \r\n';
    invokeMock.mockResolvedValue(Array.from(new TextEncoder().encode(raw)));
    expect(await nativeFs.readText('host-issued-id')).toBe(raw);
    expect(invokeMock).toHaveBeenCalledWith('native_read_grant', {
      id: 'host-issued-id', relative: '', limit: MAX_NATIVE_READ_BYTES,
    });
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
});
