import type { Page } from '@playwright/test';

/**
 * Virtual file system state passed from the test via exposeFunction.
 * We use page.exposeFunction so the browser-side script can call back into
 * Node.js to read/write the shared mock state.
 */
export interface MockTabTransfer {
  id: string; file_path: string; source_window: string; target_window: string;
}

export interface MockFs {
  [path: string]: string;
}

/**
 * Sets up Tauri IPC mocks and a virtual file system before the page loads.
 *
 * The virtual FS is backed by a plain object in Node land so tests can
 * inspect what was written without going through the UI.
 */
export async function setupTauriMocks(
  page: Page,
  opts: {
    /** Initial file system contents */
    initialFs?: MockFs;
    /** Initial file path, retained for single-file test compatibility. */
    openFilePath?: string | null;
    /** Ordered native startup queue. Takes precedence over openFilePath. */
    openFilePaths?: string[];
    /** Simulated native window and live registry for queue-owner tests. */
    windowLabel?: string;
    windowLabels?: string[];
    /** Native transfer requests created before the target has a listener. */
    pendingTransfers?: MockTabTransfer[];
    /** App version string */
    version?: string;
  } = {},
): Promise<{
  /** Inspect current virtual FS state from a test */
  getFs: () => MockFs;
  /** Inspect IPC calls log from a test */
  getCalls: () => Array<{ cmd: string; args: unknown }>;
  /**
   * Simulate an external file change: updates the Node-side FS and fires a
   * synthetic watcher event so the app sees the file as changed externally.
   * The file must already be watched by the app (i.e. opened in a tab).
   */
  triggerExternalChange: (filePath: string, newContent: string) => Promise<void>;
  triggerWindowClose: () => Promise<void>;
  /** Queue native open requests and notify the frontend to drain them. */
  triggerOpenFiles: (paths: string[]) => Promise<void>;
  triggerTabTransfers: (transfers: MockTabTransfer[]) => Promise<void>;
  /** Remove a native window and notify the new queue owner, if any. */
  destroyNativeWindow: (label: string) => Promise<void>;
}> {
  const fs: MockFs = { ...(opts.initialFs ?? {}) };
  const calls: Array<{ cmd: string; args: unknown }> = [];

  // Expose Node-side functions so the browser script can call them
  await page.exposeFunction('__mockFsRead', (path: string): string => {
    calls.push({ cmd: 'read', args: path });
    if (!(path in fs)) throw new Error(`ENOENT: ${path}`);
    return fs[path];
  });

  await page.exposeFunction('__mockFsWrite', (path: string, content: string): void => {
    calls.push({ cmd: 'write', args: { path, content } });
    fs[path] = content;
  });

  await page.exposeFunction('__mockFsRename', (from: string, to: string): void => {
    calls.push({ cmd: 'rename', args: { from, to } });
    if (!(from in fs)) throw new Error(`ENOENT rename: ${from}`);
    fs[to] = fs[from];
    delete fs[from];
  });

  await page.exposeFunction('__mockFsRemove', (path: string): void => {
    calls.push({ cmd: 'remove', args: path });
    delete fs[path];
  });

  await page.exposeFunction('__mockFsExists', (path: string): boolean => {
    return path in fs;
  });

  await page.exposeFunction('__mockFsWatch', (): void => {
    // no-op — watcher registration is tracked browser-side via __watchCallbacks
  });

  // NOTE: dialogSavePath is intentionally NOT exposed via page.exposeFunction
  // because exposeFunction creates immutable bindings that can't be overridden
  // from tests. Instead, we use a plain window variable set in addInitScript,
  // which tests can override via page.evaluate.

  const openFilePaths = opts.openFilePaths ?? (opts.openFilePath ? [opts.openFilePath] : []);
  const version = opts.version ?? '0.0.0-test';
  const pendingTransfers = opts.pendingTransfers ?? [];
  const windowLabel = opts.windowLabel ?? 'main';
  const windowLabels = opts.windowLabels ?? [windowLabel];

  // Inject mock __TAURI_INTERNALS__ before the app JS runs
  await page.addInitScript(
    ({ openFilePaths, version, windowLabel, windowLabels, pendingTransfers }: { openFilePaths: string[]; version: string; windowLabel: string; windowLabels: string[]; pendingTransfers: MockTabTransfer[] }) => {
      // Keep the first-run AI popover from covering toolbar controls in tests.
      // Tests that provide their own settings before this mock keep them.
      if (!localStorage.getItem('mermark-settings')) {
        localStorage.setItem('mermark-settings', JSON.stringify({ ai: { hasSeenFirstRun: true } }));
      }

      // Helper to resolve a promise from a window-exposed async Node function
      const call = (fn: string, ...args: unknown[]): Promise<unknown> =>
        (window as Record<string, unknown>)[fn]?.(...args) as Promise<unknown>;

      // Mutable dialog save path — tests override this via page.evaluate
      // Using a plain window variable (NOT page.exposeFunction) so it can be reassigned
      (window as Record<string, unknown>).__mockDialogSavePath = null;
      const listeners = new Map<number, { event: string; handler: number }>();
      let nextListener = 1;
      const pendingOpenPaths = [...openFilePaths];
      const transferQueue = [...pendingTransfers];
      (window as any).__mockTransferAcks = [];
      (window as any).__mockTransferAckError = null;
      (window as any).__triggerTabTransfers = async (transfers: MockTabTransfer[]) => {
        transferQueue.push(...transfers);
        for (const [id, listener] of listeners) {
          if (listener.event === 'tab-transfer') {
            await (window as any)['_cb_' + listener.handler]({ event: listener.event, id, payload: {
              file_path: '/untrusted/event-only.md', source_window: 'spoofed', target_window: 'spoofed',
            } });
          }
        }
      };
      (window as any).__nativeOpenDrainCalls = 0;
      let liveWindowLabels = [...windowLabels];
      const nativeOwner = () => liveWindowLabels.includes('main') ? 'main'
        : liveWindowLabels.filter(label => /^window-[1-9]\d*$/.test(label) && Number(label.slice(7)) <= 0xffffffff)
          .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))[0];
      const notifyNativeOwner = async () => {
        if (nativeOwner() !== windowLabel) return;
        for (const [id, listener] of listeners) {
          if (listener.event === 'open-files-pending') {
            await (window as any)['_cb_' + listener.handler]({ event: listener.event, id, payload: null });
          }
        }
      };
      (window as any).__triggerOpenFiles = async (paths: string[]) => {
        pendingOpenPaths.push(...paths);
        await notifyNativeOwner();
      };
      (window as any).__destroyNativeWindow = async (label: string) => {
        liveWindowLabels = liveWindowLabels.filter(current => current !== label);
        if (pendingOpenPaths.length > 0) await notifyNativeOwner();
      };
      (window as any).__mockWindowCommands = [];
      (window as any).__triggerWindowClose = async () => {
        for (const [id, listener] of listeners) {
          if (listener.event === 'tauri://close-requested') {
            await (window as any)['_cb_' + listener.handler]({ event: listener.event, id, payload: null });
          }
        }
      };

      // Watcher callback registry: path -> Tauri callback id
      // Filled when plugin:fs|watch is invoked (see invoke handler below).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__watchCallbacks = {} as Record<string, { id: number; index: number }>;

      // Trigger a synthetic watcher event for a path (called from test via page.evaluate).
      // The Node side must have already updated the FS content before calling this.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__triggerWatchEvent = (path: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const channel = (window as any).__watchCallbacks[path] as { id: number; index: number } | undefined;
        if (channel) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cb = (window as any)[`_cb_${channel.id}`];
          if (cb) cb({ index: channel.index++, message: { type: 'modify', paths: [path], attrs: null } });
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: windowLabel },
          windows: windowLabels.map(label => ({ label })),
        },

        transformCallback(callback: (data: unknown) => unknown, once: boolean) {
          const id = Math.random();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any)[`_cb_${id}`] = once
            ? (data: unknown) => { callback(data); delete (window as any)[`_cb_${id}`]; }
            : callback;
          return id;
        },

        async invoke(cmd: string, args: Record<string, unknown> | Uint8Array = {}, options: Record<string, unknown> = {}) {
          // ── fs plugin ──────────────────────────────────────────────
          if (cmd === 'plugin:fs|read_text_file') {
            const path = (args as Record<string, unknown>).path as string;
            const content = await call('__mockFsRead', path) as string;
            // Return as array of bytes (Uint8Array.from works on iterable of numbers)
            return Array.from(new TextEncoder().encode(content));
          }
          if (cmd === 'plugin:fs|write_text_file') {
            // plugin-fs v2: body = Uint8Array, path in options.headers.path (URL-encoded)
            const headers = (options as Record<string, unknown>)?.headers as Record<string, string> | undefined;
            const path = decodeURIComponent(headers?.path ?? '');
            // Native write_text_file writes the supplied bytes verbatim.
            const content = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(args as Uint8Array);
            return call('__mockFsWrite', path, content);
          }
          if (cmd === 'plugin:fs|rename') {
            const a = args as Record<string, unknown>;
            return call('__mockFsRename', a.oldPath ?? a.from, a.newPath ?? a.to);
          }
          if (cmd === 'plugin:fs|remove') {
            return call('__mockFsRemove', (args as Record<string, unknown>).path);
          }
          if (cmd === 'plugin:fs|exists') {
            return call('__mockFsExists', (args as Record<string, unknown>).path);
          }
          if (cmd === 'plugin:fs|watch') {
            // Capture the Tauri callback id so tests can fire synthetic events.
            // plugin-fs v2 sends the callback through a Channel in `onEvent`.
            const watchArgs = args as Record<string, unknown>;
            const cbId = (watchArgs.onEvent as { id?: number } | undefined)?.id ?? watchArgs.id as number;
            const paths = (watchArgs.paths as string[]) ?? [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const p of paths) (window as any).__watchCallbacks[p] = { id: cbId, index: 0 };
            await call('__mockFsWatch');
            return 1;
          }
          if (cmd === 'plugin:fs|unwatch') {
            return call('__mockFsWatch');
          }

          // ── dialog plugin ──────────────────────────────────────────
          if (cmd === 'plugin:dialog|open') {
            return null; // no file selected
          }
          if (cmd === 'plugin:dialog|save') {
            // Read the mutable path variable (overridable from tests via page.evaluate)
            return (window as Record<string, unknown>).__mockDialogSavePath ?? null;
          }

          // ── shell plugin ───────────────────────────────────────────
          if (cmd === 'plugin:shell|open') {
            return undefined;
          }

          // ── updater ────────────────────────────────────────────────
          if (cmd.startsWith('plugin:updater')) return null;

          // ── core app ───────────────────────────────────────────────
          if (cmd === 'plugin:app|version' || cmd === 'app_get_version') return version;

          // ── event system ──────────────────────────────────────────
          if (cmd === 'plugin:event|listen') {
            const id = nextListener++;
            const request = args as { event: string; handler: number };
            listeners.set(id, request);
            return id;
          }
          if (cmd === 'plugin:event|unlisten') {
            listeners.delete((args as { eventId: number }).eventId);
            return undefined;
          }
          if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') return undefined;

          // ── window commands ────────────────────────────────────────
          if (cmd === 'plugin:window|set_title' || cmd === 'plugin:core|set_title') return undefined;
          if (cmd === 'plugin:window|is_maximized') return false;
          if (cmd === 'plugin:window|maximize' || cmd === 'plugin:window|unmaximize') return undefined;
          if (cmd === 'plugin:window|close' || cmd === 'plugin:window|destroy' || cmd === 'plugin:process|exit') {
            (window as any).__mockWindowCommands.push(cmd);
            return undefined;
          }
          if (cmd.startsWith('plugin:window|')) return undefined;

          // ── deep-link / process ────────────────────────────────────
          if (cmd.startsWith('plugin:deep-link') || cmd.startsWith('plugin:process')) return null;

          // ── custom Rust commands ───────────────────────────────────
          if (cmd === 'native_get_pending_transfers') return transferQueue.filter(item => item.target_window === windowLabel);
          if (cmd === 'native_ack_tab_transfer') {
            const request = args as { id: string; success: boolean };
            (window as any).__mockTransferAcks.push({ ...request });
            if ((window as any).__mockTransferAckError) throw new Error((window as any).__mockTransferAckError);
            const index = transferQueue.findIndex(item => item.id === request.id && item.target_window === windowLabel);
            if (index < 0) throw new Error('transfer_not_found');
            transferQueue.splice(index, 1);
            return null;
          }
          if (cmd === 'get_open_file_paths') {
            (window as any).__nativeOpenDrainCalls++;
            return nativeOwner() === windowLabel ? pendingOpenPaths.splice(0) : [];
          }
          if (cmd === 'get_open_file_path') return nativeOwner() === windowLabel ? pendingOpenPaths.shift() ?? null : null;
          if (cmd === 'get_current_window_label') return windowLabel;
          if (cmd === 'register_open_file' || cmd === 'unregister_open_file' || cmd === 'check_file_open' || cmd === 'get_window_for_file' || cmd === 'focus_window_with_file' || cmd === 'unregister_window_files') {
            return null;
          }

          // Fallback
          console.warn(`[TauriMock] Unhandled IPC: ${cmd}`, args);
          return null;
        },

        // Minimal event system
        event: {
          listen: async () => () => {},
          emit: async () => {},
          once: async () => () => {},
        },
      };
    },
    { openFilePaths, version, windowLabel, windowLabels, pendingTransfers },
  );

  const triggerExternalChange = async (filePath: string, newContent: string): Promise<void> => {
    // 1. Update the Node-side virtual FS so subsequent readTextFile calls return new content
    fs[filePath] = newContent;
    // 2. Fire a synthetic watcher event in the browser — the app will read the updated content
    await page.evaluate((path: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__triggerWatchEvent(path);
    }, filePath);
  };

  return {
    destroyNativeWindow: async (label: string) => {
      await page.evaluate(async label => { await (window as any).__destroyNativeWindow(label); }, label);
    },
    getFs: () => ({ ...fs }),
    getCalls: () => [...calls],
    triggerExternalChange,
    triggerTabTransfers: transfers => page.evaluate(async items => { await (window as any).__triggerTabTransfers(items); }, transfers),
    triggerOpenFiles: paths => page.evaluate(async paths => { await (window as any).__triggerOpenFiles(paths); }, paths),
    triggerWindowClose: () => page.evaluate(async () => { await (window as any).__triggerWindowClose(); }),
  };
}
