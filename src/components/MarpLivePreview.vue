<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount } from 'vue';
import { renderDeck, buildStandaloneHtml } from '../composables/useMarpExport';

const props = defineProps<{ markdown: string }>();
const emit = defineEmits<{ 'scroll-ready': []; 'scroll-reset': [] }>();
const scrollEl = shallowRef<HTMLElement | null>(null);
const frame = ref<HTMLIFrameElement | null>(null);
const srcdoc = computed(() => {
  try {
    const deck = renderDeck(props.markdown || '');
    return buildStandaloneHtml({
      html: `<div class="marp-scroll" style="height:100vh!important;overflow-y:auto!important"><div class="deck">${deck.html}</div></div>`,
      css: `${deck.css}
        html,body { margin:0; padding:0; }
        * { box-sizing:border-box; }
        .deck { padding:16px; display:flex; flex-direction:column; gap:16px; align-items:center; }
        .deck svg[data-marpit-svg], .deck > svg { width:100%; height:auto; max-width:960px;
          box-shadow:0 2px 12px rgba(0,0,0,.25); border-radius:6px; }`,
    });
  } catch {
    return buildStandaloneHtml({ html: '<p>Unable to render slides.</p>', css: '' });
  }
});
function resetScroll() { scrollEl.value = null; emit('scroll-reset'); }
watch(srcdoc, resetScroll, { flush: 'sync' });
function onFrameLoad() {
  scrollEl.value = frame.value?.contentDocument?.querySelector<HTMLElement>('.marp-scroll') ?? null;
  emit('scroll-ready');
}
onBeforeUnmount(resetScroll);
// Bind directly to the real scroll container so iframe wheel/touch intent and
// long decks participate in the same bidirectional synchronization as the editor.
defineExpose({ scrollEl });
</script>

<template>
  <div class="marp-live">
    <iframe :key="srcdoc" ref="frame" class="marp-live-frame" title="Slide preview"
      :srcdoc="srcdoc" sandbox="allow-same-origin"
      @load="onFrameLoad"></iframe>
  </div>
</template>

<style scoped>
.marp-live { height:100%; overflow:hidden; background:var(--bg-secondary, #15151c); }
.marp-live-frame { display:block; width:100%; height:100%; border:0; }
</style>
