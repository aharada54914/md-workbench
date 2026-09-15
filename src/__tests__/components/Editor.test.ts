import { describe, it, expect, vi } from 'vitest';

import { parseHtmlTable, parseTextTable } from '../../utils/editor-table-paste';

describe('Editor Helper Functions', () => {
  describe('parseHtmlTable', () => {
    it('returns null for non-table HTML', () => {
      expect(parseHtmlTable('<p>Not a table</p>')).toBeNull();
    });

    it('returns null for empty table', () => {
      expect(parseHtmlTable('<table></table>')).toBeNull();
    });

    it('parses simple HTML table', () => {
      const html = `
        <table>
          <tr><th>Header 1</th><th>Header 2</th></tr>
          <tr><td>Cell 1</td><td>Cell 2</td></tr>
        </table>
      `;
      const result = parseHtmlTable(html);

      expect(result).toContain('<thead>');
      expect(result).toContain('<tbody>');
      expect(result).toContain('<th><p>Header 1</p></th>');
      expect(result).toContain('<td><p>Cell 1</p></td>');
    });

    it('handles table with only header row', () => {
      const html = `
        <table>
          <tr><th>Only</th><th>Header</th></tr>
        </table>
      `;
      const result = parseHtmlTable(html);

      expect(result).toContain('<thead>');
      expect(result).toContain('<tbody>');
      // Header should be duplicated as body when no body rows
      expect(result).toContain('<th><p>Only</p></th>');
    });

    it('handles empty cells', () => {
      const html = `
        <table>
          <tr><th>Header</th><th></th></tr>
          <tr><td></td><td>Value</td></tr>
        </table>
      `;
      const result = parseHtmlTable(html);

      // Empty cells should get non-breaking space
      expect(result).toContain('\u00A0');
    });

    it('preserves cell content with whitespace', () => {
      const html = `
        <table>
          <tr><th>  Spaced  </th></tr>
          <tr><td>  Content  </td></tr>
        </table>
      `;
      const result = parseHtmlTable(html);

      expect(result).toContain('<th><p>Spaced</p></th>');
      expect(result).toContain('<td><p>Content</p></td>');
    });

    it('handles multiple rows', () => {
      const html = `
        <table>
          <tr><th>A</th><th>B</th></tr>
          <tr><td>1</td><td>2</td></tr>
          <tr><td>3</td><td>4</td></tr>
          <tr><td>5</td><td>6</td></tr>
        </table>
      `;
      const result = parseHtmlTable(html);

      expect(result).toContain('<td><p>1</p></td>');
      expect(result).toContain('<td><p>3</p></td>');
      expect(result).toContain('<td><p>5</p></td>');
    });
  });

  describe('parseTextTable', () => {
    it('returns null for single line', () => {
      expect(parseTextTable('single line')).toBeNull();
    });

    it('returns null for text without tabs or pipes', () => {
      expect(parseTextTable('line 1\nline 2\nline 3')).toBeNull();
    });

    it('parses tab-separated table', () => {
      const text = 'Header1\tHeader2\nValue1\tValue2';
      const result = parseTextTable(text);

      expect(result).toContain('<th><p>Header1</p></th>');
      expect(result).toContain('<th><p>Header2</p></th>');
      expect(result).toContain('<td><p>Value1</p></td>');
      expect(result).toContain('<td><p>Value2</p></td>');
    });

    it('parses pipe-separated table (Markdown style)', () => {
      const text = '| Header1 | Header2 |\n| --- | --- |\n| Value1 | Value2 |';
      const result = parseTextTable(text);

      expect(result).toContain('<th><p>Header1</p></th>');
      expect(result).toContain('<td><p>Value1</p></td>');
    });

    it('skips Markdown separator line', () => {
      const text = '| A | B |\n|---|---|\n| 1 | 2 |';
      const result = parseTextTable(text);

      // Separator line should not create a row
      expect(result).not.toContain('---');
    });

    it('handles header-only table', () => {
      const text = 'Col1\tCol2';
      // Single line returns null
      expect(parseTextTable(text)).toBeNull();
    });

    it('handles Excel-style paste (tabs)', () => {
      const text = 'Name\tAge\tCity\nJohn\t30\tNY\nJane\t25\tLA';
      const result = parseTextTable(text);

      expect(result).toContain('<th><p>Name</p></th>');
      expect(result).toContain('<th><p>Age</p></th>');
      expect(result).toContain('<td><p>John</p></td>');
      expect(result).toContain('<td><p>30</p></td>');
      expect(result).toContain('<td><p>Jane</p></td>');
    });

    it('handles pipes without leading/trailing pipe', () => {
      const text = 'A | B | C\n1 | 2 | 3';
      const result = parseTextTable(text);

      expect(result).toContain('<th><p>A</p></th>');
      expect(result).toContain('<td><p>1</p></td>');
    });

    it('trims whitespace from cells', () => {
      const text = '  Header  \t  Value  \n  A  \t  B  ';
      const result = parseTextTable(text);

      expect(result).toContain('<th><p>Header</p></th>');
      expect(result).toContain('<th><p>Value</p></th>');
      expect(result).toContain('<td><p>A</p></td>');
      expect(result).toContain('<td><p>B</p></td>');
    });
  });
});

 describe('inert table paste', () => {
  it('does not use resource-capable DOMParser and escapes HTML-looking cell text', () => {
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(() => { throw new Error('active parser'); });
    try {
      const result = parseHtmlTable('<table><tr><td>&lt;img src=x&gt;&amp;</td></tr></table>');
      expect(result).toContain('&lt;img src=x&gt;&amp;');
      expect(result).not.toContain('<img');
    } finally { spy.mockRestore(); }
  });
  it('escapes plain text cells before treating the result as HTML', () => {
    const result = parseTextTable('Name\tValue\n<img src=x>\tA&B');
    expect(result).toContain('&lt;img src=x&gt;');
    expect(result).toContain('A&amp;B');
    expect(result).not.toContain('<img');
  });
});
