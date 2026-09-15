import { decodeHtmlEntities } from './html-entities';

/** Only this context introduces NUL token starts. Authored NULs, including
 * those produced by entity decoding, become opaque entries before conversion
 * continues. All entries restore once, so their contents cannot become tokens.
 * This does not depend on the number of decoding or list-processing passes. */
export const createSerializationContext = () => {
  const entries: { source: string; block: boolean; verbatim: boolean }[] = [];
  const prefix = '\0MDW';
  const protect = (source: string, block = false, verbatim = false): string => {
    const token = `${prefix}${block ? 'B' : 'I'}${entries.length}TOKEN`;
    entries.push({ source, block, verbatim });
    return token;
  };
  const protectNuls = (source: string): string => source.replace(/\0/g, () => protect('\0'));
  const decode = (source: string, decoder: (text: string) => string = decodeHtmlEntities): string => source.split('\0')
    .map(part => protectNuls(decoder(part))).join('\0');
  const restore = (source: string, normalizeWhitespace = false): string => {
    let output = '';
    let pending = '';
    let cursor = 0;
    // Only block placeholders own their surrounding line indentation. Inline
    // tokens must leave trailing spaces intact, including Markdown hard breaks.
    const pattern = /(^[ \t]+)\0MDWB(\d+)TOKEN[ \t]*$|\0MDW[BI](\d+)TOKEN/gm;
    const flush = () => {
      output += normalizeWhitespace ? pending.replace(/\n{3,}/g, '\n\n') : pending;
      pending = '';
    };
    for (const match of source.matchAll(pattern)) {
      pending += source.slice(cursor, match.index);
      const [, indent, indentedIndex, index] = match;
      const entry = entries[Number(indentedIndex ?? index)];
      let value = match[0];
      if (entry) {
        value = indent && entry.block
          ? entry.source.replace(/^\n+/, '').replace(/\n+$/, '').split('\n')
            .map(line => line.length > 0 ? indent + line : '').join('\n')
          : (indent ?? '') + entry.source;
      }
      // Atomic math kept its exact whitespace in the former final math pass.
      // Flush ordinary output without scanning the restored math payload.
      if (normalizeWhitespace && entry?.verbatim) {
        flush();
        output += value;
      } else pending += value;
      cursor = match.index! + match[0].length;
    }
    pending += source.slice(cursor);
    flush();
    return output;
  };
  return { blockPrefix: `${prefix}B`, protect, protectNuls, decode, restore };
};

export type SerializationContext = ReturnType<typeof createSerializationContext>;
