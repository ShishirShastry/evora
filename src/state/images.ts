import {
  addLayer,
  containerAt,
  placeInFlow,
  imagePaint,
  isImageMimeType,
  nameFromFile,
  placementInParent,
  sha256Hex,
  type AssetInfo,
  type NodeId,
  type Point,
} from '../core';
import type { ImageCache } from '../engine/images/imageCache';
import { visibleRect } from '../engine/viewport';
import type { DocumentStorage } from '../persistence/storage';
import type { EditorStore } from './editorStore';

export interface ImportedImage {
  hash: string;
  info: AssetInfo;
}

/** A file as far as importing cares: the browser's File satisfies this, and so can a test. */
export interface ImageFile {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

/** The image type of a file, from its declared type or, failing that, its extension. Null if it is not an image we place. */
export function imageTypeOf(file: Pick<ImageFile, 'name' | 'type'>): string | null {
  if (isImageMimeType(file.type)) return file.type;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return (extension && EXTENSION_TYPES[extension]) || null;
}

/**
 * Turns image files into assets: each is hashed, decoded (which proves it
 * really is an image and gives its size) and stored. Files that are not
 * images, or that cannot be decoded, are skipped and counted in `failed`.
 */
export async function importImageFiles(
  storage: DocumentStorage,
  images: ImageCache,
  files: readonly ImageFile[],
): Promise<{ imported: ImportedImage[]; failed: number }> {
  const imported: ImportedImage[] = [];
  let failed = 0;
  for (const file of files) {
    const mimeType = imageTypeOf(file);
    if (!mimeType) {
      failed++;
      continue;
    }
    try {
      const bytes = await file.arrayBuffer();
      const hash = await sha256Hex(bytes);
      const decoded = await images.put(hash, { mimeType, bytes });
      await storage.saveAsset(hash, { mimeType, bytes });
      imported.push({ hash, info: { mimeType, width: decoded.width, height: decoded.height, name: file.name } });
    } catch {
      failed++;
    }
  }
  return { imported, failed };
}

/**
 * Places imported images on the current page as rectangles with an image
 * fill, one undo step for all of them. They are centred on `at` (page space)
 * or on the middle of the view, at their natural size unless that would not
 * fit in the view, and go inside a frame if they land on one.
 */
export function placeImages(store: EditorStore, imported: readonly ImportedImage[], at?: Point): NodeId[] {
  if (imported.length === 0) return [];
  const state = store.getState();
  const assets: Record<string, AssetInfo> = {};
  for (const image of imported) assets[image.hash] = image.info;
  state.addAssets(assets);

  const view = visibleRect(state.viewport, state.canvasSize);
  const hasView = state.canvasSize.width > 0 && state.canvasSize.height > 0;
  const center = at ?? (hasView ? { x: view.x + view.width / 2, y: view.y + view.height / 2 } : { x: 0, y: 0 });
  const created: NodeId[] = [];

  store.getState().apply(imported.length === 1 ? 'Place image' : 'Place images', (doc) => {
    let next = doc;
    imported.forEach((image, index) => {
      let { width, height } = image.info;
      if (hasView) {
        // Never larger than most of what the user can see right now.
        const fit = Math.min(1, (view.width * 0.8) / width, (view.height * 0.8) / height);
        width = Math.max(1, Math.round(width * fit));
        height = Math.max(1, Math.round(height * fit));
      }
      // Several images are fanned out so that none hides another completely.
      const middle = { x: center.x + index * 24, y: center.y + index * 24 };
      const parentId = containerAt(next, state.pageId, middle);
      const placed = placementInParent(next, parentId, middle, width, height, 0);
      const out = addLayer(next, 'RECTANGLE', parentId, {
        name: nameFromFile(image.info.name),
        x: Math.round(placed.x),
        y: Math.round(placed.y),
        rotation: placed.rotation,
        width,
        height,
        fills: [imagePaint(image.hash)],
      });
      // On a frame that lays out its children it takes the place in the row or column that it was dropped over.
      next = placeInFlow(out.doc, [out.id], middle);
      created.push(out.id);
    });
    return next;
  });
  store.getState().setSelection(created);
  return created;
}
