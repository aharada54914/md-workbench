import type { NativeGrant } from '../services/nativeFs';
import {
  acceptsFolderDrop,
  droppedFolders,
  toCssPoint,
  type DropPoint,
  type DropRect,
} from '../utils/folder-drop';

export interface UseFolderDropOptions {
  /** Sidebar box in CSS pixels, or null when the sidebar is hidden. */
  sidebarRect: () => DropRect | null;
  openWorkspace: (root: string, expectedGrantId?: string, isCurrent?: () => boolean) => Promise<{ id: string }>;
  revealWorkspace?: (id: string) => void;
}

export interface UseFolderDropReturn {
  /** Adds host-confirmed workspace grants. Returns the roots opened successfully. */
  handleDrop: (grants: NativeGrant[], position?: DropPoint | null, isCurrent?: () => boolean) => Promise<string[]>;
}

export function useFolderDrop(options: UseFolderDropOptions): UseFolderDropReturn {
  async function handleDrop(
    grants: NativeGrant[], position?: DropPoint | null, isCurrent: () => boolean = () => true,
  ): Promise<string[]> {
    if (!isCurrent()) return [];
    const folders = droppedFolders(grants);
    if (folders.length === 0) return [];

    const point = position ? toCssPoint(position, window.devicePixelRatio) : null;
    if (!acceptsFolderDrop(point, options.sidebarRect())) return [];

    const added: string[] = [];
    let lastId: string | null = null;
    for (const root of folders) {
      if (!isCurrent()) break;
      // droppedFolders retains the first spelling: keep that exact grant identity.
      const grant = grants.find((item) => item.kind === 'workspace' && item.path === root);
      if (!grant) continue;
      try {
        const entry = await options.openWorkspace(root, grant.id, isCurrent);
        if (!isCurrent()) break;
        added.push(root);
        lastId = entry.id;
      } catch (e) {
        if (!isCurrent()) break;
        console.error('[useFolderDrop] open workspace:', root, e);
      }
    }
    if (isCurrent() && lastId) options.revealWorkspace?.(lastId);
    return added;
  }

  return { handleDrop };
}
