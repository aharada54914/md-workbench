import { expect, type Page } from '@playwright/test';

export const codeEditor = (page: Page) => page.locator('.code-editor .cm-content');

/** Disk documents start in isolated reading; explicit editing is a user action. */
export async function startEditing(page: Page): Promise<void> {
  await expect(page.locator('.isolated-preview-toggle')).toBeVisible({ timeout: 10_000 });
  const toggle = page.locator('.isolated-preview-toggle');
  if ((await toggle.textContent())?.trim() !== 'Isolated read-only preview') await toggle.click();
  await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 10_000 });
}

export async function openCodeView(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(codeEditor(page)).toBeVisible({ timeout: 3_000 });
}

export async function openVisualView(page: Page): Promise<void> {
  if (await page.getByRole('button', { name: 'Visual', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Visual', exact: true }).click();
  } else {
    await startEditing(page);
  }
  await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 10_000 });
}

export async function fillCodeEditor(page: Page, value: string): Promise<void> {
  const editor = codeEditor(page);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  // Chromium insertText treats CR and LF as separate DOM line breaks. Feed the
  // editor logical newlines; its source adapter retains the document separator.
  value = value.replace(/\r\n?/g, '\n');
  const trailingNewlines = value.match(/\n+$/)?.[0].length ?? 0;
  const body = trailingNewlines > 0 ? value.slice(0, -trailingNewlines) : value;
  if (body) await page.keyboard.insertText(body);
  else await page.keyboard.press('Backspace');
  for (let i = 0; i < trailingNewlines; i++) await page.keyboard.press('Enter');
}

export async function getCodeEditorValue(page: Page): Promise<string> {
  return (await page.locator('.code-editor .cm-line').allTextContents()).join('\n');
}

export async function setCodeCursor(page: Page, position: number): Promise<void> {
  const editor = codeEditor(page);
  await editor.focus();
  await editor.evaluate((element, absolutePosition) => {
    const lines = Array.from(element.querySelectorAll<HTMLElement>('.cm-line'));
    let remaining = absolutePosition;
    for (const line of lines) {
      const length = line.textContent?.length ?? 0;
      if (remaining <= length) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        let offset = remaining;
        while (node) {
          const nodeLength = node.textContent?.length ?? 0;
          if (offset <= nodeLength) {
            const range = document.createRange();
            range.setStart(node, offset);
            range.collapse(true);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            return;
          }
          offset -= nodeLength;
          node = walker.nextNode();
        }
        return;
      }
      remaining -= length + 1;
    }
  }, position);
  await page.waitForTimeout(50);
}
