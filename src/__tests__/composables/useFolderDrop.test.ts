import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTheme: vi.fn() }),
}));

import { useFolderDrop } from '../../composables/useFolderDrop';
import { useWorkspace, type WorkspaceNode } from '../../composables/useWorkspace';
import { useSettings } from '../../composables/useSettings';
import type { NativeGrant } from '../../services/nativeFs';

const SIDEBAR = { left: 0, top: 32, right: 240, bottom: 800 };
const INSIDE = { x: 120, y: 400 };
const OUTSIDE = { x: 900, y: 400 };

function folderNode(path: string): WorkspaceNode {
  return { name: path, path, kind: 'folder', children: [] };
}

function grant(path: string, kind: NativeGrant['kind'] = 'workspace'): NativeGrant {
  return { id: `grant-${path}`, path, kind, read: true, write: false };
}

function serveTrees() {
  invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'read_workspace_tree') {
      return Promise.resolve(folderNode(String(args.root)));
    }
    return Promise.reject(new Error(`Unexpected IPC: ${cmd}`));
  });
}

function resetWorkspaceState() {
  const { settings } = useSettings();
  settings.value.workspace.openWorkspaces = [];
  settings.value.workspace.activeWorkspaceId = null;
  settings.value.workspace.recentRoots = [];
  settings.value.workspace.sidebarVisible = true;
  const ws = useWorkspace();
  ws.expandedFolders.value = new Set();
  ws.collapsedWorkspaceIds.value = new Set();
  ws.highlightedPath.value = null;
  ws.revealSignal.value = null;
}

function makeDrop(overrides: Partial<Parameters<typeof useFolderDrop>[0]> = {}) {
  const ws = useWorkspace();
  const revealWorkspace = vi.fn((id: string) => ws.revealWorkspace(id));
  const drop = useFolderDrop({
    sidebarRect: () => SIDEBAR,
    openWorkspace: ws.openWorkspace,
    revealWorkspace,
    ...overrides,
  });
  return { ws, drop, revealWorkspace };
}

