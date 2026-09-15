import { watch as watchFs, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { readTextFile } from '../services/documentText';
import { TIMING } from '../constants';

export interface UseFileWatcherOptions {
  onExternalChange: (filePath: string, newDiskContent: string) => void;
  onFileDeleted?: (filePath: string) => void;
  onWatchError?: (filePath: string, error: unknown) => void;
}

export interface UseFileWatcherReturn {
  watchFile: (filePath: string, initialContent: string) => Promise<void>;
  unwatchFile: (filePath: string) => void;
  unwatchAll: () => void;
  markSaveStart: (filePath: string) => void;
  markSaveEnd: (filePath: string, newContent: string) => void;
  markSaveAbort: (filePath: string) => void;
  updateKnownContent: (filePath: string, content: string) => void;
}

export function useFileWatcher(options: UseFileWatcherOptions): UseFileWatcherReturn {
  const { onExternalChange, onFileDeleted, onWatchError } = options;

  // Object identity separates close/reopen sessions, including pending installs.
  type WatchSession = { revision: number; unwatch?: UnwatchFn };
  const watchers = new Map<string, WatchSession>();
  // Files currently being saved by us
  const ownSavesInProgress = new Set<string>();
  // Last known disk content per file (to detect actual content changes)
  const lastKnownDiskContent = new Map<string, string>();

  const isOwnSave = (filePath: string): boolean => {
    // Only skip events while OUR save is literally in progress (markSaveStart → markSaveEnd).
    // The time-based grace period was removed because it caused a false-positive:
    // an external save within 2s of our own save was silently ignored.
    // Post-save spurious events are already filtered by the lastKnownDiskContent
    // comparison below — after markSaveEnd the known content is updated to what
    // we just wrote, so a watcher event for our own rename reads identical content
    // and returns early without calling onExternalChange.
    return ownSavesInProgress.has(filePath);
  };

  const invalidateReads = (filePath: string): void => {
    const session = watchers.get(filePath);
    if (session) session.revision++;
  };

  const handleWatchEvent = async (filePath: string, session: WatchSession) => {
    if (watchers.get(filePath) !== session || isOwnSave(filePath)) return;
    // A newer event or an accepted/save revision makes this result obsolete.
    const revision = ++session.revision;
    const isCurrent = () => watchers.get(filePath) === session && session.revision === revision;
    let newContent: string;
    try {
      newContent = await readTextFile(filePath);
    } catch (error) {
      if (!isCurrent()) return;
      // Keep the legacy reader's error handling until typed native reads land.
      if (onFileDeleted) {
        onFileDeleted(filePath);
      } else {
        onWatchError?.(filePath, error);
      }
      return;
    }
    if (!isCurrent()) return;
    const knownContent = lastKnownDiskContent.get(filePath);
    if (knownContent !== undefined && newContent === knownContent) return;

    lastKnownDiskContent.set(filePath, newContent);
    try {
      onExternalChange(filePath, newContent);
    } catch (error) {
      // Rendering/conflict callbacks cannot establish that the file was deleted.
      onWatchError?.(filePath, error);
    }
  };

  const watchFile = async (filePath: string, initialContent: string): Promise<void> => {
    // Already watching this file
    if (watchers.has(filePath)) return;

    const session: WatchSession = { revision: 0 };
    watchers.set(filePath, session);
    lastKnownDiskContent.set(filePath, initialContent);

    try {
      const unwatch = await watchFs(filePath, (event) => {
        console.debug('[FileWatcher] Event received:', filePath, JSON.stringify(event.type));

        // Skip access-only events (file reads, not writes)
        const t = event.type;
        if (t && typeof t === 'object' && 'access' in t) return;

        // For all other events (modify, create, any, other, etc.)
        // delegate to handleWatchEvent which reads and compares content.
        // This is safe because content comparison filters spurious events.
        void handleWatchEvent(filePath, session);
      }, { delayMs: TIMING.FILE_WATCH_DEBOUNCE });

      if (watchers.get(filePath) !== session) {
        unwatch();
        return;
      }
      session.unwatch = unwatch;
      console.debug('[FileWatcher] Now watching:', filePath);
    } catch (error) {
      if (watchers.get(filePath) !== session) return;
      watchers.delete(filePath);
      lastKnownDiskContent.delete(filePath);
      console.error('[FileWatcher] Failed to watch:', filePath, error);
      onWatchError?.(filePath, error);
    }
  };

  const unwatchFile = (filePath: string): void => {
    const session = watchers.get(filePath);
    watchers.delete(filePath);
    lastKnownDiskContent.delete(filePath);
    ownSavesInProgress.delete(filePath);
    session?.unwatch?.();
  };

  const unwatchAll = (): void => {
    const sessions = [...watchers.values()];
    watchers.clear();
    lastKnownDiskContent.clear();
    ownSavesInProgress.clear();
    for (const session of sessions) session.unwatch?.();
  };

  const markSaveStart = (filePath: string): void => {
    invalidateReads(filePath);
    ownSavesInProgress.add(filePath);
  };

  const markSaveEnd = (filePath: string, newContent: string): void => {
    invalidateReads(filePath);
    ownSavesInProgress.delete(filePath);
    lastKnownDiskContent.set(filePath, newContent);
  };

  const markSaveAbort = (filePath: string): void => {
    invalidateReads(filePath);
    ownSavesInProgress.delete(filePath);
  };

  const updateKnownContent = (filePath: string, content: string): void => {
    invalidateReads(filePath);
    lastKnownDiskContent.set(filePath, content);
  };

  return {
    watchFile,
    unwatchFile,
    unwatchAll,
    markSaveStart,
    markSaveEnd,
    markSaveAbort,
    updateKnownContent,
  };
}
