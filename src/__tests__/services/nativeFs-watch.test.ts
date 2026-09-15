import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { MAX_NATIVE_READ_BYTES, nativeFs } from '../../services/nativeFs';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

describe('native owned polling subscriptions', () => {
  beforeEach(() => { invokeMock.mockReset(); });

  it('resolves document READ authority using the existing host resolver without minting grants', async () => {
    invokeMock.mockResolvedValue({ grantId: 'selected' });
    expect(await nativeFs.resolveDocumentReadGrant('/a.md')).toEqual({ grantId: 'selected' });
    expect(invokeMock.mock.calls).toEqual([['native_resolve_image_document', { documentPath: '/a.md' }]]);
  });

  it('subscribes only with the supplied current identity and does not install a scheduler or read implicitly', async () => {
    const watch = { id: 'host-token', grantId: 'current-grant' };
    invokeMock.mockResolvedValue(watch);
    expect(await nativeFs.subscribeWatch('/selected/日本語.md', 'current-grant')).toBe(watch);
    expect(invokeMock.mock.calls).toEqual([
      ['native_watch_subscribe', { path: '/selected/日本語.md', expectedGrantId: 'current-grant' }],
    ]);
  });

  it('preserves original bytes while passing only token and bounded read limit', async () => {
    const bytes = [0xef, 0xbb, 0xbf, 13, 10, 0xc3, 0x28, 0];
    invokeMock.mockResolvedValue(bytes);
    expect(await nativeFs.readWatchBytes('host-token')).toEqual(Uint8Array.from(bytes));
    expect(await nativeFs.readWatchBytes('host-token', 123)).toEqual(Uint8Array.from(bytes));
    expect(invokeMock.mock.calls).toEqual([
      ['native_watch_read', { id: 'host-token', limit: MAX_NATIVE_READ_BYTES }],
      ['native_watch_read', { id: 'host-token', limit: 123 }],
    ]);
  });

  it('unsubscribes the opaque token without using a path or clearing other tokens', async () => {
    invokeMock.mockResolvedValue(undefined);
    await nativeFs.unsubscribeWatch('host-token');
    expect(invokeMock.mock.calls).toEqual([['native_watch_unsubscribe', { id: 'host-token' }]]);
  });

  it.each(['permission_required', 'file_not_found', 'watch_busy', 'watch_limit_exceeded'] as const)(
    'propagates %s unchanged without grant selection, retry, path fallback or deletion inference', async (code) => {
      const error = { code, message: 'host rejected' };
      invokeMock.mockRejectedValue(error);
      await expect(nativeFs.subscribeWatch('/new-save.md', 'stale')).rejects.toBe(error);
      await expect(nativeFs.readWatchBytes('stale')).rejects.toBe(error);
      await expect(nativeFs.unsubscribeWatch('stale')).rejects.toBe(error);
      expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
        'native_watch_subscribe', 'native_watch_read', 'native_watch_unsubscribe',
      ]);
    },
  );
});
