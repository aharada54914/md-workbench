<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Compartment, EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEditorZoom } from '../composables/useEditorZoom';
import { useSettings } from '../composables/useSettings';
import type { CodeEditorHandle } from '../types/code-editor';
import { applySourceEdits, sourceOffset, editorOffset, type SourceEdit } from '../utils/source-edits';

const props = defineProps<{ modelValue: string; readOnly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const { zoomScale } = useEditorZoom();
const { settings } = useSettings();
const hostRef = ref<HTMLDivElement | null>(null);
const wrapConfig = new Compartment();
const gutterConfig = new Compartment();
const editingConfig = new Compartment();
let view: EditorView | null = null;
let applyingExternalValue = false;
let lastSyncedValue = props.modelValue;
let highlightedLine: HTMLElement | null = null;
let highlightTimer: number | null = null;
let highlightAnimation: Animation | null = null;

const clearSelectionHighlight = () => {
  highlightAnimation?.cancel();
  highlightAnimation = null;
  highlightedLine?.classList.remove('code-cursor-highlight-line');
  highlightedLine = null;
  if (highlightTimer !== null) {
    window.clearTimeout(highlightTimer);
    highlightTimer = null;
  }
};

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--code-md-heading)', fontWeight: '600' },
  { tag: tags.list, color: 'var(--code-md-bullet)' },
  { tag: tags.strong, color: 'var(--code-md-strong)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--code-md-emphasis)', fontStyle: 'italic' },
  { tag: [tags.link, tags.url, tags.string], color: 'var(--code-md-link)' },
  { tag: [tags.monospace, tags.quote], color: 'var(--code-md-code)' },
  { tag: [tags.meta, tags.processingInstruction, tags.contentSeparator], color: 'var(--code-md-meta)' },
]);

const codeZoomStyle = computed(() => ({ zoom: zoomScale.value }));

const editor: CodeEditorHandle = {
  focus: () => view?.focus(),
  getValue: () => lastSyncedValue,
  getSelection: () => {
    const range = view?.state.selection.main;
    return range ? { start: sourceOffset(lastSyncedValue, range.from), end: sourceOffset(lastSyncedValue, range.to) } : { start: 0, end: 0 };
  },
  setSelection: (start, end = start) => {
    if (!view) return;
    const length = view.state.doc.length;
    const anchor = Math.max(0, Math.min(editorOffset(lastSyncedValue, start), length));
    const head = Math.max(0, Math.min(editorOffset(lastSyncedValue, end), length));
    view.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(head, { y: 'center' }),
    });
  },
  replaceSelection: (text) => {
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + view.state.toText(text).length },
      scrollIntoView: true,
    });
  },
  getScrollRatio: () => {
    if (!view) return 0;
    const maxScroll = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight;
    return maxScroll > 0 ? view.scrollDOM.scrollTop / maxScroll : 0;
  },
  scrollToRatio: (ratio) => {
    if (!view) return;
    const maxScroll = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight;
    view.scrollDOM.scrollTop = Math.max(0, Math.min(1, ratio)) * Math.max(0, maxScroll);
  },
  scrollToPosition: (position) => {
    if (!view) return;
    const pos = Math.max(0, Math.min(editorOffset(lastSyncedValue, position), view.state.doc.length));
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  },
  highlightSelectionLine: (durationMs = 1000) => {
    if (!view) return;
    clearSelectionHighlight();
    // CodeMirror may still be completing its scroll/layout measure after a
    // maximized window or viewport resize. Start the animation in its next
    // synchronized write phase so none of it is consumed off-screen.
    view.requestMeasure<HTMLElement | null>({
      read: (measuredView) => {
        const domAtCursor = measuredView.domAtPos(measuredView.state.selection.main.head).node;
        const cursorElement = domAtCursor instanceof Element ? domAtCursor : domAtCursor.parentElement;
        return cursorElement?.closest<HTMLElement>('.cm-line') ?? null;
      },
      write: (line) => {
        if (!line || !line.isConnected) return;
        line.classList.add('code-cursor-highlight-line');
        highlightedLine = line;
        // A fresh Animation object avoids Chromium reusing a CSS animation's
        // timeline after CodeMirror is mounted/unmounted several times.
        highlightAnimation = line.animate([
          {
            backgroundColor: 'rgba(56, 189, 248, 0.55)',
            boxShadow: '0 0 18px 6px rgba(56, 189, 248, 0.65), 0 0 30px 10px rgba(14, 165, 233, 0.35)',
          },
          {
            offset: 0.25,
            backgroundColor: 'rgba(56, 189, 248, 0.42)',
            boxShadow: '0 0 14px 4px rgba(56, 189, 248, 0.48), 0 0 24px 8px rgba(14, 165, 233, 0.26)',
          },
          {
            offset: 0.5,
            backgroundColor: 'rgba(56, 189, 248, 0.28)',
            boxShadow: '0 0 10px 3px rgba(56, 189, 248, 0.32), 0 0 18px 6px rgba(14, 165, 233, 0.18)',
          },
          {
            offset: 0.75,
            backgroundColor: 'rgba(56, 189, 248, 0.14)',
            boxShadow: '0 0 5px 1px rgba(56, 189, 248, 0.16), 0 0 9px 3px rgba(14, 165, 233, 0.09)',
          },
          { backgroundColor: 'transparent', boxShadow: '0 0 0 0 transparent' },
        ], { duration: durationMs, easing: 'linear', fill: 'forwards' });
        highlightAnimation.addEventListener('finish', clearSelectionHighlight, { once: true });
        // Fallback for environments that suppress animation events.
        highlightTimer = window.setTimeout(clearSelectionHighlight, durationMs + 250);
      },
      key: 'cursor-line-highlight',
    });
  },
};

