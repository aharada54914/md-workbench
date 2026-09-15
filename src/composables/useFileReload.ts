import { ref, computed, type Ref, type ComputedRef } from 'vue';
import { readTextFile } from '../services/documentText';
import { markdownToHtml } from '../utils/markdown-converter';
import { serializeVisualMarkdown } from '../utils/visual-source';
import { generateDiff, type DiffLine, type DiffStats } from './useDiffPreview';
import { useFileWatcher } from './useFileWatcher';
import { scrollTopFromRatio } from './useScrollSync';
import { DOM_SELECTORS, TIMING, MAX_DOM_RESTORE_ATTEMPTS } from '../constants';
import { t } from '../i18n';
import type { Tab } from './useTabs';

// Reading the live container (not the stale tab.scrollTop) is the whole point:
// an external edit can fire while the user is mid-scroll.
// This scroll restoration targets the active Visual container; Source editors
// retain their own scroll state when setCodeMarkdown reseeds the raw buffer.
const getActiveScrollContainer = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(DOM_SELECTORS.ACTIVE_EDITOR_CONTAINER);

const getScrollRatio = (el: HTMLElement): number => {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
};

// Content was just rebuilt; the container may not have its final scrollHeight
// for a few frames. Retry until it can honour the target or attempts run out.
// ponytail: ratio restore only. Upgrade path if "external edit changed content
// a lot" drifts noticeably: reuse useCodeView's findElementByBlockMap to anchor
// on the block under the viewport instead of a proportional position.
const restoreScrollRatio = (ratio: number): void => {
  let attempts = 0;
  const tryRestore = () => {
    const el = getActiveScrollContainer();
    if (el && el.scrollHeight - el.clientHeight > 0) {
      el.scrollTop = scrollTopFromRatio(ratio, el.scrollHeight, el.clientHeight);
      return;
    }
    if (attempts++ < MAX_DOM_RESTORE_ATTEMPTS) {
      window.setTimeout(tryRestore, TIMING.DOM_RETRY_INTERVAL);
    }
  };
  tryRestore();
};

interface PaneTabResult {
  pane: { id: string; activeTabId: string; tabs: Tab[] };
  tab: Tab;
}

export interface UseFileReloadOptions {
  activePaneId: Ref<string>;
  currentFile: ComputedRef<string | null>;
  /** Select manual reload by object identity when multiple tabs share a path. */
  activeTab?: ComputedRef<Tab | undefined>;
  hasChanges: ComputedRef<boolean>;
  /** With expectedTab, resolve that exact object across all live panes. */
  findTabByFilePathSplit: (filePath: string, expectedTab?: Tab) => PaneTabResult | undefined;
  setEditorContent: (content: string) => void;
  /** Reseed active Source/Split editors with the exact reloaded Markdown. */
  setCodeMarkdown?: (markdown: string) => void;
}

