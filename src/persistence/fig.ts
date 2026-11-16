import { approximateMeasurer, createId, readFig, referencedAssetHashes, sha256Hex, toFile, writeFig, type Document, type FigEnvironment, type TextMeasurer } from '../core';
import { deflateRaw, inflateRaw } from './compression';
import type { DocumentStorage } from './storage';

/**
 * Figma `.fig` files to and from the files kept on this device: what the
 * core reads becomes a new local file with its images stored, and a local
 * file is written with the bytes of the images it uses.
 */

function environment(measurer?: TextMeasurer): FigEnvironment {
  return { inflateRaw, deflateRaw, sha256Hex, measurer: measurer ?? approximateMeasurer };
}

/** Whether bytes look like a `.fig` file: an archive, or a bare canvas. */
export function looksLikeFig(name: string, bytes: Uint8Array): boolean {
  if (/\.fig$/i.test(name)) return true;
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  return head === 'fig-kiwi' || head === 'fig-jam.';
}

/** Reads a `.fig` file into a new local file. Returns its ID and what was not converted. Throws a `FigError` when it cannot be read. */
export async function importFigBytes(storage: DocumentStorage, bytes: Uint8Array, fileName: string, measurer?: TextMeasurer): Promise<{ id: string; notConverted: string[] }> {
  const name = fileName.replace(/\.(fig|jam)$/i, '') || 'Figma file';
  const read = await readFig(bytes, name, environment(measurer));
  for (const hash in read.images) {
    const image = read.images[hash] as { mimeType: string; bytes: Uint8Array };
    const copy = new Uint8Array(image.bytes.byteLength);
    copy.set(image.bytes);
    await storage.saveAsset(hash, { mimeType: image.mimeType, bytes: copy.buffer });
  }
  const now = new Date().toISOString();
  const doc: Document = { ...read.doc, id: createId() };
  await storage.save(toFile(doc, { createdAt: now, updatedAt: now }));
  return { id: doc.id, notConverted: read.notConverted };
}

/** Writes a local document as a `.fig` file, with the images on this device. */
export async function exportFigBytes(storage: DocumentStorage, doc: Document): Promise<{ bytes: Uint8Array; notWritten: string[] }> {
  const images: Record<string, { bytes: Uint8Array }> = {};
  for (const hash of referencedAssetHashes(doc)) {
    const asset = await storage.loadAsset(hash);
    if (asset) images[hash] = { bytes: new Uint8Array(asset.bytes) };
  }
  return writeFig(doc, images, environment());
}
