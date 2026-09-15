import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useImageDrop, type ImageDropTarget } from '../../composables/useImageDrop';
import { importImage } from '../../services/imageImport';
import { documentImageBytes } from '../../services/documentImageBytes';
import type { NativeGrant } from '../../services/nativeFs';
import type { CodeEditorHandle } from '../../types/code-editor';

vi.mock('../../services/imageImport', () => ({ importImage: vi.fn() }));

const grant = (path = '/drop/a.png'): NativeGrant => ({ id: `grant:${path}`, path, kind: 'resource', read: true, write: false });
const pos = { x: 40, y: 80 };
const image = { markdownPath: 'images/a.png', altText: 'a' };
function editor(): CodeEditorHandle {
  return {
    focus: vi.fn(), getValue: vi.fn(() => ''), getSelection: vi.fn(() => ({ start: 0, end: 0 })),
    setSelection: vi.fn(), replaceSelection: vi.fn(), getScrollRatio: vi.fn(() => 0),
    scrollToRatio: vi.fn(), scrollToPosition: vi.fn(), highlightSelectionLine: vi.fn(),
  };
}
function setup(code = true, withOwner = false) {
  let owner = withOwner ? documentImageBytes.createOwner() : undefined;
  let currentEditor: CodeEditorHandle | null = editor();
  let filePath: string | null = '/docs/note.md';
  let current = true;
  const codeView = ref(code);
  let target: ImageDropTarget | null = { imageOwner: owner, filePath, insertImages: vi.fn(), isCurrent: () => true };
  const onError = vi.fn();
  const onImagesImported = vi.fn();
  const findVisualTargetAt = vi.fn(() => target);
  const drop = useImageDrop({ codeView, codeEditor: () => currentEditor, activeFilePath: () => filePath,
    findVisualTargetAt, onError, onImagesImported, activeImageOwner: () => owner });
  return { ...drop, codeView, editor: currentEditor, target, onError, onImagesImported, findVisualTargetAt,
    selection: { grants: [grant(), grant('/drop/b.png')], isCurrent: () => current },
    getOwner: () => owner, replaceOwner: () => { owner = documentImageBytes.createOwner(); },
    stop: () => { current = false; }, setFilePath: (value: string | null) => { filePath = value; },
    setEditor: (value: CodeEditorHandle | null) => { currentEditor = value; },
    setTarget: (value: ImageDropTarget | null) => { target = value; },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(importImage).mockResolvedValue(image);
});

afterEach(() => documentImageBytes.disposeAll());

