import { isComponent, mirrorId, setOf } from '../components/instances';
import { createPage } from '../document/factory';
import { patchNodes, setNodes, setTable } from '../document/mutate';
import { isFrame, isLayer, isPage, type DesignNode, type Document, type LayerNode, type LibraryRef, type NodeId, type PageNode, type Publication } from '../document/schema';
import { repairDocument } from '../document/validate';
import { getChildIds, getDescendantIds, getLibraryPages, getPageIdOf } from '../scene/tree';
import { insertionKeys } from './ordering';

/**
 * Libraries. A document publishes its components, styles and variables;
 * another document adds that library and from then on has them: it can place
 * instances of the components, apply the styles and bind to the variables.
 *
 * What a document has from a library is a copy, kept in the document so that
 * the file is complete on its own: the components on a page of their own
 * that is never shown (`PageNode.library`), the styles and variables in the
 * document's tables, marked with the library they came from (`remote`). The
 * copies cannot be changed here. When the library is published again, the
 * copy is replaced, and because instances, style references and bindings go
 * by ID, and an imported item always gets the same ID, everything that uses
 * the library follows, keeping its overrides.
 */

type Content = Omit<Publication, 'version' | 'publishedAt'>;

/** The library a layer came from, when it is on a page that holds one. */
export function libraryOf(doc: Document, nodeId: NodeId): LibraryRef | null {
  const pageId = getPageIdOf(doc, nodeId);
  const page = pageId === null ? undefined : doc.nodes[pageId];
  return isPage(page) ? page.library : null;
}

/** The libraries a document has added. */
export function listLibraries(doc: Document): LibraryRef[] {
  return getLibraryPages(doc)
    .map((page) => page.library as LibraryRef)
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/** The component, or the set it is a variant in: what is published and imported as one. */
function rootOf(doc: Document, componentId: NodeId): NodeId {
  return setOf(doc, componentId)?.id ?? componentId;
}

/** Every component named anywhere in a value: as the component of an instance, in an override, as the value of a swap property. */
function componentsNamed(doc: Document, value: unknown, into: Set<NodeId>): void {
  if (typeof value === 'string') {
    if (isComponent(doc.nodes[value])) into.add(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) componentsNamed(doc, entry, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const key in value) componentsNamed(doc, (value as Record<string, unknown>)[key], into);
  }
}

/**
 * What a document would publish now: its own components and component sets,
 * the components those use (wherever they are from, so that what is
 * published is complete), and all its styles and variables.
 */
export function publishContent(doc: Document): Content {
  const roots: NodeId[] = [];
  const seen = new Set<NodeId>();
  const add = (id: NodeId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    roots.push(id);
  };
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!isFrame(node) || libraryOf(doc, id)) continue;
    if (node.kind === 'COMPONENT_SET' || (node.kind === 'COMPONENT' && !setOf(doc, id))) add(id);
  }
  const nodes: Record<NodeId, LayerNode> = {};
  for (let i = 0; i < roots.length; i++) {
    const rootId = roots[i] as NodeId;
    const named = new Set<NodeId>();
    for (const id of [rootId, ...getDescendantIds(doc, rootId)]) {
      const node = doc.nodes[id];
      if (!isLayer(node)) continue;
      // Also in the layers an instance mirrors: one of them may show a component that was swapped in.
      componentsNamed(doc, { componentId: (node as { componentId?: unknown }).componentId, overrides: (node as { overrides?: unknown }).overrides, propValues: (node as { propValues?: unknown }).propValues }, named);
      if (node.sourceId !== null) continue;
      nodes[id] = id === rootId ? { ...node, parentId: '' } : node;
    }
    for (const id of named) add(rootOf(doc, id));
  }
  roots.sort();
  return { roots, nodes, styles: doc.styles, variables: doc.variables, variableCollections: doc.variableCollections, assets: doc.assets };
}

/** How much a document would publish, for saying so before it does. */
export function publishCounts(content: Pick<Publication, 'nodes' | 'styles' | 'variables'>): { components: number; styles: number; variables: number } {
  let components = 0;
  for (const id in content.nodes) if ((content.nodes[id] as { kind?: string }).kind === 'COMPONENT') components++;
  return { components, styles: Object.keys(content.styles).length, variables: Object.keys(content.variables).length };
}

/** Whether the document differs from what it last published (or has something to publish and never did). */
export function hasUnpublishedChanges(doc: Document): boolean {
  const content = publishContent(doc);
  if (!doc.publication) {
    const counts = publishCounts(content);
    return counts.components + counts.styles + counts.variables > 0;
  }
  const { version: _version, publishedAt: _publishedAt, ...published } = doc.publication;
  return JSON.stringify(content) !== JSON.stringify({ roots: published.roots, nodes: published.nodes, styles: published.styles, variables: published.variables, variableCollections: published.variableCollections, assets: published.assets });
}

/**
 * Publishes the document as a library, or publishes it again as it is now:
 * the next version. `at` is the time, as an ISO string. A document with no
 * component, style or variable has nothing to publish.
 */
export function publishLibrary(doc: Document, at: string): Document {
  const content = publishContent(doc);
  const counts = publishCounts(content);
  if (counts.components + counts.styles + counts.variables === 0) return doc;
  if (doc.publication && !hasUnpublishedChanges(doc)) return doc;
  return { ...doc, publication: { version: (doc.publication?.version ?? 0) + 1, publishedAt: at, ...content } };
}

