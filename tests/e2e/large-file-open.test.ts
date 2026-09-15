import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { codeEditor } from './helpers/code-editor';

// ============================================================
// Test suite: Large file open (#129)
// Files above LARGE_FILE_CHAR_THRESHOLD (1M chars) must open
// markdown-first: straight into section-virtualized visual editing, without
// converting or mounting the complete document in a single TipTap instance.
// ============================================================

const NON_REVERSIBLE_CHUNK = [
  '# Section header',
  '',
  'A paragraph with **bold**, *italic*, `code` and a [link](https://example.com).',
  '',
  '- list item one',
  '  continuation line under the item',
  '- list item two',
  '  more continuation',
  '',
  '    indented code candidate line 1',
  '    indented code candidate line 2',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
].join('\n');

// Ordinary list continuations round-trip. A blank line followed by four-space
// indentation inside a list loses layout metadata in the current parser.
const CHUNK = NON_REVERSIBLE_CHUNK.replace(
  '    indented code candidate line 1\n    indented code candidate line 2\n\n', '',
) + '\n';

function buildLargeDoc(minChars: number, chunk = CHUNK): string {
  let doc = '';
  while (doc.length < minChars) doc += chunk;
  return doc;
}

const BIG_MD = buildLargeDoc(1_050_000);
const PATH_BIG = '/test/big.md';

