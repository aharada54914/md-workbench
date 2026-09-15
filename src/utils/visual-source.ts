import { applyLineEnding, detectLineEnding, htmlToMarkdown } from './markdown-converter';

/** Keep the document envelope that the visual serializer intentionally omits. */
export function serializeVisualMarkdown(html: string, reference: string | null | undefined): string {
  const markdown = htmlToMarkdown(html);
  if (reference == null) return markdown;
  const bom = reference.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = reference.slice(bom.length);
  const leading = body.match(/^(?:[ \t]*(?:\r\n|\r|\n))*/)?.[0] ?? '';
  const trailing = body.slice(leading.length).match(/[ \t\r\n]*$/)?.[0] ?? '';
  return bom + leading + applyLineEnding(markdown, detectLineEnding(reference)) + trailing;
}

/** Call with HTML from the actual editor schema, after its parsing step. */
export function canEditVisualSource(html: string, source: string | null | undefined): boolean {
  return source == null || serializeVisualMarkdown(html, source) === source;
}
