import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

beforeAll(() => {
  Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList);
  Range.prototype.getBoundingClientRect = vi.fn(() => new DOMRect());
});

import CodeEditor from '../../components/CodeEditor.vue';
import type { CodeEditorHandle } from '../../types/code-editor';

vi.mock('../../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({
      codeWordWrap: false,
      showLineNumbers: true,
      codeFontFamily: 'monospace',
    }),
  }),
}));

vi.mock('../../composables/useEditorZoom', () => ({
  useEditorZoom: () => ({ zoomScale: ref(1) }),
}));

describe('CodeEditor virtualization (issue #129)', () => {
  it('highlights the current DOM line after a redraw between measure read and write', () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'original' }, attachTo: document.body });
    const view = EditorView.findFromDOM(wrapper.element)!;
    const handle = (wrapper.vm as unknown as { editor: CodeEditorHandle }).editor;
    let request: Parameters<EditorView['requestMeasure']>[0];
    const measure = vi.spyOn(view, 'requestMeasure').mockImplementation((value) => {
      if (value?.key === 'cursor-line-highlight') request = value;
    });
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel, addEventListener: vi.fn() }));
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    try {
      handle.highlightSelectionLine();
      const readResult = request!.read(view);
      const oldLine = wrapper.get('.cm-line').element;
      // CodeMirror updates docView between measure.read and measure.write.
      // Resetting the actual view here deterministically replaces its line DOM.
      view.setState(EditorState.create({ doc: 'redrawn' }));
      expect(oldLine.isConnected).toBe(false);
      request!.write!(readResult, view);
      expect(wrapper.get('.cm-line').classes()).toContain('code-cursor-highlight-line');
      expect(animate).toHaveBeenCalledOnce();
    } finally {
      wrapper.unmount();
      measure.mockRestore();
      Element.prototype.animate = originalAnimate;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('exposes the complete editable document through the editor handle', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'a\nb\nc' } });
    await nextTick();

    const handle = (wrapper.vm as unknown as { editor: { getValue: () => string } }).editor;
    expect(handle.getValue()).toBe('a\nb\nc');
    expect(wrapper.find('.cm-gutters').exists()).toBe(true);
  });

  it('does not create one DOM line per line of a 3 MB document', async () => {
    const line = '# Large file line with enough text to exercise viewport rendering\n';
    const big = line.repeat(Math.ceil((3 * 1024 * 1024) / line.length));
    const wrapper = mount(CodeEditor, { props: { modelValue: big } });
    await nextTick();

    const renderedLines = wrapper.findAll('.cm-line').length;
    expect(renderedLines).toBeGreaterThan(0);
    expect(renderedLines).toBeLessThan(100);
    const handle = (wrapper.vm as unknown as { editor: { getValue: () => string } }).editor;
    expect(handle.getValue().length).toBe(big.length);
  });

  it('highlights Markdown syntax inside the virtualized viewport', async () => {
    const wrapper = mount(CodeEditor, {
      props: { modelValue: '# Heading\n\n- **Bold** and [link](https://example.com)\n\n`code`' },
    });
    await nextTick();

    expect(wrapper.find('.cm-line span').exists()).toBe(true);
    expect(wrapper.find('.cm-content').text()).toContain('Heading');
  });

  it('synchronizes source arriving between setup and mounting before the first edit', async () => {
    const raw = '\uFEFF# Loaded\r\n\r\nbody\r\n';
    const wrapper = mount(CodeEditor, { props: {
      modelValue: '',
      onVnodeBeforeMount: (vnode: any) => { vnode.component.props.modelValue = raw; },
    } });
    await nextTick();
    const handle = (wrapper.vm as unknown as { editor: CodeEditorHandle }).editor;
    expect(handle.getValue()).toBe(raw);
    handle.setSelection(raw.length);
    handle.replaceSelection('appended');
    expect(handle.getValue()).toBe(raw + 'appended');
    expect(wrapper.emitted('update:modelValue')?.slice(-1)[0]).toEqual([raw + 'appended']);
    wrapper.unmount();
  });

  it('preserves CRLF when replacing the whole document with multiline editor input', async () => {
    const raw = '\uFEFF# Original\r\n\r\nbody\r\n';
    const replacement = '\uFEFF# Changed\n\nline one\nline two\n';
    const wrapper = mount(CodeEditor, { props: { modelValue: raw } });
    const handle = (wrapper.vm as unknown as { editor: CodeEditorHandle }).editor;
    handle.setSelection(0, raw.length);
    handle.replaceSelection(replacement);
    expect(handle.getValue()).toBe(replacement.replace(/\n/g, '\r\n'));
    wrapper.unmount();
  });

  it('rejects programmatic edits while reading and accepts external source updates', async () => {
    const wrapper = mount(CodeEditor, { props: { modelValue: 'original' } });
    const handle = (wrapper.vm as unknown as { editor: CodeEditorHandle }).editor;
    handle.setSelection(8);
    await wrapper.setProps({ readOnly: true });
    handle.replaceSelection(' blocked');
    expect(handle.getValue()).toBe('original');
    await wrapper.setProps({ modelValue: 'external\r\n' });
    expect(handle.getValue()).toBe('external\r\n');
    await wrapper.setProps({ readOnly: false });
    handle.setSelection(handle.getValue().length);
    handle.replaceSelection('allowed');
    expect(handle.getValue()).toBe('external\r\nallowed');
    wrapper.unmount();
  });

});
