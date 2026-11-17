import {
  bytesToBase64,
  EXPORT_MIME_TYPES,
  exportScale,
  getChildIds,
  getDescendantIds,
  isLayer,
  isPage,
  multiply,
  referencedAssetHashes,
  unionRects,
  type Document,
  type ExportSetting,
  type ExportTarget,
  type LayerNode,
  type NodeId,
  type Rect,
  type RGB,
  type TextMeasurer,
} from '../../core';
import type { ImageSource } from '../images/imageCache';
import { getRenderBounds, renderScene } from '../render/scene';
import { separateShadow } from './effects';
import { exportPdf, writableAsPdfText, type EffectPictures, type PdfImage, type PdfPage, type PlacedPicture } from './pdf';
import { exportSvg, type SvgImage } from './svg';
import { buildVectorScene } from './vector';

/**
 * Makes the files of an export. A layer or a page is drawn by the editor's
 * own renderer for PNG and JPG, and turned into a vector scene for SVG and
 * PDF. What is needed from the surroundings is passed in: a canvas, the
 * images, something that compresses.
 */

export interface ExportedFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  /** The size of the result: pixels for a picture, units for SVG and PDF. */
  width: number;
  height: number;
}

export type ExportCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface ExportEnvironment {
  /** Must be the measurer the editor lays text out with. */
  measurer: TextMeasurer;
  /** Decoded images, for drawing image fills. */
  images?: ImageSource;
  createCanvas(width: number, height: number): ExportCanvas;
  /** The bytes of an image asset as it was imported. */
  loadAsset(hash: string): Promise<{ mimeType: string; bytes: ArrayBuffer } | null>;
  /** The bytes of a canvas as a PNG or a JPEG. */
  encode(canvas: ExportCanvas, mimeType: 'image/png' | 'image/jpeg', quality: number): Promise<Uint8Array>;
  /** Compresses bytes (zlib format), for PDF. Optional. */
  deflate?: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/** The biggest side, and the most pixels, a picture is made with: beyond these browsers give up without saying so. */
const MAX_SIDE = 16384;
const MAX_PIXELS = 120_000_000;
const WHITE: RGB = { r: 1, g: 1, b: 1 };

export class ExportError extends Error {}

/** What is exported for a layer or a page: the part of the page it covers, and the layers to draw (all of the page for a page). */
export function exportArea(doc: Document, nodeId: NodeId): { pageId: NodeId; bounds: Rect; roots: NodeId[] | null; background: RGB } | null {
  const node = doc.nodes[nodeId];
  if (isPage(node)) {
    const parts: Rect[] = [];
    for (const id of getChildIds(doc, nodeId)) {
      const child = doc.nodes[id];
      if (isLayer(child) && child.visible) parts.push(getRenderBounds(doc, id));
    }
    const bounds = unionRects(parts);
    return bounds ? { pageId: nodeId, bounds, roots: null, background: node.backgroundColor } : null;
  }
  if (!isLayer(node)) return null;
  let pageId: NodeId = node.parentId;
  for (let step = 0; step < 1000; step++) {
    const parent = doc.nodes[pageId];
    if (!parent || parent.parentId === null) break;
    pageId = parent.parentId;
  }
  const page = doc.nodes[pageId];
  if (!isPage(page)) return null;
  return { pageId, bounds: getRenderBounds(doc, nodeId), roots: [nodeId], background: page.backgroundColor };
}

/** Draws part of a page, or some of its layers, on a new canvas at a scale. Transparent where nothing is, unless given a colour to lie on. */
function draw(doc: Document, area: { pageId: NodeId; bounds: Rect; roots: NodeId[] | null }, scale: number, background: RGB | null, env: ExportEnvironment, hiddenIds?: ReadonlySet<NodeId>): ExportCanvas {
  const width = Math.max(1, Math.round(area.bounds.width * scale));
  const height = Math.max(1, Math.round(area.bounds.height * scale));
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new ExportError(`${width} × ${height} pixels is more than can be exported as one picture. Choose a smaller scale.`);
  }
  const canvas = env.createCanvas(width, height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new ExportError('This browser could not make a picture to draw on.');
  renderScene(ctx, doc, area.pageId, {
    size: { width, height },
    dpr: 1,
    viewport: { x: area.bounds.x, y: area.bounds.y, zoom: scale },
    measurer: env.measurer,
    images: env.images,
    background: false,
    roots: area.roots ?? undefined,
    hiddenIds,
    createCanvas: (w, h) => env.createCanvas(w, h),
  });
  if (!background) return canvas;
  // Laid on a colour: the drawing over a canvas filled with it.
  const backed = env.createCanvas(width, height);
  const under = backed.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!under) throw new ExportError('This browser could not make a picture to draw on.');
  under.fillStyle = `rgb(${Math.round(background.r * 255)}, ${Math.round(background.g * 255)}, ${Math.round(background.b * 255)})`;
  under.fillRect(0, 0, width, height);
  under.drawImage(canvas as CanvasImageSource, 0, 0);
  return backed;
}

