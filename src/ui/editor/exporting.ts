import { writeZip, type Document, type ExportTarget } from '../../core';
import { exportAll, type ExportCanvas, type ExportedFile, type ExportEnvironment } from '../../engine/export/export';
import type { ImageCache } from '../../engine/images/imageCache';
import { getBrowserMeasurer } from '../../engine/text/measure';
import { approximateMeasurer } from '../../core';
import { canCompress, deflateZlib } from '../../persistence/compression';
import type { DocumentStorage } from '../../persistence/storage';

/**
 * Exporting from the browser: the canvas, the images and the compression
 * the export engine is given here, and how the files reach the disk.
 */

/** What the export engine needs, from the browser and from where the file's images are kept. */
export function exportEnvironment(storage: DocumentStorage, images: ImageCache): ExportEnvironment {
  return {
    measurer: getBrowserMeasurer() ?? approximateMeasurer,
    images,
    createCanvas(width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    loadAsset: (hash) => storage.loadAsset(hash),
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
    deflate: canCompress() ? deflateZlib : undefined,
  };
}

/** Hands a file to the browser to save, as a download. */
export function downloadBytes(name: string, mimeType: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Makes the files of some exports and saves them: one file as it is, more
 * than one together in a ZIP archive. Returns the files and what could not
 * be written as designed.
 */
export async function runExport(doc: Document, targets: readonly ExportTarget[], env: ExportEnvironment, archiveName: string): Promise<{ files: ExportedFile[]; warnings: string[] }> {
  const out = await exportAll(doc, targets, env);
  if (out.files.length === 1) {
    const file = out.files[0] as ExportedFile;
    downloadBytes(file.name, file.mimeType, file.bytes);
  } else if (out.files.length > 1) {
    downloadBytes(`${archiveName}.zip`, 'application/zip', writeZip(out.files.map((file) => ({ name: file.name, bytes: file.bytes }))));
  }
  return out;
}
