import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, computed, type Ref } from 'vue';
import type { Tab } from '../../composables/useTabs';
import type { UseFileReloadOptions } from '../../composables/useFileReload';

// Mock dependencies
vi.mock('@tauri-apps/plugin-fs', () => ({
  watch: vi.fn(async () => vi.fn()),
}));
vi.mock('../../services/documentText', () => ({
  readTextFile: vi.fn(async () => 'disk content'),
}));

vi.mock('../../utils/markdown-converter', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../utils/markdown-converter')>(),
  markdownToHtml: vi.fn((md: string) => `<p>${md}</p>`),
  htmlToMarkdown: vi.fn((html: string) => html.replace(/<[^>]*>/g, '')),
}));

vi.mock('../../composables/useDiffPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useDiffPreview')>();
  return {
    ...actual,
    generateDiff: vi.fn((_oldText: string, _newText: string) => ({
      lines: [{ type: 'added', content: 'diff line', oldLineNumber: null, newLineNumber: 1 }],
      stats: { additions: 1, deletions: 0 },
    })),
  };
});

vi.mock('../../i18n', () => ({
  t: {
    value: {
      fileReloadedExternally: (name: string) => `${name} reloaded externally`,
      fileReloaded: 'File reloaded',
      fileReloadError: 'Error reloading file',
      fileDeletedExternally: (name: string) => `${name} was deleted`,
      fileChangedExternally: 'File changed externally',
      fileConflictMessage: 'The file has been modified externally.',
      keepMyChanges: 'Keep My Changes',
      loadExternalVersion: 'Load External Version',
      externalChanges: 'External Changes',
    },
  },
}));

import { useFileReload } from '../../composables/useFileReload';
import { readTextFile } from '../../services/documentText';
import { markdownToHtml } from '../../utils/markdown-converter';
import { generateDiff } from '../../composables/useDiffPreview';

