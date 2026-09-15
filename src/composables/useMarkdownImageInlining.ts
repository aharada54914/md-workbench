import { onBeforeUnmount, watch } from 'vue';
import { inlineMarkdownImages } from '../utils/image-resolver';

/** Latest render wins, including context leave/return before an older read completes. */
export function useMarkdownImageInlining(context: () => readonly unknown[]) {
  let generation = 0;
  let disposed = false;
  watch(context, () => { generation += 1; }, { flush: 'sync' });
  onBeforeUnmount(() => { disposed = true; generation += 1; });
  async function render(markdown: string, baseDir: string | undefined, apply: (result: string) => void): Promise<void> {
    if (disposed) return;
    const started = ++generation;
    const isCurrent = () => !disposed && started === generation;
    const result = await inlineMarkdownImages(markdown, baseDir, isCurrent);
    if (isCurrent()) apply(result);
  }
  return { render };
}
