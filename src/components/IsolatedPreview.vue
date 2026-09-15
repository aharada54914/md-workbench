<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { buildIsolatedPreviewDocument, buildIsolatedSourceDocument } from '../utils/isolated-preview';
const props = defineProps<{ markdown: string }>();
// A large document must not create a complete Markdown DOM merely to open it.
const PAGE_CHARS = 64 * 1024;
const page = ref(0);
const isLarge = computed(() => props.markdown.length > 1_000_000);
const pageCount = computed(() => Math.ceil(props.markdown.length / PAGE_CHARS));
watch(() => props.markdown, () => { page.value = 0; });
const source = computed(() => {
  if (!isLarge.value) return buildIsolatedPreviewDocument(props.markdown);
  const boundary = (offset: number) => /[\uDC00-\uDFFF]/.test(props.markdown[offset] ?? '') ? offset + 1 : offset;
  const start = boundary(page.value * PAGE_CHARS);
  const end = boundary((page.value + 1) * PAGE_CHARS);
  return buildIsolatedSourceDocument(props.markdown.slice(start, end));
});
</script>

<template>
  <section class="isolated-preview">
    <p class="preview-policy">Isolated read-only preview · Network, scripts and file access blocked · Diagrams use source fallback</p>
    <nav v-if="isLarge" aria-label="Large document pages">
      <button type="button" :disabled="page === 0" @click="page--">Previous page</button>
      <span>Source page {{ page + 1 }} / {{ pageCount }}</span>
      <button type="button" :disabled="page + 1 >= pageCount" @click="page++">Next page</button>
    </nav>
    <!-- Empty sandbox deliberately omits allow-scripts and allow-same-origin.
         No bridge, message listener, Tauri API, or editor session is provided. -->
    <iframe title="Isolated document preview" sandbox="" allow="" referrerpolicy="no-referrer" :srcdoc="source" />
  </section>
</template>

<style scoped>
.isolated-preview { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; }
.preview-policy { margin:0; padding:8px 16px; font-size:12px; background:var(--bg-secondary,#eef2f6); }
iframe { flex:1; width:100%; border:0; background:white; }
</style>
