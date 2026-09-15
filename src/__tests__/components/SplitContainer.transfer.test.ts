import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, shallowMount } from '@vue/test-utils';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
  drop: null as null | ((id: string, pane: string, path: string | null) => Promise<void>),
  state: null as any,
  localImages: false,
  message: vi.fn(),
  writeTextFile: vi.fn(),
  createNewWindow: vi.fn(),
  closeCurrentWindow: vi.fn(),
  unregisterOpenFile: vi.fn(),
  registerOpenFile: vi.fn(),
  getAllWindows: vi.fn(),
  getCurrentWindowLabel: vi.fn(),
  transferTabToWindow: vi.fn(),
  removeTabWithoutCreate: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: mocks.writeTextFile }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: mocks.message }));
vi.mock('../../components/EditorPane.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../composables/useWindowManager', () => ({ useWindowManager: () => mocks }));
vi.mock('../../composables/useSplitView', () => ({ tabHasLocalImages: () => mocks.localImages, useSplitView: () => ({
  splitState: mocks.state,
  isSplitActive: ref(false),
  activePaneId: ref('left'),
  leftPane: ref(mocks.state.value.panes[0]),
  rightPane: ref(null),
  removeTabWithoutCreate: mocks.removeTabWithoutCreate,
  isWindowEmpty: () => false,
}) }));
vi.mock('../../composables/useTabDrag', () => ({ useTabDrag: () => ({
  setOnDrop: vi.fn(),
  setOnDropOutside: (callback: typeof mocks.drop) => { mocks.drop = callback; },
}) }));
import SplitContainer from '../../components/SplitContainer.vue';

