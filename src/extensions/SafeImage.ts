import { Image, type ImageOptions } from '@tiptap/extension-image';
import type { DocumentImageDisplay, ImageDisplayBinding } from '../services/documentImageDisplay';

/** Authored attributes stay in the model/serializer; only the NodeView is inert.
 * Callers still need inert HTML parse, serialization and clipboard boundaries. */
export const SafeImage = Image.extend<{ provider: DocumentImageDisplay | null } & ImageOptions>({
  addOptions() {
    return { ...this.parent!(), provider: null, HTMLAttributes: { class: 'editor-image' } };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-original-src': {
        default: null,
        parseHTML: element => element.getAttribute('data-original-src'),
        renderHTML: attributes => attributes['data-original-src'] ? { 'data-original-src': attributes['data-original-src'] } : {},
      },
    };
  },
  addNodeView() {
    return ({ node }) => {
      const image = document.createElement('img');
      image.className = 'editor-image';
      let binding: ImageDisplayBinding | undefined;
      let previousSource: unknown;
      let latestAttributes: Record<string, unknown> = node.attrs;
      const render = (attributes: Record<string, unknown>) => {
        latestAttributes = attributes;
        image.alt = typeof attributes.alt === 'string' ? attributes.alt : '';
        if (image.dataset.imageStatus === 'unavailable') image.alt = image.alt ? `${image.alt} (Image unavailable)` : 'Image unavailable';
        image.title = typeof attributes.title === 'string' ? attributes.title : '';
        for (const dimension of ['width', 'height'] as const) {
          const value = Number(attributes[dimension]);
          if (Number.isFinite(value) && value > 0 && value <= 32768) image.setAttribute(dimension, String(value));
          else image.removeAttribute(dimension);
        }
        if (attributes.src !== previousSource || !binding) {
          binding?.dispose();
          previousSource = attributes.src;
          image.removeAttribute('src');
          const source = typeof attributes.src === 'string' ? attributes.src : '';
          binding = this.options.provider?.attach(image, source, status => {
            const alt = typeof latestAttributes.alt === 'string' ? latestAttributes.alt : '';
            image.alt = alt;
            if (status === 'unavailable') {
              image.setAttribute('aria-label', 'Image unavailable');
              image.alt = alt ? `${alt} (Image unavailable)` : 'Image unavailable';
            } else image.removeAttribute('aria-label');
          });
          if (!binding) { image.dataset.imageStatus = 'unavailable'; image.alt ||= 'Image unavailable'; }
        }
      };
      render(node.attrs);
      return {
        dom: image,
        update(next) {
          if (next.type !== node.type) return false;
          render(next.attrs); return true;
        },
        destroy() { binding?.dispose(); },
      };
    };
  },
});
