import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, computed } from 'vue';
import type { Tab } from '../../composables/useTabs';

// ============================================================
// Mocks — must be hoisted above imports
// ============================================================

const mockReadTextFile = vi.fn();
const mockNativeRead = vi.fn();
const mockPickDocuments = vi.fn();
vi.mock('../../services/nativeFs', () => ({
  nativeFs: { readPathText: (...args: unknown[]) => mockNativeRead(...args), pickDocuments: () => mockPickDocuments() },
}));
const mockWriteTextFile = vi.fn();
const mockRename = vi.fn();
const mockRemove = vi.fn();
const mockExists = vi.fn();
const mockOpenDialog = vi.fn();
const mockSaveDialog = vi.fn();
const mockOpenShell = vi.fn();
vi.mock('../../services/documentText', () => ({
  readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
}));
const mockGetCurrentWindow = vi.fn(() => ({
  isMaximized: vi.fn(async () => false),
  maximize: vi.fn(async () => {}),
  unmaximize: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  remove: (...args: unknown[]) => mockRemove(...args),
  exists: (...args: unknown[]) => mockExists(...args),
}));

vi.mock('../../services/aiCommands', () => ({
  aiCommands: { sessionMigrate: vi.fn(), accessMigrate: vi.fn(), snapshotMigrate: vi.fn() },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => mockOpenDialog(...args),
  save: (...args: unknown[]) => mockSaveDialog(...args),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: (...args: unknown[]) => mockOpenShell(...args),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => mockGetCurrentWindow(),
}));

// Spread the real module so `generateSlug` stays the genuine implementation —
// the anchor fallback compares against it, and a hand-copied stub would keep
// passing after the real slug rules change.
vi.mock('../../utils/markdown-converter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/markdown-converter')>()),
  htmlToMarkdown: vi.fn((html: string) => `md:${html}`),
  markdownToHtml: vi.fn((md: string) => `<p>${md}</p>`),
  detectLineEnding: vi.fn(() => '\n'),
  applyLineEnding: vi.fn((content: string) => content),
}));

vi.mock('../../constants', () => ({
  EMPTY_TAB_CONTENT: '<p></p>',
  DEFAULT_FILE_NAME: 'dokument.md',
  DOM_SELECTORS: {
    EDITOR_CONTAINER: '.editor-container',
    ACTIVE_EDITOR_CONTAINER: '.editor-pane.active .editor-container',
  },
  TIMING: { MAXIMIZE_ANIMATION_DELAY: 0 },
  LARGE_FILE_CHAR_THRESHOLD: 1_000_000,
}));

import { useFileOperations } from '../../composables/useFileOperations';
import { htmlToMarkdown, markdownToHtml } from '../../utils/markdown-converter';
import { aiCommands } from '../../services/aiCommands';

// ============================================================
// Helpers
// ============================================================

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: 'tab-1',
  filePath: '/test/file.md',
  fileName: 'file.md',
  content: '<p>hello</p>',
  hasChanges: true,
  scrollTop: 0,
  originalMarkdown: '# hello',
  ...overrides,
});

const makeOptions = (tabOverrides: Partial<Tab> = {}, extraOptions: Record<string, unknown> = {}) => {
  const tab = makeTab(tabOverrides);
  const tabs = ref<Tab[]>([tab]);
  const activeTabId = ref(tab.id);
  const activeTab = computed(() => tabs.value[0]);
  const getEditorHtml = vi.fn(() => tab.content);
  const setEditorContent = vi.fn();
  const createNewTab = vi.fn(() => 'new-tab-id');
  const switchToTab = vi.fn(async () => {});
  const findTabByFilePath = vi.fn(() => undefined);

  return {
    options: {
      tabs,
      activeTabId,
      activeTab,
      findTabByFilePath,
      createNewTab,
      switchToTab,
      getEditorHtml,
      setEditorContent,
      ...extraOptions,
    },
    tabs,
    tab,
    getEditorHtml,
    setEditorContent,
    createNewTab,
    switchToTab,
    findTabByFilePath,
  };
};

// ============================================================
// Tests
// ============================================================

