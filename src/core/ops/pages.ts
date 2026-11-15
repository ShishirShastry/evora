import { createPage, nextPageName } from '../document/factory';
import { patchNodes, setNodes } from '../document/mutate';
import { isPage, type DesignNode, type Document, type NodeId } from '../document/schema';
import { getChildIds, getDescendantIds, getPages } from '../scene/tree';
import { cloneSubtree } from './nodes';
import { insertionKeys } from './ordering';

/** Adds an empty page after `afterId`, or at the end. */
export function addPage(doc: Document, name?: string, afterId?: NodeId): { doc: Document; id: NodeId } {
  const pages = getChildIds(doc, null);
  const index = afterId !== undefined && pages.includes(afterId) ? pages.indexOf(afterId) + 1 : pages.length;
  const { keys, rekeyed } = insertionKeys(doc, null, index, 1);
  const page = createPage(name ?? nextPageName(doc), keys[0] as string);
  return { doc: setNodes(patchNodes(doc, rekeyed), { [page.id]: page }), id: page.id };
}

/** Deletes a page and everything on it. The last remaining page cannot be deleted. */
export function deletePage(doc: Document, pageId: NodeId): Document {
  if (!isPage(doc.nodes[pageId]) || getPages(doc).length <= 1) return doc;
  const changes: Record<NodeId, null> = { [pageId]: null };
  for (const id of getDescendantIds(doc, pageId)) changes[id] = null;
  return setNodes(doc, changes);
}

/** Copies a page with all of its layers and places the copy right after it. */
export function duplicatePage(doc: Document, pageId: NodeId): { doc: Document; id: NodeId } | null {
  const source = doc.nodes[pageId];
  if (!isPage(source)) return null;
  const added = addPage(doc, `${source.name} copy`, pageId);
  const changes: Record<NodeId, DesignNode> = {};
  for (const childId of getChildIds(doc, pageId)) {
    const clones = cloneSubtree(doc, childId);
    clones.forEach((clone, i) => {
      changes[clone.id] = i === 0 ? { ...clone, parentId: added.id } : clone;
    });
  }
  const next = patchNodes(setNodes(added.doc, changes), {
    [added.id]: { backgroundColor: { ...source.backgroundColor } },
  });
  return { doc: next, id: added.id };
}

/** Moves a page to `index` in the page list. */
export function movePage(doc: Document, pageId: NodeId, index: number): Document {
  if (!isPage(doc.nodes[pageId])) return doc;
  const { keys, rekeyed } = insertionKeys(doc, null, index, 1, new Set([pageId]));
  return patchNodes(doc, { ...rekeyed, [pageId]: { order: keys[0] as string } });
}
