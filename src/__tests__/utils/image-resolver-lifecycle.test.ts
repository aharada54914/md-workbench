import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inlineMarkdownImages } from '../../utils/image-resolver';
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile }));
beforeEach(() => { readFile.mockReset(); readFile.mockResolvedValue(new Uint8Array([1])); });

describe('Markdown inline request ownership', () => {
  it('does not reuse a previous document data URI for the same path', async () => {
    readFile.mockResolvedValueOnce(new Uint8Array([1])).mockResolvedValueOnce(new Uint8Array([2]));
    const first = await inlineMarkdownImages('![a](/shared.png)');
    const second = await inlineMarkdownImages('![a](/shared.png)');
    expect(second).not.toBe(first);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('shares duplicate inline reads only within one request and leaves external URLs alone', async () => {
    const markdown = '![a](/same.png) ![b](/same.png) ![c](https://example.com/a.png) ![d](data:image/png;base64,AQ==)';
    const rendered = await inlineMarkdownImages(markdown);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(rendered.match(/data:image\/png;base64,AQ==/g)).toHaveLength(3);
    expect(rendered).toContain('https://example.com/a.png');
  });
});
