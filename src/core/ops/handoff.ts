import { patchNodes } from '../document/mutate';
import { isFrame, isLayer, type Annotation, type CodeConnect, type DevResource, type DevStatus, type Document, type LayerNode, type NodeId } from '../document/schema';
import { createId } from '../ids';
import { getDescendantIds, getLibraryPages, getPages } from '../scene/tree';

/**
 * Handing a design to developers: marking what is ready, leaving notes on
 * layers, attaching links, and saying how a component is known in code.
 */

/** Marks layers as ready for development, as built, or as neither. */
export function setDevStatus(doc: Document, ids: readonly NodeId[], status: DevStatus): Document {
  const patches: Record<NodeId, { devStatus: DevStatus }> = {};
  for (const id of ids) if (isLayer(doc.nodes[id])) patches[id] = { devStatus: status };
  return patchNodes(doc, patches);
}

/** The layers of a document that are marked ready for development or as built, page by page, by name. */
export function devStatusList(doc: Document): { pageId: NodeId; layer: LayerNode }[] {
  const out: { pageId: NodeId; layer: LayerNode }[] = [];
  for (const page of getPages(doc)) {
    const found: LayerNode[] = [];
    for (const id of getDescendantIds(doc, page.id)) {
      const node = doc.nodes[id];
      if (isLayer(node) && node.devStatus !== 'NONE') found.push(node);
    }
    found.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    for (const layer of found) out.push({ pageId: page.id, layer });
  }
  return out;
}

/** Leaves a note on a layer. */
export function addAnnotation(doc: Document, layerId: NodeId, text: string): { doc: Document; id: string } | null {
  const node = doc.nodes[layerId];
  if (!isLayer(node)) return null;
  const annotation: Annotation = { id: createId(), text };
  return { doc: patchNodes(doc, { [layerId]: { annotations: [...node.annotations, annotation] } }), id: annotation.id };
}

export function updateAnnotation(doc: Document, layerId: NodeId, annotationId: string, text: string): Document {
  const node = doc.nodes[layerId];
  if (!isLayer(node) || !node.annotations.some((annotation) => annotation.id === annotationId)) return doc;
  return patchNodes(doc, { [layerId]: { annotations: node.annotations.map((annotation) => (annotation.id === annotationId ? { ...annotation, text } : annotation)) } });
}

export function removeAnnotation(doc: Document, layerId: NodeId, annotationId: string): Document {
  const node = doc.nodes[layerId];
  if (!isLayer(node) || !node.annotations.some((annotation) => annotation.id === annotationId)) return doc;
  return patchNodes(doc, { [layerId]: { annotations: node.annotations.filter((annotation) => annotation.id !== annotationId) } });
}

/** A note with the layer it is on and its number on the page: notes are numbered from 1 in the order the layers are painted. */
export interface PlacedAnnotation {
  number: number;
  layerId: NodeId;
  annotation: Annotation;
}

/** Every note on a page, numbered. */
export function annotationsOn(doc: Document, pageId: NodeId): PlacedAnnotation[] {
  const out: PlacedAnnotation[] = [];
  for (const id of getDescendantIds(doc, pageId)) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    for (const annotation of node.annotations) out.push({ number: out.length + 1, layerId: id, annotation });
  }
  return out;
}

/** A web address that is safe to follow from the application: http, https or mailto, and nothing that runs. */
export function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)[^\s]+$/i.test(trimmed) ? trimmed : null;
}

/** Attaches a link to a layer. The address must be one that is safe to follow. */
export function addDevResource(doc: Document, layerId: NodeId, name: string, url: string): { doc: Document; id: string } | null {
  const node = doc.nodes[layerId];
  const address = safeUrl(url);
  if (!isLayer(node) || address === null) return null;
  const resource: DevResource = { id: createId(), name: name.trim() || address, url: address };
  return { doc: patchNodes(doc, { [layerId]: { devResources: [...node.devResources, resource] } }), id: resource.id };
}

export function removeDevResource(doc: Document, layerId: NodeId, resourceId: string): Document {
  const node = doc.nodes[layerId];
  if (!isLayer(node) || !node.devResources.some((resource) => resource.id === resourceId)) return doc;
  return patchNodes(doc, { [layerId]: { devResources: node.devResources.filter((resource) => resource.id !== resourceId) } });
}

/** Says how a component (or a set, for all its variants) is known in code, or with null takes that away. */
export function setCodeConnect(doc: Document, componentId: NodeId, connect: CodeConnect | null): Document {
  const node = doc.nodes[componentId];
  if (!isFrame(node) || (node.kind !== 'COMPONENT' && node.kind !== 'COMPONENT_SET')) return doc;
  // What came from a library is described in the library.
  if (getLibraryPages(doc).some((page) => getDescendantIds(doc, page.id).includes(componentId))) return doc;
  const cleaned = connect && (connect.component.trim() || connect.snippet.trim()) ? { component: connect.component.trim(), source: connect.source.trim(), snippet: connect.snippet } : null;
  return patchNodes(doc, { [componentId]: { codeConnect: cleaned } });
}
