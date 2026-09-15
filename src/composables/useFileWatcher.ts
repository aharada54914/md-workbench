import { nativeFs, MAX_NATIVE_READ_BYTES, type NativeWatch } from '../services/nativeFs';
import { decodeDocumentUtf8 } from '../services/documentUtf8';
import { FILE_WATCH_POLL } from '../constants';
import { scheduleWatchRead, cancelWatchRead } from './watchReadScheduler';

export interface UseFileWatcherOptions {
  onExternalChange: (filePath: string, newDiskContent: string) => void;
  onFileDeleted?: (filePath: string) => void;
  onWatchError?: (filePath: string, error: unknown) => void;
  /** Only a current successful read establishes that monitoring works. */
  onWatchReady?: (filePath: string) => void;
}

export interface UseFileWatcherReturn {
  watchFile: (filePath: string, initialContent: string) => Promise<void>;
  restartWatch: (filePath: string, initialContent: string, expectedGrantId: string) => Promise<void>;
  unwatchFile: (filePath: string) => void;
  unwatchAll: () => void;
  markSaveStart: (filePath: string) => void;
  markSaveEnd: (filePath: string, newContent: string) => void;
  markSaveAbort: (filePath: string) => void;
  updateKnownContent: (filePath: string, content: string) => void;
}

const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

export function useFileWatcher(options: UseFileWatcherOptions): UseFileWatcherReturn {
  type WatchSession = { revision: number; token?: NativeWatch; installing: boolean; paused: boolean; error?: string };
  const watchers = new Map<string, WatchSession>();
  const ownSavesInProgress = new Set<string>();
  const lastKnownDiskContent = new Map<string, string>();

  const report = (path: string, session: WatchSession, error: unknown): void => {
    const key = errorCode(error) || String(error);
    if (session.error === key) return;
    session.error = key;
    try {
      if (errorCode(error) === 'file_not_found' && options.onFileDeleted) options.onFileDeleted(path);
      else options.onWatchError?.(path, error);
    } catch (callbackError) { console.error('[FileWatcher] Error callback failed:', callbackError); }
  };
  const release = (session: WatchSession): void => {
    cancelWatchRead(session);
    const token = session.token;
    session.token = undefined;
    if (token) void nativeFs.unsubscribeWatch(token.id).catch(error => {
      console.error('[FileWatcher] Failed to release native subscription:', error);
    });
  };
  const isCurrent = (path: string, session: WatchSession) => watchers.get(path) === session;

  const queue = (path: string, session: WatchSession, due = Date.now()): void => {
    if (!isCurrent(path, session) || !session.token || session.paused || ownSavesInProgress.has(path)) return;
    scheduleWatchRead(session, due, () => read(path, session));
  };
  const read = async (path: string, session: WatchSession): Promise<void> => {
    if (!isCurrent(path, session) || !session.token || session.paused || ownSavesInProgress.has(path)) return;
    const revision = ++session.revision;
    const current = () => isCurrent(path, session) && revision === session.revision;
    try {
      let content: string;
      try {
        content = decodeDocumentUtf8(await nativeFs.readWatchBytes(session.token.id, MAX_NATIVE_READ_BYTES));
      } catch (error) {
        if (!current()) return;
        if (['permission_required', 'invalid_grant_kind'].includes(errorCode(error))) {
          session.paused = true;
          release(session);
        }
        report(path, session, error);
        return;
      }
      if (!current()) return;
      session.error = undefined;
      try {
        options.onWatchReady?.(path);
        if (!current() || lastKnownDiskContent.get(path) === content) return;
        lastKnownDiskContent.set(path, content);
        options.onExternalChange(path, content);
      } catch (error) {
        // Callback exceptions do not establish that a file is missing.
        try { options.onWatchError?.(path, error); }
        catch (callbackError) { console.error('[FileWatcher] Error callback failed:', callbackError); }
      }
    } finally {
      // An already-queued End/Abort catch-up keeps its earlier due time.
      queue(path, session, Date.now() + FILE_WATCH_POLL.INTERVAL);
    }
  };

  const install = async (path: string, initialContent: string, expectedGrantId?: string): Promise<void> => {
    const session: WatchSession = { revision: 0, installing: true, paused: false };
    watchers.set(path, session);
    if (!lastKnownDiskContent.has(path)) lastKnownDiskContent.set(path, initialContent);
    try {
      const grantId = expectedGrantId ?? (await nativeFs.resolveDocumentReadGrant(path)).grantId;
      if (!isCurrent(path, session)) return;
      const token = await nativeFs.subscribeWatch(path, grantId);
      session.token = token;
      if (!isCurrent(path, session)) { release(session); return; }
      session.installing = false;
      queue(path, session); // Compare the open-time baseline immediately after installation.
    } catch (error) {
      if (!isCurrent(path, session)) return;
      session.installing = false;
      session.paused = true;
      report(path, session, error);
    }
  };
  const watchFile = async (path: string, initialContent: string): Promise<void> => {
    const old = watchers.get(path);
    if (old && (old.installing || !old.paused || ['permission_required', 'invalid_grant_kind'].includes(old.error ?? ''))) return;
    if (old) release(old);
    await install(path, initialContent);
  };
  const restartWatch = async (path: string, initialContent: string, expectedGrantId: string): Promise<void> => {
    const old = watchers.get(path);
    if (old) release(old);
    await install(path, initialContent, expectedGrantId);
  };
  const unwatchFile = (path: string): void => {
    const session = watchers.get(path);
    watchers.delete(path);
    lastKnownDiskContent.delete(path);
    ownSavesInProgress.delete(path);
    if (session) release(session);
  };
  const unwatchAll = (): void => {
    for (const path of [...watchers.keys()]) unwatchFile(path);
    lastKnownDiskContent.clear();
    ownSavesInProgress.clear();
  };
  const invalidate = (path: string): WatchSession | undefined => {
    const session = watchers.get(path);
    if (session) session.revision++;
    return session;
  };
  const catchUp = (path: string): void => {
    const session = invalidate(path);
    ownSavesInProgress.delete(path);
    if (session) queue(path, session);
  };
  return {
    watchFile, restartWatch, unwatchFile, unwatchAll,
    markSaveStart: path => {
      const session = invalidate(path);
      ownSavesInProgress.add(path);
      if (session) cancelWatchRead(session);
    },
    markSaveEnd: (path, content) => { lastKnownDiskContent.set(path, content); catchUp(path); },
    markSaveAbort: catchUp,
    updateKnownContent: (path, content) => { invalidate(path); lastKnownDiskContent.set(path, content); },
  };
}
