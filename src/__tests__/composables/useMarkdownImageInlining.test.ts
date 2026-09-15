import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { useMarkdownImageInlining } from '../../composables/useMarkdownImageInlining';
import { documentImageBytes } from '../../services/documentImageBytes';
const { read, resolve } = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn() }));
vi.mock('../../services/nativeFs', () => ({ nativeFs: { readDocumentImageBytes: read, resolveDocumentReadGrant: resolve } }));
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function deferred() {
  let resolve!: (value: Uint8Array) => void;
  const promise = new Promise<Uint8Array>(res => { resolve = res; });
  return { promise, resolve };
}
function setup() {
  const document = ref({ id: 'one', path: '/same.md' });
  const owner = documentImageBytes.createOwner(); const revision = ref(0);
  const source = ref('![a](images/one.png)'); const visible = ref(true); const output = ref('');
  const clear = vi.fn(() => { output.value = ''; });
  let images!: ReturnType<typeof useMarkdownImageInlining>;
  const wrapper = mount(defineComponent({ setup() {
    images = useMarkdownImageInlining(() => [document.value, document.value.id, document.value.path, source.value, visible.value, revision.value], clear);
    return () => h('div', output.value);
  } }));
  const context = () => ({ owner, path: document.value.path, revision: revision.value });
  return { wrapper, images, document, source, visible, context, revision, output, clear };
}
beforeEach(() => { vi.clearAllMocks(); resolve.mockResolvedValue({ grantId: 'current' }); });
afterEach(async () => { documentImageBytes.disposeAll(); await flushPromises(); });
describe('Marp native image render ownership', () => {
  it('an older request cannot overwrite the latest render of the same document', async () => {
    const first = deferred(); const second = deferred();
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const state = setup(); const apply = vi.fn();
    const old = state.images.render('![a](images/one.png)', state.context(), apply); await flushPromises();
    const latest = state.images.render('![b](images/two.png)', state.context(), apply); await flushPromises();
    second.resolve(new Uint8Array([...png, 2])); await latest;
    first.resolve(png); await old;
    expect(apply).toHaveBeenCalledOnce(); expect(apply.mock.calls[0][0]).toContain('iVBORw0KGgoC');
    state.wrapper.unmount();
  });
  it.each(['document', 'same-id-object', 'source', 'hide', 'unmount', 'leave-return', 'authority'] as const)(
    '%s invalidates a pending native read before display commits', async action => {
      const pending = deferred(); read.mockReturnValue(pending.promise);
      const state = setup(); const apply = vi.fn();
      const work = state.images.render(state.source.value, state.context(), apply); await flushPromises();
      expect(read).toHaveBeenCalledOnce();
      if (action === 'document') state.document.value = { id: 'two', path: '/same.md' };
      if (action === 'same-id-object') state.document.value = { id: 'one', path: '/same.md' };
      if (action === 'source') state.source.value = 'new markdown';
      if (action === 'hide') state.visible.value = false;
      if (action === 'authority') state.revision.value += 1;
      if (action === 'unmount') state.wrapper.unmount();
      if (action === 'leave-return') { state.visible.value = false; state.visible.value = true; }
      pending.resolve(png); await work;
      expect(apply).not.toHaveBeenCalled(); state.wrapper.unmount();
    });
  it('clears already published output when authority changes and never reads after unmount', async () => {
    read.mockResolvedValue(png);
    const state = setup();
    await state.images.render(state.source.value, state.context(), result => { state.output.value = result; });
    await flushPromises(); expect(state.wrapper.text()).toContain('data:image/png;');
    state.revision.value += 1;
    expect(state.output.value).toBe(''); await flushPromises(); expect(state.wrapper.text()).toBe('');
    state.wrapper.unmount(); await state.images.render(state.source.value, state.context(), vi.fn());
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('keeps original source on native read failure with no fallback', async () => {
    const state = setup(); const apply = vi.fn(); read.mockRejectedValue({ code: 'permission_required' });
    await state.images.render(state.source.value, state.context(), apply);
    expect(apply).toHaveBeenCalledWith(state.source.value); expect(read).toHaveBeenCalledTimes(1);
    state.wrapper.unmount();
  });
});

it('does not publish a completed synchronous render after its owner is disposed', async () => {
  const state = setup(); const apply = vi.fn(); const context = state.context();
  const work = state.images.render('no image', context, apply);
  documentImageBytes.dispose(context.owner);
  await work; expect(apply).not.toHaveBeenCalled(); state.wrapper.unmount();
});
it('releases output leases when an apply callback throws', async () => {
  read.mockResolvedValue(png);
  const state = setup();
  for (let i = 0; i < 3; i++) {
    await expect(state.images.render('![a](images/a.png) '.repeat(128), state.context(), () => { throw new Error('consumer failed'); })).rejects.toThrow('consumer failed');
    await flushPromises();
  }
  expect(read).toHaveBeenCalledTimes(3); state.wrapper.unmount();
});
