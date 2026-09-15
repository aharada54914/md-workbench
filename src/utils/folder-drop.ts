/**
 * Pure helpers for the OS-level directory drop that adds a workspace (#124).
 *
 * `tauri://drag-drop` reports the pointer in PHYSICAL pixels while
 * `getBoundingClientRect` works in CSS pixels, so every geometry check goes
 * through `toCssPoint` first.
 */

import type { NativeGrant } from '../services/nativeFs';
import { trimTrailingSep } from './path-utils';

export interface DropPoint {
  x: number;
  y: number;
}

export interface DropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function toCssPoint(position: DropPoint, dpr: number): DropPoint {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { x: position.x / ratio, y: position.y / ratio };
}

export function isPointInRect(point: DropPoint, rect: DropRect): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

/**
 * The workspace sidebar is the drop target for directories. When it is hidden
 * there is nothing to aim at, so the whole window accepts the drop instead.
 * A drop without a position (older webviews) is accepted as well.
 */
export function acceptsFolderDrop(point: DropPoint | null, sidebarRect: DropRect | null): boolean {
  if (!sidebarRect || !point) return true;
  return isPointInRect(point, sidebarRect);
}

function dedupeKey(path: string): string {
  return trimTrailingSep(path.replace(/\\/g, '/'));
}

/** Host-confirmed workspaces, in drop order, without separator-only duplicates. */
export function droppedFolders(grants: NativeGrant[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of grants) {
    if (entry.kind !== 'workspace') continue;
    const key = dedupeKey(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry.path);
  }
  return out;
}
