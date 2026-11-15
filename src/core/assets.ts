import type { Document, ImagePaint, ImageScaleMode } from './document/schema';
import type { Rect } from './math/geometry';

/** The hashes of the image assets that layers in the document actually use, without duplicates. */
export function referencedAssetHashes(doc: Document): string[] {
  const hashes = new Set<string>();
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!node || node.type === 'PAGE') continue;
    for (const paint of [...node.fills, ...node.strokes]) if (paint.type === 'IMAGE') hashes.add(paint.imageHash);
  }
  return [...hashes];
}

/** Lowercase hex SHA-256 of some bytes. This is what identifies an image asset. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Copy into a plain ArrayBuffer so the digest accepts it whatever backs the view.
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encodes bytes as base64. Written out here so the core needs no platform API for it. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    out += BASE64[a >> 2];
    out += BASE64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? BASE64[c & 63] : '=';
  }
  return out;
}

/** Decodes base64. Returns null if the text is not valid base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = BASE64.indexOf(text[i] as string);
    const b = BASE64.indexOf(text[i + 1] as string);
    const c = text[i + 2] === '=' ? 0 : BASE64.indexOf(text[i + 2] as string);
    const d = text[i + 3] === '=' ? 0 : BASE64.indexOf(text[i + 3] as string);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Where an image is drawn in a layer's box, and which part of the image is used. */
export interface ImagePlacement {
  /** Part of the image, in image pixels. */
  source: Rect;
  /** Where that part goes, in the layer's local pixels. May extend past the box; the layer's outline clips it. */
  target: Rect;
}

/**
 * How an image paint maps the image onto a `width × height` box.
 * - FILL covers the box, keeping the image's proportions and cropping the overflow.
 * - FIT shows the whole image inside the box, leaving the rest of the box empty.
 * - CROP stretches a chosen part of the image over the whole box.
 * TILE is a repeating pattern and has no single placement: it returns null.
 */
export function imagePlacement(
  mode: ImageScaleMode,
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
  crop: ImagePaint['crop'],
): ImagePlacement | null {
  if (imageWidth <= 0 || imageHeight <= 0 || width <= 0 || height <= 0 || mode === 'TILE') return null;
  const whole = { x: 0, y: 0, width: imageWidth, height: imageHeight };
  if (mode === 'CROP') {
    return {
      source: { x: crop.x * imageWidth, y: crop.y * imageHeight, width: crop.width * imageWidth, height: crop.height * imageHeight },
      target: { x: 0, y: 0, width, height },
    };
  }
  const scale = mode === 'FILL' ? Math.max(width / imageWidth, height / imageHeight) : Math.min(width / imageWidth, height / imageHeight);
  const w = imageWidth * scale;
  const h = imageHeight * scale;
  return { source: whole, target: { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h } };
}

/** File types that can be placed as images. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'] as const;

export function isImageMimeType(type: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

/** A layer name from a file name: the name without its extension. */
export function nameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, '').trim();
  return base || 'Image';
}
