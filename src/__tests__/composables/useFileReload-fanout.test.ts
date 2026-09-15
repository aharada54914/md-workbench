import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import type { Tab } from '../../composables/useTabs';
import type { UseFileReloadOptions } from '../../composables/useFileReload';

const watcher = vi.hoisted(() => ({
  notify: (_path: string, _content: string) => {}, updateKnownContent: vi.fn(),
}));
vi.mock('../../services/documentText', () => ({ readTextFile: vi.fn() }));
vi.mock('../../composables/useFileWatcher', () => ({ useFileWatcher: (options: {
  onExternalChange: (path: string, content: string) => void;
}) => {
  watcher.notify = options.onExternalChange;
  return { updateKnownContent: watcher.updateKnownContent, watchFile: vi.fn(),
    unwatchFile: vi.fn(), unwatchAll: vi.fn(), markSaveStart: vi.fn(),
    markSaveEnd: vi.fn(), markSaveAbort: vi.fn() };
} }));
vi.mock('../../utils/markdown-converter', () => ({ markdownToHtml: (md: string) => `<p>${md}</p>` }));
import { useFileReload } from '../../composables/useFileReload';
import { readTextFile } from '../../services/documentText';

function setup(dirty: boolean[]) {
  const tabs: Tab[] = dirty.map((hasChanges, index) => ({
    id: `tab-${index}`, filePath: '/a.md', fileName: `copy-${index}.md`,
    content: '<p>old</p>', originalMarkdown: 'old', pendingMarkdown: 'old', hasChanges, scrollTop: 0,
  }));
  const panes = tabs.map((tab, index) => ({ id: `pane-${index}`, activeTabId: tab.id, tabs: [tab] }));
  const findAll = (path: string) => panes.flatMap(pane => pane.tabs
    .filter(tab => tab.filePath === path).map(tab => ({ pane, tab })));
  const options: UseFileReloadOptions & { findTabsByFilePathSplit: typeof findAll } = {
    activePaneId: ref('pane-1'), currentFile: computed(() => '/a.md'),
    hasChanges: computed(() => false), setEditorContent: vi.fn(),
    activeTab: computed(() => tabs[0]),
    findTabByFilePathSplit: (path, expected) => findAll(path).find(item => !expected || item.tab === expected),
    findTabsByFilePathSplit: findAll,
  };
  return { tabs, panes, reload: useFileReload(options), options };
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.runAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('external change fanout', () => {
  it('reloads every clean same-path object across panes', () => {
    const { tabs, options } = setup([false, false, false]);
    watcher.notify('/a.md', 'disk');
    expect(tabs.map(tab => tab.pendingMarkdown)).toEqual(['disk', 'disk', 'disk']);
    expect(options.setEditorContent).toHaveBeenCalledTimes(1);
  });
  it('keeps the first conflict visible and independently resolves each dirty duplicate', () => {
    const { tabs, reload } = setup([true, true, false]);
    watcher.notify('/a.md', 'disk');
    expect(reload.conflictFileName.value).toBe('copy-0.md');
    expect(tabs[2].pendingMarkdown).toBe('disk');
    reload.handleConflictLoadExternal();
    expect(tabs[0].pendingMarkdown).toBe('disk');
    expect(tabs[1].pendingMarkdown).toBe('old');
    expect(reload.showConflictModal.value).toBe(true);
    expect(reload.conflictFileName.value).toBe('copy-1.md');
    reload.handleConflictMerge('merged');
    expect(tabs[1].pendingMarkdown).toBe('merged');
    expect(tabs[1].originalMarkdown).toBe('disk');
    expect(tabs[1].hasChanges).toBe(true);
    expect(reload.showConflictModal.value).toBe(false);
  });
  it('does not replace an active conflict when another path changes', () => {
    const { tabs, reload } = setup([true, true]);
    tabs[1].filePath = '/b.md';
    watcher.notify('/a.md', 'disk-a');
    watcher.notify('/b.md', 'disk-b');
    expect(reload.conflictFilePath.value).toBe('/a.md');
    reload.handleConflictLoadExternal();
    expect(tabs[0].pendingMarkdown).toBe('disk-a');
    expect(reload.conflictFilePath.value).toBe('/b.md');
    reload.handleConflictLoadExternal();
    expect(tabs[1].pendingMarkdown).toBe('disk-b');
  });
});


describe('queued conflict lifecycle', () => {
  it.each(['keep', 'load', 'merge'] as const)('ignores a superseded %s answer and retains only the newest pending version', action => {
    const { tabs, reload } = setup([true, true]);
    watcher.notify('/a.md', 'first disk');
    const firstKey = reload.conflictKey.value;
    const firstDiff = reload.conflictDiffLines.value;
    for (let i = 0; i < 20; i++) watcher.notify('/a.md', `disk-${i}`);
    expect(reload.conflictKey.value).toBe(firstKey);
    expect(reload.conflictDiffLines.value).toBe(firstDiff);
    if (action === 'keep') reload.handleConflictKeepLocal();
    if (action === 'load') reload.handleConflictLoadExternal();
    if (action === 'merge') reload.handleConflictMerge('stale merge');
    expect(tabs.map(tab => tab.pendingMarkdown)).toEqual(['old', 'old']);
    expect(watcher.updateKnownContent).not.toHaveBeenCalled();
    expect(reload.conflictKey.value).toBeGreaterThan(firstKey);
    reload.handleConflictLoadExternal();
    reload.handleConflictLoadExternal();
    expect(tabs.map(tab => tab.pendingMarkdown)).toEqual(['disk-19', 'disk-19']);
    expect(reload.showConflictModal.value).toBe(false);
  });

  it.each(['closed', 'replaced', 'rebound', 'source', 'visual', 'baseline', 'dirty'])
  ('skips a queued tab that was %s, preserving the next live candidate', change => {
    const { tabs, panes, reload } = setup([true, true, true]);
    watcher.notify('/a.md', 'disk');
    if (change === 'closed') panes[1].tabs = [];
    if (change === 'replaced') panes[1].tabs = [{ ...tabs[1] }];
    if (change === 'rebound') tabs[1].filePath = '/new.md';
    if (change === 'source') tabs[1].pendingMarkdown = 'new edit';
    if (change === 'visual') tabs[1].content = '<p>new edit</p>';
    if (change === 'baseline') tabs[1].originalMarkdown = 'saved';
    if (change === 'dirty') tabs[1].hasChanges = false;
    const expected = { ...tabs[1] };
    reload.handleConflictKeepLocal();
    expect(reload.conflictFileName.value).toBe('copy-2.md');
    reload.handleConflictLoadExternal();
    expect(tabs[1]).toEqual(expected);
    expect(tabs[2].pendingMarkdown).toBe('disk');
    expect(reload.showConflictModal.value).toBe(false);
  });

  it('follows a queued object moved to another pane', () => {
    const { tabs, panes, reload } = setup([true, true]);
    watcher.notify('/a.md', 'disk');
    panes[1].tabs = [];
    panes[0].tabs.push(tabs[1]);
    reload.handleConflictKeepLocal();
    reload.handleConflictLoadExternal();
    expect(tabs[1].pendingMarkdown).toBe('disk');
  });

  it('prunes closed queued objects during repeated notifications', () => {
    const { tabs, panes, reload } = setup([true, true]);
    watcher.notify('/a.md', 'disk');
    for (let i = 0; i < 30; i++) {
      const temporary = { ...tabs[1], id: `temporary-${i}`, filePath: `/temporary-${i}.md` };
      panes[1].tabs = [temporary];
      watcher.notify(temporary.filePath, 'other disk');
    }
    panes[1].tabs = [];
    reload.handleConflictKeepLocal();
    expect(reload.showConflictModal.value).toBe(false);
  });

  it('drops all queued versions when the watcher is stopped', () => {
    const { tabs, reload } = setup([true, true]);
    watcher.notify('/a.md', 'disk');
    reload.unwatchAll();
    reload.handleConflictLoadExternal();
    expect(reload.showConflictModal.value).toBe(false);
    expect(tabs.map(tab => tab.pendingMarkdown)).toEqual(['old', 'old']);
  });

  it('removes one unwatched path while preserving another queued path', () => {
    const { tabs, reload } = setup([true, true]);
    tabs[1].filePath = '/b.md';
    watcher.notify('/a.md', 'disk-a');
    watcher.notify('/b.md', 'disk-b');
    reload.unwatchFile('/a.md');
    expect(reload.conflictFilePath.value).toBe('/b.md');
    reload.handleConflictLoadExternal();
    expect(tabs[0].pendingMarkdown).toBe('old');
    expect(tabs[1].pendingMarkdown).toBe('disk-b');
  });

  it('does not let an older pending manual read supersede a watcher observation', async () => {
    const { tabs, reload } = setup([true]);
    let resolve!: (text: string) => void;
    vi.mocked(readTextFile).mockReturnValueOnce(new Promise<string>(yes => { resolve = yes; }));
    const pending = reload.manualReload();
    watcher.notify('/a.md', 'new disk');
    resolve('older disk');
    await pending;
    reload.handleConflictLoadExternal();
    expect(tabs[0].pendingMarkdown).toBe('new disk');
    expect(reload.showConflictModal.value).toBe(false);
  });

  it('does not rewind the shared baseline when another duplicate was manually reloaded', async () => {
    const { tabs, reload } = setup([true, true]);
    watcher.notify('/a.md', 'first disk');
    vi.mocked(readTextFile).mockResolvedValueOnce('latest disk');
    await reload.manualReload();
    reload.handleConflictKeepLocal(); // superseded first dialog
    // The other duplicate's obsolete disk candidate is pruned too.
    expect(watcher.updateKnownContent).not.toHaveBeenCalled();
    reload.handleConflictLoadExternal(); // latest version for manually selected tab
    expect(tabs[0].pendingMarkdown).toBe('latest disk');
    expect(watcher.updateKnownContent).toHaveBeenCalledWith('/a.md', 'latest disk');
    expect(reload.showConflictModal.value).toBe(false);
  });
});


describe('delayed conflict shared baseline', () => {
  it('allows an unchanged candidate when the shared disk content returns to the same bytes', () => {
    const { tabs, reload } = setup([true, true]);
    watcher.notify('/a.md', 'candidate disk');
    reload.markSaveEnd('/a.md', 'intermediate disk');
    reload.markSaveEnd('/a.md', 'candidate disk');
    reload.handleConflictLoadExternal();
    expect(tabs[0].pendingMarkdown).toBe('candidate disk');
    expect(tabs[0].hasChanges).toBe(false);
    expect(reload.conflictFileName.value).toBe('copy-1.md');
  });

  it.each(['save', 'direct-reload'])('does not undo a later %s baseline from another duplicate', action => {
    const { tabs, reload } = setup([true, true]);
    watcher.notify('/a.md', 'old disk');
    if (action === 'save') reload.markSaveEnd('/a.md', 'saved disk');
    else reload.reloadTabContent('/a.md', 'saved disk', tabs[1]);
    watcher.updateKnownContent.mockClear();
    reload.handleConflictKeepLocal();
    expect(watcher.updateKnownContent).not.toHaveBeenCalled();
    expect(tabs[0].pendingMarkdown).toBe('old');
  });

  it.each(['load', 'merge'] as const)('does not apply an obsolete %s after another duplicate saved newer content', action => {
    const { tabs, reload } = setup([true, true]);
    watcher.notify('/a.md', 'old disk');
    const snapshot = { ...tabs[0] };
    reload.markSaveEnd('/a.md', 'saved disk');
    watcher.updateKnownContent.mockClear();
    if (action === 'load') reload.handleConflictLoadExternal();
    else reload.handleConflictMerge('stale merged content');
    expect(tabs[0]).toEqual(snapshot);
    expect(watcher.updateKnownContent).not.toHaveBeenCalled();
    expect(reload.showConflictModal.value).toBe(false);
  });
});

describe('pending manual read shared path generation', () => {
  it.each(['unwatchFile', 'unwatchAll'] as const)('invalidates pending reads on %s even before any disk observation', async action => {
    const { tabs, reload } = setup([false]);
    let resolve!: (text: string) => void;
    vi.mocked(readTextFile).mockReturnValueOnce(new Promise<string>(yes => { resolve = yes; }));
    const pending = reload.manualReload();
    if (action === 'unwatchFile') reload.unwatchFile('/a.md');
    else reload.unwatchAll();
    resolve('old session disk');
    await pending;
    expect(tabs[0].pendingMarkdown).toBe('old');
    expect(watcher.updateKnownContent).not.toHaveBeenCalled();
    expect(reload.showToast.value).toBe(false);
  });

  const cases = (['save', 'direct-reload', 'manual-reload', 'watcher'] as const)
    .flatMap(action => (['success', 'failure'] as const).map(result => ({ action, result })));
  it.each(cases)('ignores late $result after a newer $action', async ({ action, result }) => {
    const { tabs, reload, options } = setup([false, false]);
    let resolve!: (text: string) => void;
    let reject!: (error: Error) => void;
    vi.mocked(readTextFile).mockReturnValueOnce(new Promise<string>((yes, no) => { resolve = yes; reject = no; }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = reload.manualReload();
    if (action === 'save') reload.markSaveEnd('/a.md', 'newer disk');
    if (action === 'direct-reload') reload.reloadTabContent('/a.md', 'newer disk', tabs[1]);
    if (action === 'manual-reload') {
      options.activeTab = computed(() => tabs[1]);
      vi.mocked(readTextFile).mockResolvedValueOnce('newer disk');
      await reload.manualReload();
    }
    if (action === 'watcher') watcher.notify('/a.md', 'newer disk');
    const snapshot = tabs.map(tab => ({ ...tab }));
    watcher.updateKnownContent.mockClear();
    reload.dismissToast();
    if (result === 'success') resolve('older disk');
    else reject(new Error('stale read failed'));
    await pending;
    expect(tabs).toEqual(snapshot);
    expect(watcher.updateKnownContent).not.toHaveBeenCalled();
    expect(reload.showToast.value).toBe(false);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('does not invalidate a pending read when a different path is saved', async () => {
    const { tabs, reload } = setup([false]);
    let resolve!: (text: string) => void;
    vi.mocked(readTextFile).mockReturnValueOnce(new Promise<string>(yes => { resolve = yes; }));
    const pending = reload.manualReload();
    reload.markSaveEnd('/other.md', 'unrelated');
    resolve('current disk');
    await pending;
    expect(tabs[0].pendingMarkdown).toBe('current disk');
    expect(watcher.updateKnownContent).toHaveBeenCalledWith('/a.md', 'current disk');
  });
});
