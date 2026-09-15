/** Current-window imported snapshots. Keys never authorize filesystem access. */
export const IMAGE_BYTE_LIMIT = 8 * 1024 * 1024;
export const DOCUMENT_IMAGE_BYTE_LIMIT = 64 * 1024 * 1024;
export const DOCUMENT_IMAGE_ENTRY_LIMIT = 128;
export const WINDOW_IMAGE_BYTE_LIMIT = 128 * 1024 * 1024;

const ownerBrand: unique symbol = Symbol('image document owner');
export interface ImageDocumentOwner { readonly [ownerBrand]: true }
export interface PreparedDocumentImage {
  /** Commit immediately before synchronous model insertion, after checking its owner. */
  commit(): void;
  /** Releases an uncommitted reservation; committed snapshots survive Undo/mode switches. */
  release(): void;
}
interface Snapshot { bytes: Uint8Array }
interface Reservation { size: number; path?: string; snapshot?: Snapshot }
interface OwnerState {
  bytes: number;
  entries: Map<string, Snapshot>;
  pending: Set<Reservation>;
}

export function createDocumentImageBytes() {
  const owners = new Map<ImageDocumentOwner, OwnerState>();
  let totalBytes = 0;
  const current = (owner: ImageDocumentOwner): OwnerState => {
    const state = owners.get(owner);
    if (!state) throw new DOMException('Image document is closed', 'AbortError');
    return state;
  };
  const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  const conflict = (state: OwnerState, path: string, bytes: Uint8Array, self: Reservation) => {
    const previous = state.entries.get(path);
    if (previous && !equal(previous.bytes, bytes)) throw new Error('image_path_conflict');
    for (const pending of state.pending) {
      if (pending !== self && pending.path === path && pending.snapshot && !equal(pending.snapshot.bytes, bytes)) {
        throw new Error('image_path_conflict');
      }
    }
  };
  return {
    createOwner(): ImageDocumentOwner {
      const owner = Object.freeze({ [ownerBrand]: true as const });
      owners.set(owner, { bytes: 0, entries: new Map(), pending: new Set() });
      return owner;
    },
    isCurrent(owner: ImageDocumentOwner): boolean { return owners.has(owner); },
    dispose(owner: ImageDocumentOwner): void {
      const state = owners.get(owner);
      if (!state) return;
      totalBytes -= state.bytes;
      state.entries.clear();
      for (const pending of state.pending) pending.snapshot = undefined;
      state.pending.clear();
      state.bytes = 0;
      owners.delete(owner);
    },
    disposeAll(): void {
      for (const owner of owners.keys()) this.dispose(owner);
    },
    /** Reserves capacity before native read/File.arrayBuffer or destination writes. */
    reserve(owner: ImageDocumentOwner, size = IMAGE_BYTE_LIMIT) {
      const state = current(owner);
      if (!Number.isSafeInteger(size) || size < 0 || size > IMAGE_BYTE_LIMIT) throw new Error('image_too_large');
      if (state.bytes + size > DOCUMENT_IMAGE_BYTE_LIMIT || totalBytes + size > WINDOW_IMAGE_BYTE_LIMIT
        || state.entries.size + state.pending.size >= DOCUMENT_IMAGE_ENTRY_LIMIT) throw new Error('image_budget_exceeded');
      const reservation: Reservation = { size };
      state.pending.add(reservation);
      state.bytes += size;
      totalBytes += size;
      let finished = false;
      const release = () => {
        if (finished) return;
        finished = true;
        reservation.snapshot = undefined;
        if (state.pending.delete(reservation)) {
          state.bytes -= reservation.size;
          totalBytes -= reservation.size;
        }
      };
      return {
        release,
        prepare(path: string, bytes: Uint8Array): PreparedDocumentImage {
          try {
            if (finished || current(owner) !== state || !state.pending.has(reservation)) throw new DOMException('Image preparation expired', 'AbortError');
            if (reservation.snapshot) throw new Error('image_already_prepared');
            if (!path || bytes.byteLength > reservation.size) throw new Error('image_too_large');
            conflict(state, path, bytes, reservation);
            reservation.path = path;
            reservation.snapshot = { bytes: bytes.slice() };
            const unused = reservation.size - bytes.byteLength;
            reservation.size = bytes.byteLength;
            state.bytes -= unused;
            totalBytes -= unused;
            return {
              release,
              commit() {
                try {
                  if (finished || current(owner) !== state || !state.pending.has(reservation)) throw new DOMException('Image preparation expired', 'AbortError');
                  const snapshot = reservation.snapshot!;
                  conflict(state, path, snapshot.bytes, reservation);
                  if (state.entries.has(path)) { release(); return; }
                  state.pending.delete(reservation);
                  state.entries.set(path, snapshot);
                  reservation.snapshot = undefined;
                  finished = true;
                } catch (error) { release(); throw error; }
              },
            };
          } catch (error) { release(); throw error; }
        },
      };
    },
    /** Copies bytes; no Blob URL, mutable storage reference or native grant escapes. */
    read(owner: ImageDocumentOwner, path: string): Uint8Array | undefined {
      return current(owner).entries.get(path)?.bytes.slice();
    },
  };
}

export const documentImageBytes = createDocumentImageBytes();
