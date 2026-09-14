export interface SourceEdit { from: number; to: number; insert: string }

/** CodeMirror counts each CRLF as one character; authoritative source does not. */
export function sourceOffset(raw: string, editorOffset: number): number {
  let source = 0, normalized = 0;
  while (source < raw.length && normalized < editorOffset) {
    source += raw[source] === '\r' && raw[source + 1] === '\n' ? 2 : 1;
    normalized++;
  }
  return source;
}

export function editorOffset(raw: string, sourcePosition: number): number {
  const end = Math.max(0, Math.min(sourcePosition, raw.length));
  let source = 0, normalized = 0;
  while (source < end) {
    source += raw[source] === '\r' && raw[source + 1] === '\n' ? 2 : 1;
    normalized++;
  }
  return normalized;
}

/** Patch only changed spans. Unrelated newlines, BOM and whitespace remain raw.
 * Newly inserted line breaks follow the first existing separator (LF if empty). */
export function applySourceEdits(raw: string, edits: SourceEdit[]): string {
  const newline = /\r\n|\r|\n/.exec(raw)?.[0] ?? '\n';
  let cursor = 0, previousEditorEnd = 0, result = '';
  for (const edit of edits) {
    if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < previousEditorEnd || edit.to < edit.from) throw new Error('Invalid or overlapping source edit');
    const from = sourceOffset(raw, edit.from), to = sourceOffset(raw, edit.to);
    if (editorOffset(raw, to) !== edit.to) throw new Error('Source edit exceeds revision');
    result += raw.slice(cursor, from) + edit.insert.replace(/\r\n|\r|\n/g, newline);
    cursor = to; previousEditorEnd = edit.to;
  }
  return result + raw.slice(cursor);
}