function pixelsOf(canvas: ExportCanvas): PdfImage {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  return { kind: 'pixels', rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
}

/** The image fills that what is exported uses, as the vector writers need them. */
async function assetsFor(doc: Document, ids: readonly NodeId[], env: ExportEnvironment, warnings: Set<string>): Promise<{ svg: Record<string, SvgImage>; pdf: Record<string, PdfImage> }> {
  const wanted = new Set<string>();
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    for (const paint of [...node.fills, ...node.strokes]) if (paint.type === 'IMAGE' && paint.visible) wanted.add(paint.imageHash);
  }
  const svg: Record<string, SvgImage> = {};
  const pdf: Record<string, PdfImage> = {};
  for (const hash of referencedAssetHashes(doc)) {
    if (!wanted.has(hash)) continue;
    const info = doc.assets[hash];
    const asset = await env.loadAsset(hash);
    if (!info || !asset) continue;
    const bytes = new Uint8Array(asset.bytes);
    svg[hash] = { mimeType: asset.mimeType, base64: bytesToBase64(bytes), width: info.width, height: info.height };
    if (asset.mimeType === 'image/jpeg') pdf[hash] = { kind: 'jpeg', bytes, width: info.width, height: info.height };
    else {
      // Anything else is drawn once and its pixels kept.
      const decoded = env.images?.get(hash);
      if (!decoded) {
        warnings.add('An image had not finished loading and was left out of the PDF. Export again in a moment.');
        continue;
      }
      const canvas = env.createCanvas(decoded.width, decoded.height);
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) continue;
      ctx.drawImage(decoded.image as CanvasImageSource, 0, 0);
      pdf[hash] = pixelsOf(canvas);
    }
  }
  return { svg, pdf };
}

/** The layers that are drawn when a layer or a page is exported: it and everything in it. */
function drawnIds(doc: Document, nodeId: NodeId): NodeId[] {
  return [nodeId, ...getDescendantIds(doc, nodeId)];
}

/**
 * Makes the file of one export. Returns it with what could not be written
 * as designed, in words. Throws an `ExportError` when there is nothing to
 * export or it is too big.
 */
