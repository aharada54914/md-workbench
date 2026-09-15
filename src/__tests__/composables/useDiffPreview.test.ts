import { describe, it, expect } from 'vitest';
import { computed, ref } from 'vue';
import { useDiffPreview, generateDiff, splitIntoHunks, applyHunkSelections } from '../../composables/useDiffPreview';

describe('useDiffPreview', () => {
  const createOptions = (opts: {
    originalMarkdown?: string | null;
    currentMarkdown?: string;
    hasChanges?: boolean;
  } = {}) => {
    const originalMd = ref<string | null>(opts.originalMarkdown ?? null);
    const changes = ref(opts.hasChanges ?? false);
    const currentMd = opts.currentMarkdown ?? '';

    return {
      originalMarkdown: computed(() => originalMd.value),
      getCurrentMarkdown: () => currentMd,
      hasChanges: computed(() => changes.value),
      _originalMd: originalMd,
      _changes: changes,
    };
  };

  describe('canShowDiff', () => {
    it('returns false when originalMarkdown is null', () => {
      const opts = createOptions({ originalMarkdown: null, hasChanges: true });
      const { canShowDiff } = useDiffPreview(opts);
      expect(canShowDiff.value).toBe(false);
    });

    it('returns false when hasChanges is false', () => {
      const opts = createOptions({ originalMarkdown: 'hello', hasChanges: false });
      const { canShowDiff } = useDiffPreview(opts);
      expect(canShowDiff.value).toBe(false);
    });

    it('returns true when hasChanges and originalMarkdown exist', () => {
      const opts = createOptions({ originalMarkdown: 'hello', hasChanges: true });
      const { canShowDiff } = useDiffPreview(opts);
      expect(canShowDiff.value).toBe(true);
    });

    it('reacts to changes in hasChanges', () => {
      const opts = createOptions({ originalMarkdown: 'hello', hasChanges: false });
      const { canShowDiff } = useDiffPreview(opts);
      expect(canShowDiff.value).toBe(false);

      opts._changes.value = true;
      expect(canShowDiff.value).toBe(true);
    });
  });

  describe('openDiffPreview', () => {
    it('computes diff lines for simple change', () => {
      const opts = createOptions({
        originalMarkdown: 'line1\nline2\nline3\n',
        currentMarkdown: 'line1\nmodified\nline3\n',
        hasChanges: true,
      });
      const { openDiffPreview, diffPreviewLines, diffStats } = useDiffPreview(opts);

      openDiffPreview();

      expect(diffPreviewLines.value.length).toBeGreaterThan(0);
      expect(diffStats.value.additions).toBeGreaterThan(0);
      expect(diffStats.value.deletions).toBeGreaterThan(0);

      // Should have 'line2' removed and 'modified' added
      const removed = diffPreviewLines.value.filter(l => l.type === 'removed');
      const added = diffPreviewLines.value.filter(l => l.type === 'added');
      expect(removed.some(l => l.content === 'line2')).toBe(true);
      expect(added.some(l => l.content === 'modified')).toBe(true);
    });

    it('shows all unchanged for identical content', () => {
      const content = 'hello\nworld\n';
      const opts = createOptions({
        originalMarkdown: content,
        currentMarkdown: content,
        hasChanges: true,
      });
      const { openDiffPreview, diffPreviewLines, diffStats } = useDiffPreview(opts);

      openDiffPreview();

      expect(diffStats.value.additions).toBe(0);
      expect(diffStats.value.deletions).toBe(0);
      expect(diffPreviewLines.value.every(l => l.type === 'unchanged')).toBe(true);
    });

    it('handles empty original (new file content)', () => {
      const opts = createOptions({
        originalMarkdown: '',
        currentMarkdown: 'new content\n',
        hasChanges: true,
      });
      const { openDiffPreview, diffPreviewLines, diffStats } = useDiffPreview(opts);

      openDiffPreview();

      expect(diffStats.value.additions).toBeGreaterThan(0);
      expect(diffStats.value.deletions).toBe(0);
      expect(diffPreviewLines.value.every(l => l.type === 'added')).toBe(true);
    });

    it('assigns correct line numbers', () => {
      const opts = createOptions({
        originalMarkdown: 'a\nb\nc\n',
        currentMarkdown: 'a\nx\nc\n',
        hasChanges: true,
      });
      const { openDiffPreview, diffPreviewLines } = useDiffPreview(opts);

      openDiffPreview();

      // First line unchanged — has both line numbers
      const firstUnchanged = diffPreviewLines.value.find(l => l.content === 'a');
      expect(firstUnchanged?.oldLineNumber).toBe(1);
      expect(firstUnchanged?.newLineNumber).toBe(1);

      // Removed line — has only old line number
      const removedLine = diffPreviewLines.value.find(l => l.type === 'removed');
      expect(removedLine?.oldLineNumber).toBeGreaterThan(0);
      expect(removedLine?.newLineNumber).toBeNull();

      // Added line — has only new line number
      const addedLine = diffPreviewLines.value.find(l => l.type === 'added');
      expect(addedLine?.oldLineNumber).toBeNull();
      expect(addedLine?.newLineNumber).toBeGreaterThan(0);
    });

    it('makes line ending changes selectable without changing display text', () => {
      const opts = createOptions({
        originalMarkdown: 'line1\r\nline2\r\n',
        currentMarkdown: 'line1\nline2\n',
        hasChanges: true,
      });
      const { openDiffPreview, diffPreviewLines, diffStats } = useDiffPreview(opts);

      openDiffPreview();

      expect(diffStats.value).toEqual({ additions: 2, deletions: 2 });
      expect(diffPreviewLines.value.map(l => l.content)).toEqual(['line1', 'line2', 'line1', 'line2']);
    });

    it('sets showDiffPreview to true', () => {
      const opts = createOptions({
        originalMarkdown: 'hello',
        currentMarkdown: 'world',
        hasChanges: true,
      });
      const { openDiffPreview, showDiffPreview } = useDiffPreview(opts);

      expect(showDiffPreview.value).toBe(false);
      openDiffPreview();
      expect(showDiffPreview.value).toBe(true);
    });
  });

  describe('closeDiffPreview', () => {
    it('resets all state', () => {
      const opts = createOptions({
        originalMarkdown: 'hello',
        currentMarkdown: 'world',
        hasChanges: true,
      });
      const { openDiffPreview, closeDiffPreview, showDiffPreview, diffPreviewLines, diffStats } = useDiffPreview(opts);

      openDiffPreview();
      expect(showDiffPreview.value).toBe(true);
      expect(diffPreviewLines.value.length).toBeGreaterThan(0);

      closeDiffPreview();
      expect(showDiffPreview.value).toBe(false);
      expect(diffPreviewLines.value).toEqual([]);
      expect(diffStats.value).toEqual({ additions: 0, deletions: 0 });
    });
  });

  describe('generateDiff', () => {
    it('reports trailing whitespace differences so a merge can preserve either source', () => {
      const original = 'line one\nline two\nline three';
      const current = 'line one   \nline two\t\nline three  ';
      const { lines, stats } = generateDiff(original, current);
      expect(stats).toEqual({ additions: 3, deletions: 3 });
      expect(lines.filter(l => l.type === 'added').map(l => l.raw).join('')).toBe(current);
    });

    it('only marks the actually-edited line when one line changes mid-file', () => {
      const original = 'a\nb\nc\nd\ne';
      const current = 'a\nb\nc CHANGED\nd\ne';
      const { stats } = generateDiff(original, current);
      expect(stats.additions).toBe(1);
      expect(stats.deletions).toBe(1);
    });

    it('attaches word-level segments to paired removed/added lines', () => {
      const { lines } = generateDiff('the quick brown fox', 'the slow brown fox');
      const removed = lines.find((l) => l.type === 'removed');
      const added = lines.find((l) => l.type === 'added');
      expect(removed?.segments?.some((s) => s.highlight && s.value.includes('quick'))).toBe(true);
      expect(added?.segments?.some((s) => s.highlight && s.value.includes('slow'))).toBe(true);
      // Shared words stay un-highlighted.
      expect(removed?.segments?.some((s) => !s.highlight && s.value.includes('brown'))).toBe(true);
    });

    it('counts a genuine added line', () => {
      const { stats } = generateDiff('a\nb', 'a\nNEW\nb');
      expect(stats.additions).toBe(1);
      expect(stats.deletions).toBe(0);
    });
  });

  describe('applyHunkSelections', () => {
    it.each([
      ['', ''],
      ['', '\uFEFFnew  \r\n\r\n'],
      ['\uFEFFold\t\r\n', ''],
      ['same', 'same\n'],
      ['same\r\n\r\n', 'same'],
      ['\uFEFF日本語 😀  \r\nanchor\r\nold\t', '\uFEFF日本語 😀\nanchor\r\nnew  \n\n'],
      ['first\rsecond\r', 'first\nsecond\r\n'],
      ['line  \nlast\t', 'line\nlast'],
    ])('reconstructs both exact sources (%j → %j)', (oldText, newText) => {
      const hunks = splitIntoHunks(generateDiff(oldText, newText).lines);
      const allChanges = new Set(hunks.filter(h => h.type === 'change').map(h => h.id));
      expect(applyHunkSelections(hunks, new Set())).toBe(oldText);
      expect(applyHunkSelections(hunks, allChanges)).toBe(newText);
    });

    it('preserves each selected source slice in a mixed merge', () => {
      const oldText = '\uFEFFold first  \r\nanchor\r\nold last\t';
      const newText = '\uFEFFnew first\nanchor\r\nnew last  \r\n\r\n';
      const hunks = splitIntoHunks(generateDiff(oldText, newText).lines);
      const changes = hunks.filter(h => h.type === 'change');
      expect(changes).toHaveLength(2);
      expect(applyHunkSelections(hunks, new Set([changes[0].id])))
        .toBe('\uFEFFnew first\nanchor\r\nold last\t');
      expect(applyHunkSelections(hunks, new Set([changes[1].id])))
        .toBe('\uFEFFold first  \r\nanchor\r\nnew last  \r\n\r\n');
    });
  });
});
