import { describe, it, expect, beforeEach, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTheme: vi.fn() }),
}));

import { useWorkspace, type WorkspaceNode } from '../../composables/useWorkspace';
import { useSettings, RECENT_WORKSPACES_LIMIT, OPEN_WORKSPACES_LIMIT } from '../../composables/useSettings';

function makeFolderNode(path: string, files: string[] = []): WorkspaceNode {
  return { name: path, path, kind: 'folder', children: files.map(name => ({
    name, path: `${path}/${name}`, kind: 'file',
  })) };
}

function resetWorkspaceState() {
  const { settings } = useSettings();
  settings.value.workspace.openWorkspaces = [];
  settings.value.workspace.activeWorkspaceId = null;
  settings.value.workspace.recentRoots = [];
  settings.value.workspace.sidebarVisible = true;
  settings.value.workspace.sidebarWidth = 240;
  // Module-level tree-view state must also be reset between tests since
  // `useWorkspace` is a singleton.
  const ws = useWorkspace();
  ws.expandedFolders.value = new Set();
  ws.collapsedWorkspaceIds.value = new Set();
  ws.highlightedPath.value = null;
  ws.revealSignal.value = null;
  ws.lastOpenError.value = null;
  ws.clearSelection();
  ws.setDropTargetPane(null);
}

