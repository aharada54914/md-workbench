import { nextTick, onBeforeUnmount, watch } from 'vue';
import { documentImageBytes } from '../services/documentImageBytes';
import { inlineMarkdownImages, type InlinedMarkdown, type MarkdownImageContext } from '../utils/image-resolver';

/** Latest render wins, including context leave/return before a read completes.
 * clear removes the previous output ref; its payload lease survives Vue's DOM
 * update, so mounted previews and replacement requests share the window bound. */
export function useMarkdownImageInlining(context: () => readonly unknown[], clear: () => void) {
  let generation = 0;
  let disposed = false;
  let held: InlinedMarkdown | undefined;
  const retire = (result: InlinedMarkdown | undefined) => { void nextTick().then(() => result?.release()); };
  const invalidate = () => {
    generation += 1;
    const previous = held;
    held = undefined;
    try { clear(); } finally { retire(previous); }
  };
  watch(context, invalidate, { flush: 'sync' });
  onBeforeUnmount(() => { disposed = true; invalidate(); });
  async function render(markdown: string, imageContext: MarkdownImageContext, apply: (result: string) => void): Promise<void> {
    if (disposed) return;
    invalidate();
    const started = generation;
    const { owner, path, revision } = imageContext;
    const isCurrent = () => !disposed && started === generation && !!owner && documentImageBytes.isCurrent(owner)
      && imageContext.owner === owner && imageContext.path === path && imageContext.revision === revision;
    const result = await inlineMarkdownImages(markdown, imageContext, isCurrent);
    if (!result) return;
    if (!isCurrent()) { result.release(); return; }
    held = result;
    try { apply(result.markdown); } catch (error) { invalidate(); throw error; }
  }
  return { render };
}
