import { beforeEach, afterEach, vi } from 'vitest';
vi.mock('../../services/nativeFs', () => ({
  MAX_NATIVE_READ_BYTES: 64 * 1024 * 1024,
  nativeFs: { resolveDocumentReadGrant: vi.fn(), subscribeWatch: vi.fn(), readWatchBytes: vi.fn(), unsubscribeWatch: vi.fn() },
}));
import { nativeFs } from '../../services/nativeFs';
import { useFileWatcher, type UseFileWatcherOptions } from '../../composables/useFileWatcher';
export const mockNativeFs = nativeFs;
export const bytes = (s: string) => new TextEncoder().encode(s);
export const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
export const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const instances: ReturnType<typeof useFileWatcher>[] = [];
export const disk = new Map<string, string>();
export function setup(extra: Partial<UseFileWatcherOptions> = {}) {
  const onExternalChange = vi.fn();
  const onFileDeleted = vi.fn();
  const onWatchError = vi.fn();
  const onWatchReady = vi.fn();
  const watcher = useFileWatcher({ onExternalChange, onFileDeleted, onWatchError, onWatchReady, ...extra });
  instances.push(watcher);
  return { watcher, onExternalChange, onFileDeleted, onWatchError, onWatchReady };
}
let clockEpoch = 0;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(clockEpoch += 1_000_000); vi.resetAllMocks(); disk.clear();
  let serial = 0;
  const paths = new Map<string, string>();
  vi.mocked(nativeFs.resolveDocumentReadGrant).mockResolvedValue({ grantId: 'current-grant' });
  vi.mocked(nativeFs.subscribeWatch).mockImplementation(async (path, grantId) => {
    const id = `watch-${++serial}`; paths.set(id, path); return { id, grantId };
  });
  vi.mocked(nativeFs.readWatchBytes).mockImplementation(async id => bytes(disk.get(paths.get(id) ?? '') ?? 'disk'));
  vi.mocked(nativeFs.unsubscribeWatch).mockResolvedValue(undefined);
});
afterEach(async () => {
  instances.splice(0).forEach(watcher => watcher.unwatchAll());
  await flush(); await tick(0); vi.useRealTimers();
});
