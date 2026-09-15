import { onScopeDispose, ref, watch } from 'vue';
import { aiCommands } from '../services/aiCommands';

export interface SnapshotRestoreRequest { id: string; path: string }
export interface SnapshotRestoreTarget {
  readonly path: string;
  isCurrent: () => boolean;
  apply: (content: string) => void;
}
interface SnapshotContext {
  document: object | null;
  path: string;
  enabled: boolean;
  /** Live buffers and mode/baseline state, observed synchronously to reject ABA changes. */
  revisionInputs: readonly unknown[];
}
const staleMessage = 'Snapshot restore cancelled because the document changed or closed.';

/** App-owned identity capture; renderer props alone can lag the active document. */
export function useAiSnapshotTarget(getContext: () => SnapshotContext, apply: (content: string) => void) {
  let revision = 0;
  let disposed = false;
  const values = () => {
    const c = getContext();
    return [c.document, c.path, c.enabled, ...c.revisionInputs];
  };
  watch(values, () => { revision++; }, { flush: 'sync' });
  onScopeDispose(() => { disposed = true; });
  return (): SnapshotRestoreTarget | null => {
    const c = getContext();
    if (disposed || !c.enabled || !c.document || !c.path) return null;
    const start = revision;
    const captured = values();
    const isCurrent = () => {
      if (disposed || start !== revision) return false;
      const current = values();
      return current.length === captured.length
        && current.every((value, index) => Object.is(value, captured[index]));
    };
    return { path: c.path, isCurrent, apply(content) {
      if (!isCurrent()) throw new Error(staleMessage);
      apply(content);
    } };
  };
}

export function useAiSnapshotRestore(capture: () => SnapshotRestoreTarget | null) {
  const restoring = ref(false);
  let disposed = false;
  onScopeDispose(() => { disposed = true; });
  async function restore(request?: SnapshotRestoreRequest): Promise<void> {
    if (restoring.value) return;
    const target = capture();
    if (!target || (request && request.path !== target.path)) throw new Error(staleMessage);
    const check = () => { if (disposed || !target.isCurrent()) throw new Error(staleMessage); };
    restoring.value = true;
    try {
      check();
      let id = request?.id;
      if (!id) {
        const items = await aiCommands.snapshotList(target.path);
        check();
        if (items.length === 0) { window.alert('No snapshots to revert to.'); return; }
        const latest = [...items].sort((a, b) => b.ts.localeCompare(a.ts))[0];
        if (!window.confirm(`Revert to snapshot from ${latest.ts}?`)) return;
        check();
        id = latest.id;
      }
      const content = await aiCommands.snapshotRestore(target.path, id);
      check();
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      check();
      // An already dispatched legacy write cannot be cancelled. Never reread an
      // active path, and never adopt its result into a changed/new document.
      await writeTextFile(target.path, content);
      if (disposed || !target.isCurrent()) {
        throw new Error('Snapshot was written to its original file, but the editor was not updated because the document changed or closed.');
      }
      target.apply(content);
    } finally {
      restoring.value = false;
    }
  }
  return { restoring, restore };
}