describe('useImageDrop captured OS selection', () => {
  it('passes the live session guard to asynchronous workspace refresh', async () => {
    const state = setup();
    await state.handleDrop(['/drop/a.png'], pos, state.selection);
    expect(state.onImagesImported).toHaveBeenCalledWith(state.selection.isCurrent);
    const guard = state.onImagesImported.mock.calls[0]![0] as () => boolean;
    expect(guard()).toBe(true);
    state.stop();
    expect(guard()).toBe(false);
  });

  it('passes each matching grant ID to source import and inserts code', async () => {
    const state = setup();
    await state.handleDrop(['/drop/a.png', '/drop/b.png', '/drop/note.md'], pos, state.selection);
    expect(importImage).toHaveBeenNthCalledWith(1, '/drop/a.png', '/docs/note.md', {
      expectedGrantId: 'grant:/drop/a.png', isCurrent: expect.any(Function),
    });
    expect(importImage).toHaveBeenNthCalledWith(2, '/drop/b.png', '/docs/note.md', {
      expectedGrantId: 'grant:/drop/b.png', isCurrent: expect.any(Function),
    });
    expect(state.editor.replaceSelection).toHaveBeenCalledWith('![a](images/a.png)\n\n![a](images/a.png)');
  });

  it.each(['absent', 'unreadable', 'document'] as const)('rejects %s source metadata without import', async (invalid) => {
    const state = setup();
    if (invalid === 'absent') state.selection.grants = [];
    if (invalid === 'unreadable') state.selection.grants[0]!.read = false;
    if (invalid === 'document') state.selection.grants[0]!.kind = 'document';
    await state.handleDrop(['/drop/a.png'], pos, state.selection);
    expect(importImage).not.toHaveBeenCalled();
    expect(state.editor.replaceSelection).not.toHaveBeenCalled();
    expect(state.onError).toHaveBeenCalledWith('/drop/a.png');
  });

  it('does not start an import after stop', async () => {
    const state = setup(); state.stop();
    await state.handleDrop(['/drop/a.png'], pos, state.selection);
    expect(importImage).not.toHaveBeenCalled();
    expect(state.onImagesImported).not.toHaveBeenCalled();
  });

  it('suppresses later images, insertion and notifications after a pending import is stopped', async () => {
    const state = setup();
    vi.mocked(importImage).mockImplementationOnce(async () => { state.stop(); return image; });
    await state.handleDrop(['/drop/a.png', '/drop/b.png'], pos, state.selection);
    expect(importImage).toHaveBeenCalledTimes(1);
    expect(state.editor.replaceSelection).not.toHaveBeenCalled();
    expect(state.onImagesImported).not.toHaveBeenCalled();
  });

  it('suppresses errors from an obsolete pending import', async () => {
    const state = setup();
    vi.mocked(importImage).mockImplementationOnce(async () => { state.stop(); throw new Error('revoked'); });
    await state.handleDrop(['/drop/a.png', '/drop/b.png'], pos, state.selection);
    expect(importImage).toHaveBeenCalledTimes(1);
    expect(state.onError).not.toHaveBeenCalled();
  });

  it.each(['file', 'editor', 'mode'] as const)('does not insert into a changed code target: %s', async (change) => {
    const state = setup();
    vi.mocked(importImage).mockImplementationOnce(async (_src, _doc, selection) => {
      if (change === 'file') state.setFilePath('/docs/other.md');
      if (change === 'editor') state.setEditor(editor());
      if (change === 'mode') state.codeView.value = false;
      expect(selection?.isCurrent()).toBe(false);
      return image;
    });
    await state.handleDrop(['/drop/a.png', '/drop/b.png'], pos, state.selection);
    expect(importImage).toHaveBeenCalledTimes(1);
    expect(state.editor.replaceSelection).not.toHaveBeenCalled();
  });

  it('inserts into the visual target using CSS coordinates', async () => {
    const state = setup(false);
    const dpr = window.devicePixelRatio || 1;
    await state.handleDrop(['/drop/a.png'], pos, state.selection);
    expect(state.findVisualTargetAt).toHaveBeenCalledWith(pos.x / dpr, pos.y / dpr);
    expect(state.target?.insertImages).toHaveBeenCalledWith([{ path: 'images/a.png', alt: 'a' }]);
  });

  it.each(['file', 'identity', 'missing'] as const)('does not insert into a changed visual target: %s', async (change) => {
    const state = setup(false);
    vi.mocked(importImage).mockImplementationOnce(async () => {
      if (change === 'file') state.setTarget({ filePath: '/docs/other.md', insertImages: vi.fn() });
      if (change === 'identity') state.target!.isCurrent = () => false;
      if (change === 'missing') state.setTarget(null);
      return image;
    });
    await state.handleDrop(['/drop/a.png', '/drop/b.png'], pos, state.selection);
    expect(importImage).toHaveBeenCalledTimes(1);
    expect(state.target?.insertImages).not.toHaveBeenCalled();
  });

  it('continues remaining valid images after a current import failure', async () => {
    const state = setup();
    vi.mocked(importImage).mockRejectedValueOnce(new Error('denied'));
    await state.handleDrop(['/drop/a.png', '/drop/b.png'], pos, state.selection);
    expect(importImage).toHaveBeenCalledTimes(2);
    expect(state.onError).toHaveBeenCalledWith('/drop/a.png');
    expect(state.editor.replaceSelection).toHaveBeenCalledTimes(1);
  });

  it('retains the optional legacy import call', async () => {
    const state = setup();
    await state.handleDrop(['/drop/a.png'], pos);
    expect(importImage).toHaveBeenCalledWith('/drop/a.png', '/docs/note.md');
    expect(state.editor.replaceSelection).toHaveBeenCalledTimes(1);
  });
});