describe('useFolderDrop', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    invokeMock.mockReset();
    resetWorkspaceState();
    vi.stubGlobal('devicePixelRatio', 1);
    serveTrees();
  });

  describe('handleDrop', () => {
    it('adds a dropped directory as a workspace', async () => {
      const { ws, drop } = makeDrop();

      const added = await drop.handleDrop([grant('/notes')], INSIDE);

      expect(added).toEqual(['/notes']);
      expect(ws.openWorkspaces.value.map((w) => w.rootPath)).toEqual(['/notes']);
    });

    it('adds every dropped directory, in drop order', async () => {
      const { ws, drop } = makeDrop();

      const added = await drop.handleDrop(['/a', '/b', '/c'].map((path) => grant(path)), INSIDE);

      expect(added).toEqual(['/a', '/b', '/c']);
      expect(ws.openWorkspaces.value.map((w) => w.rootPath)).toEqual(['/a', '/b', '/c']);
    });

    it('does not add a directory twice — reveals the open one instead', async () => {
      const { ws, drop, revealWorkspace } = makeDrop();
      const first = await ws.openWorkspace('/notes');
      revealWorkspace.mockClear();

      const added = await drop.handleDrop([grant('/notes')], INSIDE);

      expect(ws.openWorkspaces.value).toHaveLength(1);
      expect(added).toEqual(['/notes']);
      expect(revealWorkspace).toHaveBeenCalledWith(first.id);
    });

    it('treats a trailing separator as the same directory', async () => {
      const { ws, drop } = makeDrop();
      await ws.openWorkspace('/notes');

      await drop.handleDrop([grant('/notes/')], INSIDE);

      expect(ws.openWorkspaces.value).toHaveLength(1);
    });

    it('ignores directories dropped outside the sidebar while it is visible', async () => {
      const { ws, drop } = makeDrop();

      const added = await drop.handleDrop([grant('/notes')], OUTSIDE);

      expect(added).toEqual([]);
      expect(ws.openWorkspaces.value).toHaveLength(0);
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('accepts a drop anywhere when the sidebar is hidden', async () => {
      const { ws, drop } = makeDrop({ sidebarRect: () => null });

      const added = await drop.handleDrop([grant('/notes')], OUTSIDE);

      expect(added).toEqual(['/notes']);
      expect(ws.openWorkspaces.value).toHaveLength(1);
    });

    it('is a no-op for a file-only drop', async () => {
      const { ws, drop } = makeDrop();

      const added = await drop.handleDrop([grant('/notes/a.md', 'document')], INSIDE);

      expect(added).toEqual([]);
      expect(ws.openWorkspaces.value).toHaveLength(0);
    });

    it('adds only the directories of a mixed drop', async () => {
      const { ws, drop } = makeDrop();

      const added = await drop.handleDrop([grant('/elsewhere/a.md', 'document'), grant('/notes')], INSIDE);

      expect(added).toEqual(['/notes']);
      expect(ws.openWorkspaces.value.map((w) => w.rootPath)).toEqual(['/notes']);
    });

    it('skips directories that fail to open and keeps the rest', async () => {
      const openWorkspace = vi.fn((root: string) =>
        root.startsWith('/bad') ? Promise.reject(new Error('denied')) : Promise.resolve({ id: `id-${root}` }),
      );
      const { drop, revealWorkspace } = makeDrop({ openWorkspace });

      const added = await drop.handleDrop(['/bad', '/good', '/bad-last'].map((path) => grant(path)), INSIDE);

      expect(added).toEqual(['/good']);
      expect(revealWorkspace).toHaveBeenCalledExactlyOnceWith('id-/good');
    });

    it('does no IPC for empty, document, resource, or export-only grants', async () => {
      const { drop } = makeDrop();
      expect(await drop.handleDrop([], INSIDE)).toEqual([]);
      expect(await drop.handleDrop([
        grant('/folder-shaped-document', 'document'),
        grant('/resource', 'resource'),
        grant('/export', 'export'),
      ], INSIDE)).toEqual([]);
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('deduplicates workspace grants before opening and reveals the last success', async () => {
      const openWorkspace = vi.fn(async (root: string) => ({ id: root }));
      const { drop, revealWorkspace } = makeDrop({ openWorkspace });
      const added = await drop.handleDrop([
        grant('/a'), grant('/a/'), grant('/b.md'), grant('/b.md/'),
      ], INSIDE);
      expect(added).toEqual(['/a', '/b.md']);
      expect(openWorkspace.mock.calls).toEqual([
        ['/a', 'grant-/a', expect.any(Function)],
        ['/b.md', 'grant-/b.md', expect.any(Function)],
      ]);
      expect(revealWorkspace).toHaveBeenCalledExactlyOnceWith('/b.md');
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('does no work when the drop session is already stale', async () => {
      const { drop, revealWorkspace } = makeDrop();
      expect(await drop.handleDrop([grant('/notes')], INSIDE, () => false)).toEqual([]);
      expect(invokeMock).not.toHaveBeenCalled();
      expect(revealWorkspace).not.toHaveBeenCalled();
    });

    it.each(['resolve', 'reject'])('stops inside an active callback after stale %s', async (outcome) => {
      let complete!: (value: { id: string }) => void;
      let fail!: (error: Error) => void;
      const openWorkspace = vi.fn(() => new Promise<{ id: string }>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      }));
      const { drop, revealWorkspace } = makeDrop({ openWorkspace });
      let current = true;
      const isCurrent = () => current;
      const pending = drop.handleDrop([grant('/a'), grant('/b')], INSIDE, isCurrent);
      expect(openWorkspace).toHaveBeenCalledExactlyOnceWith('/a', 'grant-/a', isCurrent);
      current = false;
      if (outcome === 'resolve') complete({ id: 'a' });
      else fail(new Error('late error'));
      expect(await pending).toEqual([]);
      expect(openWorkspace).toHaveBeenCalledTimes(1);
      expect(revealWorkspace).not.toHaveBeenCalled();
    });

    it('converts physical coordinates using device pixel ratio', async () => {
      vi.stubGlobal('devicePixelRatio', 2);
      const { drop } = makeDrop();
      expect(await drop.handleDrop([grant('/notes')], { x: 400, y: 1000 })).toEqual(['/notes']);
    });

    it('accepts a drop without position', async () => {
      const { drop } = makeDrop();
      expect(await drop.handleDrop([grant('/notes')])).toEqual(['/notes']);
    });

    it.each(['permission_required', 'filesystem_error'])('keeps workspace state unchanged on host %s', async (code) => {
      invokeMock.mockRejectedValue({ code, message: 'Workspace unavailable' });
      const { ws, drop, revealWorkspace } = makeDrop();
      expect(await drop.handleDrop([grant('/unavailable')], INSIDE)).toEqual([]);
      expect(ws.openWorkspaces.value).toHaveLength(0);
      expect(revealWorkspace).not.toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledExactlyOnceWith('read_workspace_tree', { root: '/unavailable', expectedGrantId: 'grant-/unavailable' });
    });
  });
});
