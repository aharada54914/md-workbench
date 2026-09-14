import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { Tab } from '../../composables/useTabs';
const native = vi.hoisted(() => ({
  close: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  destroy: vi.fn(),
  exit: vi.fn(),
  write: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  destroy: native.destroy,
  onCloseRequested: async (callback: typeof native.close) => { native.close = callback; return () => {}; },
}) }));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: native.exit }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: native.write }));
import { useCloseConfirmation } from '../../composables/useCloseConfirmation';

function tab(id: string): Tab {
  return { id, filePath: '/docs/' + id + '.md', fileName: id, content: '<p>display</p>',
    originalMarkdown: '\uFEFF# Original\r\n', hasChanges: true, scrollTop: 0 };
}
async function setup(initial = [tab('a')]) {
  const tabs = ref(initial);
  const saveTab = vi.fn(async (document: Tab) => { document.hasChanges = false; return true; });
  const switchToTab = vi.fn(async (_id: string) => {});
  const controller = useCloseConfirmation({ tabs, saveTab, switchToTab });
  await controller.setupCloseHandler();
  const preventDefault = vi.fn();
  await native.close!({ preventDefault });
  return { ...controller, tabs, saveTab, switchToTab, preventDefault };
}
beforeEach(() => { vi.clearAllMocks(); native.destroy.mockResolvedValue(undefined); });

describe('native close uses normal save and preserves unsaved documents', () => {
  it('delegates save after awaited selection and destroys only this window', async () => {
    const state = await setup();
    await state.handleSave();
    expect(state.preventDefault).toHaveBeenCalled();
    expect(state.saveTab).toHaveBeenCalledWith(state.tabs.value[0]);
    const selectionOrder = state.switchToTab.mock.invocationCallOrder;
    expect(selectionOrder[selectionOrder.length - 1]).toBeLessThan(state.saveTab.mock.invocationCallOrder[0]);
    expect(native.write).not.toHaveBeenCalled();
    expect(native.exit).not.toHaveBeenCalled();
    expect(native.destroy).toHaveBeenCalledOnce();
  });
  it.each(['cancel', 'error'])('keeps the document on save %s', async (outcome) => {
    const state = await setup();
    if (outcome === 'error') state.saveTab.mockRejectedValueOnce(new Error('read failed'));
    else state.saveTab.mockResolvedValueOnce(false);
    await state.handleSave();
    expect(state.showSaveConfirmDialog.value).toBe(true);
    expect(state.tabs.value[0].hasChanges).toBe(true);
    expect(native.destroy).not.toHaveBeenCalled();
    expect(native.write).not.toHaveBeenCalled();
  });
  it('cancel after discarding one tab preserves that earlier tab and its dirty flag', async () => {
    const state = await setup([tab('left'), tab('right')]);
    await state.handleDiscard();
    expect(state.currentTabToSave.value?.tab.id).toBe('right');
    state.handleCancel();
    expect(state.tabs.value.every(document => document.hasChanges)).toBe(true);
    expect(native.destroy).not.toHaveBeenCalled();
    await native.close!({ preventDefault: vi.fn() });
    expect(state.currentTabToSave.value?.tab.id).toBe('left');
  });
  it('cancel during an in-flight save prevents the later completion from closing', async () => {
    const state = await setup();
    let finish!: () => void;
    state.saveTab.mockImplementationOnce(document => new Promise(resolve => {
      finish = () => { document.hasChanges = false; resolve(true); };
    }));
    const saving = state.handleSave();
    await vi.waitFor(() => expect(finish).toBeDefined());
    state.handleCancel();
    finish();
    await saving;
    expect(native.destroy).not.toHaveBeenCalled();
  });
  it('a successful callback cannot close while newer dirty state remains', async () => {
    const state = await setup();
    state.saveTab.mockResolvedValueOnce(true);
    await state.handleSave();
    expect(state.showSaveConfirmDialog.value).toBe(true);
    expect(native.destroy).not.toHaveBeenCalled();
  });
  it('keeps the window if synchronization fails', async () => {
    const controller = useCloseConfirmation({
      tabs: ref([tab('a')]), saveTab: vi.fn(), switchToTab: vi.fn(),
      syncActiveTabContent: () => { throw new Error('unmounted editor'); },
    });
    await controller.setupCloseHandler();
    const preventDefault = vi.fn();
    await native.close!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(native.destroy).not.toHaveBeenCalled();
  });
});