export async function exportOne(doc: Document, target: ExportTarget, env: ExportEnvironment): Promise<{ file: ExportedFile; warnings: string[] }> {
  const { setting } = target;
  const area = exportArea(doc, target.nodeId);
  if (!area || area.bounds.width <= 0 || area.bounds.height <= 0) throw new ExportError(`“${doc.nodes[target.nodeId]?.name ?? 'This'}” has nothing in it to export.`);
  const scale = exportScale(setting.constraint, area.bounds.width, area.bounds.height);
  const mimeType = EXPORT_MIME_TYPES[setting.format];
  const warnings = new Set<string>();
  const origin = { x: area.bounds.x, y: area.bounds.y };

  if (setting.format === 'PNG' || setting.format === 'JPG') {
    // A JPG has no transparency: it lies on the page's colour when asked, on white otherwise.
    const under = setting.background ? area.background : setting.format === 'JPG' ? WHITE : null;
    const canvas = draw(doc, area, scale, under, env);
    const bytes = await env.encode(canvas, setting.format === 'PNG' ? 'image/png' : 'image/jpeg', setting.quality);
    return { file: { name: target.fileName, mimeType, bytes, width: canvas.width, height: canvas.height }, warnings: [] };
  }

  const scene = (roots: readonly NodeId[] | null, at: { x: number; y: number }) => buildVectorScene(doc, roots ?? { pageId: area.pageId }, { measurer: env.measurer, origin: at });
  const assets = await assetsFor(doc, drawnIds(doc, target.nodeId), env, warnings);

  if (setting.format === 'SVG') {
    const out = exportSvg(scene(area.roots, origin), { width: area.bounds.width, height: area.bounds.height, scale, background: setting.background ? area.background : null, ids: setting.svgIds, images: assets.svg });
    for (const warning of out.warnings) warnings.add(warning);
    return { file: { name: target.fileName, mimeType, bytes: new TextEncoder().encode(out.svg), width: area.bounds.width * scale, height: area.bounds.height * scale }, warnings: [...warnings] };
  }

  // PDF. A page of the design becomes one PDF page for each frame laid out on it, when it has any; anything else is one page.
  const parts: { bounds: Rect; roots: NodeId[] | null }[] = [];
  if (area.roots === null) {
    for (const id of getChildIds(doc, area.pageId)) {
      const child = doc.nodes[id];
      if (isLayer(child) && child.visible && child.type === 'FRAME') parts.push({ bounds: getRenderBounds(doc, id), roots: [id] });
    }
  }
  if (parts.length === 0) parts.push({ bounds: area.bounds, roots: area.roots });
  const pages: PdfPage[] = [];
  const textPictures: Record<string, PlacedPicture> = {};
  const effectPictures: Record<string, EffectPictures> = {};
  for (const part of parts) {
    const size = { width: part.bounds.width * scale, height: part.bounds.height * scale };
    const background = setting.background ? area.background : null;
    if (setting.pdfContent === 'PICTURE') {
      // As a picture, at twice the size it is shown at, so that it stays sharp when looked at closely.
      const canvas = draw(doc, { pageId: area.pageId, bounds: part.bounds, roots: part.roots }, Math.min(4, Math.max(1, scale * 2)), background ?? WHITE, env);
      pages.push({ ...size, picture: pixelsOf(canvas) });
      continue;
    }
    const partScene = scene(part.roots, { x: part.bounds.x, y: part.bounds.y });
    // The size of a vector page is its scale: the drawing is the design's own, the page is that many points.
    partScene.matrix = multiply([scale, 0, 0, scale, 0, 0], partScene.matrix);
    pages.push({ ...size, background, scene: partScene });
    const ids = part.roots ? part.roots.flatMap((id) => drawnIds(doc, id)) : getDescendantIds(doc, area.pageId);
    // Shadows and blurs, which PDF cannot draw, as pictures made by the renderer.
    Object.assign(effectPictures, effectPicturesFor(doc, ids, Math.min(4, Math.max(1, scale * 2)), env, warnings));
    // Text as pictures: each text layer drawn by itself, unrotated, in its own box.
    for (const id of ids) {
      const node = doc.nodes[id];
      if (!isLayer(node) || node.type !== 'TEXT' || !node.visible) continue;
      if (setting.pdfText !== 'PICTURE' && writableAsPdfText(node.characters)) continue;
      if (setting.pdfText !== 'PICTURE') warnings.add('Text with characters the standard PDF fonts do not have was written as a picture of the text.');
      textPictures[id] = textPicture(doc, node, env);
    }
  }
  const out = await exportPdf(pages, { images: assets.pdf, textPictures, effectPictures, measurer: env.measurer, deflate: env.deflate, title: doc.nodes[target.nodeId]?.name });
  for (const warning of out.warnings) warnings.add(warning);
  const first = pages[0] as PdfPage;
  return { file: { name: target.fileName, mimeType, bytes: out.bytes, width: first.width, height: first.height }, warnings: [...warnings] };
}

/** A picture of one text layer as it looks, in the layer's own space: what a PDF shows where the text cannot be written as text. */
function textPicture(doc: Document, node: LayerNode, env: ExportEnvironment): { image: PdfImage; x: number; y: number; width: number; height: number } {
  // Room round the box for what reaches out of it: a stroke, the tails of letters.
  const pad = Math.ceil(node.strokeWeight + 4);
  const width = node.width + pad * 2;
  const height = node.height + pad * 2;
  const scale = 3;
  // The layer alone on a page of its own, upright at the origin, fully opaque: its place, turn and opacity are the PDF group's.
  const pageId = pageIdOf(doc, node.id);
  const alone: Document = { ...doc, nodes: { ...doc.nodes, [node.id]: { ...node, parentId: pageId, x: 0, y: 0, rotation: 0, opacity: 1, effects: [] } } };
  const canvas = draw(alone, { pageId, bounds: { x: -pad, y: -pad, width, height }, roots: [node.id] }, scale, null, env);
  return { image: pixelsOf(canvas), x: -pad, y: -pad, width, height };
}

/**
 * A picture of one layer by itself, in the layer's own space: upright at the
 * origin, fully opaque and blended normally (its place, turn, opacity and
 * blend are the PDF group's), with some of its properties changed.
 */
