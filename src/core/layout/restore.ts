import type { Document } from '../document/schema';
import { normalizeGroups } from '../ops/groups';
import { fitVectors } from '../ops/vector';
import { fitTextLayers, type TextMeasurer } from '../text/layout';
import { fitTextRanges } from '../text/ranges';
import { syncInstances } from '../components/instances';
import { applyAutoLayout } from './autoLayout';

/** More rounds than any real nesting needs; a document that has not settled by then is left as it is. */
const MAX_ROUNDS = 8;

/**
 * Restores everything about a document that follows from its content, after
 * an edit took it from `previous` to `next`: text sized to its characters,
 * vectors boxed round their curves, groups round their children, and every
 * Auto Layout frame laid out. These depend on each other (a frame hugs a
 * group that holds a text), so they are repeated until nothing changes. The
 * editor store runs this after every change, which is why a layout follows
 * what is typed, removed or resized in the same undo step.
 */
export function restoreLayout(previous: Document, next: Document, measurer: TextMeasurer): Document {
  // Instances first: what was changed in one becomes its override, and every instance gets its component's layers.
  let synced = syncInstances(previous, next, true);
  let doc = normalizeGroups(fitVectors(previous, fitTextLayers(previous, fitTextRanges(previous, synced), measurer)));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const laid = applyAutoLayout(doc, measurer);
    // A component that fitting or the layout resized is taken to its instances, which are then fitted and laid out too.
    const again = syncInstances(synced, laid, false);
    if (again === doc) break;
    synced = again;
    // What the layout resized may need fitting again: a text whose width a constraint changed, a group that was stretched.
    doc = normalizeGroups(fitVectors(doc, fitTextLayers(doc, again, measurer)));
  }
  return doc;
}
