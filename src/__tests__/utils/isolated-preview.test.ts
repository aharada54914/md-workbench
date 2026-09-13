import { describe, expect, it } from 'vitest';
import { buildIsolatedPreviewDocument, PREVIEW_CSP, sanitizePreviewHtml } from '../../utils/isolated-preview';

describe('unprivileged document display copy', () => {
  it.each([
    '<script>window.__TAURI__.core.invoke("write_file")</script>',
    '<img src="https://example.invalid/tracker" onerror="alert(1)">',
    '<img srcset="https://example.invalid/1 1x" src="//example.invalid/2">',
    '<svg><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>',
    '<svg><use href="https://example.invalid/x.svg#x"/></svg>',
    '<style>@import "https://example.invalid/font";</style>',
    '<div style="background:url(https://example.invalid/x)">text</div>',
    '<meta http-equiv="refresh" content="0;url=https://example.invalid">',
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    '<a href="javascript:alert(1)" ping="https://example.invalid" target="_top">link</a>',
    '<form action="https://example.invalid"><input name="secret"></form>',
  ])('removes executable and network markup: %s', source => {
    const html = sanitizePreviewHtml(source);
    expect(html).not.toMatch(/script|onerror|foreignObject|https:|srcset|style=|href=|srcdoc=|<svg|<form/);
  });

  it('retains safe semantic text and inert raster images only', () => {
    expect(sanitizePreviewHtml('<h1>日本語</h1><p><strong>本文</strong></p>')).toBe('<h1>日本語</h1><p><strong>本文</strong></p>');
    expect(sanitizePreviewHtml('<img src="data:image/png;base64,aA==">')).toContain('src="data:image/png;base64,aA=="');
    expect(sanitizePreviewHtml('<img src="data:image/svg+xml;base64,aA==">')).toContain('Image blocked');
  });

  it('keeps raw Markdown separate from its lossy preview', () => {
    const raw = '\uFEFF# 日本語\r\n\r\n<p onclick="bad()">本文</p>\r\n\r\n$$a+b$$\r\n';
    const before = raw;
    const html = buildIsolatedPreviewDocument(raw);
    expect(raw).toBe(before);
    expect(html).toContain('$$a+b$$');
    expect(html).not.toContain('onclick');
    expect(html).toContain(PREVIEW_CSP);
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('data-type=');
  });
});
