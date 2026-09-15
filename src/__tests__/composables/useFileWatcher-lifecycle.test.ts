import { describe, expect, it, vi } from 'vitest';
import { setup, mockNativeFs as nativeFs, bytes, deferred, tick, flush } from './native-watch-fixture';
import type { NativeWatch } from '../../services/nativeFs';

describe('native watch authority and asynchronous lifecycle', () => {
  it.each(['one', 'all'])('releases a late-installed native token after unwatch %s', async mode => {
    const pending = deferred<NativeWatch>(); vi.mocked(nativeFs.subscribeWatch).mockReturnValueOnce(pending.promise);
    const { watcher } = setup(); const install = watcher.watchFile('/a', 'old'); await flush();
    if (mode === 'one') watcher.unwatchFile('/a'); else watcher.unwatchAll();
    pending.resolve({ id: 'late', grantId: 'old' }); await install; await tick();
    expect(nativeFs.unsubscribeWatch).toHaveBeenCalledWith('late'); expect(nativeFs.readWatchBytes).not.toHaveBeenCalled();
  });
  it('deduplicates installation while its resolver is pending', async () => {
    const grant = deferred<{ grantId: string }>(); vi.mocked(nativeFs.resolveDocumentReadGrant).mockReturnValueOnce(grant.promise);
    const { watcher } = setup(); const first = watcher.watchFile('/a', 'old');
    await watcher.watchFile('/a', 'wrong'); expect(nativeFs.resolveDocumentReadGrant).toHaveBeenCalledTimes(1);
    grant.resolve({ grantId: 'selected' }); await first; await tick();
    expect(nativeFs.subscribeWatch).toHaveBeenCalledTimes(1);
  });
  it.each(['resolve', 'reject'])('old installation %s cannot overwrite a newer rebind', async finish => {
    const pending = deferred<NativeWatch>(); vi.mocked(nativeFs.subscribeWatch).mockReturnValueOnce(pending.promise);
    const { watcher, onWatchError } = setup(); const install = watcher.watchFile('/a', 'disk'); await flush();
    await watcher.restartWatch('/a', 'disk', 'new');
    if (finish === 'resolve') pending.resolve({ id: 'old-token', grantId: 'old' }); else pending.reject({ code: 'permission_required' });
    await install; await tick();
    expect(nativeFs.readWatchBytes).toHaveBeenCalledWith('watch-1', 64 * 1024 * 1024);
    expect(onWatchError).not.toHaveBeenCalled();
  });
  it.each(['resolve', 'reject'])('keeps a closed old read in the global slot until it %ss', async finish => {
    const pending = deferred<Uint8Array>(); vi.mocked(nativeFs.readWatchBytes).mockReturnValueOnce(pending.promise);
    const first = setup(); const second = setup();
    await first.watcher.watchFile('/a', 'old'); await tick(); first.watcher.unwatchAll();
    await second.watcher.watchFile('/b', 'old'); await tick(5000);
    expect(nativeFs.readWatchBytes).toHaveBeenCalledTimes(1);
    if (finish === 'resolve') pending.resolve(bytes('stale')); else pending.reject({ code: 'file_not_found' });
    await flush(); await tick();
    expect(nativeFs.readWatchBytes).toHaveBeenCalledTimes(2);
    expect(first.onExternalChange).not.toHaveBeenCalled(); expect(first.onFileDeleted).not.toHaveBeenCalled();
    expect(second.onExternalChange).toHaveBeenCalledWith('/b', 'disk');
  });
  it.each(['saveStart', 'saveEnd', 'known', 'abort', 'rebind'])('invalidates an in-flight result on %s and does not create parallel native reads', async action => {
    const pending = deferred<Uint8Array>(); vi.mocked(nativeFs.readWatchBytes).mockReturnValueOnce(pending.promise);
    const { watcher, onExternalChange } = setup(); await watcher.watchFile('/a', 'disk'); await tick();
    if (action === 'saveStart') watcher.markSaveStart('/a');
    if (action === 'saveEnd') watcher.markSaveEnd('/a', 'disk');
    if (action === 'known') watcher.updateKnownContent('/a', 'disk');
    if (action === 'abort') watcher.markSaveAbort('/a');
    if (action === 'rebind') await watcher.restartWatch('/a', 'wrong', 'new');
    await tick(1000); expect(nativeFs.readWatchBytes).toHaveBeenCalledTimes(1);
    pending.resolve(bytes('stale')); await flush(); await tick(1000);
    expect(onExternalChange).not.toHaveBeenCalled();
    if (action !== 'saveStart') expect(vi.mocked(nativeFs.readWatchBytes).mock.calls.length).toBeGreaterThan(1);
  });
  it.each(['end', 'abort'])('prioritizes %s catch-up after a stale read settles instead of waiting a normal poll', async action => {
    const pending = deferred<Uint8Array>(); vi.mocked(nativeFs.readWatchBytes).mockReturnValueOnce(pending.promise);
    const { watcher, onExternalChange } = setup(); await watcher.watchFile('/a', 'old'); await tick();
    watcher.markSaveStart('/a'); await tick(500);
    if (action === 'end') watcher.markSaveEnd('/a', 'saved'); else watcher.markSaveAbort('/a');
    pending.resolve(bytes('stale')); await flush(); await tick();
    expect(nativeFs.readWatchBytes).toHaveBeenCalledTimes(2);
    expect(onExternalChange).toHaveBeenCalledExactlyOnceWith('/a', 'disk');
  });
  it.each(['close', 'permission'])('preserves minimum global start spacing across an empty queue caused by %s', async action => {
    const starts: number[] = [];
    vi.mocked(nativeFs.readWatchBytes).mockImplementation(async () => {
      starts.push(Date.now()); if (action === 'permission' && starts.length === 1) throw { code: 'permission_required' };
      return bytes('disk');
    });
    const { watcher } = setup(); await watcher.watchFile('/a', 'disk'); await tick();
    if (action === 'close') { watcher.unwatchAll(); await watcher.watchFile('/a', 'disk'); }
    else await watcher.restartWatch('/a', 'disk', 'selected');
    await tick(249); expect(starts).toHaveLength(1); await tick(1);
    expect(starts).toHaveLength(2); expect(starts[1] - starts[0]).toBe(250);
  });
  it('services 128 ready paths in order despite repeated save catch-up requests and stops all queued work on close', async () => {
    const starts: number[] = [];
    vi.mocked(nativeFs.readWatchBytes).mockImplementation(async () => { starts.push(Date.now()); return bytes('disk'); });
    const { watcher } = setup();
    for (let index = 0; index < 128; index++) await watcher.watchFile(`/path-${index}`, 'disk');
    await tick();
    for (let index = 1; index < 128; index++) {
      watcher.markSaveAbort('/path-0');
      await tick(250);
    }
    expect(vi.mocked(nativeFs.readWatchBytes).mock.calls.map(([id]) => id))
      .toEqual(Array.from({ length: 128 }, (_, index) => `watch-${index + 1}`));
    expect(starts.slice(1).every((start, index) => start - starts[index] >= 250)).toBe(true);
    watcher.unwatchAll(); await tick(10_000);
    expect(nativeFs.unsubscribeWatch).toHaveBeenCalledTimes(128);
    expect(nativeFs.readWatchBytes).toHaveBeenCalledTimes(128);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['saveStart', 'saveEnd', 'abort', 'known'])('does not report a stale missing-file failure after %s', async action => {
    const pending = deferred<Uint8Array>(); vi.mocked(nativeFs.readWatchBytes).mockReturnValueOnce(pending.promise);
    const { watcher, onFileDeleted, onWatchError } = setup();
    await watcher.watchFile('/a', 'disk'); await tick();
    if (action === 'saveStart') watcher.markSaveStart('/a');
    if (action === 'saveEnd') watcher.markSaveEnd('/a', 'disk');
    if (action === 'abort') watcher.markSaveAbort('/a');
    if (action === 'known') watcher.updateKnownContent('/a', 'disk');
    pending.reject({ code: 'file_not_found' }); await flush(); await tick(1000);
    expect(onFileDeleted).not.toHaveBeenCalled(); expect(onWatchError).not.toHaveBeenCalled();
  });
  it('ignores an obsolete read error after explicit rebind and uses the selected new ID', async () => {
    const pending = deferred<Uint8Array>(); vi.mocked(nativeFs.readWatchBytes).mockReturnValueOnce(pending.promise);
    const { watcher, onWatchError } = setup(); await watcher.watchFile('/a', 'disk'); await tick();
    await watcher.restartWatch('/a', 'disk', 'new-id'); pending.reject({ code: 'permission_required' });
    await flush(); await tick(250); expect(onWatchError).not.toHaveBeenCalled();
    expect(nativeFs.subscribeWatch).toHaveBeenLastCalledWith('/a', 'new-id');
  });
});