describe('cross-window tab transfer preserves source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localImages = false;
    mocks.state = ref({ panes: [{ id: 'left', activeTabId: 'a', tabs: [{
      id: 'a', filePath: '/docs/a.md', fileName: 'a.md', hasChanges: false,
      content: '<p>A normalized display copy</p>',
      originalMarkdown: '\uFEFF# Original\r\n\r\n:::unknown  \r\n', scrollTop: 0,
    }] }], splitRatio: 0.5 });
    mocks.getCurrentWindowLabel.mockResolvedValue('main');
    mocks.getAllWindows.mockResolvedValue(['main']);
    mocks.createNewWindow.mockResolvedValue('window-1');
    mocks.transferTabToWindow.mockResolvedValue(undefined);
  });

  async function drop(path = '/docs/a.md') {
    const wrapper = shallowMount(SplitContainer);
    try { await mocks.drop!('a', 'left', path); } finally { wrapper.unmount(); }
  }

  it('moves a clean file without serializing or writing its BOM/CRLF/unknown source', async () => {
    const source = mocks.state.value.panes[0].tabs[0].originalMarkdown;
    await drop();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(mocks.createNewWindow).toHaveBeenCalledWith('/docs/a.md');
    expect(mocks.removeTabWithoutCreate).toHaveBeenCalledWith('left', 'a');
    expect(mocks.state.value.panes[0].tabs[0].originalMarkdown).toBe(source);
  });

  it('keeps dirty edits and asks for a normal explicit save before transfer', async () => {
    mocks.state.value.panes[0].tabs[0].hasChanges = true;
    await drop();
    expect(mocks.message).toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(mocks.unregisterOpenFile).not.toHaveBeenCalled();
    expect(mocks.createNewWindow).not.toHaveBeenCalled();
    expect(mocks.removeTabWithoutCreate).not.toHaveBeenCalled();
    expect(mocks.state.value.panes[0].tabs[0].hasChanges).toBe(true);
  });

  it('rejects a stale drag path before any transfer', async () => {
    await drop('/docs/another.md');
    expect(mocks.unregisterOpenFile).not.toHaveBeenCalled();
    expect(mocks.createNewWindow).not.toHaveBeenCalled();
  });

  it('keeps edits arriving while the window list is pending', async () => {
    mocks.getAllWindows.mockImplementationOnce(async () => {
      mocks.state.value.panes[0].tabs[0].hasChanges = true;
      return ['main'];
    });
    await drop();
    expect(mocks.unregisterOpenFile).not.toHaveBeenCalled();
    expect(mocks.removeTabWithoutCreate).not.toHaveBeenCalled();
  });

  it('does not remove newer edits while the native transfer is pending', async () => {
    mocks.getAllWindows.mockResolvedValueOnce(['main', 'window-1']);
    mocks.transferTabToWindow.mockImplementationOnce(async () => {
      mocks.state.value.panes[0].tabs[0].content = '<p>New user edit</p>';
      mocks.state.value.panes[0].tabs[0].hasChanges = true;
    });
    await drop();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
    expect(mocks.removeTabWithoutCreate).not.toHaveBeenCalled();
    expect(mocks.state.value.panes[0].tabs[0].hasChanges).toBe(true);
  });

  it('keeps registration and tab until native target ACK resolves, ignoring duplicate drags', async () => {
    let acknowledge!: () => void;
    mocks.createNewWindow.mockImplementationOnce(() => new Promise<string>(resolve => {
      acknowledge = () => resolve('window-1');
    }));
    const wrapper = shallowMount(SplitContainer);
    const transfer = mocks.drop!('a', 'left', '/docs/a.md');
    await flushPromises();
    await mocks.drop!('a', 'left', '/docs/a.md');
    expect(mocks.createNewWindow).toHaveBeenCalledTimes(1);
    expect(mocks.unregisterOpenFile).not.toHaveBeenCalled();
    expect(mocks.removeTabWithoutCreate).not.toHaveBeenCalled();
    acknowledge();
    await transfer;
    expect(mocks.unregisterOpenFile).toHaveBeenCalledWith('/docs/a.md');
    expect(mocks.removeTabWithoutCreate).toHaveBeenCalledWith('left', 'a');
    wrapper.unmount();
  });

  it.each(['transfer_timeout', 'target_destroyed', 'transfer_rejected'])('keeps source and reports %s', async reason => {
    mocks.createNewWindow.mockRejectedValueOnce(new Error(reason));
    await drop();
    expect(mocks.unregisterOpenFile).not.toHaveBeenCalled();
    expect(mocks.removeTabWithoutCreate).not.toHaveBeenCalled();
    expect(mocks.message).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: 'error' }));
  });

  it('keeps pending raw changes even before hasChanges has propagated', async () => {
    mocks.createNewWindow.mockImplementationOnce(async () => {
      mocks.state.value.panes[0].tabs[0].pendingMarkdown = 'New raw source';
      return 'window-1';
    });
    await drop();
    expect(mocks.unregisterOpenFile).not.toHaveBeenCalled();
    expect(mocks.removeTabWithoutCreate).not.toHaveBeenCalled();
  });

  it('restores source registration when edits arrive during final unregister', async () => {
    mocks.unregisterOpenFile.mockImplementationOnce(async () => {
      mocks.state.value.panes[0].tabs[0].pendingMarkdown = 'Edit while unregister awaits';
    });
    await drop();
    expect(mocks.registerOpenFile).toHaveBeenCalledWith('/docs/a.md', 'main');
    expect(mocks.removeTabWithoutCreate).not.toHaveBeenCalled();
    expect(mocks.closeCurrentWindow).not.toHaveBeenCalled();
  });

  it('keeps committed or pending local images in the source window before transfer', async () => {
    mocks.localImages = true;
    await drop();
    expect(mocks.getAllWindows).not.toHaveBeenCalled();
    expect(mocks.createNewWindow).not.toHaveBeenCalled();
    expect(mocks.removeTabWithoutCreate).not.toHaveBeenCalled();
    expect(mocks.message).toHaveBeenCalledWith(expect.stringContaining('imported images'), expect.objectContaining({kind: 'info'}));
  });

  it.each(['list', 'transfer', 'unregister'])('keeps imports that start while %s is pending', async stage => {
    if (stage === 'list') mocks.getAllWindows.mockImplementationOnce(async () => { mocks.localImages = true; return ['main']; });
    if (stage === 'transfer') mocks.createNewWindow.mockImplementationOnce(async () => { mocks.localImages = true; return 'window-1'; });
    if (stage === 'unregister') mocks.unregisterOpenFile.mockImplementationOnce(async () => { mocks.localImages = true; });
    await drop();
    expect(mocks.removeTabWithoutCreate).not.toHaveBeenCalled();
    expect(mocks.closeCurrentWindow).not.toHaveBeenCalled();
    expect(mocks.message).toHaveBeenCalledWith(expect.stringContaining('imported images'), expect.objectContaining({kind: 'info'}));
    if (stage === 'unregister') expect(mocks.registerOpenFile).toHaveBeenCalledWith('/docs/a.md', 'main');
  });

});
