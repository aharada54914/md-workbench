import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import type { Tab } from '../../composables/useTabs';

vi.mock('../../services/documentText', () => ({ readTextFile: vi.fn() }));
const { updateKnownContent } = vi.hoisted(() => ({ updateKnownContent: vi.fn() }));
vi.mock('../../composables/useFileWatcher', () => ({ useFileWatcher: () => ({
  updateKnownContent, watchFile: vi.fn(), unwatchFile: vi.fn(), unwatchAll: vi.fn(),
  markSaveStart: vi.fn(), markSaveEnd: vi.fn(), markSaveAbort: vi.fn(),
}) }));
vi.mock('../../utils/markdown-converter', () => ({ markdownToHtml: (md: string) => `<p>${md}</p>` }));
import { useFileReload } from '../../composables/useFileReload';
import { readTextFile } from '../../services/documentText';

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const tab: Tab = { id: 'a', filePath: '/a.md', fileName: 'a.md', content: '<p>old</p>',
    originalMarkdown: 'old', pendingMarkdown: 'old', hasChanges: false, scrollTop: 0 };
  const pane = { id: 'left', activeTabId: tab.id, tabs: [tab] };
  const currentFile = ref<string | null>(tab.filePath);
  const setEditorContent = vi.fn();
  const reload = useFileReload({ activePaneId: ref('left'), currentFile: computed(() => currentFile.value),
    hasChanges: computed(() => tab.hasChanges), setEditorContent,
    activeTab: computed(() => pane.tabs.find(item => item.id === pane.activeTabId)),
    findTabByFilePathSplit: (path: string, expectedTab?: Tab) => {
      const found = pane.tabs.find(item => item.filePath === path && (!expectedTab || item === expectedTab));
      return found ? { pane, tab: found } : undefined;
    },
  });
  const read = deferred();
  vi.mocked(readTextFile).mockReturnValueOnce(read.promise);
  return { tab, pane, currentFile, setEditorContent, reload, read };
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.runAllTimers(); vi.useRealTimers(); });

describe('manual reload ownership', () => {
  it.each(['closed', 'replaced', 'rebound', 'baseline', 'source', 'visual', 'dirty'])
  ('discards a pending result after the target is %s', async change => {
    const { tab, pane, reload, read, setEditorContent } = setup();
    const pending = reload.manualReload();
    if (change === 'closed') pane.tabs = [];
    if (change === 'replaced') pane.tabs = [{ ...tab, content: '<p>replacement</p>' }];
    if (change === 'rebound') tab.filePath = '/new.md';
    if (change === 'baseline') tab.originalMarkdown = 'new baseline';
    if (change === 'source') tab.pendingMarkdown = 'new edit';
    if (change === 'visual') tab.content = '<p>new edit</p>';
    if (change === 'dirty') tab.hasChanges = true;
    const expected = pane.tabs.map(item => ({ ...item }));
    read.resolve('stale disk');
    await pending;
    expect(pane.tabs).toEqual(expected);
    expect(setEditorContent).not.toHaveBeenCalled();
    expect(reload.showToast.value).toBe(false);
    expect(reload.showConflictModal.value).toBe(false);
  });

  it('updates only the captured tab after focus changes', async () => {
    const { tab, pane, currentFile, reload, read, setEditorContent } = setup();
    const other = { ...tab, id: 'b', filePath: '/b.md', pendingMarkdown: 'other' };
    pane.tabs.push(other);
    const pending = reload.manualReload();
    pane.activeTabId = other.id;
    currentFile.value = other.filePath;
    read.resolve('fresh disk');
    await pending;
    expect(tab.pendingMarkdown).toBe('fresh disk');
    expect(other.pendingMarkdown).toBe('other');
    expect(setEditorContent).not.toHaveBeenCalled();
  });

  it('does not report an error for a closed target', async () => {
    const { pane, reload, read } = setup();
    const pending = reload.manualReload();
    pane.tabs = [];
    read.reject(new Error('late failure'));
    await pending;
    expect(reload.showToast.value).toBe(false);
  });

  it('discards an older read when a newer request is still pending', async () => {
    const { tab, reload, read } = setup();
    const first = reload.manualReload();
    const newer = deferred();
    vi.mocked(readTextFile).mockReturnValueOnce(newer.promise);
    const second = reload.manualReload();
    read.resolve('older disk');
    await first;
    expect(tab.originalMarkdown).toBe('old');
    newer.resolve('latest disk');
    await second;
    expect(tab.originalMarkdown).toBe('latest disk');
  });
});


