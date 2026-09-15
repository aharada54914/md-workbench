import { test, expect } from '@playwright/test';
import { setupTauriMocks } from './helpers/tauri-mock';
import { codeEditor, getCodeEditorValue, openCodeView } from './helpers/code-editor';

// ============================================================
// Test suite: Tab Close in Code View (#36)
// When closing the active tab while in code view, the next tab
// should become active and its content should be displayed.
// ============================================================

const FILE_A_MD = '# File A\n\nContent of file A.\n';
const FILE_B_MD = '# File B\n\nContent of file B.\n';
const PATH_A = '/test/file-a.md';
const PATH_B = '/test/file-b.md';

/** Wait for the tab bar to show a specific file name */
async function waitForTab(page: import('@playwright/test').Page, fileName: string) {
  await expect(page.locator('.tab-bar .tab')).toContainText(fileName, { timeout: 8_000 });
}

async function createPlainTab(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.locator('.nf-card:not(.nf-card--marp)').click();
}

// ============================================================

test.describe('Tab Close in Code View (#36)', () => {
  test('closing active tab in code view shows new active tab content', async ({ page }) => {
    const mock = await setupTauriMocks(page, {
      initialFs: { [PATH_A]: FILE_A_MD, [PATH_B]: FILE_B_MD },
      openFilePath: PATH_A,
    });
    await page.goto('/');
    await waitForTab(page, 'file-a.md');
    // Explicit Source intent belongs to A and must be restored after closing B.
    await openCodeView(page);
    await mock.triggerOpenFiles([PATH_B]);
    await expect(page.locator('.tab-bar .tab')).toHaveCount(2);
    await openCodeView(page);
    await expect.poll(() => getCodeEditorValue(page)).toBe(FILE_B_MD);
    await page.locator('.tab-bar .tab.active .tab-close').click();
    await expect(page.locator('.tab-bar .tab')).toHaveCount(1);
    await expect(page.locator('.tab-bar .tab.active')).toContainText('file-a.md');
    await expect(codeEditor(page)).toBeVisible();
    await expect.poll(() => getCodeEditorValue(page)).toBe(FILE_A_MD);
    expect(mock.getFs()).toEqual({ [PATH_A]: FILE_A_MD, [PATH_B]: FILE_B_MD });
  });

  test('closing non-active tab in code view preserves current content', async ({ page }) => {
    await setupTauriMocks(page, {
      initialFs: { [PATH_A]: FILE_A_MD },
      openFilePath: PATH_A,
    });

    await page.goto('/');
    await page.waitForSelector('.tab-bar', { timeout: 10_000 });
    await waitForTab(page, 'file-a.md');

    // Create a second tab
    await createPlainTab(page);
    await page.waitForTimeout(500);

    // Switch back to first tab
    const firstTab = page.locator('.tab-bar .tab').first();
    await firstTab.click();
    await page.waitForTimeout(300);

    // Switch to code view
    await openCodeView(page);
    const codeEditorElement = codeEditor(page);
    await page.waitForTimeout(300);

    // Get current code content
    const contentBefore = await getCodeEditorValue(page);

    // Close the non-active tab (second tab)
    const tabs = page.locator('.tab-bar .tab');
    const tabCount = await tabs.count();
    if (tabCount >= 2) {
      const secondTab = tabs.nth(1);
      const closeButton = secondTab.locator('.close-btn, .tab-close, [class*="close"]');
      if (await closeButton.count() > 0) {
        await closeButton.first().click();
        await page.waitForTimeout(500);

        // Code editor should still be visible with same content
        await expect(codeEditorElement).toBeVisible();
        const contentAfter = await getCodeEditorValue(page);
        expect(contentAfter).toBe(contentBefore);
      }
    }
  });
});
