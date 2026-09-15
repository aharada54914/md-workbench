import { ref, computed, type Ref, type ComputedRef } from 'vue';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, rename, remove, exists } from '@tauri-apps/plugin-fs';
import { readTextFile } from '../services/documentText';
import { nativeFs } from '../services/nativeFs';
import { resolveDocumentLinkPath } from '../utils/document-link-path';
import { openExternal } from '../services/nativeExternalLink';
import { generateSlug } from '../utils/markdown-converter';
import { serializeVisualMarkdown } from '../utils/visual-source';
import { aiCommands } from '../services/aiCommands';
import type { Tab } from './useTabs';
import { EMPTY_TAB_CONTENT, DEFAULT_FILE_NAME, DOM_SELECTORS, LARGE_FILE_CHAR_THRESHOLD } from '../constants';

export interface OpenDocumentSelection {
  expectedGrantId?: string;
  isCurrent?: () => boolean;
}

export interface SavedDocument {
  tab: Tab;
  oldPath: string | null;
  filePath: string;
  content: string;
}

export interface UseFileOperationsOptions {
  tabs: Ref<Tab[]>;
  activeTabId: Ref<string>;
  activeTab: ComputedRef<Tab>;
  /** Hosts with split panes must check object identity across every pane. */
  isTabOpen?: (tab: Tab) => boolean;
  findTabByFilePath: (filePath: string) => Tab | undefined;
  createNewTab: (filePath?: string | null, fileContent?: string, fileName?: string) => string;
  switchToTab: (tabId: string, preserveHasChanges?: boolean) => Promise<void>;
  getEditorHtml: () => string;
  /** Optional override — when provided, used directly as markdown instead of converting from HTML.
   *  Use this to pass raw codeContent when saving from code view. */
  getMarkdownOverride?: () => string | null;
  setEditorContent: (content: string) => void;
  markSaveStart?: (filePath: string) => void;
  markSaveEnd?: (filePath: string, content: string) => void;
  markSaveAbort?: (filePath: string) => void;
  /** Reports native permission/read failures without mutating tabs or falling back. */
  onOpenError?: (error: unknown, filePath: string | null) => void;
  onFileOpened?: (filePath: string, content: string) => void;
  onFileReselected?: (tab: Tab, expectedGrantId: string) => Promise<void>;
  /** Notifies hosts of a large raw document. Opening does not activate an editor;
   *  the host can page its source until the user chooses an editing mode. */
  onLargeFileOpened?: (filePath: string, markdown: string) => void;
  /** Called after a successful save / save-as so the host can register a
   *  file watcher for new paths. Safe to call repeatedly — the watcher
   *  layer ignores already-watched files. */
  onAfterSave?: (saved: SavedDocument) => void;
  /** Returns 'save' | 'cancel' | mergedMarkdownString (to save the merged version).
   *  localMarkdown is the current editor content (used to compute a local→disk diff). */
  onPreSaveConflict?: (filePath: string, diskContent: string, localMarkdown: string, tab: Tab) => Promise<'save' | 'cancel' | string>;
  /** Called when a `#anchor` link matches no heading, so the host can tell the
   *  user instead of leaving the click looking like a no-op. */
  onAnchorNotFound?: (anchor: string) => void;
}

export interface UseFileOperationsReturn {
  currentFile: ComputedRef<string | null>;
  isLoadingFile: Ref<boolean>;
  showExternalLinkDialog: Ref<boolean>;
  pendingExternalUrl: Ref<string>;
  openFile: () => Promise<void>;
  openFileFromPath: (filePath: string, selection?: OpenDocumentSelection) => Promise<void>;
  saveFile: () => Promise<boolean>;
  saveExistingTab: (tab: Tab, snapshot: { markdown: string | null; html: string }) => Promise<boolean>;
  saveFileAs: () => Promise<void>;
  handleLinkClick: (href: string) => void;
  confirmExternalLink: () => Promise<void>;
  cancelExternalLink: () => void;
  openFileInNewTab: (relativePath: string) => Promise<void>;
}

