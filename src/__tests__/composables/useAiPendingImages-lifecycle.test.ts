import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { useAiPendingImages } from '../../composables/useAiPendingImages';

const { open, readFile } = vi.hoisted(() => ({ open: vi.fn(), readFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile }));
vi.mock('../../services/aiCommands', () => ({ aiCommands: { imageSave: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const create = vi.fn(() => 'blob:pending');
const revoke = vi.fn();
function setup() {
  const documentPath = ref('/one.md');
  const documentId = ref('document-1');
  const thread = ref<object | null>({ id: 'one' });
  const isOpen = ref(true);
  let api!: ReturnType<typeof useAiPendingImages>;
  const wrapper = mount(defineComponent({
    setup() {
      api = useAiPendingImages(() => [documentId.value, documentPath.value, thread.value, isOpen.value]);
      return () => h('div');
    },
  }));
  return { api, wrapper, documentPath, documentId, thread, isOpen };
}
function paste(api: ReturnType<typeof useAiPendingImages>) {
  api.addPendingImage(new Blob(['image'], { type: 'image/png' }), 'clipboard.png');
}

beforeEach(() => {
  open.mockReset(); readFile.mockReset(); create.mockClear(); revoke.mockClear();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe('pending image async ownership', () => {
  it.each(['clear', 'remove', 'unmount', 'document', 'thread', 'close'] as const)(
    '%s invalidates an outstanding picker before file reads', async action => {
      const state = setup();
      paste(state.api);
      const selection = deferred<string[]>();
      open.mockReturnValue(selection.promise);
      const work = state.api.pickImageFile();
      await flushPromises();
      expect(open).toHaveBeenCalledOnce();
      if (action === 'clear') state.api.clearPendingImages();
      if (action === 'remove') state.api.removePendingImage(state.api.pendingImages.value[0].id);
      if (action === 'unmount') state.wrapper.unmount();
      if (action === 'document') state.documentPath.value = '/two.md';
      if (action === 'thread') state.thread.value = { id: 'two' };
      if (action === 'close') state.isOpen.value = false;
      selection.resolve(['/late.png']);
      await work;
      expect(readFile).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      state.wrapper.unmount();
    },
  );

  it('clear during a read suppresses its result and remaining reads', async () => {
    const { api, wrapper } = setup();
    const read = deferred<Uint8Array>();
    open.mockResolvedValue(['/first.png', '/second.png']);
    readFile.mockReturnValueOnce(read.promise);
    const work = api.pickImageFile();
    await flushPromises();
    expect(readFile).toHaveBeenCalledWith('/first.png');
    api.clearPendingImages();
    read.resolve(new Uint8Array([1]));
    await work;
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(api.pendingImages.value).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('same-tick context leave and return cannot revive an old read', async () => {
    const { api, wrapper, documentPath } = setup();
    const read = deferred<Uint8Array>();
    open.mockResolvedValue(['/late.png']); readFile.mockReturnValue(read.promise);
    const work = api.pickImageFile(); await flushPromises();
    documentPath.value = '/two.md'; documentPath.value = '/one.md';
    read.resolve(new Uint8Array([1])); await work;
    expect(api.pendingImages.value).toEqual([]);
    expect(create).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it.each(['remove', 'unmount', 'document', 'thread', 'close'] as const)(
    '%s during a read suppresses late blobs and remaining reads', async action => {
      const state = setup(); paste(state.api);
      const read = deferred<Uint8Array>();
      open.mockResolvedValue(['/first.png', '/second.png']);
      readFile.mockReturnValueOnce(read.promise);
      const work = state.api.pickImageFile(); await flushPromises();
      if (action === 'remove') state.api.removePendingImage(state.api.pendingImages.value[0].id);
      if (action === 'unmount') state.wrapper.unmount();
      if (action === 'document') state.documentPath.value = '/two.md';
      if (action === 'thread') state.thread.value = { id: 'two' };
      if (action === 'close') state.isOpen.value = false;
      read.resolve(new Uint8Array([1])); await work;
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      state.wrapper.unmount();
    },
  );

  it('a stale failed read stops the batch while a new selection remains usable', async () => {
    const { api, wrapper } = setup();
    const read = deferred<Uint8Array>();
    open.mockResolvedValueOnce(['/first.png', '/second.png']);
    readFile.mockReturnValueOnce(read.promise);
    const work = api.pickImageFile(); await flushPromises();
    api.clearPendingImages(); read.reject(new Error('late failure')); await work;
    expect(readFile).toHaveBeenCalledTimes(1);
    open.mockResolvedValueOnce(['/new.png']); await api.pickImageFile();
    expect(api.pendingImages.value.map(p => p.name)).toEqual(['new.png']);
    wrapper.unmount();
  });

  it('unmount prevents subsequent direct additions and dialog opening', async () => {
    const { api, wrapper } = setup(); wrapper.unmount();
    paste(api); await api.pickImageFile();
    expect(create).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });

  it('context replacement with the same thread ID invalidates reads', async () => {
    const { api, wrapper, thread } = setup();
    const read = deferred<Uint8Array>();
    open.mockResolvedValue(['/late.png']); readFile.mockReturnValue(read.promise);
    const work = api.pickImageFile(); await flushPromises();
    thread.value = { id: 'one' };
    read.resolve(new Uint8Array([1])); await work;
    expect(api.pendingImages.value).toEqual([]); wrapper.unmount();
  });

  it.each(['/one.md', ''])('switching document ID with unchanged path %j rejects late reads', async path => {
    const { api, wrapper, documentPath, documentId } = setup();
    documentPath.value = path; paste(api);
    const read = deferred<Uint8Array>();
    open.mockResolvedValue(['/late.png']); readFile.mockReturnValue(read.promise);
    const work = api.pickImageFile(); await flushPromises();
    documentId.value = 'document-2';
    read.resolve(new Uint8Array([1])); await work;
    expect(api.pendingImages.value.map(p => p.name)).toEqual(['clipboard.png']);
    expect(create).toHaveBeenCalledTimes(1); wrapper.unmount();
  });

  it('clear before module imports finish prevents opening the dialog', async () => {
    const { api, wrapper } = setup();
    const work = api.pickImageFile(); api.clearPendingImages();
    await work; expect(open).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it('preserves multiple selection, cancellation, and existing clipboard images', async () => {
    const { api, wrapper } = setup(); paste(api);
    open.mockResolvedValueOnce(null);
    await api.pickImageFile();
    expect(api.pendingImages.value.map(p => p.name)).toEqual(['clipboard.png']);
    open.mockResolvedValueOnce(['/first.jpg', '/second.png']);
    await api.pickImageFile();
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ multiple: true }));
    expect(api.pendingImages.value.map(p => p.name)).toEqual(['clipboard.png', 'first.jpg', 'second.png']);
    wrapper.unmount();
  });

  it('removal closes only that image preview and revokes its URL', () => {
    const { api, wrapper } = setup(); paste(api); paste(api);
    api.previewedImage.value = api.pendingImages.value[0];
    api.removePendingImage(api.pendingImages.value[1].id);
    expect(api.previewedImage.value).not.toBeNull();
    api.removePendingImage(api.pendingImages.value[0].id);
    expect(api.previewedImage.value).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(2); wrapper.unmount();
  });

  it('clear closes the preview and unmount does not revoke twice', () => {
    const { api, wrapper } = setup(); paste(api);
    api.previewedImage.value = api.pendingImages.value[0]; api.clearPendingImages();
    expect(api.previewedImage.value).toBeNull(); wrapper.unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('detach transfers URLs without revocation and cancels older picker work', async () => {
    const { api, wrapper } = setup(); paste(api);
    api.previewedImage.value = api.pendingImages.value[0];
    const selection = deferred<string[]>(); open.mockReturnValue(selection.promise);
    const work = api.pickImageFile(); await flushPromises();
    expect(api.detachForChat()).toEqual([{ name: 'clipboard.png', blobUrl: 'blob:pending' }]);
    expect(api.previewedImage.value).toBeNull();
    selection.resolve(['/late.png']); await work;
    expect(readFile).not.toHaveBeenCalled(); wrapper.unmount();
    expect(revoke).not.toHaveBeenCalled();
  });
});