describe('useWorkspace', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetWorkspaceState();
  });

  describe('openWorkspace', () => {
    it('loads tree and adds entry to openWorkspaces; sets active', async () => {
      const ws = useWorkspace();
      const node = makeFolderNode('/path/to/workspace');
      invokeMock.mockResolvedValueOnce(node);

      const entry = await ws.openWorkspace('/path/to/workspace');

      expect(invokeMock).toHaveBeenCalledWith('read_workspace_tree', { root: '/path/to/workspace' });
      expect(ws.openWorkspaces.value).toHaveLength(1);
      expect(ws.openWorkspaces.value[0].rootPath).toBe('/path/to/workspace');
      expect(ws.activeWorkspace.value?.id).toBe(entry.id);
      expect(ws.tree.value).toEqual(node);
    });

    it('switches to existing entry instead of duplicating', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('/x'));

      await ws.openWorkspace('/x');
      const firstId = ws.activeWorkspace.value!.id;
      // Open something else, then re-open /x
      invokeMock.mockResolvedValueOnce(makeFolderNode('/y'));
      await ws.openWorkspace('/y');
      invokeMock.mockResolvedValueOnce(makeFolderNode('/x'));
      const second = await ws.openWorkspace('/x');

      expect(second.id).toBe(firstId);
      expect(ws.openWorkspaces.value).toHaveLength(2);
      expect(ws.activeWorkspace.value?.rootPath).toBe('/x');
    });

    it('validates the exact dropped alias and grant even when already cached', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/x'));
      const entry = await ws.openWorkspace('/x');
      invokeMock.mockResolvedValueOnce(makeFolderNode('/x/'));
      expect((await ws.openWorkspace('/x/', 'drop-id')).id).toBe(entry.id);
      expect(invokeMock).toHaveBeenLastCalledWith('read_workspace_tree', {
        root: '/x/', expectedGrantId: 'drop-id',
      });
      expect(ws.openWorkspaces.value).toHaveLength(1);
    });

    it('preserves cached tree and active selection when dropped authority is rejected', async () => {
      const ws = useWorkspace();
      const previous = makeFolderNode('/x');
      invokeMock.mockResolvedValueOnce(previous);
      const entry = await ws.openWorkspace('/x');
      invokeMock.mockResolvedValueOnce(makeFolderNode('/y'));
      const active = await ws.openWorkspace('/y');
      invokeMock.mockRejectedValueOnce({ code: 'permission_required', message: 'changed grant' });
      await expect(ws.openWorkspace('/x', 'old-id')).rejects.toThrow();
      expect(ws.treesById.value[entry.id]).toEqual(previous);
      expect(ws.activeWorkspaceId.value).toBe(active.id);
      expect(ws.openWorkspaces.value).toHaveLength(2);
    });

    it('does no I/O or state changes for an already stale open', async () => {
      const ws = useWorkspace();
      ws.lastOpenError.value = 'previous';
      await expect(ws.openWorkspace('/x', 'id', () => false)).rejects.toMatchObject({ name: 'AbortError' });
      expect(invokeMock).not.toHaveBeenCalled();
      expect(ws.openWorkspaces.value).toEqual([]);
      expect(ws.lastOpenError.value).toBe('previous');
    });

    it.each([false, true])('discards a late tree without adopting state (cached=%s)', async (cached) => {
      const ws = useWorkspace();
      let entryId: string | undefined;
      const old = makeFolderNode('/x');
      if (cached) {
        invokeMock.mockResolvedValueOnce(old);
        entryId = (await ws.openWorkspace('/x')).id;
      }
      const beforeOpen = [...ws.openWorkspaces.value];
      const beforeRecents = [...ws.recentWorkspaces.value];
      const beforeExpanded = new Set(ws.expandedFolders.value);
      ws.lastOpenError.value = 'previous';
      let complete!: (node: WorkspaceNode) => void;
      invokeMock.mockImplementationOnce(() => new Promise<WorkspaceNode>((resolve) => { complete = resolve; }));
      let current = true;
      const pending = ws.openWorkspace('/x', 'id', () => current);
      current = false;
      complete({ ...old, children: [makeFolderNode('/x/new')] });
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(ws.openWorkspaces.value).toEqual(beforeOpen);
      expect(ws.recentWorkspaces.value).toEqual(beforeRecents);
      expect(ws.expandedFolders.value).toEqual(beforeExpanded);
      expect(ws.lastOpenError.value).toBe('previous');
      if (entryId) expect(ws.treesById.value[entryId]).toEqual(old);
    });

    it('suppresses a late read failure after the session stops', async () => {
      const ws = useWorkspace();
      ws.lastOpenError.value = 'previous';
      let fail!: (error: unknown) => void;
      invokeMock.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
      let current = true;
      const pending = ws.openWorkspace('/x', 'id', () => current);
      current = false;
      fail({ code: 'permission_required' });
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(ws.lastOpenError.value).toBe('previous');
      expect(ws.openWorkspaces.value).toEqual([]);
    });

    it('does not restore or activate a cached workspace closed while validating a drop', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/x'));
      const entry = await ws.openWorkspace('/x');
      let complete!: (node: WorkspaceNode) => void;
      invokeMock.mockImplementationOnce(() => new Promise<WorkspaceNode>((resolve) => { complete = resolve; }));
      const pending = ws.openWorkspace('/x', 'id');
      ws.closeWorkspaceById(entry.id);
      complete(makeFolderNode('/x'));
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(ws.treesById.value[entry.id]).toBeUndefined();
      expect(ws.openWorkspaces.value).toEqual([]);
      expect(ws.activeWorkspaceId.value).toBeNull();
    });

    it('caps open workspaces at OPEN_WORKSPACES_LIMIT (drops oldest non-active)', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));

      for (let i = 0; i < OPEN_WORKSPACES_LIMIT + 2; i++) {
        await ws.openWorkspace(`/p${i}`);
      }
      expect(ws.openWorkspaces.value.length).toBeLessThanOrEqual(OPEN_WORKSPACES_LIMIT);
      // The most recently opened is active
      expect(ws.activeWorkspace.value?.rootPath).toBe(`/p${OPEN_WORKSPACES_LIMIT + 1}`);
    });

    it('does not pollute state when load fails', async () => {
      const ws = useWorkspace();
      invokeMock.mockRejectedValueOnce(new Error('boom'));
      await expect(ws.openWorkspace('/bad')).rejects.toThrow('boom');
      expect(ws.openWorkspaces.value).toHaveLength(0);
      expect(ws.activeWorkspace.value).toBeNull();
    });

    it('reports a denied recent path without picking automatically or widening authority', async () => {
      const ws = useWorkspace();
      const { settings } = useSettings();
      settings.value.workspace.recentRoots = ['/unselected'];
      invokeMock.mockRejectedValueOnce({ code: 'permission_required', message: 'permission_required' });
      await expect(ws.openWorkspace('/unselected')).rejects.toThrow();
      expect(ws.lastOpenError.value).toBeTruthy();
      expect(ws.lastOpenError.value).not.toContain('[object Object]');
      expect(ws.openWorkspaces.value).toEqual([]);
      expect(ws.recentWorkspaces.value).toEqual(['/unselected']);
      expect(invokeMock.mock.calls).toEqual([['read_workspace_tree', { root: '/unselected' }]]);
    });

    it('removes path from recents when opened', async () => {
      const ws = useWorkspace();
      const { settings } = useSettings();
      settings.value.workspace.recentRoots = ['/x', '/y'];
      invokeMock.mockResolvedValueOnce(makeFolderNode('/x'));
      await ws.openWorkspace('/x');
      expect(ws.recentWorkspaces.value).toEqual(['/y']);
    });
  });

  describe('closeWorkspaceById', () => {
    it('drops the workspace and pushes its path to recents', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/a'));
      const a = await ws.openWorkspace('/a');
      invokeMock.mockResolvedValueOnce(makeFolderNode('/b'));
      await ws.openWorkspace('/b');

      ws.closeWorkspaceById(a.id);

      expect(ws.openWorkspaces.value.map((w) => w.rootPath)).toEqual(['/b']);
      expect(ws.recentWorkspaces.value).toEqual(['/a']);
    });

    it('switches active when active is closed', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/a'));
      await ws.openWorkspace('/a');
      invokeMock.mockResolvedValueOnce(makeFolderNode('/b'));
      const b = await ws.openWorkspace('/b'); // active = b
      ws.closeWorkspaceById(b.id);
      expect(ws.activeWorkspace.value?.rootPath).toBe('/a');
    });
  });

  describe('setActive', () => {
    it('switches active id and lazy-loads tree if missing', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/a'));
      const a = await ws.openWorkspace('/a');
      invokeMock.mockResolvedValueOnce(makeFolderNode('/b'));
      const b = await ws.openWorkspace('/b'); // tree(b) loaded

      // Drop tree(a) to simulate missing tree
      ws.treesById.value[a.id] = null;
      invokeMock.mockResolvedValueOnce(makeFolderNode('/a'));
      ws.setActive(a.id);
      // Wait for the lazy-load microtask
      await Promise.resolve();
      await Promise.resolve();
      expect(ws.activeWorkspace.value?.id).toBe(a.id);
      expect(invokeMock).toHaveBeenCalledWith('read_workspace_tree', { root: '/a' });
      // b still around
      expect(ws.openWorkspaces.value.map((w) => w.id)).toContain(b.id);
    });
  });

  describe('refreshAll with a drop session', () => {
    it.each(['success', 'failure'])('discards a stale %s and does not start later roots', async (outcome) => {
      const ws = useWorkspace();
      const previous = makeFolderNode('/a');
      invokeMock.mockResolvedValueOnce(previous);
      const a = await ws.openWorkspace('/a');
      invokeMock.mockResolvedValueOnce(makeFolderNode('/b'));
      await ws.openWorkspace('/b');
      ws.lastOpenError.value = 'previous error';
      const expanded = new Set(ws.expandedFolders.value);
      invokeMock.mockClear();
      let complete!: (node: WorkspaceNode) => void;
      let fail!: (error: Error) => void;
      invokeMock.mockImplementationOnce(() => new Promise<WorkspaceNode>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      }));
      let current = true;
      const pending = ws.refreshAll(() => current);
      expect(invokeMock).toHaveBeenCalledExactlyOnceWith('read_workspace_tree', { root: '/a' });
      current = false;
      if (outcome === 'success') complete({ ...previous, children: [makeFolderNode('/a/new')] });
      else fail(new Error('late failure'));
      await pending;
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(ws.treesById.value[a.id]).toEqual(previous);
      expect(ws.expandedFolders.value).toEqual(expanded);
      expect(ws.lastOpenError.value).toBe('previous error');
      expect(ws.isLoading.value).toBe(false);
    });

    it('does no reads when the drop session already stopped', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/a'));
      await ws.openWorkspace('/a');
      invokeMock.mockClear();
      await ws.refreshAll(() => false);
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('refreshes all roots while the drop session stays current', async () => {
      const ws = useWorkspace();
      for (const root of ['/a', '/b']) {
        invokeMock.mockResolvedValueOnce(makeFolderNode(root));
        await ws.openWorkspace(root);
      }
      invokeMock.mockClear();
      invokeMock.mockImplementation(async (_cmd, args) => ({ ...makeFolderNode(args.root), name: 'updated' }));
      await ws.refreshAll(() => true);
      expect(invokeMock.mock.calls).toEqual([
        ['read_workspace_tree', { root: '/a' }], ['read_workspace_tree', { root: '/b' }],
      ]);
      for (const entry of ws.openWorkspaces.value) expect(ws.treesById.value[entry.id]?.name).toBe('updated');
    });
  });

  describe('restoreLastOnStartup', () => {
    it('does nothing when no openWorkspaces', async () => {
      const ws = useWorkspace();
      await ws.restoreLastOnStartup();
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('loads all open workspaces in parallel', async () => {
      const ws = useWorkspace();
      const { settings } = useSettings();
      settings.value.workspace.openWorkspaces = [
        { id: 'a', rootPath: '/a', name: 'a' },
        { id: 'b', rootPath: '/b', name: 'b' },
      ];
      settings.value.workspace.activeWorkspaceId = 'a';
      invokeMock.mockResolvedValue(makeFolderNode('any'));

      await ws.restoreLastOnStartup();

      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(ws.openWorkspaces.value).toHaveLength(2);
    });

    it('drops failed entries and moves them to recents', async () => {
      const ws = useWorkspace();
      const { settings } = useSettings();
      settings.value.workspace.openWorkspaces = [
        { id: 'a', rootPath: '/missing', name: 'missing' },
        { id: 'b', rootPath: '/ok', name: 'ok' },
      ];
      settings.value.workspace.activeWorkspaceId = 'a';
      invokeMock.mockImplementation((_cmd, args) => {
        const root = (args as { root?: string }).root;
        if (root === '/missing') return Promise.reject(new Error('not found'));
        return Promise.resolve(makeFolderNode(root || ''));
      });

      await ws.restoreLastOnStartup();

      expect(ws.openWorkspaces.value.map((w) => w.rootPath)).toEqual(['/ok']);
      expect(ws.recentWorkspaces.value).toContain('/missing');
    });
  });

  describe('refreshAll', () => {
    it('re-invokes read_workspace_tree for every open workspace', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      await ws.openWorkspace('/a');
      await ws.openWorkspace('/b');

      invokeMock.mockClear();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      await ws.refreshAll();

      const treeCalls = invokeMock.mock.calls.filter((c) => c[0] === 'read_workspace_tree');
      expect(treeCalls).toHaveLength(2);
    });
  });

  describe('removeRecent', () => {
    it('drops a single entry', async () => {
      const ws = useWorkspace();
      const { settings } = useSettings();
      settings.value.workspace.recentRoots = ['/a', '/b'];
      ws.removeRecent('/a');
      expect(ws.recentWorkspaces.value).toEqual(['/b']);
    });
  });

  describe('reorderOpenWorkspaces', () => {
    it('moves an entry from one index to another', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      await ws.openWorkspace('/a');
      await ws.openWorkspace('/b');
      await ws.openWorkspace('/c');
      ws.reorderOpenWorkspaces(0, 2);
      expect(ws.openWorkspaces.value.map((w) => w.rootPath)).toEqual(['/b', '/c', '/a']);
    });
  });

  describe('file operations', () => {
    it.each(['createFile', 'createFolder'] as const)('%s reports typed denial without changing the open workspace', async (operation) => {
      const ws = useWorkspace();
      const oldTree = makeFolderNode('/r');
      invokeMock.mockResolvedValueOnce(oldTree);
      const opened = await ws.openWorkspace('/r');
      for (const [code, message] of [
        ['permission_required', 'Choose this folder again with Open Folder to grant access.'],
        ['invalid_path', 'Use a valid file or folder name without path separators or reserved characters.'],
        ['filesystem_error', 'Could not create the file or folder. Check that the name is available and the folder is writable.'],
      ]) {
        invokeMock.mockClear();
        invokeMock.mockRejectedValueOnce({ code, message: 'native diagnostic' });
        await expect(ws[operation]('/r', 'new')).rejects.toThrow(message);
        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(ws.activeWorkspaceId.value).toBe(opened.id);
        expect(ws.tree.value).toEqual(oldTree);
      }
    });

    it('createFile invokes command and refreshes all open trees', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      await ws.openWorkspace('/r1');
      await ws.openWorkspace('/r2');

      invokeMock.mockReset();
      invokeMock.mockResolvedValueOnce('/r1/new.md');
      invokeMock.mockResolvedValue(makeFolderNode('any'));

      const created = await ws.createFile('/r1', 'new');
      expect(created).toBe('/r1/new.md');

      const cmds = invokeMock.mock.calls.map((c) => c[0]);
      expect(cmds[0]).toBe('create_md_file');
      // both trees refresh
      expect(cmds.filter((c) => c === 'read_workspace_tree')).toHaveLength(2);
    });

    it('revealInOs invokes command without refresh', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(undefined);
      await ws.revealInOs('/r/a.md');
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith('reveal_in_os', { path: '/r/a.md' });
    });

    it('rename denial preserves the tree and explains destination collisions', async () => {
      const ws = useWorkspace();
      const before = makeFolderNode('/r');
      invokeMock.mockResolvedValueOnce(before);
      await ws.openWorkspace('/r');
      invokeMock.mockClear();
      invokeMock.mockRejectedValueOnce({ code: 'already_exists', message: 'native diagnostic' });
      await expect(ws.renamePath('/r/a.md', '/r/b.md')).rejects.toThrow(
        'An item already exists at the destination. Choose another name or location.',
      );
      expect(invokeMock.mock.calls).toEqual([['rename_path', { from: '/r/a.md', to: '/r/b.md' }]]);
      expect(ws.tree.value).toEqual(before);
    });

    it.each([false, true])('delete failure refreshes every tree and reports partial=%s', async partial => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/r1'));
      await ws.openWorkspace('/r1');
      invokeMock.mockResolvedValueOnce(makeFolderNode('/r2'));
      await ws.openWorkspace('/r2');
      invokeMock.mockReset();
      invokeMock.mockRejectedValueOnce({ code: 'permission_required', partial, removed: partial ? 1 : 0 });
      invokeMock.mockResolvedValueOnce(makeFolderNode('/r1', ['remaining.md']));
      invokeMock.mockResolvedValueOnce(makeFolderNode('/r2', ['other.md']));
      await expect(ws.deletePath('/r1/folder')).rejects.toThrow(partial
        ? 'Deletion stopped and some items may have been removed. Check the refreshed folder before trying again.'
        : 'Choose this folder again with Open Folder to grant access.');
      expect(invokeMock.mock.calls).toEqual([
        ['delete_path', { path: '/r1/folder' }],
        ['read_workspace_tree', { root: '/r1' }],
        ['read_workspace_tree', { root: '/r2' }],
      ]);
      expect(ws.tree.value).toEqual(makeFolderNode('/r2', ['other.md']));
    });

    it('a failed refresh cannot hide the partial deletion error', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/r'));
      await ws.openWorkspace('/r');
      invokeMock.mockRejectedValueOnce({ code: 'file_too_large', partial: true, removed: 1 });
      invokeMock.mockRejectedValueOnce({ code: 'permission_required' });
      await expect(ws.deletePath('/r/folder')).rejects.toThrow(
        'Deletion stopped and some items may have been removed. Check the refreshed folder before trying again.',
      );
      expect(ws.tree.value).toBeNull();
    });
  });

  describe('findOwningWorkspace', () => {
    it('returns the workspace whose root is an ancestor of the path', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      await ws.openWorkspace('/notes');
      await ws.openWorkspace('/code');

      const owner = ws.findOwningWorkspace('/notes/sub/file.md');
      expect(owner?.rootPath).toBe('/notes');
      expect(ws.findOwningWorkspace('/elsewhere/x.md')).toBeNull();
    });

    it('handles backslash separators', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('C:\\notes'));
      await ws.openWorkspace('C:\\notes');
      const owner = ws.findOwningWorkspace('C:\\notes\\sub\\x.md');
      expect(owner?.rootPath).toBe('C:\\notes');
    });
  });

  describe('tree view state', () => {
    it('toggleFolder flips expanded state', () => {
      const ws = useWorkspace();
      expect(ws.isFolderExpanded('/a/b')).toBe(false);
      ws.toggleFolder('/a/b');
      expect(ws.isFolderExpanded('/a/b')).toBe(true);
      ws.toggleFolder('/a/b');
      expect(ws.isFolderExpanded('/a/b')).toBe(false);
    });

    it('expandAncestorsOf adds parents (not the file itself or root)', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/r'));
      await ws.openWorkspace('/r');

      ws.expandAncestorsOf('/r/sub/deep/file.md');
      expect(ws.isFolderExpanded('/r/sub')).toBe(true);
      expect(ws.isFolderExpanded('/r/sub/deep')).toBe(true);
      // The root is implicitly expanded (rendered as `isRoot`); should NOT be added.
      expect(ws.isFolderExpanded('/r')).toBe(false);
      // The file itself is not a folder.
      expect(ws.isFolderExpanded('/r/sub/deep/file.md')).toBe(false);
    });

    it('setHighlightedPath stores path and expands ancestors', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/r'));
      await ws.openWorkspace('/r');

      ws.setHighlightedPath('/r/sub/file.md');
      expect(ws.highlightedPath.value).toBe('/r/sub/file.md');
      expect(ws.isFolderExpanded('/r/sub')).toBe(true);
    });

    it('setHighlightedPath(null) clears the highlight', () => {
      const ws = useWorkspace();
      ws.setHighlightedPath('/x/y.md');
      ws.setHighlightedPath(null);
      expect(ws.highlightedPath.value).toBeNull();
    });
  });

  describe('dragSelectionFor', () => {
    it('drags the whole selection when the grabbed row belongs to it', () => {
      const ws = useWorkspace();
      ws.selectOnly('/r/a.md');
      ws.toggleSelect('/r/b.md');
      expect(ws.dragSelectionFor('/r/a.md').sort()).toEqual(['/r/a.md', '/r/b.md']);
    });

    it('drags only the grabbed row when it is outside the selection', () => {
      const ws = useWorkspace();
      ws.selectOnly('/r/a.md');
      expect(ws.dragSelectionFor('/r/z.md')).toEqual(['/r/z.md']);
    });

    it('drags only the grabbed row when nothing is selected', () => {
      const ws = useWorkspace();
      ws.clearSelection();
      expect(ws.dragSelectionFor('/r/a.md')).toEqual(['/r/a.md']);
    });
  });

  describe('openWorkspaceDialog', () => {
    it('refreshes a cached tree after native re-selection of the same path', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/picked'));
      const previous = await ws.openWorkspace('/picked');
      invokeMock.mockResolvedValueOnce({ id: 'new-selection', path: '/picked', kind: 'workspace', read: true, write: true });
      const next = { ...makeFolderNode('/picked'), children: [{ name: 'new.md', path: '/picked/new.md', kind: 'file' as const }] };
      invokeMock.mockResolvedValueOnce(next);
      await ws.openWorkspaceDialog();
      expect(ws.openWorkspaces.value).toHaveLength(1);
      expect(ws.activeWorkspaceId.value).toBe(previous.id);
      expect(ws.tree.value).toEqual(next);
    });

    it('opens picker, then loads picked path', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce({ id: 'native-workspace', path: '/picked', kind: 'workspace', read: true, write: true });
      invokeMock.mockResolvedValueOnce(makeFolderNode('/picked'));
      const picked = await ws.openWorkspaceDialog();
      expect(picked).toBe('/picked');
      expect(ws.activeWorkspace.value?.rootPath).toBe('/picked');
      expect(invokeMock.mock.calls).toEqual([
        ['native_pick_workspace'], ['read_workspace_tree', { root: '/picked', expectedGrantId: 'native-workspace' }],
      ]);
    });

    it('returns null when user cancels', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(null);
      const picked = await ws.openWorkspaceDialog();
      expect(picked).toBeNull();
      expect(invokeMock.mock.calls).toEqual([['native_pick_workspace']]);
      expect(ws.openWorkspaces.value).toEqual([]);
    });

    it('cancelling re-selection keeps an existing workspace and its denial message', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/existing'));
      await ws.openWorkspace('/existing');
      const id = ws.activeWorkspaceId.value;
      ws.lastOpenError.value = 'Select the folder again';
      invokeMock.mockResolvedValueOnce(null);
      await ws.openWorkspaceDialog();
      expect(ws.activeWorkspaceId.value).toBe(id);
      expect(ws.tree.value?.path).toBe('/existing');
      expect(ws.lastOpenError.value).toBe('Select the folder again');
    });
  });

  describe('recents LRU', () => {
    it('caps recents at RECENT_WORKSPACES_LIMIT after sequential open+close cycles', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      for (let i = 0; i < RECENT_WORKSPACES_LIMIT + 3; i++) {
        const e = await ws.openWorkspace(`/p${i}`);
        ws.closeWorkspaceById(e.id);
      }
      expect(ws.recentWorkspaces.value.length).toBe(RECENT_WORKSPACES_LIMIT);
    });
  });

  describe('workspace section collapse', () => {
    it('toggleWorkspaceSection flips collapsed state', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/r'));
      const e = await ws.openWorkspace('/r');
      expect(ws.isWorkspaceSectionCollapsed(e.id)).toBe(false);
      ws.toggleWorkspaceSection(e.id);
      expect(ws.isWorkspaceSectionCollapsed(e.id)).toBe(true);
      ws.toggleWorkspaceSection(e.id);
      expect(ws.isWorkspaceSectionCollapsed(e.id)).toBe(false);
    });

    it('expandAllWorkspaceSections clears the collapsed set', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      const a = await ws.openWorkspace('/a');
      const b = await ws.openWorkspace('/b');
      ws.collapseWorkspaceSection(a.id);
      ws.collapseWorkspaceSection(b.id);
      ws.expandAllWorkspaceSections();
      expect(ws.isWorkspaceSectionCollapsed(a.id)).toBe(false);
      expect(ws.isWorkspaceSectionCollapsed(b.id)).toBe(false);
    });

    it('collapseAllWorkspaceSections collapses every open workspace', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      const a = await ws.openWorkspace('/a');
      const b = await ws.openWorkspace('/b');
      ws.collapseAllWorkspaceSections();
      expect(ws.isWorkspaceSectionCollapsed(a.id)).toBe(true);
      expect(ws.isWorkspaceSectionCollapsed(b.id)).toBe(true);
    });

    it('revealWorkspace activates, expands and signals the sidebar to scroll', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      const a = await ws.openWorkspace('/a');
      const b = await ws.openWorkspace('/b');
      ws.collapseWorkspaceSection(a.id);

      ws.revealWorkspace(a.id);

      expect(ws.activeWorkspace.value?.id).toBe(a.id);
      expect(ws.isWorkspaceSectionCollapsed(a.id)).toBe(false);
      expect(ws.revealSignal.value?.id).toBe(a.id);

      const firstSeq = ws.revealSignal.value!.seq;
      ws.revealWorkspace(b.id);
      expect(ws.revealSignal.value!.seq).toBeGreaterThan(firstSeq);
    });

    it('revealWorkspace ignores an unknown id', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValue(makeFolderNode('any'));
      const a = await ws.openWorkspace('/a');

      ws.revealWorkspace('nope');

      expect(ws.activeWorkspace.value?.id).toBe(a.id);
      expect(ws.revealSignal.value).toBeNull();
    });

    it('setHighlightedPath auto-expands the owning collapsed section', async () => {
      const ws = useWorkspace();
      invokeMock.mockResolvedValueOnce(makeFolderNode('/r'));
      const entry = await ws.openWorkspace('/r');
      ws.collapseWorkspaceSection(entry.id);
      expect(ws.isWorkspaceSectionCollapsed(entry.id)).toBe(true);

      ws.setHighlightedPath('/r/sub/file.md');
      expect(ws.isWorkspaceSectionCollapsed(entry.id)).toBe(false);
    });
  });
});