describe('useImageDrop preparation lifecycle', () => {
  it('commits prepared snapshots before insertion and releases tokens afterwards', async () => {
    const state = setup(false);
    const calls: string[] = [];
    const prepared = { commit: vi.fn(() => calls.push('commit')), release: vi.fn(() => calls.push('release')) };
    vi.mocked(importImage).mockResolvedValue({ ...image, prepared });
    state.target!.insertImages = () => { calls.push('insert'); };
    await state.handleDrop(['/drop/a.png'], pos, state.selection);
    expect(calls).toEqual(['commit', 'insert', 'release']);
  });

  it('releases all earlier pending images when a later import becomes stale', async () => {
    const state = setup();
    const first = { commit: vi.fn(), release: vi.fn() };
    const second = { commit: vi.fn(), release: vi.fn() };
    vi.mocked(importImage).mockResolvedValueOnce({ ...image, prepared: first })
      .mockImplementationOnce(async () => { state.stop(); return { ...image, prepared: second }; });
    await state.handleDrop(['/drop/a.png', '/drop/b.png'], pos, state.selection);
    expect(first.commit).not.toHaveBeenCalled(); expect(second.commit).not.toHaveBeenCalled();
    expect(first.release).toHaveBeenCalledOnce(); expect(second.release).toHaveBeenCalledOnce();
    expect(state.editor.replaceSelection).not.toHaveBeenCalled();
  });

  it('releases accumulated preparations when the error callback itself throws', async () => {
    const state = setup();
    const prepared = { commit: vi.fn(), release: vi.fn() };
    vi.mocked(importImage).mockResolvedValueOnce({ ...image, prepared }).mockRejectedValueOnce(new Error('import'));
    state.onError.mockImplementation(() => { throw new Error('callback'); });
    await expect(state.handleDrop(['/drop/a.png', '/drop/b.png'], pos, state.selection)).rejects.toThrow('callback');
    expect(prepared.release).toHaveBeenCalledOnce();
    expect(prepared.commit).not.toHaveBeenCalled();
  });
});


describe('useImageDrop exact document owner', () => {
  it('passes the captured owner without conflating same-path code documents', async () => {
    const state = setup(true, true);
    const owner = state.getOwner();
    const prepared = { commit: vi.fn(), release: vi.fn() };
    vi.mocked(importImage).mockImplementationOnce(async (_src, _doc, selected) => {
      expect(selected?.owner).toBe(owner);
      state.replaceOwner();
      expect(selected?.isCurrent()).toBe(false);
      return { ...image, prepared };
    });
    await state.handleDrop(['/drop/a.png'], pos, state.selection);
    expect(prepared.commit).not.toHaveBeenCalled();
    expect(prepared.release).toHaveBeenCalledOnce();
    expect(state.editor.replaceSelection).not.toHaveBeenCalled();
  });

  it('rejects a new visual owner even when path and legacy target guard match', async () => {
    const state = setup(false, true);
    const prepared = { commit: vi.fn(), release: vi.fn() };
    vi.mocked(importImage).mockImplementationOnce(async () => {
      state.setTarget({ filePath: '/docs/note.md', imageOwner: documentImageBytes.createOwner(), insertImages: vi.fn() });
      return { ...image, prepared };
    });
    await state.handleDrop(['/drop/a.png'], pos, state.selection);
    expect(prepared.commit).not.toHaveBeenCalled();
    expect(prepared.release).toHaveBeenCalledOnce();
    expect(state.target!.insertImages).not.toHaveBeenCalled();
  });
});
