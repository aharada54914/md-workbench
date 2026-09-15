import { IMAGE_BYTE_LIMIT } from './documentImageBytes';

const DATA_HEADER = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,/;
const MAX_BASE64_LENGTH = Math.ceil(IMAGE_BYTE_LIMIT / 3) * 4;

/** Strict base64 only. No URL decoding, arbitrary MIME, whitespace or fetch. */
export function decodeImageData(source: string): { bytes: Uint8Array; mime: string } {
  if (source.length > MAX_BASE64_LENGTH + 64) throw new Error('image_too_large');
  const header = DATA_HEADER.exec(source);
  if (!header) throw new Error('image_unavailable');
  const encoded = source.slice(header[0].length);
  if (encoded.length > MAX_BASE64_LENGTH) throw new Error('image_too_large');
  if (!encoded.length || encoded.length % 4
    || /[^A-Za-z0-9+/=]/.test(encoded) || !/^[^=]*={0,2}$/.test(encoded)) throw new Error('image_unavailable');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = alphabet.indexOf(encoded[encoded.length - padding - 1]!);
  if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) throw new Error('image_unavailable');
  if (encoded.length / 4 * 3 - padding > IMAGE_BYTE_LIMIT) throw new Error('image_too_large');
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (imageMime(bytes) !== header[1]) throw new Error('image_unavailable');
  return { bytes, mime: header[1]! };
}

/** Format routing, not a safe decoder or a bound on decoded pixel memory.
 * SVG bytes are allowed only in an owned Blob used by an HTML img element. */
export function imageMime(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > IMAGE_BYTE_LIMIT) throw new Error('image_too_large');
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (starts(255, 216, 255)) return 'image/jpeg';
  if (starts(71, 73, 70, 56, 55, 97) || starts(71, 73, 70, 56, 57, 97)) return 'image/gif';
  if (starts(82, 73, 70, 70) && bytes.length >= 12
    && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return 'image/webp';
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // Keep XML out of DOMParser, objects and inline SVG. Reject declarations that
  // introduce entities; browser image decoding remains the only SVG processor.
  if (!/<!DOCTYPE|<!ENTITY/i.test(text)
    && /^\s*(?:<\?xml\s[^?]*\?>\s*)?<svg(?:\s|>)/.test(text)) return 'image/svg+xml';
  throw new Error('image_unavailable');
}
