import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
  drop: null as null | ((id: string, pane: string, path: string | null) => Promise<void>),
  state: null as any,
  message: vi.fn(),
  writeTextFile: vi.fn(),
  createNewWindow: vi.fn(),
  closeCurrentWindow: vi.fn(),
  unregisterOpenFile: vi.fn(),
  getAllWindows: vi.fn(),
  getCurrentWindowLabel: vi.fn(),
  transferTabToWindow: vi.fn(),
  removeTabWithoutCreate: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: mocks.writeTextFile }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: mocks.message }));
vi.mock('../../components/EditorPane.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../../composables/useWindowManager', () => ({ useWindowManager: () => mocks }));
vi.mock('../../composables/useSplitView', () => ({ useSplitView: () => ({
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
});
