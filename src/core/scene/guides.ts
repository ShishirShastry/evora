import { patchNode } from '../document/mutate';
import { isFrame, isLayer, isPage, type Document, type Guide, type NodeId, type NodeMap } from '../document/schema';
import type { Point } from '../math/geometry';
import type { SnapTargets } from './snap';
import { getChildIds, getWorldBounds, getWorldRotation } from './tree';

/**
 * Ruler guides. A page's guides are lines right across it, at positions in
 * page space. A frame can have guides of its own: they are positions in the
 * frame's own space, so they move with the frame, and they are lines across
 * the frame and no further.
 */

/**
 * The guide under a page-space point, if one is within `tolerance`. When
 * several are, the nearest wins, and among equals the one added last.
 * Returns its index in the page's guide list.
 */
export function hitGuide(guides: readonly Guide[], point: Point, tolerance: number): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  guides.forEach((guide, index) => {
    const distance = Math.abs((guide.axis === 'X' ? point.x : point.y) - guide.position);
    if (distance <= tolerance && distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** The guides that a page or a frame holds; none for anything else. */
export function guidesOf(doc: Document, ownerId: NodeId): readonly Guide[] {
  const owner = doc.nodes[ownerId];
  return isPage(owner) || isFrame(owner) ? owner.guides : [];
}

/**
 * Adds, moves or removes one guide of a page or of a frame:
 * - `index` null and a guide: the guide is added;
 * - an index and a guide: that guide is replaced;
 * - an index and null: that guide is removed.
 */
export function setGuide(doc: Document, ownerId: NodeId, index: number | null, guide: Guide | null): Document {
  const owner = doc.nodes[ownerId];
  if (!isPage(owner) && !isFrame(owner)) return doc;
  const current = owner.guides;
  let guides: Guide[];
  if (index === null) {
    if (!guide) return doc;
    guides = [...current, guide];
  } else {
    if (index < 0 || index >= current.length) return doc;
    const old = current[index] as Guide;
    if (guide && old.axis === guide.axis && old.position === guide.position) return doc;
    guides = guide ? current.map((other, i) => (i === index ? guide : other)) : current.filter((_, i) => i !== index);
  }
  return patchNode(doc, ownerId, { guides });
}

/** A page's guides as snap lines. They have no extent of their own: a snap guide is drawn only across what is being moved. */
export function guideSnapTargets(guides: readonly Guide[]): SnapTargets {
  const targets: SnapTargets = { xs: [], ys: [] };
  for (const guide of guides) {
    (guide.axis === 'X' ? targets.xs : targets.ys).push({ value: guide.position, from: Infinity, to: -Infinity });
  }
  return targets;
}

/** A guide of a frame, where it is on the page: a line across its frame. */
export interface PlacedGuide {
  ownerId: NodeId;
  /** Its index in its frame's guide list. */
  index: number;
  axis: Guide['axis'];
  /** Where the line is, in page space. */
  position: number;
  /** Where the line starts and ends along the other axis, in page space. */
  from: number;
  to: number;
}

/**
 * Can this frame show guides? A guide is a line along a page axis, so a frame
 * that is turned, or is inside something turned, cannot.
 */
export function frameTakesGuides(doc: Document, frameId: NodeId): boolean {
  return isFrame(doc.nodes[frameId]) && getWorldRotation(doc, frameId) === 0;
}

const placedCache = new WeakMap<NodeMap, Map<NodeId, PlacedGuide[]>>();

/**
 * The guides of the frames on a page, placed on the page: those of visible
 * frames that can show guides, and of each frame only the ones that lie
 * within it. Outer frames come first. Cached per document snapshot.
 */
export function frameGuides(doc: Document, pageId: NodeId): PlacedGuide[] {
  let perPage = placedCache.get(doc.nodes);
  if (!perPage) {
    perPage = new Map();
    placedCache.set(doc.nodes, perPage);
  }
  const cached = perPage.get(pageId);
  if (cached) return cached;
  const placed: PlacedGuide[] = [];
  const walk = (parentId: NodeId): void => {
    for (const id of getChildIds(doc, parentId)) {
      const node = doc.nodes[id];
      if (!isLayer(node) || !node.visible) continue;
      if (isFrame(node) && node.guides.length > 0 && getWorldRotation(doc, id) === 0) {
        const bounds = getWorldBounds(doc, id);
        node.guides.forEach((guide, index) => {
          const across = guide.axis === 'X';
          if (guide.position < 0 || guide.position > (across ? node.width : node.height)) return;
          placed.push(
            across
              ? { ownerId: id, index, axis: 'X', position: bounds.x + guide.position, from: bounds.y, to: bounds.y + bounds.height }
              : { ownerId: id, index, axis: 'Y', position: bounds.y + guide.position, from: bounds.x, to: bounds.x + bounds.width },
          );
        });
      }
      walk(id);
    }
  };
  walk(pageId);
  perPage.set(pageId, placed);
  return placed;
}

/**
 * The frame guide under a page-space point: within `tolerance` of the line,
 * and within the stretch of it that is drawn. The nearest wins, and among
 * equals the one drawn last (the innermost frame's).
 */
export function hitFrameGuide(guides: readonly PlacedGuide[], point: Point, tolerance: number): PlacedGuide | null {
  let best: PlacedGuide | null = null;
  let bestDistance = Infinity;
  for (const guide of guides) {
    const along = guide.axis === 'X' ? point.y : point.x;
    if (along < guide.from - tolerance || along > guide.to + tolerance) continue;
    const distance = Math.abs((guide.axis === 'X' ? point.x : point.y) - guide.position);
    if (distance <= tolerance && distance <= bestDistance) {
      best = guide;
      bestDistance = distance;
    }
  }
  return best;
}

/** How many guides a document holds in all, on its pages and in its frames. */
export function countGuides(doc: Document): number {
  let count = 0;
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (isPage(node) || isFrame(node)) count += node.guides.length;
  }
  return count;
}