export function useFileReload(options: UseFileReloadOptions) {
  const { activePaneId, currentFile, findTabByFilePathSplit, setEditorContent, setCodeMarkdown } = options;
  const findTarget = (filePath: string, expectedTab?: Tab) => {
    const result = findTabByFilePathSplit(filePath, expectedTab);
    return result && (!expectedTab || result.tab === expectedTab) ? result : undefined;
  };
  const captureTab = (tab: Tab, filePath: string) => ({
    tab, filePath, originalMarkdown: tab.originalMarkdown,
    pendingMarkdown: tab.pendingMarkdown, content: tab.content, hasChanges: tab.hasChanges,
  });
  type TabSnapshot = ReturnType<typeof captureTab>;
  const currentSnapshotTarget = (snapshot: TabSnapshot) => {
    const { tab, filePath } = snapshot;
    const target = findTarget(filePath, tab);
    return target && tab.filePath === filePath
      && tab.originalMarkdown === snapshot.originalMarkdown
      && tab.pendingMarkdown === snapshot.pendingMarkdown
      && tab.content === snapshot.content
      && tab.hasChanges === snapshot.hasChanges ? target : undefined;
  };

  // Toast state
  const showToast = ref(false);
  const toastMessage = ref('');
  const toastType = ref<'info' | 'success' | 'warning'>('info');

  // Conflict modal state
  const showConflictModal = ref(false);
  const conflictFileName = ref('');
  const conflictDiffLines = ref<DiffLine[]>([]);
  const conflictDiffStats = ref<DiffStats>({ additions: 0, deletions: 0 });
  const conflictFilePath = ref('');
  const conflictNewContent = ref('');
  let conflictTarget: TabSnapshot | null = null;

  const showToastNotification = (message: string, type: 'info' | 'success' | 'warning' = 'info') => {
    toastMessage.value = message;
    toastType.value = type;
    showToast.value = true;
  };

  const dismissToast = () => {
    showToast.value = false;
  };

  // File watcher — callbacks are arrow functions so handlers are resolved at call time
  const fileWatcher = useFileWatcher({
    onExternalChange: (filePath: string, newDiskContent: string) => {
      handleExternalFileChange(filePath, newDiskContent);
    },
    onFileDeleted: (filePath: string) => {
      const result = findTabByFilePathSplit(filePath);
      if (!result) return;
      showToastNotification(t.value.fileDeletedExternally(filePath), 'warning');
    },
    onWatchError: (filePath, error) => {
      console.error(`[FileWatcher] Error watching ${filePath}:`, error);
    },
  });

  const reloadTabContent = (filePath: string, newContent: string, expectedTab?: Tab) => {
    const result = findTarget(filePath, expectedTab);
    if (!result) return;

    const { pane, tab } = result;

    if (tab.largeFile && tab.pendingMarkdown != null) {
      tab.pendingMarkdown = newContent;
      tab.originalMarkdown = newContent;
      tab.hasChanges = false;
      fileWatcher.updateKnownContent(filePath, newContent);
      const isActiveTab = tab.id === pane.activeTabId && pane.id === activePaneId.value;
      if (isActiveTab) setCodeMarkdown?.(newContent);
      return;
    }

    const htmlContent = markdownToHtml(newContent);
    const isActive = tab.id === pane.activeTabId && pane.id === activePaneId.value;

    // Capture the user's LIVE scroll position before the DOM is rebuilt.
    const container = isActive ? getActiveScrollContainer() : null;
    const savedRatio = container ? getScrollRatio(container) : 0;

    tab.content = htmlContent;
    tab.pendingMarkdown = newContent;
    tab.originalMarkdown = newContent;
    tab.hasChanges = false;

    fileWatcher.updateKnownContent(filePath, newContent);

    if (isActive) {
      setCodeMarkdown?.(newContent);
      setEditorContent(htmlContent);
      restoreScrollRatio(savedRatio);
    }
  };

  const handleExternalFileChange = (filePath: string, newDiskContent: string, expectedTab?: Tab) => {
    const result = findTarget(filePath, expectedTab);
    if (!result) return;

    const { tab } = result;

    if (!tab.hasChanges) {
      reloadTabContent(filePath, newDiskContent, tab);
      showToastNotification(t.value.fileReloadedExternally(filePath), 'info');
    } else {
      // Diff shows local (current editor) → disk so the user sees their changes vs external changes.
      const localMarkdown = tab.pendingMarkdown ?? serializeVisualMarkdown(tab.content, tab.originalMarkdown);
      const diffResult = generateDiff(localMarkdown, newDiskContent);
      conflictTarget = captureTab(tab, filePath);
      conflictFilePath.value = filePath;
      conflictFileName.value = tab.fileName;
      conflictDiffLines.value = diffResult.lines;
      conflictDiffStats.value = diffResult.stats;
      conflictNewContent.value = newDiskContent;
      showConflictModal.value = true;
    }
  };

  const takeConflictTarget = () => {
    const target = conflictTarget && currentSnapshotTarget(conflictTarget);
    conflictTarget = null;
    showConflictModal.value = false;
    return target;
  };

  const handleConflictKeepLocal = () => {
    if (!takeConflictTarget()) return;
    fileWatcher.updateKnownContent(conflictFilePath.value, conflictNewContent.value);
  };

  const handleConflictLoadExternal = () => {
    const target = takeConflictTarget();
    if (target) reloadTabContent(conflictFilePath.value, conflictNewContent.value, target.tab);
  };

  const handleConflictMerge = (mergedContent: string) => {
    const target = takeConflictTarget();
    if (!target) return;
    const filePath = conflictFilePath.value;
    reloadTabContent(filePath, mergedContent, target.tab);
    // A manual merge edits the buffer; the external version is still on disk.
    target.tab.originalMarkdown = conflictNewContent.value;
    target.tab.hasChanges = mergedContent !== conflictNewContent.value;
    fileWatcher.updateKnownContent(filePath, conflictNewContent.value);
  };

  const manualReads = new WeakMap<Tab, symbol>();
  const manualReload = async () => {
    const filePath = currentFile.value;
    if (!filePath) return;
    const activeTab = options.activeTab?.value;
    if (options.activeTab && !activeTab) return;
    const target = findTarget(filePath, activeTab);
    if (!target) return;
    const { tab } = target;
    const snapshot = captureTab(tab, filePath);
    const request = Symbol();
    manualReads.set(tab, request);
    // A path can be reopened into a different tab while this read is pending.
    // Buffer comparison also protects edits before the dirty flag is updated.
    const isCurrent = () => manualReads.get(tab) === request
      && !!currentSnapshotTarget(snapshot);

    try {
      const newContent = await readTextFile(filePath);
      if (!isCurrent()) return;

      if (tab.hasChanges) {
        handleExternalFileChange(filePath, newContent, tab);
      } else {
        reloadTabContent(filePath, newContent, tab);
        showToastNotification(t.value.fileReloaded, 'success');
      }
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Error reloading file:', error);
      showToastNotification(t.value.fileReloadError, 'warning');
    } finally {
      if (manualReads.get(tab) === request) manualReads.delete(tab);
    }
  };

  return {
    // Toast
    showToastNotification,
    showToast: computed(() => showToast.value),
    toastMessage: computed(() => toastMessage.value),
    toastType: computed(() => toastType.value),
    dismissToast,

    // Conflict modal
    showConflictModal: computed(() => showConflictModal.value),
    conflictFileName: computed(() => conflictFileName.value),
    conflictFilePath: computed(() => conflictFilePath.value),
    conflictDiffLines: computed(() => conflictDiffLines.value),
    conflictDiffStats: computed(() => conflictDiffStats.value),
    handleConflictKeepLocal,
    handleConflictLoadExternal,
    handleConflictMerge,

    // Manual reload
    manualReload,

    // Reload helper (exposed for pre-save conflict "load external" action in App.vue)
    reloadTabContent,

    // File watcher controls (exposed for App.vue integration)
    watchFile: fileWatcher.watchFile,
    unwatchFile: fileWatcher.unwatchFile,
    unwatchAll: fileWatcher.unwatchAll,
    markSaveStart: fileWatcher.markSaveStart,
    markSaveEnd: fileWatcher.markSaveEnd,
    markSaveAbort: fileWatcher.markSaveAbort,
  };
}