describe('useFileOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteTextFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockRemove.mockResolvedValue(undefined);
    mockReadTextFile.mockResolvedValue('# hello');
    mockNativeRead.mockReset().mockResolvedValue('# hello');
    mockPickDocuments.mockReset().mockResolvedValue([]);
    mockExists.mockResolvedValue(true);
  });

  // ----------------------------------------------------------
  // atomicWriteFile (via saveFile)
  // ----------------------------------------------------------

  describe('atomicWriteFile', () => {
    it.each(['# A\n\n', '# A\r\n\r\n', '\uFEFF# A\r\n\r\n'])('background Source save preserves raw bytes for %j', async (source) => {
      const candidate = source + '追記😀';
      const { options, tabs, getEditorHtml } = makeOptions({ originalMarkdown: source }, { getMarkdownOverride: () => candidate });
      getEditorHtml.mockImplementation(() => { throw new Error('editor is unmounted'); });
      mockReadTextFile.mockImplementation(async path => path.endsWith('.tmp') ? candidate : source);
      const operations = useFileOperations(options);
      expect(await operations.saveExistingTab(tabs.value[0], { markdown: candidate, html: '' })).toBe(true);
      expect(mockWriteTextFile).toHaveBeenCalledWith('/test/file.md.tmp', candidate);
      expect(tabs.value[0].hasChanges).toBe(false);
      expect(getEditorHtml).not.toHaveBeenCalled();
    });

    it('background save checks revisions even without an interactive conflict callback', async () => {
      const { options, tabs } = makeOptions({ originalMarkdown: '' });
      mockReadTextFile.mockResolvedValue('\r\n');
      const operations = useFileOperations(options);
      expect(await operations.saveExistingTab(tabs.value[0], { markdown: 'local', html: '' })).toBe(false);
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(tabs.value[0].hasChanges).toBe(true);
    });

    it('an unreadable background target is not treated as a new file', async () => {
      const { options, tabs } = makeOptions();
      mockReadTextFile.mockRejectedValue(new Error('read denied'));
      mockExists.mockResolvedValue(false);
      const operations = useFileOperations(options);
      expect(await operations.saveExistingTab(tabs.value[0], { markdown: 'local', html: '' })).toBe(false);
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(tabs.value[0].hasChanges).toBe(true);
    });

    it('saves another pane without updating the active tab or reading its editor', async () => {
      const { options, tabs, getEditorHtml } = makeOptions();
      const target = makeTab({ id: 'other', filePath: '/test/other.md', originalMarkdown: 'old' });
      mockReadTextFile.mockImplementation(async path => path.endsWith('.tmp') ? 'new' : 'old');
      const operations = useFileOperations(options);
      expect(await operations.saveExistingTab(target, { markdown: 'new', html: '' })).toBe(true);
      expect(target.originalMarkdown).toBe('new');
      expect(target.hasChanges).toBe(false);
      expect(tabs.value[0].originalMarkdown).toBe('# hello');
      expect(tabs.value[0].hasChanges).toBe(true);
      expect(getEditorHtml).not.toHaveBeenCalled();
    });

    it('keeps edits arriving while raw Source bytes are being saved dirty', async () => {
      let live = 'new';
      const { options, tabs } = makeOptions({}, { getMarkdownOverride: () => live });
      mockReadTextFile.mockImplementation(async path => path.endsWith('.tmp') ? 'new' : '# hello');
      mockRename.mockImplementationOnce(async () => { live = 'newer'; });
      const operations = useFileOperations(options);
      expect(await operations.saveExistingTab(tabs.value[0], { markdown: 'new', html: '' })).toBe(true);
      expect(tabs.value[0].originalMarkdown).toBe('new');
      expect(tabs.value[0].hasChanges).toBe(true);
    });

    it('refuses an overlapping manual write to the same temporary path', async () => {
      let finish!: () => void;
      const { options, tabs } = makeOptions({}, { getMarkdownOverride: () => 'new' });
      mockReadTextFile.mockImplementation(async path => path.endsWith('.tmp') ? 'new' : '# hello');
      mockWriteTextFile.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
      const operations = useFileOperations(options);
      const pending = operations.saveExistingTab(tabs.value[0], { markdown: 'new', html: '' });
      await vi.waitFor(() => expect(finish).toBeDefined());
      expect(await operations.saveFile()).toBe(false);
      expect(mockWriteTextFile).toHaveBeenCalledOnce();
      finish();
      expect(await pending).toBe(true);
    });

    it('writes to .tmp file first, then renames to final path', async () => {
      // readTextFile is called twice: once for .tmp verification, once for pre-save conflict check
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return '# hello'; // disk content matches originalMarkdown → no conflict
      });

      const { options } = makeOptions();
      const { saveFile } = useFileOperations(options);

      await saveFile();

      const tmpPath = '/test/file.md.tmp';
      expect(mockWriteTextFile).toHaveBeenCalledWith(tmpPath, expect.any(String));
      expect(mockRename).toHaveBeenCalledWith(tmpPath, '/test/file.md');
    });

    it('removes .tmp file when rename succeeds (no leftover temp)', async () => {
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return '# hello';
      });

      const { options } = makeOptions();
      const { saveFile } = useFileOperations(options);

      await saveFile();

      // remove should NOT be called on success path
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('removes .tmp file and rethrows when writeTextFile fails', async () => {
      mockWriteTextFile.mockRejectedValue(new Error('disk full'));
      const markSaveEnd = vi.fn();

      const { options, tabs } = makeOptions();
      const { saveFile } = useFileOperations({ ...options, markSaveEnd });

      // saveFile swallows errors internally (console.error) — verify .tmp cleanup
      await saveFile();

      expect(mockRemove).toHaveBeenCalledWith('/test/file.md.tmp');
      // tab should remain unchanged (hasChanges still true)
      expect(tabs.value[0].hasChanges).toBe(true);
    });

    it('removes .tmp and throws when verification fails (written !== content)', async () => {
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'CORRUPTED_CONTENT';
        return '# hello';
      });

      const { options, tabs } = makeOptions();
      const { saveFile } = useFileOperations(options);

      await saveFile();

      // .tmp should be cleaned up on verification failure
      expect(mockRemove).toHaveBeenCalledWith('/test/file.md.tmp');
      // tab should remain unsaved
      expect(tabs.value[0].hasChanges).toBe(true);
    });

    it('calls markSaveStart before write and markSaveEnd after rename', async () => {
      const calls: string[] = [];
      const markSaveStart = vi.fn(() => calls.push('start'));
      const markSaveEnd = vi.fn(() => calls.push('end'));

      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return '# hello';
      });

      const { options } = makeOptions();
      const { saveFile } = useFileOperations({ ...options, markSaveStart, markSaveEnd });

      await saveFile();

      expect(calls).toEqual(['start', 'end']);
      expect(markSaveStart).toHaveBeenCalledWith('/test/file.md');
      expect(markSaveEnd).toHaveBeenCalledWith('/test/file.md', expect.any(String));
    });
  });

  // ----------------------------------------------------------
  // Code view fix — getMarkdownOverride
  // ----------------------------------------------------------

  describe('getMarkdownOverride (code view save)', () => {
    it('uses raw markdown from override instead of converting editor HTML', async () => {
      const rawMarkdown = '# Raw from code editor\n\nNo conversion needed.';
      const getMarkdownOverride = vi.fn(() => rawMarkdown);

      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return rawMarkdown;
        return '# hello'; // disk matches → no conflict
      });

      const { options } = makeOptions();
      const { saveFile } = useFileOperations({ ...options, getMarkdownOverride });

      await saveFile();

      // Should write the raw override content, NOT the HTML→markdown conversion
      expect(mockWriteTextFile).toHaveBeenCalledWith('/test/file.md.tmp', rawMarkdown);
      expect(htmlToMarkdown).not.toHaveBeenCalled();
    });

    it('falls back to HTML→markdown when override returns null (visual mode)', async () => {
      const getMarkdownOverride = vi.fn(() => null);

      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return '# hello';
      });

      const { options } = makeOptions();
      const { saveFile } = useFileOperations({ ...options, getMarkdownOverride });

      await saveFile();

      expect(htmlToMarkdown).toHaveBeenCalledWith('<p>hello</p>');
    });

    it('updates tab.originalMarkdown with override content after save', async () => {
      const rawMarkdown = '# Saved from code view';
      const getMarkdownOverride = vi.fn(() => rawMarkdown);

      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return rawMarkdown;
        return '# hello';
      });

      const { options, tabs } = makeOptions();
      const { saveFile } = useFileOperations({ ...options, getMarkdownOverride });

      await saveFile();

      expect(tabs.value[0].originalMarkdown).toBe(rawMarkdown);
      expect(tabs.value[0].hasChanges).toBe(false);
    });

    it('does NOT update tab.content when saving from code view (html is null)', async () => {
      const rawMarkdown = '# code view content';
      const getMarkdownOverride = vi.fn(() => rawMarkdown);
      const originalContent = '<p>hello</p>';

      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return rawMarkdown;
        return '# hello';
      });

      const { options, tabs } = makeOptions({ content: originalContent });
      const { saveFile } = useFileOperations({ ...options, getMarkdownOverride });

      await saveFile();

      // content (cached HTML) should remain unchanged — code view doesn't produce fresh HTML
      expect(tabs.value[0].content).toBe(originalContent);
    });
  });

  // ----------------------------------------------------------
  // Pre-save conflict detection
  // ----------------------------------------------------------

  describe('checkPreSaveConflict', () => {
    it.each([
      ['', 'external text', 'md:<p>hello</p>'],
      ['# original\r\n', '# original\n', 'md:<p>hello</p>\r\n'],
    ])('detects exact external revision from %j', async (originalMarkdown, disk, local) => {
      mockReadTextFile.mockResolvedValue(disk);
      const onPreSaveConflict = vi.fn(async () => 'cancel' as const);
      const { options, tabs } = makeOptions({ originalMarkdown });
      await useFileOperations({ ...options, onPreSaveConflict }).saveFile();
      expect(onPreSaveConflict).toHaveBeenCalledWith('/test/file.md', disk, local);
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(tabs.value[0].hasChanges).toBe(true);
    });

    it('does not overwrite an open document when its current bytes cannot be read', async () => {
      mockReadTextFile.mockRejectedValue(new Error('permission denied or invalid UTF-8'));
      const onPreSaveConflict = vi.fn(async () => 'save' as const);
      const { options, tabs } = makeOptions();
      await useFileOperations({ ...options, onPreSaveConflict }).saveFile();
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
      expect(onPreSaveConflict).not.toHaveBeenCalled();
      expect(tabs.value[0].hasChanges).toBe(true);
    });

    it('does not migrate metadata, watch or change tabs after cancelled Save As', async () => {
      mockSaveDialog.mockResolvedValue('/new/existing.md');
      mockReadTextFile.mockResolvedValue('external target');
      const onPreSaveConflict = vi.fn(async () => 'cancel' as const), onAfterSave = vi.fn();
      const { options, tabs } = makeOptions();
      await useFileOperations({ ...options, onPreSaveConflict, onAfterSave }).saveFileAs();
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(aiCommands.sessionMigrate).not.toHaveBeenCalled();
      expect(aiCommands.accessMigrate).not.toHaveBeenCalled();
      expect(aiCommands.snapshotMigrate).not.toHaveBeenCalled();
      expect(onAfterSave).not.toHaveBeenCalled();
      expect(tabs.value[0].filePath).toBe('/test/file.md');
      expect(tabs.value[0].hasChanges).toBe(true);
    });

    it.each([true, false])('only treats an absent different Save As target as new (exists=%j)', async targetExists => {
      mockSaveDialog.mockResolvedValue('/new/target.md');
      mockExists.mockResolvedValue(targetExists);
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        throw new Error('read failed');
      });
      const onPreSaveConflict = vi.fn(async () => 'save' as const);
      const { options } = makeOptions();
      await useFileOperations({ ...options, onPreSaveConflict }).saveFileAs();
      expect(mockWriteTextFile).toHaveBeenCalledTimes(targetExists ? 0 : 1);
      expect(aiCommands.sessionMigrate).toHaveBeenCalledTimes(targetExists ? 0 : 1);
    });

    it('skips save when conflict detected and user cancels', async () => {
      // Disk content differs from originalMarkdown → conflict
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return '# DIFFERENT disk content'; // conflict!
      });

      const onPreSaveConflict = vi.fn(async () => 'cancel' as const);
      const { options, tabs } = makeOptions();
      const { saveFile } = useFileOperations({ ...options, onPreSaveConflict });

      await saveFile();

      expect(onPreSaveConflict).toHaveBeenCalledWith('/test/file.md', '# DIFFERENT disk content', 'md:<p>hello</p>');
      // File should NOT be written since user cancelled
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(tabs.value[0].hasChanges).toBe(true);
    });

    it('proceeds with save when conflict detected but user confirms', async () => {
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return '# DIFFERENT disk content'; // conflict
      });

      const onPreSaveConflict = vi.fn(async () => 'save' as const);
      const { options, tabs } = makeOptions();
      const { saveFile } = useFileOperations({ ...options, onPreSaveConflict });

      await saveFile();

      expect(onPreSaveConflict).toHaveBeenCalled();
      expect(mockWriteTextFile).toHaveBeenCalled();
      expect(tabs.value[0].hasChanges).toBe(false);
    });

    it('does not call onPreSaveConflict when disk matches originalMarkdown', async () => {
      // Disk content matches originalMarkdown → no conflict
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return '# hello'; // matches originalMarkdown
      });

      const onPreSaveConflict = vi.fn(async () => 'save' as const);
      const { options } = makeOptions({ originalMarkdown: '# hello' });
      const { saveFile } = useFileOperations({ ...options, onPreSaveConflict });

      await saveFile();

      expect(onPreSaveConflict).not.toHaveBeenCalled();
    });

    it('does not call onPreSaveConflict when tab has no originalMarkdown (new file)', async () => {
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return 'some disk content';
      });

      const onPreSaveConflict = vi.fn(async () => 'cancel' as const);
      const { options } = makeOptions({ originalMarkdown: null });
      const { saveFile } = useFileOperations({ ...options, onPreSaveConflict });

      await saveFile();

      expect(onPreSaveConflict).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // saveFile — basic flow
  // ----------------------------------------------------------

  describe('saveFile', () => {
    it.each(['', '\uFEFF# 日本語\r\n\r\n:::unknown untouched\r\n$$a+b$$  \r\n\t\r\n', '# mixed\r\nUnknown  \nlast\r'])('Save As preserves unchanged source bytes: %j', source => {
      mockSaveDialog.mockResolvedValue('/new/copy.md');
      mockReadTextFile.mockImplementation(async (path: string) => path.endsWith('.tmp') ? source : '');
      const { options, tabs, getEditorHtml } = makeOptions({ hasChanges: false, originalMarkdown: source });
      const { saveFileAs } = useFileOperations(options);
      return saveFileAs().then(() => {
        expect(mockWriteTextFile).toHaveBeenCalledWith('/new/copy.md.tmp', source);
        expect(getEditorHtml).not.toHaveBeenCalled();
        expect(htmlToMarkdown).not.toHaveBeenCalled();
        expect(tabs.value[0].originalMarkdown).toBe(source);
      });
    });

    it('preserves authoritative Source edits including BOM, mixed newlines and trailing whitespace', async () => {
      const source = '\uFEFF# changed\r\n:::unknown\n$$x$$  \r\n\t';
      mockReadTextFile.mockImplementation(async (path: string) => path.endsWith('.tmp') ? source : '# hello');
      const { options } = makeOptions({}, { getMarkdownOverride: () => source });
      await useFileOperations(options).saveFile();
      expect(mockWriteTextFile).toHaveBeenCalledWith('/test/file.md.tmp', source);
      expect(htmlToMarkdown).not.toHaveBeenCalled();
    });

    it('skips save when file exists and has no changes', async () => {
      const { options } = makeOptions({ hasChanges: false });
      const { saveFile } = useFileOperations(options);

      await saveFile();

      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it('shows save dialog when file has no path yet', async () => {
      mockSaveDialog.mockResolvedValue('/new/path/file.md');
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return ''; // no disk conflict
      });

      const { options } = makeOptions({ filePath: null });
      const { saveFile } = useFileOperations(options);

      await saveFile();

      expect(mockSaveDialog).toHaveBeenCalled();
      expect(mockWriteTextFile).toHaveBeenCalledWith('/new/path/file.md.tmp', expect.any(String));
    });

    it('updates tab state after successful save', async () => {
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path.endsWith('.tmp')) return 'md:<p>hello</p>';
        return '# hello';
      });

      const { options, tabs } = makeOptions();
      const { saveFile } = useFileOperations(options);

      await saveFile();

      expect(tabs.value[0].hasChanges).toBe(false);
      expect(tabs.value[0].filePath).toBe('/test/file.md');
    });
  });

  // ----------------------------------------------------------
  // openFileFromPath
  // ----------------------------------------------------------

  describe('native document authority', () => {
    it.each(['recent', 'session', 'link'])('rejects an ungranted %s path without changing tabs or using legacy reads', async (entry) => {
      const denied = { code: 'permission_required', message: 'Select again' };
      mockNativeRead.mockRejectedValue(denied);
      const onOpenError = vi.fn();
      const { options, tabs, createNewTab, switchToTab } = makeOptions({}, { onOpenError });
      const before = JSON.stringify(tabs.value);
      const operations = useFileOperations(options);
      if (entry === 'link') await operations.openFileInNewTab('../private.md');
      else await operations.openFileFromPath('/private.md');
      expect(onOpenError).toHaveBeenCalledWith(denied, '/private.md');
      expect(JSON.stringify(tabs.value)).toBe(before);
      expect(createNewTab).not.toHaveBeenCalled();
      expect(switchToTab).not.toHaveBeenCalled();
      expect(mockReadTextFile).not.toHaveBeenCalled();
      expect(mockOpenDialog).not.toHaveBeenCalled();
      expect(operations.isLoadingFile.value).toBe(false);
    });

    it('native picker cancellation preserves the active document', async () => {
      const { options, tabs } = makeOptions();
      const before = JSON.stringify(tabs.value);
      await useFileOperations(options).openFile();
      expect(mockPickDocuments).toHaveBeenCalledOnce();
      expect(mockNativeRead).not.toHaveBeenCalled();
      expect(mockOpenDialog).not.toHaveBeenCalled();
      expect(JSON.stringify(tabs.value)).toBe(before);
    });

    it('opens native selections sequentially and continues after a failed selected read', async () => {
      const sources = ['\uFEFF# A\r\n\r\n', '# B\n'];
      mockPickDocuments.mockResolvedValue([{ path: '/a.md' }, { path: '/denied.md' }, { path: '/b.md' }]);
      let release!: (value: string) => void;
      mockNativeRead.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }))
        .mockRejectedValueOnce({ code: 'permission_required' }).mockResolvedValueOnce(sources[1]);
      const onFileOpened = vi.fn();
      const onOpenError = vi.fn();
      const { options, tabs, createNewTab } = makeOptions({ filePath: null, hasChanges: false, content: '<p></p>' }, { onFileOpened, onOpenError });
      createNewTab.mockImplementation((...args: unknown[]) => {
        tabs.value.push(makeTab({ id: 'new-tab-id', filePath: args[0] as string, hasChanges: false }));
        return 'new-tab-id';
      });
      const pending = useFileOperations(options).openFile();
      await vi.waitFor(() => expect(mockNativeRead).toHaveBeenCalledOnce());
      release(sources[0]);
      await pending;
      expect(mockNativeRead.mock.calls.map(call => call[0])).toEqual(['/a.md', '/denied.md', '/b.md']);
      expect(tabs.value.map(tab => [tab.filePath, tab.pendingMarkdown])).toEqual([['/a.md', sources[0]], ['/b.md', sources[1]]]);
      expect(onFileOpened.mock.calls.map(call => call[0])).toEqual(['/a.md', '/b.md']);
      expect(onOpenError).toHaveBeenCalledWith({ code: 'permission_required' }, '/denied.md');
      expect(mockReadTextFile).not.toHaveBeenCalled();
    });

    it('does not replace new edits made in an empty tab while a native read is pending', async () => {
      let release!: (value: string) => void;
      mockNativeRead.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
      const { options, tabs, createNewTab } = makeOptions({ filePath: null, hasChanges: false, content: '<p></p>' });
      const pending = useFileOperations(options).openFileFromPath('/selected.md');
      tabs.value[0].content = '<p>New draft</p>';
      tabs.value[0].hasChanges = true;
      release('# Selected\r\n');
      await pending;
      expect(tabs.value[0].content).toBe('<p>New draft</p>');
      expect(tabs.value[0].filePath).toBeNull();
      expect(createNewTab).toHaveBeenCalledWith('/selected.md', '', 'selected.md');
    });

    it.each(['path', 'link'])('does not report a successful %s open when tab creation fails', async (entry) => {
      const onFileOpened = vi.fn();
      const { options, createNewTab, switchToTab, tabs } = makeOptions({}, { onFileOpened });
      createNewTab.mockReturnValue('');
      const before = JSON.stringify(tabs.value);
      const operations = useFileOperations(options);
      if (entry === 'path') await operations.openFileFromPath('/test/next.md');
      else await operations.openFileInNewTab('next.md');
      expect(switchToTab).not.toHaveBeenCalled();
      expect(onFileOpened).not.toHaveBeenCalled();
      expect(JSON.stringify(tabs.value)).toBe(before);
      expect(operations.isLoadingFile.value).toBe(false);
    });

    it.each(['path', 'link'])('reuses a tab created by another %s open during the pending read', async (entry) => {
      const onFileOpened = vi.fn();
      const { options, createNewTab, switchToTab, findTabByFilePath } = makeOptions({}, { onFileOpened });
      findTabByFilePath.mockReturnValueOnce(undefined).mockReturnValue(makeTab({ id: 'concurrently-opened' }) as never);
      const operations = useFileOperations(options);
      if (entry === 'path') await operations.openFileFromPath('/test/next.md');
      else await operations.openFileInNewTab('next.md');
      expect(createNewTab).not.toHaveBeenCalled();
      expect(switchToTab).toHaveBeenCalledWith('concurrently-opened');
      expect(onFileOpened).not.toHaveBeenCalled();
    });

    it('reports native picker failure and does not invoke the legacy picker', async () => {
      const failure = { code: 'dialog_unavailable' };
      mockPickDocuments.mockRejectedValueOnce(failure);
      const onOpenError = vi.fn();
      await useFileOperations(makeOptions({}, { onOpenError }).options).openFile();
      expect(onOpenError).toHaveBeenCalledWith(failure, null);
      expect(mockOpenDialog).not.toHaveBeenCalled();
    });
  });

  describe('openFileFromPath', () => {
    it('switches to existing tab if file already open', async () => {
      const existingTab = makeTab({ id: 'existing-tab' });
      const { options, switchToTab } = makeOptions();
      (options.findTabByFilePath as ReturnType<typeof vi.fn>).mockReturnValue(existingTab);

      const { openFileFromPath } = useFileOperations(options);
      await openFileFromPath('/test/file.md');

      expect(switchToTab).toHaveBeenCalledWith('existing-tab');
      expect(mockNativeRead).not.toHaveBeenCalled();
    });

    it('loads file content and calls onFileOpened callback', async () => {
      mockNativeRead.mockResolvedValue('# new file content');
      const onFileOpened = vi.fn();

      const { options } = makeOptions({ filePath: null, hasChanges: false, content: '<p></p>' });
      const { openFileFromPath } = useFileOperations({ ...options, onFileOpened });

      await openFileFromPath('/other/file.md');

      expect(mockNativeRead).toHaveBeenCalledWith('/other/file.md');
      expect(onFileOpened).toHaveBeenCalledWith('/other/file.md', '# new file content');
    });
  });

  // ----------------------------------------------------------
  // Large files — markdown-first open (issue #129)
  // ----------------------------------------------------------

  describe('large file open', () => {
    it('opens a file above the threshold as markdown-first without converting', async () => {
      const bigContent = 'x'.repeat(1_000_001);
      mockNativeRead.mockResolvedValue(bigContent);
      const onLargeFileOpened = vi.fn();

      const { options, tabs, setEditorContent } = makeOptions(
        { filePath: null, hasChanges: false, content: '<p></p>' },
      );
      const { openFileFromPath } = useFileOperations({ ...options, onLargeFileOpened });

      await openFileFromPath('/big/big.md');

      const tab = tabs.value[0];
      expect(tab.largeFile).toBe(true);
      expect(tab.pendingMarkdown).toBe(bigContent);
      expect(tab.content).toBe('');
      expect(tab.originalMarkdown).toBe(bigContent);
      expect(markdownToHtml).not.toHaveBeenCalled();
      expect(setEditorContent).not.toHaveBeenCalled();
      expect(onLargeFileOpened).toHaveBeenCalledWith('/big/big.md', bigContent);
    });

    it('opens a large file into a new tab as markdown-first when active tab is not empty', async () => {
      const bigContent = 'y'.repeat(1_000_001);
      mockNativeRead.mockResolvedValue(bigContent);
      const onLargeFileOpened = vi.fn();

      const { options, createNewTab, tabs } = makeOptions();
      tabs.value.push(makeTab({ id: 'new-tab-id', filePath: null, content: '', originalMarkdown: null }));
      const { openFileFromPath } = useFileOperations({ ...options, onLargeFileOpened });

      await openFileFromPath('/big/big.md');

      expect(createNewTab).toHaveBeenCalledWith('/big/big.md', '', 'big.md');
      const newTab = tabs.value.find(t => t.id === 'new-tab-id')!;
      expect(newTab.largeFile).toBe(true);
      expect(newTab.pendingMarkdown).toBe(bigContent);
      expect(markdownToHtml).not.toHaveBeenCalled();
      expect(onLargeFileOpened).toHaveBeenCalledWith('/big/big.md', bigContent);
    });

    it('opens an ordinary file inertly with exact source and no editor conversion', async () => {
      mockNativeRead.mockResolvedValue('# small');
      const onLargeFileOpened = vi.fn();

      const { options, tabs } = makeOptions({ filePath: null, hasChanges: false, content: '<p></p>' });
      const { openFileFromPath } = useFileOperations({ ...options, onLargeFileOpened });

      await openFileFromPath('/small/small.md');

      const tab = tabs.value[0];
      expect(tab.largeFile).toBeUndefined();
      expect(tab.pendingMarkdown).toBe('# small');
      expect(tab.content).toBe('');
      expect(tab.editorMode).toBeNull();
      expect(tab.readOnly).toBe(true);
      expect(markdownToHtml).not.toHaveBeenCalled();
      expect(options.setEditorContent).not.toHaveBeenCalled();
      expect(onLargeFileOpened).not.toHaveBeenCalled();
    });

    it('opens a large file via openFileInNewTab (relative link) as markdown-first', async () => {
      const bigContent = 'z'.repeat(1_000_001);
      mockNativeRead.mockResolvedValue(bigContent);
      const onLargeFileOpened = vi.fn();

      const { options, createNewTab, tabs } = makeOptions();
      tabs.value.push(makeTab({ id: 'new-tab-id', filePath: null, content: '', originalMarkdown: null }));
      const { openFileInNewTab } = useFileOperations({ ...options, onLargeFileOpened });

      await openFileInNewTab('big.md');

      expect(createNewTab).toHaveBeenCalledWith('/test/big.md', '', 'big.md');
      const newTab = tabs.value.find(t => t.id === 'new-tab-id')!;
      expect(newTab.largeFile).toBe(true);
      expect(newTab.pendingMarkdown).toBe(bigContent);
      expect(markdownToHtml).not.toHaveBeenCalled();
      expect(onLargeFileOpened).toHaveBeenCalledWith('/test/big.md', bigContent);
    });
  });
});