test.describe('Large file open (#129)', () => {
  test('opens above-threshold file directly in editable lazy visual mode', async ({ page }) => {
    await setupTauriMocks(page, {
      initialFs: { [PATH_BIG]: BIG_MD },
      openFilePath: PATH_BIG,
    });

    await page.goto('/');
    await page.waitForSelector('.tab-bar', { timeout: 10_000 });
    await expect(page.locator('.tab-bar .tab')).toContainText('big.md', { timeout: 8_000 });

    await expect(page.locator('.lazy-editor')).toBeVisible({ timeout: 10_000 });
    const visualChunks = page.locator('.lazy-editor .ProseMirror');
    await expect(visualChunks.first()).toBeEditable();
    await expect(visualChunks.first().locator('h1').first()).toContainText('Section header');
    expect(await visualChunks.count()).toBeLessThan(10);
  });

  test('explicit toggle opens bounded editable lazy visual mode', async ({ page }) => {
    const mocks = await setupTauriMocks(page, {
      initialFs: { [PATH_BIG]: BIG_MD },
      openFilePath: PATH_BIG,
    });

    await page.goto('/');
    await page.waitForSelector('.tab-bar', { timeout: 10_000 });
    await expect(page.locator('.lazy-editor')).toBeVisible({ timeout: 10_000 });
    const visualChunks = page.locator('.lazy-editor .ProseMirror');
    await expect(visualChunks.first()).toBeEditable();
    await expect(visualChunks.first().locator('h1').first()).toContainText('Section header');
    expect(await visualChunks.count()).toBeLessThan(10);

    await page.locator('.lazy-editor').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => visualChunks.count()).toBeGreaterThan(0);
    expect(await visualChunks.count()).toBeLessThan(10);

    await page.locator('.lazy-editor').evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    const firstChunkEditor = page.locator('.lazy-editor-chunk[data-lazy-chunk="0"] .ProseMirror');
    await expect(firstChunkEditor).toBeEditable();
    await expect(firstChunkEditor.locator('h1').first()).toContainText('Section header');
    await firstChunkEditor.focus();
    await expect(firstChunkEditor).toBeFocused();
    await firstChunkEditor.evaluate(element => {
      const editor = (element as HTMLElement & { editor: { commands: { setTextSelection: (range: { from: number; to: number }) => void } } }).editor;
      editor.commands.setTextSelection({ from: 1, to: 'Section header'.length + 1 });
    });
    await page.keyboard.insertText('Edited in lazy visual mode');
    await expect(firstChunkEditor).toContainText('Edited in lazy visual mode');
    await page.waitForTimeout(500);

    await page.keyboard.press('Control+Shift+V');
    const codeEditor = page.locator('.code-editor .cm-editor');
    await expect(codeEditor).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.code-editor .cm-line').first()).toContainText('Edited in lazy visual mode');

    await page.keyboard.press('Control+Shift+V');
    await expect(page.locator('.lazy-editor')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.lazy-editor-chunk[data-lazy-chunk="0"] .ProseMirror')).toContainText('Edited in lazy visual mode');
    await page.keyboard.press('Control+s');
    // One heading changed; every other byte, including all unmounted tail chunks, survives.
    await expect.poll(() => mocks.getFs()[PATH_BIG]).toBe(BIG_MD.replace('# Section header', '# Edited in lazy visual mode'));
  });


  test('non-reversible list layout keeps exact large source and offers source editing', async ({ page }) => {
    const source = buildLargeDoc(1_050_000, NON_REVERSIBLE_CHUNK);
    const copy = '/test/big-copy.md';
    const mocks = await setupTauriMocks(page, { initialFs: { [PATH_BIG]: source }, openFilePath: PATH_BIG });
    await page.goto('/');
    const visual = page.locator('.lazy-editor .ProseMirror').first();
    await expect(visual).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => visual.evaluate(element => (element as HTMLElement).isContentEditable)).toBe(false);
    await expect(page.locator('.source-preservation-notice').first()).toBeVisible();
    await page.evaluate(copy => { (window as Record<string, unknown>).__mockDialogSavePath = copy; }, copy);
    await page.keyboard.press('Control+Shift+s');
    await expect.poll(() => mocks.getFs()[copy]).toBe(source);
    await page.getByRole('button', { name: 'Edit source', exact: true }).first().click();
    await expect(codeEditor(page)).toBeVisible();
    await codeEditor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('Source tail edit');
    await page.keyboard.press('Control+s');
    await expect.poll(() => mocks.getFs()[copy]).toBe(source + 'Source tail edit');
    expect(mocks.getFs()[PATH_BIG]).toBe(source);
  });

  test('switching tabs restores the large file in lazy visual mode', async ({ page }) => {
    await setupTauriMocks(page, {
      initialFs: { [PATH_BIG]: BIG_MD },
      openFilePath: PATH_BIG,
    });

    await page.goto('/');
    await page.waitForSelector('.tab-bar', { timeout: 10_000 });
    await expect(page.locator('.lazy-editor')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.locator('.nf-card').first().click();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10_000 });
    expect(await page.locator('.tab-bar .tab').count()).toBeGreaterThanOrEqual(2);

    await page.locator('.tab-bar .tab', { hasText: 'big.md' }).first().click();
    await expect(page.locator('.lazy-editor')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.lazy-editor-chunk[data-lazy-chunk="0"] h1').first()).toContainText('Section header');
  });

  test('lazy visual mode keeps the same document width as the classic editor', async ({ page }) => {
    await setupTauriMocks(page, {
      initialFs: { [PATH_BIG]: BIG_MD },
      openFilePath: PATH_BIG,
    });

    await page.goto('/');
    const lazyWrapper = page.locator('.lazy-editor-chunk[data-lazy-chunk="0"] .editor-content-wrapper');
    await expect(lazyWrapper).toBeVisible({ timeout: 10_000 });
    const lazyWidth = await lazyWrapper.evaluate(element => element.getBoundingClientRect().width);

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.locator('.nf-card').first().click();
    const classicWrapper = page.locator('.editor-pane.active .editor-content-wrapper');
    await expect(classicWrapper).toBeVisible({ timeout: 10_000 });
    const classicWidth = await classicWrapper.evaluate(element => element.getBoundingClientRect().width);

    expect(Math.abs(lazyWidth - classicWidth)).toBeLessThanOrEqual(1);
  });

  test('large-file table of contents is virtualized and navigates to a lazy section', async ({ page }) => {
    await setupTauriMocks(page, {
      initialFs: { [PATH_BIG]: BIG_MD },
      openFilePath: PATH_BIG,
    });

    await page.goto('/');
    await expect(page.locator('.lazy-editor')).toBeVisible({ timeout: 10_000 });
    await page.locator('.toc-toggle-btn').first().click();

    const toc = page.locator('.toc-panel');
    await expect(toc).toBeVisible();
    await expect(toc.locator('.toc-item').first()).toContainText('Section header', { timeout: 10_000 });
    expect(await toc.locator('.toc-item').count()).toBeLessThan(100);

    const tocContent = toc.locator('.toc-content');
    await tocContent.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await toc.locator('.toc-item').last().click();

    await expect.poll(
      () => page.locator('.lazy-editor').evaluate(element => element.scrollTop),
      { timeout: 10_000 },
    ).toBeGreaterThan(0);
    expect(await page.locator('.lazy-editor .ProseMirror').count()).toBeLessThan(10);
  });

  test('external file change reloads lazy visual mode without full conversion', async ({ page }) => {
    const mocks = await setupTauriMocks(page, {
      initialFs: { [PATH_BIG]: BIG_MD },
      openFilePath: PATH_BIG,
    });

    await page.goto('/');
    await page.waitForSelector('.tab-bar', { timeout: 10_000 });
    await expect(page.locator('.lazy-editor')).toBeVisible({ timeout: 10_000 });

    await mocks.triggerExternalChange(PATH_BIG, '# CHANGED EXTERNALLY\n\n' + BIG_MD);

    await expect
      .poll(async () => (await page.locator('.lazy-editor-chunk[data-lazy-chunk="0"] h1').first().textContent())?.startsWith('CHANGED EXTERNALLY'), { timeout: 10_000 })
      .toBe(true);
  });
});
