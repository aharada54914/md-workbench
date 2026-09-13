<script setup lang="ts">
import { computed } from 'vue';
import { buildIsolatedPreviewDocument } from '../utils/isolated-preview';
const props = defineProps<{ markdown: string }>();
const source = computed(() => buildIsolatedPreviewDocument(props.markdown));
</script>

<template>
  <section class="isolated-preview">
    <p class="preview-policy">Isolated read-only preview · Network, scripts and file access blocked · Diagrams use source fallback</p>
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
