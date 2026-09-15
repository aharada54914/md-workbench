import { describe, expect, it, vi } from 'vitest';
import { setup, mockNativeFs as nativeFs, bytes, disk, tick } from './native-watch-fixture';

describe('native file monitoring', () => {
  it('subscribes with current authority, reads immediately, and polls without OS notifications', async () => {
    const { watcher, onExternalChange, onWatchReady } = setup();
    disk.set('/a', 'opened');
    await watcher.watchFile('/a', 'opened');
    expect(nativeFs.subscribeWatch).toHaveBeenCalledWith('/a', 'current-grant');
    await tick();
    expect(onWatchReady).toHaveBeenCalledWith('/a');
    expect(onExternalChange).not.toHaveBeenCalled();
    disk.set('/a', 'changed'); await tick(999);
    expect(onExternalChange).not.toHaveBeenCalled(); await tick(1);
    expect(onExternalChange).toHaveBeenCalledWith('/a', 'changed');
    await tick(1000); expect(onExternalChange).toHaveBeenCalledTimes(1);
  });
  it('compares the first read to the open snapshot and preserves raw BOM/CRLF', async () => {
    const { watcher, onExternalChange } = setup();
    const source = '\uFEFFa\r\nb  \n'; disk.set('/a', source);
    await watcher.watchFile('/a', 'before'); await tick();
    expect(onExternalChange).toHaveBeenCalledWith('/a', source);
  });
  it('ordinary duplicate watch does not replace the subscription or baseline', async () => {
    const { watcher, onExternalChange } = setup();
    await watcher.watchFile('/a', 'disk'); await watcher.watchFile('/a', 'wrong'); await tick();
    expect(nativeFs.subscribeWatch).toHaveBeenCalledTimes(1);
    expect(onExternalChange).not.toHaveBeenCalled();
  });
  it('reports installation failure and permits retry of transient failure', async () => {
    const { watcher, onWatchError } = setup();
    const error = { code: 'io_error' }; vi.mocked(nativeFs.subscribeWatch).mockRejectedValueOnce(error);
    await watcher.watchFile('/a', 'disk'); expect(onWatchError).toHaveBeenCalledWith('/a', error);
    await watcher.watchFile('/a', 'other'); await tick();
    expect(nativeFs.subscribeWatch).toHaveBeenCalledTimes(2);
  });
  it('only typed NotFound reports deletion and a later recreated file is observed', async () => {
    const { watcher, onFileDeleted, onExternalChange, onWatchError } = setup();
    vi.mocked(nativeFs.readWatchBytes).mockRejectedValueOnce({ code: 'file_not_found' });
    await watcher.watchFile('/a', 'old'); await tick();
    expect(onFileDeleted).toHaveBeenCalledWith('/a'); expect(onWatchError).not.toHaveBeenCalled();
    await tick(1000); expect(onExternalChange).toHaveBeenCalledWith('/a', 'disk');
  });
  it.each([{ code: 'io_error' }, { code: 'too_large' }, new Error('not found')])
  ('does not infer deletion from a non-NotFound error %s', async error => {
    const { watcher, onFileDeleted, onWatchError } = setup();
    vi.mocked(nativeFs.readWatchBytes).mockRejectedValueOnce(error);
    await watcher.watchFile('/a', 'disk'); await tick();
    expect(onFileDeleted).not.toHaveBeenCalled(); expect(onWatchError).toHaveBeenCalledWith('/a', error);
  });
  it('rejects invalid UTF-8 without publishing replacement text or deletion', async () => {
    const { watcher, onFileDeleted, onWatchError, onExternalChange } = setup();
    vi.mocked(nativeFs.readWatchBytes).mockResolvedValueOnce(new Uint8Array([0xff]));
    await watcher.watchFile('/a', 'disk'); await tick();
    expect(onWatchError).toHaveBeenCalledTimes(1); expect(onFileDeleted).not.toHaveBeenCalled();
    expect(onExternalChange).not.toHaveBeenCalled();
  });
  it('pauses revoked authority, deduplicates warnings and requires explicit rebind', async () => {
    const { watcher, onWatchError, onExternalChange } = setup();
    vi.mocked(nativeFs.readWatchBytes).mockRejectedValueOnce({ code: 'permission_required' });
    await watcher.watchFile('/a', 'old'); await tick(); await tick(5000);
    await watcher.watchFile('/a', 'wrong');
    expect(nativeFs.subscribeWatch).toHaveBeenCalledTimes(1); expect(onWatchError).toHaveBeenCalledTimes(1);
    await watcher.restartWatch('/a', 'wrong', 'selected-new'); await tick();
    expect(nativeFs.subscribeWatch).toHaveBeenLastCalledWith('/a', 'selected-new');
    expect(onExternalChange).toHaveBeenCalledWith('/a', 'disk');
  });
  it('does not reread during own save and immediately checks actual saved content after End', async () => {
    const { watcher, onExternalChange } = setup(); disk.set('/a', 'old');
    await watcher.watchFile('/a', 'old'); await tick(); watcher.markSaveStart('/a');
    disk.set('/a', 'saved'); await tick(5000); expect(nativeFs.readWatchBytes).toHaveBeenCalledTimes(1);
    watcher.markSaveEnd('/a', 'saved'); await tick(); expect(onExternalChange).not.toHaveBeenCalled();
    disk.set('/a', 'external'); await tick(1000);
    expect(onExternalChange).toHaveBeenCalledWith('/a', 'external');
  });
  it('Abort catches up without accepting the failed candidate as the baseline', async () => {
    const { watcher, onExternalChange } = setup(); await watcher.watchFile('/a', 'old');
    watcher.markSaveStart('/a'); await tick(1000); watcher.markSaveAbort('/a'); await tick();
    expect(onExternalChange).toHaveBeenCalledWith('/a', 'disk');
  });
  it('updateKnownContent suppresses only an identical disk revision', async () => {
    const { watcher, onExternalChange } = setup(); await watcher.watchFile('/a', 'old');
    watcher.updateKnownContent('/a', 'disk'); await tick(); expect(onExternalChange).not.toHaveBeenCalled();
    disk.set('/a', 'later'); await tick(1000); expect(onExternalChange).toHaveBeenCalledWith('/a', 'later');
  });
  it('releases individual paths once and clears state for reopen', async () => {
    const { watcher, onExternalChange } = setup(); await watcher.watchFile('/a', 'disk'); await tick();
    watcher.unwatchFile('/a'); watcher.unwatchFile('/a'); watcher.unwatchFile('/missing');
    await tick(1000); expect(nativeFs.readWatchBytes).toHaveBeenCalledTimes(1);
    expect(nativeFs.unsubscribeWatch).toHaveBeenCalledTimes(1);
    await watcher.watchFile('/a', 'new baseline'); await tick();
    expect(onExternalChange).toHaveBeenCalledWith('/a', 'disk');
  });
  it('keeps per-path baselines and save suppression independent while spacing starts', async () => {
    const { watcher, onExternalChange } = setup(); disk.set('/b', 'b');
    await watcher.watchFile('/a', 'disk'); await watcher.watchFile('/b', 'old-b'); await tick();
    expect(nativeFs.readWatchBytes).toHaveBeenCalledTimes(1); await tick(249);
    expect(nativeFs.readWatchBytes).toHaveBeenCalledTimes(1); await tick(1);
    expect(onExternalChange).toHaveBeenCalledWith('/b', 'b');
    watcher.markSaveStart('/a'); disk.set('/b', 'next-b'); await tick(1000);
    expect(onExternalChange).toHaveBeenLastCalledWith('/b', 'next-b');
    watcher.unwatchAll(); expect(nativeFs.unsubscribeWatch).toHaveBeenCalledTimes(2);
  });
  it('callback failures are reported without claiming deletion', async () => {
    const error = new Error('callback'); const { watcher, onWatchError, onFileDeleted } = setup({ onExternalChange: () => { throw error; } });
    await watcher.watchFile('/a', 'old'); await tick();
    expect(onWatchError).toHaveBeenCalledWith('/a', error); expect(onFileDeleted).not.toHaveBeenCalled();
  });
  it('does not change the accepted baseline when a read fails', async () => {
    const { watcher, onExternalChange } = setup();
    vi.mocked(nativeFs.readWatchBytes).mockRejectedValueOnce({ code: 'io_error' }).mockResolvedValueOnce(bytes('old'));
    await watcher.watchFile('/a', 'old'); await tick(); await tick(1000);
    expect(onExternalChange).not.toHaveBeenCalled();
  });
});