export function useFileOperations(options: UseFileOperationsOptions): UseFileOperationsReturn {
  const {
    tabs,
    activeTabId,
    activeTab,
    findTabByFilePath,
    createNewTab,
    switchToTab,
    getEditorHtml,
    getMarkdownOverride,
    markSaveStart,
    markSaveEnd,
    markSaveAbort,
    onAfterSave,
    onFileReselected,
    onFileOpened,
    onOpenError,
    onLargeFileOpened,
    onPreSaveConflict,
    onAnchorNotFound,
  } = options;

  const currentFile = computed(() => activeTab.value?.filePath || null);
  const isLoadingFile = ref(false);

  // External link confirmation state
  const showExternalLinkDialog = ref(false);
  const pendingExternalUrl = ref('');

  const extractFileName = (filePath: string): string =>
    filePath.split(/[/\\]/).pop() || DEFAULT_FILE_NAME;

  const isActiveTabEmpty = (): boolean =>
    !activeTab.value?.filePath && !activeTab.value?.hasChanges && activeTab.value?.content === EMPTY_TAB_CONTENT;

  const findActiveTabIndex = (): number =>
    tabs.value.findIndex(t => t.id === activeTabId.value);

  const loadFileIntoTab = async (filePath: string, selection?: OpenDocumentSelection): Promise<void> => {
    if (selection?.isCurrent?.() === false) return;
    // Check if file is already open
    const existingTab = findTabByFilePath(filePath);
    if (existingTab) {
      if (selection?.isCurrent?.() === false) return;
      if (selection?.expectedGrantId) await onFileReselected?.(existingTab, selection.expectedGrantId);
      if (selection?.isCurrent?.() !== false && isTabOpen(existingTab) && existingTab.filePath === filePath) await switchToTab(existingTab.id);
      return;
    }

    const fileContent = selection?.expectedGrantId
      ? await nativeFs.readPathText(filePath, undefined, selection.expectedGrantId)
      : await nativeFs.readPathText(filePath);
    if (selection?.isCurrent?.() === false) return;
    // Another open may have completed during the native read.
    const openedDuringRead = findTabByFilePath(filePath);
    if (openedDuringRead) {
      if (selection?.isCurrent?.() === false) return;
      if (selection?.expectedGrantId) await onFileReselected?.(openedDuringRead, selection.expectedGrantId);
      if (selection?.isCurrent?.() !== false && isTabOpen(openedDuringRead) && openedDuringRead.filePath === filePath) await switchToTab(openedDuringRead.id);
      return;
    }
    const isLarge = fileContent.length > LARGE_FILE_CHAR_THRESHOLD;
    // Keep disk source inert until an explicit edit action.
    const htmlContent = '';
    const fileName = extractFileName(filePath);

    const activeIdx = findActiveTabIndex();
    if (selection?.isCurrent?.() === false) return;
    if (isActiveTabEmpty() && activeIdx !== -1) {
      tabs.value[activeIdx].filePath = filePath;
      tabs.value[activeIdx].fileName = fileName;
      tabs.value[activeIdx].content = htmlContent;
      tabs.value[activeIdx].hasChanges = false;
      tabs.value[activeIdx].originalMarkdown = fileContent;
      tabs.value[activeIdx].largeFile = isLarge || undefined;
      tabs.value[activeIdx].pendingMarkdown = fileContent;
      tabs.value[activeIdx].editorMode = null;
      tabs.value[activeIdx].readOnly = true;
    } else {
      const newTabId = createNewTab(filePath, htmlContent, fileName);
      if (!newTabId) return;
      const newTab = tabs.value.find(t => t.id === newTabId);
      if (!newTab) return;
      newTab.originalMarkdown = fileContent;
      newTab.largeFile = isLarge || undefined;
      newTab.pendingMarkdown = fileContent;
      newTab.editorMode = null;
      newTab.readOnly = true;
      if (selection?.isCurrent?.() === false) return;
      await switchToTab(newTabId);
    }

    if (selection?.isCurrent?.() === false) return;
    if (isLarge) onLargeFileOpened?.(filePath, fileContent);
    onFileOpened?.(filePath, fileContent);
  };

  const reportOpenError = (error: unknown, filePath: string | null): void => {
    console.error('Error opening document:', error);
    onOpenError?.(error, filePath);
  };

  const openFileFromPath = async (filePath: string, selection?: OpenDocumentSelection): Promise<void> => {
    try {
      await loadFileIntoTab(filePath, selection);
    } catch (error) {
      if (selection?.isCurrent?.() !== false) reportOpenError(error, filePath);
    }
  };

  const openFile = async (): Promise<void> => {
    try {
      const selected = await nativeFs.pickDocuments();
      // A failed selection must not prevent the remaining selected files opening.
      for (const grant of selected) await openFileFromPath(grant.path, { expectedGrantId: grant.id });
    } catch (error) {
      reportOpenError(error, null);
    }
  };

  // Returns disk content if a conflict is detected, null otherwise.
  const checkPreSaveConflict = async (filePath: string, originalMarkdown: string | null, openedPath = currentFile.value, required = false): Promise<string | null> => {
    if (originalMarkdown === null || (!required && !onPreSaveConflict)) return null;
    try {
      const currentDiskContent = await readTextFile(filePath);
      // Empty originals and newline-only changes are real revisions too.
      return currentDiskContent !== originalMarkdown ? currentDiskContent : null;
    } catch (error) {
      // Never interpret a failed read of the open document as permission to
      // overwrite it. Only a genuinely absent, different Save As target is new.
      if (filePath !== openedPath && !await exists(filePath)) return null;
      throw error;
    }
  };

  const atomicWriteFile = async (filePath: string, content: string): Promise<void> => {
    const tmpPath = filePath + '.tmp';
    try {
      markSaveStart?.(filePath);
      await writeTextFile(tmpPath, content);
      // Verify written content matches expected
      const written = await readTextFile(tmpPath);
      if (written !== content) {
        throw new Error('Atomic save verification failed: written content does not match');
      }
      await rename(tmpPath, filePath);
      markSaveEnd?.(filePath, content);
    } catch (error) {
      markSaveAbort?.(filePath); // Release suppression without accepting unwritten bytes.
      try { await remove(tmpPath); } catch { /* temp file may not exist */ }
      throw error;
    }
  };

  type EditorSnapshot = { markdown: string | null; html: string };
  type SaveSnapshot = {
    tab: Tab;
    oldPath: string | null;
    original: string | null;
    markdown: string;
    html: string | null;
    content: string;
    pending: Tab['pendingMarkdown'];
    raw: string | null;
    background: boolean;
  };
  const isTabOpen = (tab: Tab): boolean => options.isTabOpen?.(tab) ?? tabs.value.includes(tab);
  const captureSave = (tab: Tab, background?: EditorSnapshot): SaveSnapshot => {
    const raw = background ? background.markdown : getMarkdownOverride?.() ?? null;
    const unchangedSource = !tab.hasChanges ? tab.originalMarkdown : null;
    const markdownOverride = unchangedSource ?? raw;
    const html = markdownOverride === null ? (background ? background.html : getEditorHtml()) : null;
    return {
      tab, oldPath: tab.filePath, original: tab.originalMarkdown,
      markdown: markdownOverride ?? serializeVisualMarkdown(html!, tab.originalMarkdown),
      html, content: tab.content, pending: tab.pendingMarkdown, raw,
      background: !!background,
    };
  };
  const stillOwned = (snapshot: SaveSnapshot): boolean =>
    isTabOpen(snapshot.tab) && snapshot.tab.filePath === snapshot.oldPath;
  const stillCurrent = (snapshot: SaveSnapshot): boolean =>
    stillOwned(snapshot) && snapshot.tab.originalMarkdown === snapshot.original;

  const savingTabs = new WeakSet<Tab>();
  const savingPaths = new Set<string>();
  const writeAndUpdateTab = async (filePath: string, snapshot: SaveSnapshot): Promise<boolean> => {
    // Both the document and destination stay reserved through every async step.
    if (!stillCurrent(snapshot) || savingPaths.has(filePath)) return false;
    savingPaths.add(filePath);
    try {
      let markdown = snapshot.markdown;
      let merged = false;
      if (snapshot.background || onPreSaveConflict) {
        const diskContent = await checkPreSaveConflict(filePath, snapshot.original, snapshot.oldPath, snapshot.background);
        if (!stillCurrent(snapshot)) return false;
        if (diskContent !== null) {
          if (snapshot.background || !onPreSaveConflict) return false;
          const decision = await onPreSaveConflict(filePath, diskContent, markdown, snapshot.tab);
          if (decision === 'cancel' || !stillOwned(snapshot)) return false;
          if (decision !== 'save') {
            // A merge callback may install its accepted source in the captured tab.
            // Only that accepted baseline may replace the original revision.
            if (snapshot.tab.originalMarkdown !== snapshot.original && snapshot.tab.originalMarkdown !== decision) return false;
            markdown = decision;
            merged = true;
            snapshot.original = snapshot.tab.originalMarkdown;
            snapshot.content = snapshot.tab.content;
            snapshot.pending = snapshot.tab.pendingMarkdown;
            snapshot.raw = activeTab.value === snapshot.tab ? getMarkdownOverride?.() ?? null : snapshot.tab.pendingMarkdown ?? null;
            snapshot.html = snapshot.raw === null && activeTab.value === snapshot.tab ? getEditorHtml() : null;
          }
        }
      }
      if (!stillCurrent(snapshot)) return false;
      await atomicWriteFile(filePath, markdown);
      // A completed disk write cannot be rolled back safely. A closed/rebound tab
      // must nevertheless never be resurrected or adopt that completion.
      if (!stillCurrent(snapshot)) return false;

      const { tab } = snapshot;
      const active = activeTab.value === tab;
      const rawUnchanged = !active || (getMarkdownOverride?.() ?? null) === snapshot.raw;
      const htmlUnchanged = !active || snapshot.background || snapshot.html === null || getEditorHtml() === snapshot.html;
      const mergeMatchesSource = !merged || snapshot.raw === null || snapshot.raw === markdown;
      const unchanged = tab.content === snapshot.content && tab.pendingMarkdown === snapshot.pending
        && rawUnchanged && htmlUnchanged && mergeMatchesSource;
      tab.filePath = filePath;
      tab.fileName = extractFileName(filePath);
      tab.hasChanges = !unchanged;
      if (snapshot.html !== null && !merged && unchanged) tab.content = snapshot.html;
      tab.originalMarkdown = markdown;
      onAfterSave?.({ tab, oldPath: snapshot.oldPath, filePath, content: markdown });
      return true;
    } finally {
      savingPaths.delete(filePath);
    }
  };

  const saveExistingTab = async (tab: Tab, editor: EditorSnapshot): Promise<boolean> => {
    if (!isTabOpen(tab) || !tab.filePath || tab.originalMarkdown === null || savingTabs.has(tab)) return false;
    if (!tab.hasChanges) return true;
    savingTabs.add(tab);
    try {
      return await writeAndUpdateTab(tab.filePath, captureSave(tab, editor));
    } catch (error) {
      console.error('Background save stopped:', error);
      return false;
    } finally {
      savingTabs.delete(tab);
    }
  };

  const saveInteractive = async (saveAs: boolean): Promise<boolean> => {
    const tab = activeTab.value;
    if (!tab || !isTabOpen(tab) || savingTabs.has(tab)) return false;
    if (!saveAs && tab.filePath && !tab.hasChanges) return true;
    savingTabs.add(tab);
    try {
      // Capture bytes and identity before opening a dialog or awaiting disk I/O.
      const snapshot = captureSave(tab);
      let filePath = snapshot.oldPath;
      if (saveAs || !filePath) {
        filePath = await save({
          filters: [{ name: 'Markdown', extensions: ['md'] }],
          defaultPath: saveAs ? snapshot.oldPath?.split(/[/\\]/).pop() || 'dokument.md' : 'dokument.md',
        });
      }
      if (!filePath || !await writeAndUpdateTab(filePath, snapshot)) return false;
      if (saveAs && snapshot.oldPath && snapshot.oldPath !== filePath) {
        await Promise.all([
          aiCommands.sessionMigrate(snapshot.oldPath, filePath),
          aiCommands.accessMigrate(snapshot.oldPath, filePath),
          aiCommands.snapshotMigrate(snapshot.oldPath, filePath),
        ]).catch(() => {}); // Metadata migration remains best-effort after adoption.
      }
      return true;
    } catch (error) {
      console.error('Error saving file:', error);
      return false;
    } finally {
      savingTabs.delete(tab);
    }
  };
  const saveFile = (): Promise<boolean> => saveInteractive(false);
  const saveFileAs = async (): Promise<void> => { await saveInteractive(true); };

  const openFileInNewTab = async (relativePath: string): Promise<void> => {
    const fullPath = resolveDocumentLinkPath(currentFile.value, relativePath);
    const previousTab = activeTab.value;
    const scrollTop = document.querySelector(DOM_SELECTORS.ACTIVE_EDITOR_CONTAINER)?.scrollTop;
    const keepPreviousScroll = (): void => {
      if (scrollTop !== undefined && tabs.value.includes(previousTab)) previousTab.scrollTop = scrollTop;
    };
    try {
      isLoadingFile.value = true;

      // Check if file is already open
      const existingTab = findTabByFilePath(fullPath);
      if (existingTab) {
        keepPreviousScroll();
        await switchToTab(existingTab.id);
        return;
      }

      // Read the file
      const fileContent = await nativeFs.readPathText(fullPath);
      const openedDuringRead = findTabByFilePath(fullPath);
      if (openedDuringRead) {
        keepPreviousScroll();
        await switchToTab(openedDuringRead.id);
        return;
      }
      const isLarge = fileContent.length > LARGE_FILE_CHAR_THRESHOLD;
      const htmlContent = '';
      const fileName = extractFileName(fullPath);

      // Create new tab and switch to it
      const newTabId = createNewTab(fullPath, htmlContent, fileName);
      const newTab = tabs.value.find(t => t.id === newTabId);
      if (!newTabId || !newTab) return;
      keepPreviousScroll();
      newTab.originalMarkdown = fileContent;
      newTab.largeFile = isLarge || undefined;
      newTab.pendingMarkdown = fileContent;
      newTab.editorMode = null;
      newTab.readOnly = true;
      await switchToTab(newTabId);
      if (isLarge) onLargeFileOpened?.(fullPath, fileContent);
      onFileOpened?.(fullPath, fileContent);
    } catch (error) {
      reportOpenError(error, fullPath);
    } finally {
      isLoadingFile.value = false;
    }
  };

  /**
   * The pane the user is actually looking at. Split view puts several
   * `.editor-container` elements in the document and taking the first in DOM
   * order searched the wrong pane.
   *
   * The fallback covers layouts with no `.editor-pane` ancestor — code+preview
   * replaces the whole SplitContainer. Note that mode's preview pane does not
   * currently bind `@link-click` at all, so clicks there never reach this
   * function; the fallback is for robustness, not for that mode. Same order as
   * usePdfExport and App.vue's scroll helpers.
   */
  const findEditorContainer = (): Element | null =>
    document.querySelector(DOM_SELECTORS.ACTIVE_EDITOR_CONTAINER) ??
    document.querySelector(DOM_SELECTORS.EDITOR_CONTAINER);

  /** Ignore differences that only come from a slugger disagreeing about separators. */
  const looseAnchorKey = (value: string): string =>
    value.toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');

  /**
   * Exact id first, then a tolerant match against heading TEXT.
   *
   * The fallback matters because ids are recomputed from heading text on every
   * open while `[](#anchor)` links are stored verbatim in the file, so anchors
   * written against another renderer — or against MerMark's own older slug
   * rules — would otherwise be dead forever. It also covers headings renamed in
   * WYSIWYG, whose id stays stale until the next save.
   *
   * Two deliberate restrictions keep it from guessing:
   *
   * Heading *ids* are not compared loosely. Doing so let an unrelated heading
   * that merely happens to carry a stale double-hyphen id win on DOM order over
   * the heading the link actually names, silently scrolling to the wrong
   * section. Text is the thing the author wrote the anchor against, so text is
   * what gets matched.
   *
   * An ambiguous match resolves to nothing. If two headings both normalise to
   * the target, picking the first is a coin flip; reporting it as unresolved is
   * honest and the user sees a toast rather than a plausible wrong jump.
   */
  const findAnchorTarget = (container: Element, targetId: string): HTMLElement | null => {
    const exact = Array.from(container.querySelectorAll<HTMLElement>('[id]'))
      .find((el) => el.id === targetId);
    if (exact) return exact;

    const wanted = looseAnchorKey(targetId);
    if (!wanted) return null;

    const matches = Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
      .filter((heading) => looseAnchorKey(generateSlug(heading.textContent ?? '')) === wanted);

    return matches.length === 1 ? matches[0] : null;
  };

  const handleLinkClick = (href: string): void => {
    // Anchor link (internal navigation)
    if (href.startsWith('#')) {
      // decodeURIComponent throws on a lone '%' — '#100%-coverage' is a real
      // anchor, and an uncaught throw here would skip the not-found toast and
      // restore exactly the silent no-op this whole change removes.
      const raw = href.slice(1);
      let targetId = raw;
      try {
        targetId = decodeURIComponent(raw);
      } catch {
        targetId = raw;
      }
      const editorContainer = findEditorContainer();
      const targetElement = editorContainer ? findAnchorTarget(editorContainer, targetId) : null;
      if (targetElement && editorContainer) {
        const containerRect = editorContainer.getBoundingClientRect();
        const elementRect = targetElement.getBoundingClientRect();
        const scrollOffset = elementRect.top - containerRect.top + editorContainer.scrollTop - 20;
        editorContainer.scrollTo({ top: scrollOffset, behavior: 'smooth' });
      } else {
        // Used to return silently, which is indistinguishable from a dead app.
        onAnchorNotFound?.(targetId);
      }
      return;
    }

    // Relative markdown link
    if (href.endsWith('.md') || href.endsWith('.markdown')) {
      openFileInNewTab(href);
    } else if (href.startsWith('http://') || href.startsWith('https://') || (href.includes('.') && !href.includes('/'))) {
      // External link
      pendingExternalUrl.value = href.startsWith('http') ? href : `https://${href}`;
      showExternalLinkDialog.value = true;
    } else {
      // Could be a relative link to any file
      openFileInNewTab(href);
    }
  };

  const confirmExternalLink = async (): Promise<void> => {
    if (pendingExternalUrl.value) {
      try {
        await openExternal(pendingExternalUrl.value);
      } catch (error) {
        console.error('Error opening external link:', error);
      }
    }
    showExternalLinkDialog.value = false;
    pendingExternalUrl.value = '';
  };

  const cancelExternalLink = (): void => {
    showExternalLinkDialog.value = false;
    pendingExternalUrl.value = '';
  };

  return {
    currentFile,
    isLoadingFile,
    showExternalLinkDialog,
    pendingExternalUrl,
    openFile,
    openFileFromPath,
    saveFile,
    saveExistingTab,
    saveFileAs,
    handleLinkClick,
    confirmExternalLink,
    cancelExternalLink,
    openFileInNewTab,
  };
}