function layerPicture(doc: Document, node: LayerNode, patch: Partial<LayerNode>, scale: number, env: ExportEnvironment, bounds?: Rect, hiddenIds?: ReadonlySet<NodeId>): PlacedPicture {
  const pageId = pageIdOf(doc, node.id);
  const alone: Document = { ...doc, nodes: { ...doc.nodes, [node.id]: { ...node, ...patch, parentId: pageId, x: 0, y: 0, rotation: 0, opacity: 1, blendMode: 'NORMAL' } as LayerNode } };
  const box = bounds ?? getRenderBounds(alone, node.id);
  const canvas = draw(alone, { pageId, bounds: box, roots: [node.id] }, scale, null, env, hiddenIds);
  return { image: pixelsOf(canvas), x: box.x, y: box.y, width: box.width, height: box.height };
}

/**
 * Pictures of the shadows and blurs of the layers a vector PDF draws, as
 * `exportPdf` takes them. A layer blur blurs everything in the layer, so the
 * whole layer is a picture. Otherwise the layer stays vectors: its drop
 * shadows alone are a picture laid under it, and its inner shadows alone
 * (drawn with no fills, strokes or contents) a picture laid over its fills.
 */
export function effectPicturesFor(doc: Document, ids: readonly NodeId[], scale: number, env: ExportEnvironment, warnings: Set<string>): Record<string, EffectPictures> {
  const out: Record<string, EffectPictures> = {};
  const inPicture = new Set<NodeId>();
  for (const id of ids) {
    const node = doc.nodes[id];
    if (inPicture.has(id) || !isLayer(node) || !node.visible || node.opacity <= 0) continue;
    const shown = node.effects.filter((effect) => effect.visible);
    const drops = shown.filter((effect) => effect.type === 'DROP_SHADOW');
    const inners = node.type === 'TEXT' || node.type === 'GROUP' || node.type === 'LINE' ? [] : shown.filter((effect) => effect.type === 'INNER_SHADOW');
    const blurred = shown.some((effect) => effect.type === 'LAYER_BLUR' && effect.radius > 0);
    if (drops.length === 0 && inners.length === 0 && !blurred) continue;
    try {
      if (blurred) {
        out[id] = { whole: layerPicture(doc, node, { effects: shown.filter((effect) => effect.type !== 'BACKGROUND_BLUR') }, scale, env) };
        // What is in it is in the picture.
        for (const inside of getDescendantIds(doc, id)) inPicture.add(inside);
        continue;
      }
      const entry: EffectPictures = {};
      if (drops.length > 0) {
        const withShadow = layerPicture(doc, node, { effects: drops }, scale, env);
        const without = layerPicture(doc, node, { effects: [] }, scale, env, withShadow);
        const image = withShadow.image as Extract<PdfImage, { kind: 'pixels' }>;
        entry.under = { ...withShadow, image: { kind: 'pixels', rgba: separateShadow(image.rgba, (without.image as typeof image).rgba), width: image.width, height: image.height } };
      }
      if (inners.length > 0) {
        entry.inner = layerPicture(doc, node, { effects: inners, fills: [], strokes: [] }, scale, env, undefined, new Set(getDescendantIds(doc, id)));
      }
      out[id] = entry;
    } catch (error) {
      if (!(error instanceof ExportError)) throw error;
      warnings.add('A shadow or blur too big to make a picture of was left out of the PDF.');
    }
  }
  return out;
}

function pageIdOf(doc: Document, id: NodeId): NodeId {
  let current = doc.nodes[id];
  for (let step = 0; current && current.parentId !== null && step < 1000; step++) current = doc.nodes[current.parentId];
  return current?.id ?? id;
}

/** Makes the files of several exports, in order. One that fails is left out, and why is among the warnings. */
export async function exportAll(doc: Document, targets: readonly ExportTarget[], env: ExportEnvironment): Promise<{ files: ExportedFile[]; warnings: string[] }> {
  const files: ExportedFile[] = [];
  const warnings = new Set<string>();
  for (const target of targets) {
    try {
      const out = await exportOne(doc, target, env);
      files.push(out.file);
      for (const warning of out.warnings) warnings.add(warning);
    } catch (error) {
      if (!(error instanceof ExportError)) throw error;
      warnings.add(error.message);
    }
  }
  return { files, warnings: [...warnings] };
}

/** A layer or page as SVG text, as it is copied: transparent, at its own size. */
export async function svgOf(doc: Document, nodeId: NodeId, env: ExportEnvironment, setting: Partial<ExportSetting> = {}): Promise<string> {
  const { file } = await exportOne(doc, { nodeId, fileName: 'copy.svg', setting: { format: 'SVG', constraint: { type: 'SCALE', value: 1 }, suffix: '', background: false, quality: 1, svgIds: false, pdfContent: 'VECTOR', pdfText: 'TEXT', ...setting } }, env);
  return new TextDecoder().decode(file.bytes);
}
