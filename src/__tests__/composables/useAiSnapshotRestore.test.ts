import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, reactive, shallowRef } from 'vue';
import { flushPromises } from '@vue/test-utils';
const ipc = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { list: vi.fn(), restore: vi.fn(), write: vi.fn(),
    importGate: { promise, resolve }, importStarted: vi.fn() };
});
vi.mock('../../services/aiCommands', () => ({ aiCommands: { snapshotList: ipc.list, snapshotRestore: ipc.restore } }));
vi.mock('@tauri-apps/plugin-fs', async () => {
  ipc.importStarted();
  await ipc.importGate.promise;
  return { writeTextFile: ipc.write };
});
import { useAiSnapshotRestore, useAiSnapshotTarget } from '../../composables/useAiSnapshotRestore';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const scopes: ReturnType<typeof effectScope>[] = [];
function setup() {
  const state = reactive({ path: '/a.md', text: 'original', enabled: true, source: 'raw' });
  const document = shallowRef<object>({ id: 'same-id' });
  const apply = vi.fn();
  const scope = effectScope(); scopes.push(scope);
  const { capture, operation } = scope.run(() => {
    const capture = useAiSnapshotTarget(() => ({ document: document.value, path: state.path,
      enabled: state.enabled, revisionInputs: [state.text, state.source] }), apply);
    return { capture, operation: useAiSnapshotRestore(capture) };
  })!;
  return { state, document, apply, capture, operation, scope };
}
beforeEach(() => {
  vi.clearAllMocks();
  ipc.list.mockResolvedValue([{ id: 'old', ts: '2025' }, { id: 'latest', ts: '2026' }]);
  ipc.restore.mockResolvedValue('snapshot'); ipc.write.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.restoreAllMocks(); });
describe('guarded AI snapshot restoration', () => {
  it('rejects an identity change while the real dynamic fs import is pending', async () => {
    const h = setup();
    const work = h.operation.restore({ id: 'selected', path: '/a.md' });
    const result = expect(work).rejects.toThrow('document changed');
    await flushPromises();
    expect(ipc.importStarted).toHaveBeenCalledOnce();
    h.state.path = '/b.md';
    ipc.importGate.resolve();
    await result;
    expect(ipc.write).not.toHaveBeenCalled(); expect(h.apply).not.toHaveBeenCalled();
  });
  it('restores the latest snapshot to the captured path and applies once', async () => {
    const h = setup(); await h.operation.restore();
    expect(ipc.list).toHaveBeenCalledWith('/a.md');
    expect(ipc.restore).toHaveBeenCalledWith('/a.md', 'latest');
    expect(ipc.write).toHaveBeenCalledWith('/a.md', 'snapshot');
    expect(h.apply).toHaveBeenCalledExactlyOnceWith('snapshot');
  });
  it('cancels before restore when identity changes during pending list', async () => {
    const h = setup(), pending = deferred<[]>(); ipc.list.mockReturnValue(pending.promise);
    const result = expect(h.operation.restore()).rejects.toThrow('document changed');
    h.document.value = { id: 'same-id' }; pending.resolve([]); await result;
    expect(ipc.restore).not.toHaveBeenCalled(); expect(ipc.write).not.toHaveBeenCalled();
  });
  it.each(['edit', 'source', 'path', 'close', 'identity', 'switch-back', 'edit-back', 'unmount'])('rejects %s during content read before writing', async change => {
    const h = setup(), pending = deferred<string>(); ipc.restore.mockReturnValue(pending.promise);
    const result = expect(h.operation.restore({ id: 'selected', path: '/a.md' })).rejects.toThrow('document changed');
    if (change === 'edit') h.state.text = 'new edit';
    if (change === 'source') h.state.source = 'new raw edit';
    if (change === 'path') h.state.path = '/saved-as.md';
    if (change === 'close') h.state.enabled = false;
    if (change === 'identity') h.document.value = { id: 'same-id' };
    if (change === 'switch-back') { const original = h.document.value; h.document.value = {}; h.document.value = original; }
    if (change === 'edit-back') { h.state.text = 'new edit'; h.state.text = 'original'; }
    if (change === 'unmount') h.scope.stop();
    pending.resolve('snapshot'); await result;
    expect(ipc.restore).toHaveBeenCalledWith('/a.md', 'selected');
    expect(ipc.write).not.toHaveBeenCalled(); expect(h.apply).not.toHaveBeenCalled();
  });
  it('keeps an in-flight write bound to its original path but does not apply stale results', async () => {
    const h = setup(), pending = deferred<void>(); ipc.write.mockReturnValue(pending.promise);
    const result = expect(h.operation.restore({ id: 'selected', path: '/a.md' })).rejects.toThrow('Snapshot was written to its original file');
    await flushPromises(); expect(ipc.write).toHaveBeenCalledWith('/a.md', 'snapshot');
    h.state.path = '/b.md'; h.state.text = 'new edit'; pending.resolve(); await result;
    expect(ipc.write).toHaveBeenCalledTimes(1); expect(h.apply).not.toHaveBeenCalled();
  });
  it('serializes restore attempts while a write is pending', async () => {
    const h = setup(), pending = deferred<void>(); ipc.write.mockReturnValue(pending.promise);
    const work = h.operation.restore({ id: 'first', path: '/a.md' }); await flushPromises();
    await h.operation.restore({ id: 'second', path: '/a.md' });
    expect(ipc.restore).toHaveBeenCalledTimes(1);
    pending.resolve(); await work;
    expect(h.operation.restoring.value).toBe(false);
  });
  it('rejects stale list selections and missing saved targets before any I/O', async () => {
    const h = setup();
    await expect(h.operation.restore({ id: 'a', path: '/b.md' })).rejects.toThrow('document changed');
    h.state.path = ''; await expect(h.operation.restore()).rejects.toThrow('document changed');
    expect(ipc.list).not.toHaveBeenCalled(); expect(ipc.restore).not.toHaveBeenCalled();
  });
  it('preserves cancellation and write failures without applying or sticking busy', async () => {
    const h = setup(); vi.mocked(window.confirm).mockReturnValue(false);
    await h.operation.restore(); expect(ipc.restore).not.toHaveBeenCalled();
    ipc.write.mockRejectedValue(new Error('denied'));
    await expect(h.operation.restore({ id: 'a', path: '/a.md' })).rejects.toThrow('denied');
    expect(h.apply).not.toHaveBeenCalled(); expect(h.operation.restoring.value).toBe(false);
  });
  it('checks the captured target again when apply is invoked directly', () => {
    const h = setup(), target = h.capture()!;
    h.state.text = 'edited'; expect(() => target.apply('stale')).toThrow('document changed');
    expect(h.apply).not.toHaveBeenCalled();
  });
});
