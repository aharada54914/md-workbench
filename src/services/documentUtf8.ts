/** Decode exact UTF-8 source; retain BOM and line endings, reject invalid bytes. */
export function decodeDocumentUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