// ============================================================
// handleLinkClick — in-document anchors
// ============================================================

describe('handleLinkClick — anchors', () => {
  // Returns the scrollTo calls recorded for each container, in DOM order.
  const buildPanes = (panes: Array<{ active?: boolean; html: string }>) => {
    document.body.innerHTML = panes
      .map(
        (p) =>
          `<div class="editor-pane${p.active ? ' active' : ''}">` +
          `<div class="editor-container">${p.html}</div></div>`
      )
      .join('');
    return Array.from(document.querySelectorAll<HTMLElement>('.editor-container')).map((c) => {
      const calls: unknown[] = [];
      c.scrollTo = ((arg: unknown) => calls.push(arg)) as typeof c.scrollTo;
      return calls;
    });
  };

  // Code+preview replaces the whole SplitContainer, so no .editor-pane exists.
  const buildBareContainer = (html: string) => {
    document.body.innerHTML = `<div class="split-editor-preview"><div class="editor-container">${html}</div></div>`;
    const c = document.querySelector<HTMLElement>('.editor-container')!;
    const calls: unknown[] = [];
    c.scrollTo = ((arg: unknown) => calls.push(arg)) as typeof c.scrollTo;
    return calls;
  };

  it('scrolls to an exactly matching heading id', () => {
    const { options } = makeOptions();
    const { handleLinkClick } = useFileOperations(options as never);
    const [calls] = buildPanes([{ active: true, html: '<h2 id="overview">Overview</h2>' }]);

    handleLinkClick('#overview');

    expect(calls).toHaveLength(1);
  });

  it('searches the active pane, not the first one in the DOM', () => {
    const { options } = makeOptions();
    const { handleLinkClick } = useFileOperations(options as never);
    const [inactive, active] = buildPanes([
      { html: '<p>other document</p>' },
      { active: true, html: '<h2 id="overview">Overview</h2>' },
    ]);

    handleLinkClick('#overview');

    expect(inactive).toHaveLength(0);
    expect(active).toHaveLength(1);
  });

  it('falls back to the plain container when no pane is marked active', () => {
    const { options } = makeOptions();
    const { handleLinkClick } = useFileOperations(options as never);
    const calls = buildBareContainer('<h2 id="overview">Overview</h2>');

    handleLinkClick('#overview');

    expect(calls).toHaveLength(1);
  });

  it('resolves an anchor written against the old collapsed-hyphen slug rules', () => {
    const { options } = makeOptions();
    const { handleLinkClick } = useFileOperations(options as never);
    const [calls] = buildPanes([
      { active: true, html: '<h2 id="tier-0--write-path-correctness">Tier 0 — write-path correctness</h2>' },
    ]);

    // What MerMark used to generate, and what users hand-patched their docs to.
    handleLinkClick('#tier-0-write-path-correctness');

    expect(calls).toHaveLength(1);
  });

  it('resolves against heading text when the id is stale after a WYSIWYG edit', () => {
    const { options } = makeOptions();
    const { handleLinkClick } = useFileOperations(options as never);
    const [calls] = buildPanes([
      { active: true, html: '<h2 id="old-title">Renamed Section</h2>' },
    ]);

    handleLinkClick('#renamed-section');

    expect(calls).toHaveLength(1);
  });

  it('decodes percent-encoded anchors', () => {
    const { options } = makeOptions();
    const { handleLinkClick } = useFileOperations(options as never);
    const [calls] = buildPanes([{ active: true, html: '<h2 id="概要">概要</h2>' }]);

    handleLinkClick('#' + encodeURIComponent('概要'));

    expect(calls).toHaveLength(1);
  });

  it('reports a genuinely missing anchor instead of failing silently', () => {
    const onAnchorNotFound = vi.fn();
    const { options } = makeOptions({}, { onAnchorNotFound });
    const { handleLinkClick } = useFileOperations(options as never);
    const [calls] = buildPanes([{ active: true, html: '<h2 id="overview">Overview</h2>' }]);

    handleLinkClick('#nothing-like-this');

    expect(calls).toHaveLength(0);
    expect(onAnchorNotFound).toHaveBeenCalledWith('nothing-like-this');
  });

  it('does not treat an anchor as a file to open', () => {
    const { options, createNewTab } = makeOptions();
    const { handleLinkClick } = useFileOperations(options as never);
    buildPanes([{ active: true, html: '<p>no headings</p>' }]);

    handleLinkClick('#missing');

    expect(createNewTab).not.toHaveBeenCalled();
  });

  it('does not jump to an unrelated heading that carries a stale look-alike id', () => {
    const onAnchorNotFound = vi.fn();
    const { options } = makeOptions({}, { onAnchorNotFound });
    const { handleLinkClick } = useFileOperations(options as never);
    const [calls] = buildPanes([
      {
        active: true,
        html:
          '<h2 id="foo--bar">Deprecated Notice</h2>' +
          '<h2 id="foo-bar-2024">Foo Bar</h2>',
      },
    ]);

    // jsdom gives every element a zero rect, so stub distinct offsets to make
    // WHICH heading was chosen observable in the resulting scroll position.
    const wrong = document.getElementById('foo--bar')!;
    const right = document.getElementById('foo-bar-2024')!;
    const container = document.querySelector('.editor-container')!;
    container.getBoundingClientRect = (() => ({ top: 0 })) as never;
    wrong.getBoundingClientRect = (() => ({ top: 100 })) as never;
    right.getBoundingClientRect = (() => ({ top: 500 })) as never;

    handleLinkClick('#foo-bar');

    // Must land on the heading actually titled "Foo Bar" (500 - 20), never on
    // the one that merely holds a stale double-hyphen id (which would be 80).
    expect(calls).toEqual([{ top: 480, behavior: 'smooth' }]);
    expect(onAnchorNotFound).not.toHaveBeenCalled();
  });

  it('reports ambiguity instead of guessing between two equally good headings', () => {
    const onAnchorNotFound = vi.fn();
    const { options } = makeOptions({}, { onAnchorNotFound });
    const { handleLinkClick } = useFileOperations(options as never);
    const [calls] = buildPanes([
      { active: true, html: '<h2 id="a">Foo Bar</h2><h2 id="b">Foo  Bar</h2>' },
    ]);

    handleLinkClick('#foo-bar');

    expect(calls).toHaveLength(0);
    expect(onAnchorNotFound).toHaveBeenCalledWith('foo-bar');
  });

  it('does not throw on a malformed percent escape, and still reports it', () => {
    const onAnchorNotFound = vi.fn();
    const { options } = makeOptions({}, { onAnchorNotFound });
    const { handleLinkClick } = useFileOperations(options as never);
    buildPanes([{ active: true, html: '<h2 id="coverage">Coverage</h2>' }]);

    expect(() => handleLinkClick('#100%-coverage')).not.toThrow();
    expect(() => handleLinkClick('#a%zz')).not.toThrow();
    expect(onAnchorNotFound).toHaveBeenCalledTimes(2);
  });
});
