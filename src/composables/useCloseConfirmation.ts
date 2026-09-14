import { ref, type Ref } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Tab } from './useTabs';

export interface TabToSave {
  tab: Tab;
  index: number;
}

export interface UseCloseConfirmationOptions {
  tabs: Ref<Tab[]>;
  /** The same source-aware, conflict-checked save used by the normal UI. */
  saveTab: (tab: Tab) => Promise<boolean>;
  switchToTab: (tabId: string, preserveHasChanges?: boolean) => Promise<void>;
  syncActiveTabContent?: () => void;
}

export interface UseCloseConfirmationReturn {
  showSaveConfirmDialog: Ref<boolean>;
  currentTabToSave: Ref<TabToSave | null>;
  tabsToSaveCount: Ref<number>;
  currentTabIndex: Ref<number>;
  setupCloseHandler: () => Promise<() => void>;
  handleSave: () => Promise<void>;
  handleDiscard: () => Promise<void>;
  handleCancel: () => void;
}

export function useCloseConfirmation(options: UseCloseConfirmationOptions): UseCloseConfirmationReturn {
  const { tabs, saveTab, switchToTab, syncActiveTabContent } = options;

  const showSaveConfirmDialog = ref(false);
  const currentTabToSave = ref<TabToSave | null>(null);
  const tabsToSave = ref<TabToSave[]>([]);
  const tabsToSaveCount = ref(0);
  const currentTabIndex = ref(0);
  const discarded = new Set<string>();
  let processing = false;
  let closeAttempt = 0;

  const collectUnsavedTabs = (): TabToSave[] => {
    const unsaved: TabToSave[] = [];
    tabs.value.forEach((tab, index) => {
      if (tab.hasChanges && !discarded.has(tab.id)) {
        unsaved.push({ tab, index });
      }
    });
    return unsaved;
  };

  const closeWindow = async (): Promise<void> => {
    // Other application windows may still contain unsaved documents.
    await getCurrentWindow().destroy();
  };

  const processNextTab = async (): Promise<void> => {
    if (tabsToSave.value.length === 0) {
      // Recheck in case another tab was edited while a save was pending.
      tabsToSave.value = collectUnsavedTabs();
      tabsToSaveCount.value = currentTabIndex.value + tabsToSave.value.length;
      if (tabsToSave.value.length === 0) {
        await closeWindow();
        showSaveConfirmDialog.value = false;
        currentTabToSave.value = null;
        return;
      }
    }

    currentTabIndex.value++;
    currentTabToSave.value = tabsToSave.value.shift() || null;

    if (currentTabToSave.value) {
      // Switch to the tab so user can see what they're saving
      await switchToTab(currentTabToSave.value.tab.id, true);
    }
  };

  const saveTabContent = async (tab: Tab): Promise<boolean> => {
    try {
      await switchToTab(tab.id, true);
      return await saveTab(tab);
    } catch (error) {
      console.error('Error saving file:', error);
      return false;
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!currentTabToSave.value || processing) return;
    processing = true;
    const attempt = closeAttempt;
    try {
      const tab = currentTabToSave.value.tab;
      const saved = await saveTabContent(tab);
      if (attempt === closeAttempt && saved && !tab.hasChanges) await processNextTab();
    } finally {
      processing = false;
    }
    // If not saved (user cancelled), stay on current dialog
  };

  const handleDiscard = async (): Promise<void> => {
    if (!currentTabToSave.value || processing) return;
    processing = true;
    // Defer discarding until this window actually closes. Cancel on a later
    // tab must preserve every earlier unsaved document and its dirty flag.
    try {
      discarded.add(currentTabToSave.value.tab.id);
      await processNextTab();
    } finally {
      processing = false;
    }
  };

  const handleCancel = (): void => {
    closeAttempt++;
    // Cancel the entire close operation
    showSaveConfirmDialog.value = false;
    currentTabToSave.value = null;
    tabsToSave.value = [];
    discarded.clear();
    // Don't close - user wants to keep working
  };

  const setupCloseHandler = async (): Promise<() => void> => {
    const appWindow = getCurrentWindow();

    const unlisten = await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (showSaveConfirmDialog.value || processing) return;
      try {
        // Sync active tab content before checking for unsaved changes
        if (syncActiveTabContent) {
          syncActiveTabContent();
        }

        const unsavedTabs = collectUnsavedTabs();

        if (unsavedTabs.length === 0) {
          await closeWindow();
          return;
        }

        tabsToSave.value = [...unsavedTabs];
        tabsToSaveCount.value = unsavedTabs.length;
        currentTabIndex.value = 0;

        showSaveConfirmDialog.value = true;
        await processNextTab();
      } catch (error) {
        console.error('Error in close handler:', error);
        // Keep the window and its documents on synchronization/save errors.
      }
    });

    return unlisten;
  };

  return {
    showSaveConfirmDialog,
    currentTabToSave,
    tabsToSaveCount,
    currentTabIndex,
    setupCloseHandler,
    handleSave,
    handleDiscard,
    handleCancel,
  };
}
