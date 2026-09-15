import { describe, it, expect } from 'vitest';
import { renderDeck, buildStandaloneHtml } from '../../composables/useMarpExport';
import { sanitizeMarpBody, MARP_CSP } from '../../utils/marp-document';

describe('Marp display document boundary', () => {
  it('keeps actual slide layout and mathematics in an inert display copy', () => {
    const source = '# 日本語\n\n$x^2$\n\n---\n\n# Second';
    const deck = renderDeck(source);
    const result = buildStandaloneHtml(deck);
    const template = document.createElement('template'); template.innerHTML = result;
    expect(template.content.querySelectorAll('svg[data-marpit-svg]')).toHaveLength(2);
    expect(template.content.querySelector('foreignObject')).not.toBeNull();
    expect(template.content.querySelector('mjx-container svg path')).not.toBeNull();
    expect(template.content.textContent).toContain('日本語');
    expect(result).toContain(MARP_CSP);
    expect(source).toBe('# 日本語\n\n$x^2$\n\n---\n\n# Second');
  });
  it('removes active markup, navigation, events and external images without active DOM parsing', () => {
    const result = sanitizeMarpBody('<section><script>bad()</script><iframe src="https://bad.invalid"></iframe><meta http-equiv="refresh" content="0;url=https://bad.invalid"><a href="https://bad.invalid" ping="https://bad.invalid">link</a><img src="https://bad.invalid/a" srcset="https://bad.invalid/b 2x" onerror="bad()"><svg><use href="#math-id"></use><use href="https://bad.invalid/x#id"></use><animate attributeName="href"></animate></svg></section>');
    expect(result).not.toMatch(/<script|<iframe|<meta|<animate|onerror|srcset|https:/);
    expect(result).toContain('href="#math-id"');
    expect(result).toContain('[Image blocked]');
    expect(result).toContain('>link</a>');
  });
  it('keeps validated data image syntax and prevents stylesheet termination', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo=';
    const result = buildStandaloneHtml({ html: `<section><img src="${uri}"></section>`, css: '</style><script>bad()</script><style>' });
    expect(result).toContain(uri);
    expect(result).not.toContain('<script>');
    expect(result).toContain('\\3c /style>');
    expect(result.indexOf('Content-Security-Policy')).toBeLessThan(result.indexOf('<style>'));
  });
  it('preserves generated background and header/footer layout', () => {
    const source = '---\nmarp: true\nheader: Heading\nfooter: Footer\n---\n# Slide\n\n![bg](data:image/png;base64,iVBORw0KGgo=)';
    const output = buildStandaloneHtml(renderDeck(source));
    const template = document.createElement('template'); template.innerHTML = output;
    expect(template.content.querySelector('figure')?.getAttribute('style')).toContain('data:image/png');
    expect(template.content.querySelector('header')?.textContent).toBe('Heading');
    expect(template.content.querySelector('footer')?.textContent).toBe('Footer');
  });
  it('does not enable authored raw HTML in the real renderer', () => {
    expect(renderDeck('<img src="https://bad.invalid" onerror="bad()">').html).not.toContain('<img');
  });
});
