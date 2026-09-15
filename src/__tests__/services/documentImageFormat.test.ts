import { describe, expect, it } from 'vitest';
import { decodeImageData, imageMime } from '../../services/documentImageFormat';
import { IMAGE_BYTE_LIMIT } from '../../services/documentImageBytes';

describe('bounded image format routing', () => {
  it('routes signatures without trusting extension/MIME claims', () => {
    expect(imageMime(new Uint8Array([255, 216, 255]))).toBe('image/jpeg');
    expect(imageMime(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(imageMime(new TextEncoder().encode('RIFFxxxxWEBP'))).toBe('image/webp');
    expect(imageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>'))).toBe('image/svg+xml');
    expect(() => decodeImageData('data:image/jpeg;base64,iVBORw0KGgo=')).toThrow();
  });
  it.each(['data:image/png;base64,iVBORw0KGgp=', 'data:image/png;base64,iVBORw0KGgo=\n', 'data:image/png;base64,iV=ORw0KGgo=', 'data:image/png,%89PNG', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,'])('rejects noncanonical data %s', input => {
    expect(() => decodeImageData(input)).toThrow();
  });
  it('rejects encoded size before decoding and SVG declarations without parsing XML', () => {
    expect(() => decodeImageData('data:image/png;base64,' + 'A'.repeat(Math.ceil(IMAGE_BYTE_LIMIT / 3) * 4 + 4))).toThrow('image_too_large');
    expect(() => imageMime(new TextEncoder().encode('<!DOCTYPE svg><svg/>'))).toThrow();
    expect(() => imageMime(new TextEncoder().encode('<html><img src="file:///x"></html>'))).toThrow();
  });
});
