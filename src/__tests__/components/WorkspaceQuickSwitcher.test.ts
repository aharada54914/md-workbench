import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import WorkspaceQuickSwitcher from '../../components/WorkspaceQuickSwitcher.vue';
import { workspaceFs, type ContentSearchHit } from '../../services/workspaceFs';
import type { OpenWorkspaceEntry } from '../../composables/useSettings';

const state = vi.hoisted(() => ({ workspace: {} }));
vi.mock('../../composables/useWorkspace', () => ({ useWorkspace: () => state.workspace }));
vi.mock('../../services/workspaceFs', () => ({ workspaceFs: { searchContent: vi.fn() } }));
vi.mock('../../i18n', async () => {
  const { ref } = await import('vue');
  return { useI18n: () => ({ t: ref({
  qsContentPermissionRequired: 'Select the workspace again',
  qsContentLimitExceeded: 'Use a more specific query or smaller workspace',
  qsContentFailed: 'Content search could not finish',
  workspaceQuickSwitcherNoMatches: 'No matches',
}) }) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const hit = (snippet: string): ContentSearchHit => ({ path: '/work/doc.md', line: 1, snippet });
const roots = ref<OpenWorkspaceEntry[]>([]);
let wrapper: VueWrapper;
async function search(query: string) {
  await wrapper.get('input').setValue(query);
  await vi.advanceTimersByTimeAsync(150);
  await nextTick();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(workspaceFs.searchContent).mockReset().mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  roots.value = [{ id: 'w1', name: 'work', rootPath: '/work' }];
  state.workspace = {
    openWorkspaces: roots, recentWorkspaces: ref([]), highlightedPath: ref(null),
    treesById: ref({}), findOwningWorkspace: () => null,
  };
  wrapper = mount(WorkspaceQuickSwitcher, { global: { stubs: { teleport: true } } });
});
afterEach(() => { wrapper.unmount(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('native content search feedback', () => {
  it('shows searching during debounce instead of a premature no-matches state', async () => {
    await wrapper.get('input').setValue('needle');
    expect(wrapper.find('.qs-spinner').exists()).toBe(true);
    expect(wrapper.find('.qs-empty').exists()).toBe(false);
    expect(workspaceFs.searchContent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150); await nextTick();
    expect(wrapper.find('.qs-spinner').exists()).toBe(false);
    expect(wrapper.get('.qs-empty').text()).toBe('No matches');
  });

  it.each([
    ['permission_required', 'Select the workspace again'],
    ['file_too_large', 'Use a more specific query or smaller workspace'],
    ['filesystem_error', 'Content search could not finish'],
    ['unknown', 'Content search could not finish'],
  ])('shows %s as an error instead of no matches', async (code, message) => {
    vi.mocked(workspaceFs.searchContent).mockRejectedValue({ code });
    await search('needle');
    expect(wrapper.get('[role="alert"]').text()).toBe(message);
    expect(wrapper.find('.qs-empty').exists()).toBe(false);
    expect(wrapper.find('.qs-spinner').exists()).toBe(false);
    expect(workspaceFs.searchContent).toHaveBeenCalledExactlyOnceWith(['/work'], 'needle');
  });

  it('accepts exactly 200 completed hits without a false truncation warning', async () => {
    vi.mocked(workspaceFs.searchContent).mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ ...hit('needle'), line: i + 1 })),
    );
    await search('needle');
    expect(wrapper.findAll('.qs-item-content')).toHaveLength(200);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('.qs-truncated').exists()).toBe(false);
  });

  it.each(['', 'x'])('discards an in-flight result immediately after query becomes "%s"', async (query) => {
    const pending = deferred<ContentSearchHit[]>();
    vi.mocked(workspaceFs.searchContent).mockReturnValue(pending.promise);
    await search('needle');
    await wrapper.get('input').setValue(query);
    pending.resolve([hit('stale needle')]);
    await nextTick(); await nextTick();
    expect(wrapper.findAll('.qs-item-content')).toHaveLength(0);
    expect(wrapper.find('.qs-spinner').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(workspaceFs.searchContent).toHaveBeenCalledTimes(1);
  });

  it('ignores an old rejection during the next query debounce and clears prior errors', async () => {
    const pending = deferred<ContentSearchHit[]>();
    vi.mocked(workspaceFs.searchContent).mockReturnValueOnce(pending.promise).mockResolvedValueOnce([hit('current')]);
    await search('needle');
    await wrapper.get('input').setValue('current');
    pending.reject({ code: 'permission_required' });
    await nextTick(); await nextTick();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(150); await nextTick();
    expect(wrapper.get('.qs-item-snippet').text()).toBe('current');
    vi.mocked(workspaceFs.searchContent).mockRejectedValueOnce({ code: 'file_too_large' });
    await search('limit');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    await wrapper.get('input').setValue('ok');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.findAll('.qs-item-content')).toHaveLength(0);
  });

  it('invalidates old results when workspace roots change and searches the current roots', async () => {
    const pending = deferred<ContentSearchHit[]>();
    vi.mocked(workspaceFs.searchContent).mockReturnValueOnce(pending.promise).mockResolvedValueOnce([]);
    await search('needle');
    roots.value = [{ id: 'w2', name: 'new', rootPath: '/new' }];
    await nextTick();
    pending.resolve([hit('old root')]);
    await nextTick(); await nextTick();
    expect(wrapper.findAll('.qs-item-content')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(workspaceFs.searchContent).toHaveBeenLastCalledWith(['/new'], 'needle');
    roots.value = [];
    await nextTick(); await vi.advanceTimersByTimeAsync(150);
    expect(workspaceFs.searchContent).toHaveBeenCalledTimes(2);
  });
});