defineExpose({ editor });

onMounted(() => {
  if (!hostRef.value) return;
  // Props can change after setup while an async parent finishes opening a file.
  // The preserved source and the visible document must start from the same value.
  lastSyncedValue = props.modelValue;
  view = new EditorView({
    parent: hostRef.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        editingConfig.of([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
        EditorState.transactionFilter.of(transaction =>
          props.readOnly && transaction.docChanged && !applyingExternalValue ? [] : transaction),
        history(),
        markdown(),
        syntaxHighlighting(markdownHighlightStyle),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        wrapConfig.of(settings.value.codeWordWrap ? EditorView.lineWrapping : []),
        gutterConfig.of(settings.value.showLineNumbers ? lineNumbers() : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternalValue) {
            const edits: SourceEdit[] = [];
            update.changes.iterChanges((from, to, _fromB, _toB, inserted) => edits.push({ from, to, insert: inserted.toString() }));
            lastSyncedValue = applySourceEdits(lastSyncedValue, edits);
            emit('update:modelValue', lastSyncedValue);
          }
        }),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'var(--code-editor-bg)', color: 'var(--code-editor-text)' },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily: 'var(--code-font-family, "Fira Code", "Consolas", "Monaco", monospace)',
            fontSize: 'var(--code-font-size, 14px)',
            lineHeight: '1.6',
          },
          '.cm-content': { minHeight: '100%', padding: '24px 0', caretColor: 'var(--code-editor-text)' },
          '.cm-line': { padding: '0 24px' },
          '.cm-gutters': {
            backgroundColor: 'var(--code-editor-bg)',
            color: 'var(--code-editor-gutter-text, var(--text-secondary, #888))',
            border: 'none',
            borderRadius: '8px 0 0 8px',
            minWidth: '3em',
            opacity: '0.6',
            fontFamily: 'var(--code-font-family, "Fira Code", "Consolas", "Monaco", monospace)',
            fontSize: 'var(--code-font-size, 14px)',
          },
          '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.5em 0 0.75em', minWidth: '3em' },
          '&.cm-focused': { outline: 'none', boxShadow: '0 0 0 2px var(--focus-ring-alpha)' },
        }),
      ],
    }),
  });
});

watch(() => props.modelValue, (value) => {
  if (!view) {
    lastSyncedValue = value;
    return;
  }
  if (value === lastSyncedValue) return;
  applyingExternalValue = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  lastSyncedValue = value;
  applyingExternalValue = false;
});

watch(() => props.readOnly, (readOnly) => {
  view?.dispatch({ effects: editingConfig.reconfigure([
    EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly),
  ]) });
});

watch(() => settings.value.codeWordWrap, (enabled) => {
  view?.dispatch({ effects: wrapConfig.reconfigure(enabled ? EditorView.lineWrapping : []) });
});

watch(() => settings.value.showLineNumbers, (enabled) => {
  view?.dispatch({ effects: gutterConfig.reconfigure(enabled ? lineNumbers() : []) });
});

onBeforeUnmount(() => {
  clearSelectionHighlight();
  view?.destroy();
  view = null;
});
</script>

<template>
  <div class="code-editor-container">
    <div
      ref="hostRef"
      class="code-editor"
      :style="codeZoomStyle"
      :data-document-length="modelValue.length"
    ></div>
  </div>
</template>

<style scoped>
.code-editor-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--code-editor-container-bg);
  padding: 20px;
}

.code-editor {
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 8px;
  font-size: var(--code-font-size, 14px);
}

.code-editor :deep(.cm-editor) { border-radius: 8px; }
.code-editor :deep(.cm-scroller) { tab-size: var(--code-tab-size, 2); }
.code-editor :deep(.code-cursor-highlight-line) {
  border-radius: 3px;
  position: relative;
}

@media print {
  .code-editor-container { display: none !important; }
}
</style>
