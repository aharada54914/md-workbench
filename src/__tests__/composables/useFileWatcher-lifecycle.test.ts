import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnwatchFn, WatchEvent } from '@tauri-apps/plugin-fs';

vi.mock('@tauri-apps/plugin-fs', () => ({ watch: vi.fn() }));
vi.mock('../../services/documentText', () => ({ readTextFile: vi.fn() }));

import { watch as watchFs } from '@tauri-apps/plugin-fs';
import { readTextFile } from '../../services/documentText';
import { useFileWatcher } from '../../composables/useFileWatcher';

const path = '/selected/file.md';
const event: WatchEvent = { type: 'any', paths: [path], attrs: {} };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function setup() {
  const onExternalChange = vi.fn();
  const onFileDeleted = vi.fn();
  const onWatchError = vi.fn();
  return { watcher: useFileWatcher({ onExternalChange, onFileDeleted, onWatchError }), onExternalChange, onFileDeleted, onWatchError };
}
const handlerAt = (index: number) => vi.mocked(watchFs).mock.calls[index][1];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(watchFs).mockResolvedValue(vi.fn());
  vi.mocked(readTextFile).mockResolvedValue('disk');
});

describe('watch installation lifecycle', () => {
  it.each(['one', 'all'])('releases a late installation after unwatch %s', async (kind) => {
    const install = deferred<UnwatchFn>();
    vi.mocked(watchFs).mockReturnValueOnce(install.promise);
    const { watcher, onExternalChange } = setup();
    const pending = watcher.watchFile(path, 'initial');
    if (kind === 'one') watcher.unwatchFile(path); else watcher.unwatchAll();
    const stop = vi.fn();
    install.resolve(stop);
    await pending;
    expect(stop).toHaveBeenCalledOnce();
    handlerAt(0)(event);
    await flush();
    expect(readTextFile).not.toHaveBeenCalled();
    expect(onExternalChange).not.toHaveBeenCalled();
  });

  it('deduplicates installation while its promise is pending', async () => {
    const install = deferred<UnwatchFn>();
    vi.mocked(watchFs).mockReturnValueOnce(install.promise);
    const { watcher } = setup();
    const first = watcher.watchFile(path, 'initial');
    await watcher.watchFile(path, 'duplicate');
    expect(watchFs).toHaveBeenCalledOnce();
    install.resolve(vi.fn());
    await first;
  });

  it.each(['resolve', 'reject'])('an old installation cannot replace a rewatch when it later %s', async (outcome) => {
    const install = deferred<UnwatchFn>();
    vi.mocked(watchFs).mockReturnValueOnce(install.promise);
    const { watcher, onWatchError, onExternalChange } = setup();
    const first = watcher.watchFile(path, 'old');
    watcher.unwatchFile(path);
    const stopCurrent = vi.fn();
    vi.mocked(watchFs).mockResolvedValueOnce(stopCurrent);
    await watcher.watchFile(path, 'current');
    const stopOld = vi.fn();
    if (outcome === 'resolve') install.resolve(stopOld); else install.reject(new Error('old install failed'));
    await first;
    handlerAt(0)(event);
    await flush();
    expect(readTextFile).not.toHaveBeenCalled();
    handlerAt(1)(event);
    await flush();
    expect(onExternalChange).toHaveBeenCalledWith(path, 'disk');
    expect(onWatchError).not.toHaveBeenCalled();
    watcher.unwatchFile(path);
    expect(stopCurrent).toHaveBeenCalledOnce();
    expect(stopOld).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
  });

  it('can retry an active failed installation', async () => {
    vi.mocked(watchFs).mockRejectedValueOnce(new Error('install failed'));
    const { watcher, onWatchError } = setup();
    await watcher.watchFile(path, 'initial');
    await watcher.watchFile(path, 'initial');
    expect(watchFs).toHaveBeenCalledTimes(2);
    expect(onWatchError).toHaveBeenCalledOnce();
  });
});

