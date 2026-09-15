import { test, expect } from '@playwright/test';
import type { Editor } from '@tiptap/core';
import { setupTauriMocks } from './helpers/tauri-mock';
import { startEditing } from './helpers/code-editor';

for (const variant of ['block', 'inline'] as const) {
  test(`accepted Visual ${variant} insertion preserves authored placeholder text and Undo`, async ({ page }) => {
    const path = `/test/placeholder-${variant}.md`;
    const source = variant === 'block' ? '`__PROTECTED_BLOCK_0__`' : '# `__INLINE_CODE_1__`';
    const expected = source + (variant === 'block' ? '\n\n```\nNEW\n```' : ' `NEW`');
    const fs = await setupTauriMocks(page, { initialFs: { [path]: source }, openFilePath: path });
    await page.goto('/');
    await startEditing(page);
    const visual = page.locator('.ProseMirror');
    await expect(visual).toHaveAttribute('contenteditable', 'true');
    await visual.evaluate((element, kind) => {
      const editor = (element as HTMLElement & { editor: Editor }).editor;
      const end = editor.state.doc.content.size;
      if (kind === 'block') {
        editor.commands.insertContentAt(end, {
          type: 'codeBlock', content: [{ type: 'text', text: 'NEW' }],
        });
      } else {
        editor.commands.insertContentAt(end - 1, [
          { type: 'text', text: ' ' },
          { type: 'text', text: 'NEW', marks: [{ type: 'code' }] },
        ]);
      }
      editor.commands.focus();
    }, variant);
    await expect(visual).toContainText('NEW');
    await page.keyboard.press('Control+s');
    await expect.poll(() => fs.getFs()[path]).toBe(expected);
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('Control+s');
    await expect.poll(() => fs.getFs()[path]).toBe(source);
  });
}
