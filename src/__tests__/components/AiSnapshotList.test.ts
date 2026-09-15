import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
const ipc = vi.hoisted(() => ({ list: vi.fn(), restore: vi.fn() }));
vi.mock('../../services/aiCommands', () => ({ aiCommands: { snapshotList: ipc.list, snapshotRestore: ipc.restore } }));
import AiSnapshotList from '../../components/ai/AiSnapshotList.vue';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const entry = (id: string) => ({ id, ts: '2026-01-01', byteSize: 2, pinned: false });
beforeEach(() => { vi.clearAllMocks(); ipc.list.mockResolvedValue([entry('a')]); });
describe('snapshot restore origin', () => {
  it('sends the selected id and loaded path synchronously before any restore I/O', async () => {
    const wrapper = mount(AiSnapshotList, { props: { docPath: '/a.md' } });
    await flushPromises();
    await wrapper.get('.ai-snap-card__btn--primary').trigger('click');
    expect(wrapper.emitted('restoreRequested')).toEqual([[{ id: 'a', path: '/a.md' }]]);
    expect(ipc.restore).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it('refreshes the current list once a restore finishes', async () => {
    const wrapper = mount(AiSnapshotList, { props: { docPath: '/a.md', restoring: true } });
    await flushPromises();
    await wrapper.setProps({ restoring: false }); await flushPromises();
    expect(ipc.list).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
  it('does not adopt an old list response for a newly selected path', async () => {
    const old = deferred<ReturnType<typeof entry>[]>();
    ipc.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([entry('b')]);
    const wrapper = mount(AiSnapshotList, { props: { docPath: '/a.md' } });
    await wrapper.setProps({ docPath: '/b.md' });
    await flushPromises();
    old.resolve([entry('a')]); await flushPromises();
    await wrapper.get('.ai-snap-card__btn--primary').trigger('click');
    expect(wrapper.emitted('restoreRequested')).toEqual([[{ id: 'b', path: '/b.md' }]]);
    wrapper.unmount();
  });
});