describe('useFileReload', () => {
  let mockActivePaneId: Ref<string>;
  let mockCurrentFile: Ref<string | null>;
  let mockHasChanges: Ref<boolean>;
  let mockSetEditorContent: UseFileReloadOptions['setEditorContent'];
  let mockTab: Tab;
  let mockPane: { id: string; activeTabId: string; tabs: Tab[] };
  let mockFindTabByFilePathSplit: UseFileReloadOptions['findTabByFilePathSplit'];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockActivePaneId = ref('left');
    mockCurrentFile = ref<string | null>('/test/file.md');
    mockHasChanges = ref(false);
    mockSetEditorContent = vi.fn() as unknown as UseFileReloadOptions['setEditorContent'];

    mockTab = {
      id: 'tab-1',
      filePath: '/test/file.md',
      fileName: 'file.md',
      content: '<p>old content</p>',
      hasChanges: false,
      scrollTop: 0,
      originalMarkdown: 'old content',
    };

    mockPane = {
      id: 'left',
      activeTabId: 'tab-1',
      tabs: [mockTab],
    };

    mockFindTabByFilePathSplit = vi.fn((filePath: string) => {
      if (filePath === mockTab.filePath) {
        return { pane: mockPane, tab: mockTab };
      }
      return undefined;
    }) as unknown as UseFileReloadOptions['findTabByFilePathSplit'];
  });

  const createReload = (extra: Partial<UseFileReloadOptions> = {}) =>
    useFileReload({
      activePaneId: mockActivePaneId,
      currentFile: computed(() => mockCurrentFile.value),
      hasChanges: computed(() => mockHasChanges.value),
      findTabByFilePathSplit: mockFindTabByFilePathSplit,
      setEditorContent: mockSetEditorContent,
      ...extra,
    });

  describe('initial state', () => {
    it('should have toast hidden initially', () => {
      const { showToast, toastMessage, toastType } = createReload();
      expect(showToast.value).toBe(false);
      expect(toastMessage.value).toBe('');
      expect(toastType.value).toBe('info');
    });

    it('should have conflict modal hidden initially', () => {
      const { showConflictModal, conflictFileName, conflictDiffLines, conflictDiffStats } = createReload();
      expect(showConflictModal.value).toBe(false);
      expect(conflictFileName.value).toBe('');
      expect(conflictDiffLines.value).toEqual([]);
      expect(conflictDiffStats.value).toEqual({ additions: 0, deletions: 0 });
    });
  });

  describe('dismissToast', () => {
    it('should hide toast on dismiss', () => {
      const { showToast, dismissToast } = createReload();
      // Force show toast via internal mechanism (we can't directly show it)
      // Instead we test dismissToast independently
      dismissToast();
      expect(showToast.value).toBe(false);
    });
  });

  describe('manualReload', () => {
    it('should do nothing if no current file', async () => {
      mockCurrentFile.value = null;
      const { manualReload } = createReload();

      await manualReload();

      expect(readTextFile).not.toHaveBeenCalled();
    });

    it('should reload file and show success toast when no local changes', async () => {
      mockHasChanges.value = false;
      vi.mocked(readTextFile).mockResolvedValueOnce('new disk content');
      vi.mocked(markdownToHtml).mockReturnValueOnce('<p>new disk content</p>');

      const { manualReload, showToast, toastMessage, toastType } = createReload();
      await manualReload();

      expect(readTextFile).toHaveBeenCalledWith('/test/file.md');
      expect(mockTab.originalMarkdown).toBe('new disk content');
      expect(mockTab.hasChanges).toBe(false);
      expect(showToast.value).toBe(true);
      expect(toastMessage.value).toBe('File reloaded');
      expect(toastType.value).toBe('success');
    });

    it('should show conflict modal when local changes exist', async () => {
      mockHasChanges.value = true;
      mockTab.hasChanges = true;
      mockTab.originalMarkdown = 'original content';
      vi.mocked(readTextFile).mockResolvedValueOnce('different disk content');

      const { manualReload, showConflictModal, conflictFileName } = createReload();
      await manualReload();

      expect(showConflictModal.value).toBe(true);
      expect(conflictFileName.value).toBe('file.md');
    });

    it('checks the requested tab after an asynchronous read even if focus moves to a clean tab', async () => {
      mockTab.pendingMarkdown = 'unsaved target';
      mockTab.hasChanges = mockHasChanges.value = true;
      let resolveRead!: (source: string) => void;
      vi.mocked(readTextFile).mockReturnValueOnce(new Promise<string>(resolve => { resolveRead = resolve; }));
      const { manualReload, showConflictModal } = createReload();
      const reload = manualReload();
      mockCurrentFile.value = '/test/other.md';
      mockHasChanges.value = false;
      resolveRead('external');
      await reload;
      expect(showConflictModal.value).toBe(true);
      expect(mockTab.pendingMarkdown).toBe('unsaved target');
      expect(mockTab.originalMarkdown).toBe('old content');
      expect(generateDiff).toHaveBeenCalledWith('unsaved target', 'external');
    });

    it('should show warning toast on read error', async () => {
      vi.mocked(readTextFile).mockRejectedValueOnce(new Error('read error'));

      const { manualReload, showToast, toastMessage, toastType } = createReload();
      await manualReload();

      expect(showToast.value).toBe(true);
      expect(toastMessage.value).toBe('Error reloading file');
      expect(toastType.value).toBe('warning');
    });
  });

  describe('handleConflictKeepLocal', () => {
    it('should hide conflict modal', async () => {
      // Trigger conflict first
      mockHasChanges.value = true;
      mockTab.hasChanges = true;
      vi.mocked(readTextFile).mockResolvedValueOnce('different content');

      const { manualReload, handleConflictKeepLocal, showConflictModal } = createReload();
      await manualReload();
      expect(showConflictModal.value).toBe(true);

      handleConflictKeepLocal();
      expect(showConflictModal.value).toBe(false);
    });

    it('should not change tab content', async () => {
      mockHasChanges.value = true;
      mockTab.hasChanges = true;
      mockTab.content = '<p>my local content</p>';
      vi.mocked(readTextFile).mockResolvedValueOnce('different content');

      const { manualReload, handleConflictKeepLocal } = createReload();
      await manualReload();

      handleConflictKeepLocal();

      // Tab content should remain as-is (local changes preserved)
      expect(mockTab.content).toBe('<p>my local content</p>');
    });
  });

  describe('handleConflictLoadExternal', () => {
    it('should hide conflict modal and update tab content', async () => {
      mockHasChanges.value = true;
      mockTab.hasChanges = true;
      mockTab.originalMarkdown = 'old original';
      vi.mocked(readTextFile).mockResolvedValueOnce('external content');
      vi.mocked(markdownToHtml).mockReturnValue('<p>external content</p>');

      const { manualReload, handleConflictLoadExternal, showConflictModal } = createReload();
      await manualReload();
      expect(showConflictModal.value).toBe(true);

      handleConflictLoadExternal();
      expect(showConflictModal.value).toBe(false);
      expect(mockTab.originalMarkdown).toBe('external content');
      expect(mockTab.hasChanges).toBe(false);
    });

    it('should set editor content when tab is active', async () => {
      mockHasChanges.value = true;
      mockTab.hasChanges = true;
      vi.mocked(readTextFile).mockResolvedValueOnce('external content');
      vi.mocked(markdownToHtml).mockReturnValue('<p>external content</p>');

      const { manualReload, handleConflictLoadExternal } = createReload();
      await manualReload();

      handleConflictLoadExternal();

      expect(mockSetEditorContent).toHaveBeenCalledWith('<p>external content</p>');
    });
  });

  describe('exposed watcher controls', () => {
    it('should expose watchFile function', () => {
      const { watchFile } = createReload();
      expect(typeof watchFile).toBe('function');
    });

    it('should expose unwatchFile function', () => {
      const { unwatchFile } = createReload();
      expect(typeof unwatchFile).toBe('function');
    });

    it('should expose unwatchAll function', () => {
      const { unwatchAll } = createReload();
      expect(typeof unwatchAll).toBe('function');
    });

    it('should expose markSaveStart function', () => {
      const { markSaveStart } = createReload();
      expect(typeof markSaveStart).toBe('function');
    });

    it('should expose markSaveEnd function', () => {
      const { markSaveEnd } = createReload();
      expect(typeof markSaveEnd).toBe('function');
    });
  });

  describe('markdown-first tabs (issue #129)', () => {
    it('reloads a markdown-first tab without HTML conversion', () => {
      mockTab.largeFile = true;
      mockTab.pendingMarkdown = '# old';
      mockTab.content = '';
      mockTab.originalMarkdown = '# old';
      const setCodeMarkdown = vi.fn();

      const { reloadTabContent } = createReload({ setCodeMarkdown });
      reloadTabContent('/test/file.md', '# new from disk');

      expect(mockTab.pendingMarkdown).toBe('# new from disk');
      expect(mockTab.originalMarkdown).toBe('# new from disk');
      expect(mockTab.content).toBe('');
      expect(mockTab.hasChanges).toBe(false);
      expect(markdownToHtml).not.toHaveBeenCalled();
      expect(mockSetEditorContent).not.toHaveBeenCalled();
      expect(setCodeMarkdown).toHaveBeenCalledWith('# new from disk');
    });

    it('does not notify code view when the markdown-first tab is inactive', () => {
      mockTab.largeFile = true;
      mockTab.pendingMarkdown = '# old';
      mockTab.content = '';
      mockPane.activeTabId = 'other-tab';
      const setCodeMarkdown = vi.fn();

      const { reloadTabContent } = createReload({ setCodeMarkdown });
      reloadTabContent('/test/file.md', '# new');

      expect(mockTab.pendingMarkdown).toBe('# new');
      expect(setCodeMarkdown).not.toHaveBeenCalled();
    });

    it('converts normally and refreshes code view for an active regular tab', () => {
      const setCodeMarkdown = vi.fn();
      vi.mocked(markdownToHtml).mockReturnValueOnce('<p>converted</p>');

      const { reloadTabContent } = createReload({ setCodeMarkdown });
      reloadTabContent('/test/file.md', 'converted');

      expect(mockTab.content).toBe('<p>converted</p>');
      expect(setCodeMarkdown).toHaveBeenCalledWith('converted');
    });

    it('does not refresh code view for an inactive regular tab', () => {
      const setCodeMarkdown = vi.fn();
      mockPane.activeTabId = 'other-tab';

      const { reloadTabContent } = createReload({ setCodeMarkdown });
      reloadTabContent('/test/file.md', 'converted');

      expect(setCodeMarkdown).not.toHaveBeenCalled();
    });
  });

  describe('canonical Markdown after reload and conflict resolution', () => {
    it.each([true, false])('replaces stale raw Markdown in an active=%s ordinary tab', (active) => {
      mockTab.pendingMarkdown = '\uFEFFprevious Visual edit\r\n';
      mockPane.activeTabId = active ? mockTab.id : 'other';
      const source = '\uFEFFexternal\r\n<!-- exact -->  \r\n\t';
      const setCodeMarkdown = vi.fn();
      const { reloadTabContent } = createReload({ setCodeMarkdown });

      reloadTabContent('/test/file.md', source);

      expect(mockTab.pendingMarkdown).toBe(source);
      expect(mockTab.originalMarkdown).toBe(source);
      expect(mockTab.hasChanges).toBe(false);
      if (active) expect(setCodeMarkdown).toHaveBeenCalledWith(source);
      else expect(setCodeMarkdown).not.toHaveBeenCalled();
    });

    it.each([false, true])('uses exact pending Markdown for conflict diff, large=%s', async (largeFile) => {
      mockTab.largeFile = largeFile;
      mockTab.content = largeFile ? '' : '<p>lossy HTML</p>';
      mockTab.pendingMarkdown = '\uFEFF[local][ref]  \r\n\r\n[ref]: x\r\n';
      mockTab.hasChanges = mockHasChanges.value = true;
      vi.mocked(readTextFile).mockResolvedValueOnce('external');
      const { manualReload } = createReload();
      await manualReload();
      expect(generateDiff).toHaveBeenCalledWith(mockTab.pendingMarkdown, 'external');
    });

    it('uses an empty canonical buffer instead of obsolete HTML in the conflict diff', async () => {
      mockTab.pendingMarkdown = '';
      mockTab.hasChanges = mockHasChanges.value = true;
      vi.mocked(readTextFile).mockResolvedValueOnce('external');
      const { manualReload } = createReload();
      await manualReload();
      expect(generateDiff).toHaveBeenCalledWith('', 'external');
    });

    it('preserves the document envelope when a legacy dirty tab has only HTML', async () => {
      mockTab.content = '<p>local</p>';
      mockTab.originalMarkdown = '\uFEFF\r\nold  \r\n\t';
      mockTab.hasChanges = mockHasChanges.value = true;
      vi.mocked(readTextFile).mockResolvedValueOnce('external');
      const { manualReload } = createReload();
      await manualReload();
      expect(generateDiff).toHaveBeenCalledWith('\uFEFF\r\nlocal  \r\n\t', 'external');
    });

    it.each([false, true])('keeps an applied merge unsaved against the disk version, large=%s', async (largeFile) => {
      mockTab.largeFile = largeFile;
      mockTab.content = largeFile ? '' : '<p>local</p>';
      mockTab.pendingMarkdown = 'local';
      mockTab.hasChanges = mockHasChanges.value = true;
      const disk = '\uFEFFexternal\r\n';
      const merged = '\uFEFFmerged  \r\n';
      vi.mocked(readTextFile).mockResolvedValueOnce(disk);
      const { manualReload, handleConflictMerge, showConflictModal } = createReload();
      await manualReload();
      handleConflictMerge(merged);
      expect(mockTab.pendingMarkdown).toBe(merged);
      expect(mockTab.originalMarkdown).toBe(disk);
      expect(mockTab.hasChanges).toBe(true);
      expect(showConflictModal.value).toBe(false);
    });

    it('marks a merge equal to disk as clean', async () => {
      mockTab.pendingMarkdown = 'local';
      mockTab.hasChanges = mockHasChanges.value = true;
      vi.mocked(readTextFile).mockResolvedValueOnce('external');
      const { manualReload, handleConflictMerge } = createReload();
      await manualReload();
      handleConflictMerge('external');
      expect(mockTab.pendingMarkdown).toBe('external');
      expect(mockTab.originalMarkdown).toBe('external');
      expect(mockTab.hasChanges).toBe(false);
    });
  });

  describe('file not found in tabs', () => {
    it('should do nothing when findTabByFilePathSplit returns undefined on reload', async () => {
      (mockFindTabByFilePathSplit as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      mockCurrentFile.value = '/unknown/file.md';
      vi.mocked(readTextFile).mockResolvedValueOnce('content');

      const { manualReload } = createReload();
      await manualReload();

      // Should not crash and should not set editor content
      expect(mockSetEditorContent).not.toHaveBeenCalled();
    });
  });
});
afterEach(() => {
  // Finish bounded scroll/notification retries before jsdom is destroyed.
  vi.runAllTimers();
  vi.useRealTimers();
});
