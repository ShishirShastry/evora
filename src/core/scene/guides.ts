import { patchNode } from '../document/mutate';
import { isPage, type Document, type Guide, type NodeId } from '../document/schema';
import type { Point } from '../math/geometry';
import type { SnapTargets } from './snap';

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

/**
 * Adds, moves or removes one guide of a page:
 * - `index` null and a guide: the guide is added;
 * - an index and a guide: that guide is replaced;
 * - an index and null: that guide is removed.
 */
export function setGuide(doc: Document, pageId: NodeId, index: number | null, guide: Guide | null): Document {
  const page = doc.nodes[pageId];
  if (!isPage(page)) return doc;
  let guides: Guide[];
  if (index === null) {
    if (!guide) return doc;
    guides = [...page.guides, guide];
  } else {
    if (index < 0 || index >= page.guides.length) return doc;
    const current = page.guides[index] as Guide;
    if (guide && current.axis === guide.axis && current.position === guide.position) return doc;
    guides = guide ? page.guides.map((other, i) => (i === index ? guide : other)) : page.guides.filter((_, i) => i !== index);
  }
  return patchNode(doc, pageId, { guides });
}

/** A page's guides as snap lines. They have no extent of their own: a snap guide is drawn only across what is being moved. */
export function guideSnapTargets(guides: readonly Guide[]): SnapTargets {
  const targets: SnapTargets = { xs: [], ys: [] };
  for (const guide of guides) {
    (guide.axis === 'X' ? targets.xs : targets.ys).push({ value: guide.position, from: Infinity, to: -Infinity });
  }
  return targets;
}