describe('read completion lifecycle', () => {
  it.each(['resolve', 'reject'])('ignores an old read that %s after unwatch and rewatch', async (outcome) => {
    const read = deferred<string>();
    vi.mocked(readTextFile).mockReturnValueOnce(read.promise);
    const { watcher, onExternalChange, onFileDeleted, onWatchError } = setup();
    await watcher.watchFile(path, 'initial');
    handlerAt(0)(event);
    watcher.unwatchFile(path);
    await watcher.watchFile(path, 'current');
    if (outcome === 'resolve') read.resolve('obsolete'); else read.reject(new Error('old missing file'));
    await flush();
    expect(onExternalChange).not.toHaveBeenCalled();
    expect(onFileDeleted).not.toHaveBeenCalled();
    expect(onWatchError).not.toHaveBeenCalled();
    vi.mocked(readTextFile).mockResolvedValueOnce('current');
    handlerAt(1)(event);
    await flush();
    expect(onExternalChange).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'])('the latest request wins when an older read later %s', async (outcome) => {
    const read = deferred<string>();
    vi.mocked(readTextFile).mockReturnValueOnce(read.promise).mockResolvedValueOnce('newest');
    const { watcher, onExternalChange, onFileDeleted } = setup();
    await watcher.watchFile(path, 'initial');
    handlerAt(0)(event);
    handlerAt(0)(event);
    await flush();
    if (outcome === 'resolve') read.resolve('obsolete'); else read.reject(new Error('obsolete failure'));
    await flush();
    expect(onExternalChange).toHaveBeenCalledExactlyOnceWith(path, 'newest');
    expect(onFileDeleted).not.toHaveBeenCalled();
  });

  it.each(['start', 'end', 'known', 'abort'])('invalidates a pending read on %s', async (action) => {
    const read = deferred<string>();
    vi.mocked(readTextFile).mockReturnValueOnce(read.promise);
    const { watcher, onExternalChange } = setup();
    await watcher.watchFile(path, 'initial');
    handlerAt(0)(event);
    if (action === 'start') watcher.markSaveStart(path);
    if (action === 'end') watcher.markSaveEnd(path, 'saved');
    if (action === 'known') watcher.updateKnownContent(path, 'accepted');
    if (action === 'abort') watcher.markSaveAbort(path);
    read.resolve('obsolete');
    await flush();
    expect(onExternalChange).not.toHaveBeenCalled();
  });

  it('save abort releases suppression without changing known disk bytes', async () => {
    const { watcher, onExternalChange } = setup();
    await watcher.watchFile(path, 'original');
    watcher.markSaveStart(path);
    handlerAt(0)(event);
    expect(readTextFile).not.toHaveBeenCalled();
    watcher.markSaveAbort(path);
    vi.mocked(readTextFile).mockResolvedValueOnce('original');
    handlerAt(0)(event);
    await flush();
    expect(onExternalChange).not.toHaveBeenCalled();
    vi.mocked(readTextFile).mockResolvedValueOnce('external');
    handlerAt(0)(event);
    await flush();
    expect(onExternalChange).toHaveBeenCalledExactlyOnceWith(path, 'external');
  });

  it('detects an external edit immediately after successful save', async () => {
    const { watcher, onExternalChange } = setup();
    await watcher.watchFile(path, 'original');
    watcher.markSaveStart(path);
    watcher.markSaveEnd(path, 'saved');
    vi.mocked(readTextFile).mockResolvedValueOnce('external');
    handlerAt(0)(event);
    await flush();
    expect(onExternalChange).toHaveBeenCalledExactlyOnceWith(path, 'external');
  });

  it('reports callback exceptions as watch errors, never file deletion', async () => {
    const { watcher, onExternalChange, onFileDeleted, onWatchError } = setup();
    const error = new Error('render failed');
    onExternalChange.mockImplementation(() => { throw error; });
    await watcher.watchFile(path, 'original');
    handlerAt(0)(event);
    await flush();
    expect(onWatchError).toHaveBeenCalledExactlyOnceWith(path, error);
    expect(onFileDeleted).not.toHaveBeenCalled();
  });
});
