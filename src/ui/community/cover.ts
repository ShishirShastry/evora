import { approximateMeasurer, getPages, newExportSetting, type Document } from '../../core';
import { exportOne, ExportError, type ExportCanvas } from '../../engine/export/export';
import { ImageCache } from '../../engine/images/imageCache';
import { getBrowserMeasurer } from '../../engine/text/measure';

/** The width of a resource's cover picture, in pixels. */
export const COVER_WIDTH = 640;

/**
 * A resource's cover: the file's first page drawn by the app's own PNG export
 * at a small size, on the page's colour. Every image the page uses is decoded
 * first, so that it is in the picture. Null when the page has nothing on it
 * (or the picture cannot be made here).
 */
export async function renderCover(doc: Document, loadAsset: (hash: string) => Promise<{ mimeType: string; bytes: ArrayBuffer } | null>): Promise<Uint8Array | null> {
  const page = getPages(doc).find((candidate) => !candidate.library) ?? getPages(doc)[0];
  if (!page) return null;
  const images = new ImageCache(loadAsset);
  for (const hash of Object.keys(doc.assets)) {
    const asset = await loadAsset(hash).catch(() => null);
    if (asset) await images.put(hash, asset).catch(() => undefined);
  }
  try {
    const { file } = await exportOne(
      doc,
      { nodeId: page.id, fileName: 'cover.png', setting: newExportSetting({ format: 'PNG', constraint: { type: 'WIDTH', value: COVER_WIDTH }, background: true }) },
      {
        measurer: getBrowserMeasurer() ?? approximateMeasurer,
        images,
        createCanvas(width, height) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          return canvas;
        },
        loadAsset,
        encode(canvas: ExportCanvas, mimeType, quality) {
          return new Promise<Uint8Array>((resolve, reject) => {
            const done = (blob: Blob | null): void => {
              if (!blob) reject(new Error('The picture could not be made.'));
              else void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
            };
            if ('toBlob' in canvas) canvas.toBlob(done, mimeType, quality);
            else void canvas.convertToBlob({ type: mimeType, quality }).then(done, reject);
          });
        },
      },
    );
    return file.bytes;
  } catch (error) {
    if (error instanceof ExportError) return null;
    throw error;
  }
}
