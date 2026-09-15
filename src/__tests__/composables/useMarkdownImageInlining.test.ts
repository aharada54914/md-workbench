import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useMarkdownImageInlining } from '../../composables/useMarkdownImageInlining';
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile }));
function deferred() {
  let resolve!: (value: Uint8Array) => void;
  const promise = new Promise<Uint8Array>(res => { resolve = res; });
  return { promise, resolve };
}
function setup() {
  const document = ref({ id: 'one', path: '/same.md' });
  const source = ref('![a](/one.png)'); const visible = ref(true);
  let images!: ReturnType<typeof useMarkdownImageInlining>;
  const wrapper = mount(defineComponent({ setup() {
    images = useMarkdownImageInlining(() => [document.value, document.value.id, document.value.path, source.value, visible.value]);
    return () => h('div');
  } }));
  return { wrapper, images, document, source, visible };
}
beforeEach(() => { readFile.mockReset(); });
describe('Marp image render ownership', () => {
  it('an older request cannot overwrite the latest render of the same document', async () => {
    const first = deferred(); const second = deferred();
    readFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { images, wrapper } = setup(); const apply = vi.fn();
    const old = images.render('![a](/one.png)', undefined, apply);
    const latest = images.render('![b](/two.png)', undefined, apply);
    second.resolve(new Uint8Array([2])); await latest;
    first.resolve(new Uint8Array([1])); await old;
    expect(apply).toHaveBeenCalledOnce(); expect(apply.mock.calls[0][0]).toContain('Ag==');
    wrapper.unmount();
  });
  it.each(['document', 'same-id-object', 'source', 'hide', 'unmount', 'leave-return'] as const)(
    '%s invalidates pending renders before display commits', async action => {
      const read = deferred(); readFile.mockReturnValue(read.promise);
      const state = setup(); const apply = vi.fn();
      const work = state.images.render(state.source.value, undefined, apply);
      if (action === 'document') state.document.value = { id: 'two', path: '/same.md' };
      if (action === 'same-id-object') state.document.value = { id: 'one', path: '/same.md' };
      if (action === 'source') state.source.value = 'new markdown';
      if (action === 'hide') state.visible.value = false;
      if (action === 'unmount') state.wrapper.unmount();
      if (action === 'leave-return') { state.visible.value = false; state.visible.value = true; }
      read.resolve(new Uint8Array([1])); await work;
      expect(apply).not.toHaveBeenCalled(); state.wrapper.unmount();
    },
  );
  it('does not start reads after disposal and keeps original markdown when reading fails', async () => {
    const { images, wrapper } = setup(); const apply = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFile.mockRejectedValue(new Error('unavailable'));
    await images.render('![a](/missing.png)', undefined, apply);
    expect(apply).toHaveBeenCalledWith('![a](/missing.png)');
    wrapper.unmount(); await images.render('![b](/after.png)', undefined, apply);
    expect(readFile).toHaveBeenCalledTimes(1); warn.mockRestore();
  });
});