describe('duplicate tab and conflict followup ownership', () => {
  it.each([false, true])('reloads only the active same-path tab, dirty=%s', async dirty => {
    const { tab, pane, reload, read, setEditorContent } = setup();
    const active = { ...tab, id: 'duplicate', hasChanges: dirty };
    pane.tabs.push(active);
    pane.activeTabId = active.id;
    const pending = reload.manualReload();
    read.resolve('external');
    await pending;
    if (dirty) {
      expect(reload.showConflictModal.value).toBe(true);
      reload.handleConflictLoadExternal();
    }
    expect(active.pendingMarkdown).toBe('external');
    expect(tab.pendingMarkdown).toBe('old');
    expect(setEditorContent).toHaveBeenCalledWith('<p>external</p>');
  });

  it.each(['keep', 'load', 'merge'] as const)('applies %s to the captured duplicate after focus changes', async action => {
    const { tab, pane, reload, read } = setup();
    const active = { ...tab, id: 'duplicate', hasChanges: true, pendingMarkdown: 'local' };
    pane.tabs.push(active);
    pane.activeTabId = active.id;
    const pending = reload.manualReload();
    read.resolve('external');
    await pending;
    expect(reload.showConflictModal.value).toBe(true);
    pane.activeTabId = tab.id;
    if (action === 'keep') reload.handleConflictKeepLocal();
    if (action === 'load') reload.handleConflictLoadExternal();
    if (action === 'merge') reload.handleConflictMerge('merged');
    expect(tab.pendingMarkdown).toBe('old');
    expect(active.pendingMarkdown).toBe(action === 'keep' ? 'local' : action === 'load' ? 'external' : 'merged');
    expect(updateKnownContent).toHaveBeenLastCalledWith('/a.md', 'external');
  });

  describe.each(['keep', 'load', 'merge'] as const)('%s conflict action', action => {
    it.each(['closed', 'replaced', 'rebound', 'baseline', 'source', 'visual', 'dirty'])
    ('discards confirmation after the target is %s', async change => {
      const { tab, pane, reload, read, setEditorContent } = setup();
      tab.hasChanges = true;
      const pending = reload.manualReload();
      read.resolve('external');
      await pending;
      expect(reload.showConflictModal.value).toBe(true);
      if (change === 'closed') pane.tabs = [];
      if (change === 'replaced') pane.tabs = [{ ...tab, content: '<p>replacement</p>' }];
      if (change === 'rebound') tab.filePath = '/new.md';
      if (change === 'baseline') tab.originalMarkdown = 'new baseline';
      if (change === 'source') tab.pendingMarkdown = 'new edit';
      if (change === 'visual') tab.content = '<p>new edit</p>';
      if (change === 'dirty') tab.hasChanges = false;
      const expected = pane.tabs.map(item => ({ ...item }));
      if (action === 'keep') reload.handleConflictKeepLocal();
      if (action === 'load') reload.handleConflictLoadExternal();
      if (action === 'merge') reload.handleConflictMerge('merged');
      expect(pane.tabs).toEqual(expected);
      expect(updateKnownContent).not.toHaveBeenCalled();
      expect(setEditorContent).not.toHaveBeenCalled();
      expect(reload.showConflictModal.value).toBe(false);
    });
  });
});
