import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { applySourceEdits, editorOffset, sourceOffset, type SourceEdit } from '../../utils/source-edits';

describe('minimal authoritative source edits', () => {
  it('keeps unrelated mixed newlines, BOM, unknown syntax and trailing whitespace', () => {
    const raw = '\uFEFF# 日本語\r\n:::unknown\n$$x$$  \r\n\t';
    const state = EditorState.create({ doc: raw });
    const position = state.doc.toString().indexOf('日本語');
    const update = state.update({ changes: { from: position, to: position + 3, insert: '😀テスト' } });
    const edits: SourceEdit[] = [];
    update.changes.iterChanges((from, to, _a, _b, inserted) => edits.push({ from, to, insert: inserted.toString() }));
    const patched = applySourceEdits(raw, edits);
    expect(patched).toBe(raw.replace('日本語', '😀テスト'));
    expect(EditorState.create({ doc: patched }).doc.toString()).toBe(update.state.doc.toString());
  });
  it('inserts new lines in the existing convention without rewriting older mixed lines', () => {
    expect(applySourceEdits('a\r\nb\nc', [{ from: 1, to: 1, insert: '\nnew' }])).toBe('a\r\nnew\r\nb\nc');
  });
  it('maps UTF-16 positions around CRLF and emoji', () => {
    const raw = '😀\r\n日本語';
    for (const at of [0, 1, 2, 4, 5, 6, 7]) expect(sourceOffset(raw, editorOffset(raw, at))).toBe(at);
  });
  it('rejects stale or overlapping ranges', () => {
    expect(() => applySourceEdits('abc', [{ from: 0, to: 4, insert: '' }])).toThrow();
    expect(() => applySourceEdits('abc', [{ from: 1, to: 2, insert: '' }, { from: 0, to: 1, insert: '' }])).toThrow();
  });
});