/** Stops offering the document as a library. Documents that have it keep what they have. */
export function unpublishLibrary(doc: Document): Document {
  return doc.publication ? { ...doc, publication: null } : doc;
}

/** The ID of the page that holds a library's components in a document that has added it. */
function libraryPageId(libraryId: string): NodeId {
  return mirrorId(libraryId, 'library');
}

/** Names, texts and the like are never IDs, whatever they say. */
const NOT_IDS = new Set(['characters', 'name', 'description', 'fontFamily']);

/**
 * Adds a library to a document, or brings what the document has from it up
 * to the published version it is given. Everything imported gets an ID made
 * from the library's ID and its own there, the same every time, so what
 * already uses an imported component, style or variable goes on using it.
 * What the library no longer has goes: instances of a removed component
 * become ordinary frames, and layers keep the look a removed style or
 * variable gave them. A document cannot add itself.
 */
export function importLibrary(doc: Document, source: { id: string; name: string; publication: Publication }): Document {
  if (source.id === doc.id) return doc;
  const published = source.publication;
  const pageId = libraryPageId(source.id);
  const ids = new Map<string, string>();
  for (const part of [published.nodes, published.styles, published.variables, published.variableCollections]) {
    for (const id in part) ids.set(id, mirrorId(source.id, id));
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === 'string') return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(remap);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const key in value) {
      const entry = (value as Record<string, unknown>)[key];
      out[ids.get(key) ?? key] = NOT_IDS.has(key) ? entry : remap(entry);
    }
    return out;
  };

  const existing = doc.nodes[pageId];
  const order = isPage(existing) ? existing.order : (insertionKeys(doc, null, getChildIds(doc, null).length, 1).keys[0] as string);
  const page: PageNode = { ...createPage(source.name, order), id: pageId, library: { id: source.id, name: source.name, version: published.version } };
  const rawNodes: Record<string, unknown> = { [pageId]: page };
  const roots = new Set(published.roots);
  for (const id in published.nodes) {
    const node = remap(published.nodes[id]) as Record<string, unknown>;
    if (roots.has(id)) node.parentId = pageId;
    rawNodes[node.id as string] = node;
  }
  const from = (table: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const id in table) {
      const entry = remap(table[id]) as Record<string, unknown>;
      out[entry.id as string] = { ...entry, remote: source.id };
    }
    return out;
  };
  // Checked like a document that is opened: what another file offers is taken on no more trust than a file is.
  const clean = repairDocument({
    id: source.id,
    name: source.name,
    nodes: rawNodes,
    assets: published.assets,
    styles: from(published.styles),
    variables: from(published.variables),
    variableCollections: from(published.variableCollections),
  }).doc;

  const changes: Record<NodeId, DesignNode | null> = {};
  if (isPage(existing)) for (const id of getDescendantIds(doc, pageId)) if (!clean.nodes[id]) changes[id] = null;
  for (const id in clean.nodes) {
    const node = clean.nodes[id] as DesignNode;
    // Only what is on the library's page: checking adds nothing else, but nothing else is taken either.
    if (id === pageId || getPageIdOf(clean, id) === pageId) changes[id] = node;
  }
  let next = setNodes(doc, changes);
  for (const table of ['styles', 'variables', 'variableCollections'] as const) {
    const rows: Record<string, Document[typeof table][string] | null> = {};
    for (const id in next[table]) if ((next[table][id] as { remote: string | null }).remote === source.id && !clean[table][id]) rows[id] = null;
    for (const id in clean[table]) rows[id] = clean[table][id] as Document[typeof table][string];
    next = setTable(next, table, rows);
  }
  const assets = { ...next.assets };
  let added = false;
  for (const hash in clean.assets) {
    if (hash in assets) continue;
    assets[hash] = clean.assets[hash] as Document['assets'][string];
    added = true;
  }
  return added ? { ...next, assets } : next;
}

/**
 * Takes a library out of a document. Instances of its components become
 * ordinary frames with the layers they had, and layers keep the look its
 * styles and variables gave them.
 */
export function removeLibrary(doc: Document, libraryId: string): Document {
  const pageId = libraryPageId(libraryId);
  const page = doc.nodes[pageId];
  let next = doc;
  if (isPage(page) && page.library) {
    const changes: Record<NodeId, null> = { [pageId]: null };
    for (const id of getDescendantIds(doc, pageId)) changes[id] = null;
    next = setNodes(next, changes);
  }
  for (const table of ['styles', 'variables', 'variableCollections'] as const) {
    const rows: Record<string, null> = {};
    for (const id in next[table]) if ((next[table][id] as { remote: string | null }).remote === libraryId) rows[id] = null;
    next = setTable(next, table, rows);
  }
  // A mode of a collection that is gone is chosen nowhere any more.
  const patches: Record<NodeId, { variableModes: Record<string, string> }> = {};
  for (const id in next.nodes) {
    const node = next.nodes[id] as DesignNode;
    const stale = Object.keys(node.variableModes).filter((collectionId) => !next.variableCollections[collectionId]);
    if (stale.length === 0) continue;
    const variableModes = { ...node.variableModes };
    for (const collectionId of stale) delete variableModes[collectionId];
    patches[id] = { variableModes };
  }
  return patchNodes(next, patches);
}
