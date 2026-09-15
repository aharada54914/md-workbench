import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeDrop } from '../../services/nativeFs';

const mocks = vi.hoisted(() => ({ listen: vi.fn(), takeDrops: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../services/nativeFs', () => ({ nativeFs: { takeDrops: mocks.takeDrops } }));
import { useNativeDrops } from '../../composables/useNativeDrops';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function drop(id: string): NativeDrop {
  return { id, grants: [], errors: [], position: { x: 10, y: 20 } };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('native drop consumer', () => {
  let wake: (payload?: unknown) => void;
  let unlisten: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetAllMocks();
    unlisten = vi.fn();
    mocks.listen.mockImplementation(async (_event, handler) => { wake = handler; return unlisten; });
    mocks.takeDrops.mockResolvedValue([]);
  });

  function consumer() {
    const handleDrop = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    return { ...useNativeDrops({ handleDrop, onError }), handleDrop, onError };
  }

  it('drains startup drops once after registering the listener, preserving host order', async () => {
    mocks.takeDrops.mockResolvedValueOnce([drop('a'), drop('b')]);
    const c = consumer();
    await c.start();
    await c.start();
    expect(mocks.listen).toHaveBeenCalledExactlyOnceWith('native-drops-pending', expect.any(Function));
    expect(c.handleDrop.mock.calls.map(([item]) => [item])).toEqual([[drop('a')], [drop('b')]]);
    expect(mocks.takeDrops).toHaveBeenCalledExactlyOnceWith();
  });

  it('treats renderer events only as wakeups, never as grants or paths', async () => {
    const c = consumer();
    await c.start();
    wake({ payload: { paths: ['/forged.md'], grants: [{ path: '/forged.md' }] } });
    await flush();
    expect(c.handleDrop).not.toHaveBeenCalled();
    expect(mocks.takeDrops.mock.calls).toEqual([[], []]);
  });

  it('serializes drops and redrains when another notification arrives during handling', async () => {
    const first = deferred<void>();
    mocks.takeDrops.mockResolvedValueOnce([drop('a'), drop('b')]).mockResolvedValueOnce([drop('c')]);
    const c = consumer();
    c.handleDrop.mockImplementationOnce(() => first.promise);
    const started = c.start();
    await flush();
    wake(); wake();
    expect(mocks.takeDrops).toHaveBeenCalledTimes(1);
    expect(c.handleDrop).toHaveBeenCalledTimes(1);
    first.resolve();
    await started;
    expect(c.handleDrop.mock.calls.map(([item]) => [item])).toEqual([[drop('a')], [drop('b')], [drop('c')]]);
    expect(mocks.takeDrops).toHaveBeenCalledTimes(2);
  });

  it('redrains a wakeup received while the host read is pending', async () => {
    const read = deferred<NativeDrop[]>();
    mocks.takeDrops.mockReturnValueOnce(read.promise).mockResolvedValueOnce([drop('later')]);
    const c = consumer();
    const started = c.start();
    await flush();
    wake();
    read.resolve([]);
    await started;
    expect(c.handleDrop).toHaveBeenCalledExactlyOnceWith(drop('later'), expect.any(Function));
  });

  it('reports a consumer failure and continues the remaining completed selections', async () => {
    const error = new Error('open failed');
    mocks.takeDrops.mockResolvedValueOnce([drop('bad'), drop('good')]);
    const c = consumer();
    c.handleDrop.mockRejectedValueOnce(error);
    await c.start();
    expect(c.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(c.handleDrop.mock.calls.map(([item]) => [item])).toEqual([[drop('bad')], [drop('good')]]);
  });

  it('reports a host denial and retries only when another wakeup arrives', async () => {
    const error = { code: 'permission_required' };
    mocks.takeDrops.mockRejectedValueOnce(error).mockResolvedValueOnce([drop('selected')]);
    const c = consumer();
    await c.start();
    expect(c.onError).toHaveBeenCalledExactlyOnceWith(error);
    wake();
    await flush();
    expect(c.handleDrop).toHaveBeenCalledExactlyOnceWith(drop('selected'), expect.any(Function));
  });

  it('disposes a late listener and allows restart without draining the obsolete session', async () => {
    const registration = deferred<() => void>();
    const oldUnlisten = vi.fn();
    mocks.listen.mockReturnValueOnce(registration.promise);
    const c = consumer();
    const oldStart = c.start();
    c.stop();
    await c.start();
    registration.resolve(oldUnlisten);
    await oldStart;
    expect(oldUnlisten).toHaveBeenCalledOnce();
    expect(mocks.takeDrops).toHaveBeenCalledTimes(1);
    c.stop(); c.stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('ignores late reads and stale notifications after stop or restart', async () => {
    const read = deferred<NativeDrop[]>();
    mocks.takeDrops.mockReturnValueOnce(read.promise);
    const c = consumer();
    const oldStart = c.start();
    await flush();
    const oldWake = wake;
    c.stop();
    await c.start();
    oldWake();
    read.resolve([drop('obsolete')]);
    await oldStart;
    expect(c.handleDrop).not.toHaveBeenCalled();
    expect(mocks.takeDrops).toHaveBeenCalledTimes(2);
  });

  it('does not handle the rest of a drained batch after stop', async () => {
    const handling = deferred<void>();
    mocks.takeDrops.mockResolvedValueOnce([drop('first'), drop('obsolete')]);
    const c = consumer();
    c.handleDrop.mockReturnValueOnce(handling.promise);
    const started = c.start();
    await flush();
    const isCurrent = c.handleDrop.mock.calls[0][1];
    expect(isCurrent()).toBe(true);
    c.stop();
    expect(isCurrent()).toBe(false);
    handling.reject(new Error('late failure'));
    await started;
    expect(c.handleDrop).toHaveBeenCalledTimes(1);
    expect(c.onError).not.toHaveBeenCalled();
  });

  it('reports listener failure and permits a subsequent start', async () => {
    const error = new Error('listen failed');
    mocks.listen.mockRejectedValueOnce(error);
    const c = consumer();
    await c.start();
    expect(c.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(mocks.takeDrops).not.toHaveBeenCalled();
    await c.start();
    expect(mocks.takeDrops).toHaveBeenCalledOnce();
  });
});
