import { documentImageBytes, IMAGE_BYTE_LIMIT, type ImageDocumentOwner } from './documentImageBytes';
import { decodeImageData, imageMime } from './documentImageFormat';
import { nativeFs } from './nativeFs';

export interface ImageDisplayContext { owner: ImageDocumentOwner | undefined; path: string | null; revision: number }
export type ImageDisplayStatus = 'loading' | 'ready' | 'unavailable';
export interface ImageDisplayOptions {
  getContext(): ImageDisplayContext;
  /** Close any preview and await its DOM removal before the URL is revoked. */
  beforeRelease?(url: string): void | Promise<void>;
  subscribeContext?(listener: () => void): () => void;
}
export interface ImageDisplayBinding { dispose(): void }
export interface DocumentImageDisplay {
  attach(image: HTMLImageElement, source: string, onStatus?: (status: ImageDisplayStatus) => void): ImageDisplayBinding;
  refresh(): void;
  dispose(): void;
}

const OWNER_BYTES = 64 * 1024 * 1024;
const WINDOW_BYTES = 128 * 1024 * 1024;
const OWNER_ENTRIES = 128;
const WINDOW_ENTRIES = 256;
const PARALLEL_READS = 4;
const MAX_QUEUED_READS = 128;
const MAX_LITERAL_PATH = 4096;
// Display Blob/reservation budget is separate from ingress snapshots. Native
// JSON/Uint8Array and browser decoder overhead is bounded in count, not included
// in these encoded-byte totals. Never release an in-flight reservation early.
const ownerBudget = new Map<ImageDocumentOwner, { bytes: number; entries: number; leases: number }>();
let windowBytes = 0;
let windowEntries = 0;
let windowLeases = 0;
let attachedBindings = 0;
let activeReads = 0;
interface Job { run(): Promise<void>; cancel(): void }
const queue: Job[] = [];
function pump() {
  while (activeReads < PARALLEL_READS && queue.length) {
    const job = queue.shift()!;
    activeReads++;
    void job.run().finally(() => { activeReads--; pump(); });
  }
}
function budget(owner: ImageDocumentOwner) {
  let state = ownerBudget.get(owner);
  if (!state) { state = { bytes: 0, entries: 0, leases: 0 }; ownerBudget.set(owner, state); }
  return state;
}
function reserve(owner: ImageDocumentOwner) {
  const state = budget(owner);
  if (state.bytes + IMAGE_BYTE_LIMIT > OWNER_BYTES || windowBytes + IMAGE_BYTE_LIMIT > WINDOW_BYTES
    || state.leases >= OWNER_ENTRIES || windowLeases >= WINDOW_ENTRIES) {
    throw new Error('image_budget_exceeded');
  }
  let size = IMAGE_BYTE_LIMIT;
  let released = false;
  state.leases++; windowLeases++;
  state.bytes += size;
  windowBytes += size;
  return {
    shrink(actual: number) {
      if (actual > size) throw new Error('image_too_large');
      state.bytes -= size - actual;
      windowBytes -= size - actual;
      size = actual;
    },
    release() {
      if (released) return;
      released = true;
      state.bytes -= size;
      windowBytes -= size;
      state.leases--; windowLeases--;
      if (!state.entries && !state.bytes && !state.leases) ownerBudget.delete(owner);
    },
  };
}
const same = (a: ImageDisplayContext, b: ImageDisplayContext) => a.owner === b.owner && a.path === b.path && a.revision === b.revision;
function localReference(source: string, path: string): boolean {
  if (!source || source.length > MAX_LITERAL_PATH || /[\\\x00-\x1f:#?]/.test(source)) return false;
  const components = source.split('/');
  if (components.length < 2 || components.some(value => !value || value === '.' || value === '..')) return false;
  const filename = path.replace(/\\/g, '/').split('/').pop()!;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return components[0] === 'images' || components[0] === `${stem}.assets`;
}

/** One instance per editor, shared by its Image and SafeHtmlBlock renderers.
 * refresh must be called on owner/path/authority changes unless subscribed. */
export function createDocumentImageDisplay(options: ImageDisplayOptions): DocumentImageDisplay {
  let disposed = false;
  let context = { ...options.getContext() };
  let descriptor: Promise<{ grantId: string }> | undefined;
  const bindings = new Set<{ restart(): void; dispose(): void }>();
  const current = (captured: ImageDisplayContext) => !disposed && same(captured, options.getContext())
    && !!captured.owner && documentImageBytes.isCurrent(captured.owner);

  const provider: DocumentImageDisplay = {
    attach(image, source, onStatus) {
      // Defensive boundary for direct SafeHtmlBlock callers as well as NodeView.
      image.removeAttribute('src');
      image.removeAttribute('srcset');
      provider.refresh();
      if (disposed || bindings.size >= OWNER_ENTRIES || attachedBindings >= WINDOW_ENTRIES) {
        image.dataset.imageStatus = 'unavailable';
        try { onStatus?.('unavailable'); } catch { /* Display-only callback. */ }
        return { dispose() {} };
      }
      attachedBindings++;
      let ended = false;
      let generation = 0;
      let cleanup: (() => void) | undefined;
      let cancelJob: (() => void) | undefined;
      let countedOwner: ImageDocumentOwner | undefined;
      const status = (value: ImageDisplayStatus) => {
        image.dataset.imageStatus = value;
        try { onStatus?.(value); } catch { /* UI callbacks cannot break cleanup. */ }
      };
      const uncount = () => {
        if (!countedOwner) return;
        const owner = countedOwner;
        countedOwner = undefined;
        const state = budget(owner);
        state.entries--; windowEntries--;
        if (!state.entries && !state.bytes && !state.leases) ownerBudget.delete(owner);
      };
      const clear = () => {
        generation++;
        cancelJob?.(); cancelJob = undefined;
        image.onload = null; image.onerror = null;
        image.removeAttribute('src');
        cleanup?.(); cleanup = undefined;
        uncount();
      };
      const binding = {
        restart() {
          clear();
          const captured = { ...options.getContext() };
          const token = generation;
          const valid = () => !ended && token === generation && current(captured);
          if (!valid() || !captured.owner) { status('unavailable'); return; }
          const owner = captured.owner;
          // A rejected queue entry must not create an empty owner budget that
          // has no binding or reservation to release it later.
          if (windowEntries >= WINDOW_ENTRIES || queue.length >= MAX_QUEUED_READS) {
            status('unavailable'); return;
          }
          const state = budget(owner);
          if (state.entries >= OWNER_ENTRIES) { status('unavailable'); return; }
          state.entries++; windowEntries++; countedOwner = owner;
          status('loading');
          const job: Job = {
            cancel() {
              const index = queue.indexOf(job);
              if (index !== -1) queue.splice(index, 1);
            },
            async run() {
              if (!valid()) return;
              let reservation: ReturnType<typeof reserve> | undefined;
              let transferred = false;
              try {
                reservation = reserve(owner);
                let bytes = documentImageBytes.read(owner, source);
                let mime: string;
                if (bytes) mime = imageMime(bytes);
                else if (source.startsWith('data:')) ({ bytes, mime } = decodeImageData(source));
                else {
                  if (!captured.path || !localReference(source, captured.path)) throw new Error('image_unavailable');
                  descriptor ??= nativeFs.resolveDocumentReadGrant(captured.path);
                  const identity = await descriptor;
                  if (!valid()) return;
                  bytes = await nativeFs.readDocumentImageBytes(captured.path, identity.grantId, source);
                  if (!valid()) return;
                  mime = imageMime(bytes);
                }
                if (!valid()) return;
                reservation.shrink(bytes.byteLength);
                const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
                const held = reservation;
                let released = false;
                cleanup = () => {
                  if (released) return;
                  released = true;
                  // Start the callback synchronously; defer revocation until its
                  // returned DOM-flush promise settles, including failure.
                  let closing: void | Promise<void>;
                  try { closing = options.beforeRelease?.(url); } catch { closing = undefined; }
                  void Promise.resolve(closing).catch(() => {}).finally(() => {
                    try { URL.revokeObjectURL(url); } finally { held.release(); }
                  });
                };
                transferred = true;
                image.onload = () => { if (valid()) status('ready'); };
                image.onerror = () => {
                  if (!valid()) return;
                  clear(); status('unavailable');
                };
                image.src = url;
              } catch {
                const report = valid();
                if (transferred) clear();
                if (report) status('unavailable');
              } finally { if (!transferred) reservation?.release(); }
            },
          };
          cancelJob = job.cancel;
          queue.push(job); pump();
        },
        dispose() {
          if (ended) return;
          ended = true; clear(); bindings.delete(binding); attachedBindings--;
        },
      };
      bindings.add(binding);
      binding.restart();
      return { dispose: binding.dispose };
    },
    refresh() {
      if (disposed) return;
      const next = { ...options.getContext() };
      if (same(context, next) && (!next.owner || documentImageBytes.isCurrent(next.owner))) return;
      context = next; descriptor = undefined;
      for (const binding of bindings) binding.restart();
    },
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe?.();
      for (const binding of bindings) binding.dispose();
      descriptor = undefined;
    },
  };
  const unsubscribe = options.subscribeContext?.(() => provider.refresh());
  return provider;
}
