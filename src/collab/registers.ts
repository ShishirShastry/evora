import {
  CONTAINER_TYPES,
  diffDocuments,
  repairDocument,
  setNodes,
  type AssetInfo,
  type DesignNode,
  type Document,
  type DocumentPatch,
  type NodeId,
} from '../core';
import { keysBetween } from '../core/order';
import { compareClocks, EXISTS, nodeKey, observe, parseKey, tick, type Clock, type ClockState, type Register } from './protocol';

/**
 * A document as shared registers (see protocol.ts): turning a document into
 * registers, a local change into the registers it sets, and registers back
 * into a document. Everything here is pure apart from the `RegisterMap`,
 * which is the client's copy of the registers and changes only through its
 * methods.
 *
 * How merged changes become a valid document, the same everywhere:
 * - A node is shown when its `@` register is true, it has a type, and its
 *   parents lead to a page. A node whose parent (or any ancestor) has been
 *   deleted is not shown: the deletion wins, and it comes back with its
 *   parent if that deletion is undone.
 * - Two layers given the same place in their stack (both put on top at the
 *   same moment) are both kept: the one with the lower ID keeps the key and
 *   the other gets a key just above it, so every copy shows the same order.
 * - When every page has been deleted (two people deleting the last two at
 *   once), the page deleted last comes back.
 * - Anything else that does not fit (two layers moved into each other, a
 *   value out of range) is put right by the core's `repairDocument`, which
 *   does so the same way wherever it runs.
 */

const TABLES = ['styles', 'variables', 'variableCollections'] as const;
type TableName = (typeof TABLES)[number];

/** A document change as the registers need it: the history's patch, plus the document's name and the image assets added. */
export interface SyncPatch extends DocumentPatch {
  name?: { before: string; after: string };
  /** Asset descriptions added (or changed) by the change, by hash. */
  assets?: Readonly<Record<string, AssetInfo>>;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The difference between two documents as the registers need it, or null when nothing differs. */
export function diffForSync(before: Document, after: Document): SyncPatch | null {
  const patch = diffDocuments(before, after);
  const name = before.name !== after.name ? { before: before.name, after: after.name } : null;
  let assets: Record<string, AssetInfo> | null = null;
  if (before.assets !== after.assets) {
    for (const hash in after.assets) if (!sameJson(before.assets[hash], after.assets[hash])) (assets ??= {})[hash] = after.assets[hash] as AssetInfo;
  }
  if (!patch && !name && !assets) return null;
  return { ...(patch ?? { nodes: {} }), ...(name ? { name } : {}), ...(assets ? { assets } : {}) };
}

/** Every property of a node as registers, its existence last (so a node is never shown before all of it has arrived). */
function pushNode(out: Register[], id: NodeId, node: DesignNode, c: Clock): void {
  const props = node as unknown as Record<string, unknown>;
  for (const prop in props) {
    if (prop === 'id' || props[prop] === undefined) continue;
    out.push({ k: nodeKey(id, prop), v: props[prop], c });
  }
  out.push({ k: nodeKey(id, EXISTS), v: true, c });
}

/** Every register of a document, all with one new clock: what a local file becomes when it is shared. */
export function registersFromDocument(doc: Document, clock: ClockState, now: number = Date.now()): Register[] {
  const c = tick(clock, now);
  const out: Register[] = [];
  for (const id of Object.keys(doc.nodes).sort()) pushNode(out, id, doc.nodes[id] as DesignNode, c);
  for (const table of TABLES) {
    const rows = doc[table] as Record<string, unknown>;
    for (const id in rows) out.push({ k: `t:${table}:${id}`, v: rows[id], c });
  }
  out.push({ k: 'd:name', v: doc.name, c });
  out.push({ k: 'd:publication', v: doc.publication, c });
  for (const hash in doc.assets) out.push({ k: `a:${hash}`, v: doc.assets[hash], c });
  return out;
}

/**
 * The registers a local change sets, all with one new clock: a node created
 * gets all its properties and `@` true, a deleted one `@` false, a changed one
 * each property that changed (null for one that was removed); entries of the
 * tables, the name, what is published and the asset descriptions added.
 * Returns an empty list (and makes no clock) when the patch changes nothing.
 */
export function opsFromPatch(patch: SyncPatch, next: Document, clock: ClockState, now: number = Date.now()): Register[] {
  let made: Clock | null = null;
  const c = (): Clock => (made ??= tick(clock, now));
  const out: Register[] = [];
  for (const id in patch.nodes) {
    const change = patch.nodes[id];
    if (!change) continue;
    if (change.after === null) out.push({ k: nodeKey(id, EXISTS), v: false, c: c() });
    else if (change.before === null) pushNode(out, id, (next.nodes[id] ?? change.after) as DesignNode, c());
    else {
      for (const prop in change.after) {
        if (prop === 'id') continue;
        const value = change.after[prop];
        out.push({ k: nodeKey(id, prop), v: value === undefined ? null : value, c: c() });
      }
    }
  }
  for (const table of TABLES) {
    const entries = patch.tables?.[table];
    for (const id in entries) out.push({ k: `t:${table}:${id}`, v: entries[id]?.after ?? null, c: c() });
  }
  if (patch.publication) out.push({ k: 'd:publication', v: patch.publication.after ?? null, c: c() });
  if (patch.name) out.push({ k: 'd:name', v: patch.name.after, c: c() });
  for (const hash in patch.assets) out.push({ k: `a:${hash}`, v: patch.assets[hash], c: c() });
  return out;
}

// ------------------------------------------------------------------ the client's copy of the registers

/**
 * The registers of one node. Most of a node's properties are set together
 * (when it is made), so they share one clock: `base`, with `clocks` holding
 * only the properties set later. That keeps a large document's registers to
 * about the size of the document itself.
 */
interface NodeEntry {
  values: Record<string, unknown>;
  base: Clock;
  clocks: Record<string, Clock>;
}

interface PendingEntry {
  /** The latest change made here to the register, not acknowledged yet. */
  local: Register;
  /** What the server is known to hold for it (null-prototype: undefined when it never had it). */
  confirmed: Register | undefined;
}

const ROOT = '';

/**
 * The client's copy of every register of a document, with the clock that set
 * each one. Changes made here are *pending* until the server acknowledges
 * them; what the server is known to hold for each of those is kept beside
 * them, so that a change the server refuses can be taken back.
 */
export class RegisterMap {
  private readonly nodes = new Map<NodeId, NodeEntry>();
  private readonly others = new Map<string, { v: unknown; c: Clock }>();
  private readonly pending = new Map<string, PendingEntry>();
  /** For each parent, the nodes whose `parentId` register names it (pages under ""). */
  private readonly children = new Map<string, Set<NodeId>>();
  private count = 0;
  private latest: Clock | null = null;

  constructor(registers?: Iterable<Register>) {
    if (registers) this.merge(registers);
  }

  /** The number of registers held. */
  get size(): number {
    return this.count;
  }

  /** The latest clock of any register ever held, or null when none has been. */
  get latestClock(): Clock | null {
    return this.latest;
  }

  get(key: string): Register | undefined {
    const parsed = parseKey(key);
    if (parsed.kind === 'node') {
      const entry = this.nodes.get(parsed.nodeId);
      if (!entry || !(parsed.prop in entry.values)) return undefined;
      return { k: key, v: entry.values[parsed.prop], c: entry.clocks[parsed.prop] ?? entry.base };
    }
    const held = this.others.get(key);
    return held ? { k: key, v: held.v, c: held.c } : undefined;
  }

  /** The value of a register, or undefined when there is none. */
  value(key: string): unknown {
    return this.get(key)?.v;
  }

  private clockOf(key: string): Clock | undefined {
    const parsed = parseKey(key);
    if (parsed.kind === 'node') {
      const entry = this.nodes.get(parsed.nodeId);
      return entry && parsed.prop in entry.values ? (entry.clocks[parsed.prop] ?? entry.base) : undefined;
    }
    return this.others.get(key)?.c;
  }

  private index(nodeId: NodeId, from: unknown, to: unknown): void {
    const key = (value: unknown): string | null => (typeof value === 'string' ? value : value === null ? ROOT : null);
    const before = key(from);
    const after = key(to);
    if (before === after) return;
    if (before !== null) this.children.get(before)?.delete(nodeId);
    if (after !== null) {
      let set = this.children.get(after);
      if (!set) this.children.set(after, (set = new Set()));
      set.add(nodeId);
    }
  }

  private put(register: Register): void {
    if (this.latest === null || compareClocks(register.c, this.latest) > 0) this.latest = register.c;
    const parsed = parseKey(register.k);
    if (parsed.kind === 'node') {
      let entry = this.nodes.get(parsed.nodeId);
      if (!entry) {
        entry = { values: Object.create(null) as Record<string, unknown>, base: register.c, clocks: Object.create(null) as Record<string, Clock> };
        this.nodes.set(parsed.nodeId, entry);
      }
      const had = parsed.prop in entry.values;
      if (parsed.prop === 'parentId') this.index(parsed.nodeId, had ? entry.values.parentId : undefined, register.v);
      if (!had) this.count++;
      entry.values[parsed.prop] = register.v;
      if (register.c === entry.base) delete entry.clocks[parsed.prop];
      else entry.clocks[parsed.prop] = register.c;
      return;
    }
    if (!this.others.has(register.k)) this.count++;
    this.others.set(register.k, { v: register.v, c: register.c });
  }

  private remove(key: string): void {
    const parsed = parseKey(key);
    if (parsed.kind === 'node') {
      const entry = this.nodes.get(parsed.nodeId);
      if (!entry || !(parsed.prop in entry.values)) return;
      if (parsed.prop === 'parentId') this.index(parsed.nodeId, entry.values.parentId, undefined);
      delete entry.values[parsed.prop];
      delete entry.clocks[parsed.prop];
      this.count--;
      return;
    }
    if (this.others.delete(key)) this.count--;
  }

  /**
   * Sets a register for a change made here. It is pending until acknowledged.
   * Returns false, and changes nothing, when a later clock is already held
   * (which a clock made with `tick` after `observe`-ing everything never is).
   */
  setLocal(register: Register): boolean {
    const held = this.clockOf(register.k);
    if (held !== undefined && compareClocks(register.c, held) <= 0) return false;
    const entry = this.pending.get(register.k);
    if (entry) entry.local = register;
    else this.pending.set(register.k, { local: register, confirmed: held === undefined ? undefined : this.get(register.k) });
    this.put(register);
    return true;
  }

  /**
   * Merges registers from elsewhere (the server, or another copy): each one
   * is kept where its clock is later than what is held, so a remote register
   * older than a pending change made here is ignored. Duplicates and any order
   * give the same result. Returns the keys whose value was replaced. With
   * `clock`, every clock seen is taken in, so later local changes are later.
   */
  merge(registers: Iterable<Register>, clock?: ClockState): string[] {
    const won = new Set<string>();
    for (const register of registers) {
      if (!register || typeof register.k !== 'string' || typeof register.c !== 'string') continue;
      if (clock) observe(clock, register.c);
      const entry = this.pending.get(register.k);
      if (entry) {
        if (register.c === entry.local.c) this.pending.delete(register.k);
        else if (!entry.confirmed || compareClocks(register.c, entry.confirmed.c) > 0) entry.confirmed = { k: register.k, v: register.v, c: register.c };
      }
      const held = this.clockOf(register.k);
      if (held !== undefined && compareClocks(register.c, held) <= 0) continue;
      this.put({ k: register.k, v: register.v === undefined ? null : register.v, c: register.c });
      won.add(register.k);
      // A later change from someone else has replaced the one made here: it is no longer waiting for anything.
      if (entry && compareClocks(register.c, entry.local.c) > 0) this.pending.delete(register.k);
    }
    return [...won];
  }

  /** The server kept these registers (sent from here): they are no longer pending, unless changed here again since. */
  acknowledge(registers: Iterable<Register>): void {
    for (const register of registers) {
      const entry = this.pending.get(register.k);
      if (!entry) continue;
      if (entry.local.c === register.c) this.pending.delete(register.k);
      else if (!entry.confirmed || compareClocks(register.c, entry.confirmed.c) > 0) entry.confirmed = register;
    }
  }

  /**
   * The server refused these registers (sent from here): each goes back to
   * what the server is known to hold, unless it has been changed here again
   * since. Returns the keys whose value went back.
   */
  reject(registers: Iterable<Register>): string[] {
    const back: string[] = [];
    for (const register of registers) {
      const entry = this.pending.get(register.k);
      if (!entry || entry.local.c !== register.c) continue;
      this.pending.delete(register.k);
      if (entry.confirmed) this.put(entry.confirmed);
      else this.remove(register.k);
      back.push(register.k);
    }
    return back;
  }

  /** Takes back every pending change (for someone who may no longer edit). Returns the keys whose value went back. */
  dropPending(): string[] {
    return this.reject([...this.pending.values()].map((entry) => entry.local));
  }

  /** The changes made here that the server has not acknowledged, oldest clock first. */
  pendingRegisters(): Register[] {
    return [...this.pending.values()].map((entry) => entry.local).sort((a, b) => compareClocks(a.c, b.c));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  /** Every register held. */
  *registers(): IterableIterator<Register> {
    for (const [id, entry] of this.nodes) {
      for (const prop in entry.values) yield { k: nodeKey(id, prop), v: entry.values[prop], c: entry.clocks[prop] ?? entry.base };
    }
    for (const [k, held] of this.others) yield { k, v: held.v, c: held.c };
  }

  /** Every register as the server is known to hold it: pending changes are left out (what was there before them is kept instead). */
  confirmedRegisters(): Register[] {
    const out: Register[] = [];
    for (const register of this.registers()) {
      const entry = this.pending.get(register.k);
      if (!entry) out.push(register);
      else if (entry.confirmed) out.push(entry.confirmed);
    }
    return out;
  }

  /** The IDs of every node that has registers. */
  nodeIds(): IterableIterator<NodeId> {
    return this.nodes.keys();
  }

  /** The registers of one node as property values (null-prototype object; do not change it), or undefined. */
  nodeValues(id: NodeId): Readonly<Record<string, unknown>> | undefined {
    return this.nodes.get(id)?.values;
  }

  /** The clock of a node's `@` register, if it has one. */
  existsClock(id: NodeId): Clock | undefined {
    const entry = this.nodes.get(id);
    return entry && EXISTS in entry.values ? (entry.clocks[EXISTS] ?? entry.base) : undefined;
  }

  /** The nodes whose `parentId` register names this node (null: the pages). */
  childrenOf(id: NodeId | null): ReadonlySet<NodeId> {
    return this.children.get(id ?? ROOT) ?? EMPTY_SET;
  }

  /** The other registers (tables, the document's fields, assets) whose keys start with `prefix`. */
  *withPrefix(prefix: string): IterableIterator<Register> {
    for (const [k, held] of this.others) if (k.startsWith(prefix)) yield { k, v: held.v, c: held.c };
  }
}

const EMPTY_SET: ReadonlySet<NodeId> = new Set();

// ------------------------------------------------------------------ registers back into a document

type Status = 'shown' | 'hidden' | 'broken';

/**
 * Whether a node is in the document: shown; hidden (deleted, inside something
 * deleted, or not all here yet); or broken (its parents go round in a circle,
 * or its parent cannot hold layers), which `repairDocument` puts right.
 */
function statusOf(map: RegisterMap, id: NodeId, memo: Map<NodeId, Status>, revived: ReadonlySet<NodeId>): Status {
  const known = memo.get(id);
  if (known) return known;
  const chain: NodeId[] = [];
  const visiting = new Set<NodeId>();
  let current = id;
  let result: Status;
  for (;;) {
    const cached = memo.get(current);
    if (cached) {
      result = cached;
      break;
    }
    if (visiting.has(current)) {
      result = 'broken';
      break;
    }
    visiting.add(current);
    chain.push(current);
    const values = map.nodeValues(current);
    if (!values || (values[EXISTS] !== true && !revived.has(current)) || typeof values.type !== 'string') {
      result = 'hidden';
      break;
    }
    if (values.type === 'PAGE') {
      result = 'shown';
      break;
    }
    const parentId = values.parentId;
    const parent = typeof parentId === 'string' ? map.nodeValues(parentId) : undefined;
    if (typeof parentId !== 'string' || !parent || (parent[EXISTS] !== true && !revived.has(parentId))) {
      result = 'hidden';
      break;
    }
    if (typeof parent.type === 'string' && !CONTAINER_TYPES.includes(parent.type as DesignNode['type'])) {
      result = 'broken';
      break;
    }
    current = parentId;
  }
  for (const node of chain) memo.set(node, result);
  return result;
}

/** A node as its registers have it. */
function rawNode(map: RegisterMap, id: NodeId): Record<string, unknown> {
  return { ...(map.nodeValues(id) as Record<string, unknown>), id };
}

/**
 * New keys for the members of one stack that share a key (or have an empty
 * one), keeping the order they are shown in (by key, then by ID). Returns
 * null when keys cannot be made between them (malformed keys), for
 * `repairDocument` to rebuild the whole stack.
 */
export function separateOrders(members: ReadonlyArray<{ id: NodeId; order: string }>): Map<NodeId, string> | null {
  const sorted = [...members].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map<NodeId, string>();
  let previous: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const member = sorted[i] as { id: NodeId; order: string };
    if (member.order !== '' && (previous === null || member.order > previous)) {
      previous = member.order;
      continue;
    }
    let next: string | null = null;
    for (let j = i + 1; j < sorted.length; j++) {
      const order = (sorted[j] as { order: string }).order;
      if (previous === null || order > previous) {
        next = order;
        break;
      }
    }
    const key: string | undefined = keysBetween(previous, next, 1)?.[0];
    if (!key) return null;
    out.set(member.id, key);
    previous = key;
  }
  return out;
}

/** What `buildDocument` makes, with what it put right that the registers do not say. */
export interface BuiltDocument {
  doc: Document;
  /**
   * True when the document places some node differently from its registers
   * (a page brought back, a node `repairDocument` moved): then only a full
   * rebuild is sure to give the same result as everywhere else.
   */
  irregular: boolean;
}

/** The raw tables, name, publication and assets of the registers. */
function rawDocumentFields(map: RegisterMap): { styles: Record<string, unknown>; variables: Record<string, unknown>; variableCollections: Record<string, unknown>; assets: Record<string, unknown>; name: unknown; publication: unknown } {
  const tables: Record<TableName, Record<string, unknown>> = { styles: {}, variables: {}, variableCollections: {} };
  for (const table of TABLES) {
    const prefix = `t:${table}:`;
    const rows = tables[table];
    for (const register of [...map.withPrefix(prefix)].sort((a, b) => (a.k < b.k ? -1 : 1))) if (register.v !== null && register.v !== undefined) rows[register.k.slice(prefix.length)] = register.v;
  }
  const assets: Record<string, unknown> = {};
  for (const register of [...map.withPrefix('a:')].sort((a, b) => (a.k < b.k ? -1 : 1))) if (register.v !== null && register.v !== undefined) assets[register.k.slice(2)] = register.v;
  return { ...tables, assets, name: map.value('d:name'), publication: map.value('d:publication') ?? null };
}

/** The ID of the page made when the registers never had one: the same everywhere. */
export function firstPageId(docId: string): NodeId {
  return `page${docId}`;
}

/** Rebuilds the whole document from the registers (see the rules at the top of this file). */
export function buildDocument(map: RegisterMap, base: { id: string; name: string }): BuiltDocument {
  const ids = [...map.nodeIds()].sort();
  const memo = new Map<NodeId, Status>();
  let revived = new Set<NodeId>();
  let irregular = false;

  // Every page deleted: the one deleted last comes back.
  const pages = ids.filter((id) => map.nodeValues(id)?.type === 'PAGE');
  const designable = (id: NodeId): boolean => {
    const library = map.nodeValues(id)?.library;
    return library === null || library === undefined;
  };
  if (pages.length > 0 && !pages.some((id) => statusOf(map, id, memo, revived) === 'shown' && designable(id))) {
    const candidates = pages.filter(designable);
    const last = (candidates.length > 0 ? candidates : pages).reduce((a, b) => {
      const ca = map.existsClock(a) ?? '';
      const cb = map.existsClock(b) ?? '';
      return compareClocks(ca, cb) >= 0 ? a : b;
    });
    revived = new Set([last]);
    memo.clear();
    irregular = true;
  }

  const nodes: Record<NodeId, Record<string, unknown>> = {};
  const groups = new Map<string, NodeId[]>();
  for (const id of ids) {
    const status = statusOf(map, id, memo, revived);
    if (status === 'hidden') continue;
    if (status === 'broken') irregular = true;
    const node = rawNode(map, id);
    delete node[EXISTS];
    nodes[id] = node;
    if (status === 'shown') {
      const parent = typeof node.parentId === 'string' ? node.parentId : ROOT;
      const group = groups.get(parent);
      if (group) group.push(id);
      else groups.set(parent, [id]);
    }
  }
  if (pages.length === 0) {
    // No page ever: one is made, with an ID that is the same everywhere.
    nodes[firstPageId(base.id)] = { id: firstPageId(base.id), type: 'PAGE', name: 'Page 1', parentId: null, order: 'a0' };
    irregular = true;
  }

  for (const members of groups.values()) {
    const orders = separateOrders(members.map((id) => ({ id, order: typeof nodes[id]?.order === 'string' ? (nodes[id]?.order as string) : '' })));
    if (!orders) continue;
    for (const [id, order] of orders) (nodes[id] as Record<string, unknown>).order = order;
  }

  const fields = rawDocumentFields(map);
  const name = typeof fields.name === 'string' && fields.name ? fields.name : base.name;
  const { doc } = repairDocument({ id: base.id, name, nodes, assets: fields.assets, styles: fields.styles, variables: fields.variables, variableCollections: fields.variableCollections, publication: fields.publication });
  if (!irregular) {
    for (const id in doc.nodes) {
      const node = doc.nodes[id] as DesignNode;
      if (node.parentId !== (nodes[id]?.parentId ?? null) || !nodes[id]) {
        irregular = true;
        break;
      }
    }
  }
  return { doc, irregular };
}

/**
 * Rebuilds a document from registers, the same way wherever it runs, and
 * passes it through the core's `repairDocument`, so that a document made of
 * merged changes is always valid.
 */
export function documentFromRegisters(registers: Iterable<Register> | RegisterMap, base: { id: string; name: string }): Document {
  const map = registers instanceof RegisterMap ? registers : new RegisterMap(registers);
  return buildDocument(map, base).doc;
}

// ------------------------------------------------------------------ applying registers that changed

/** A change to the document's registers that the registers do not hold yet: what this copy put right and should write. */
export interface Fix {
  k: string;
  v: unknown;
}

export interface Applied {
  doc: Document;
  /** Whether the whole document was rebuilt. */
  full: boolean;
  /** See `BuiltDocument.irregular`; pass it back next time. */
  irregular: boolean;
  /**
   * Registers to write so that they say what the document now shows (keys
   * given to layers that shared one, pages brought back, layers put back
   * on a page). Only someone who may edit writes them.
   */
  fixes: Fix[];
}

function sameNode(a: DesignNode | undefined, b: DesignNode): boolean {
  if (!a) return false;
  const pa = a as unknown as Record<string, unknown>;
  const pb = b as unknown as Record<string, unknown>;
  for (const key in pb) if (!sameJson(pa[key], pb[key])) return false;
  for (const key in pa) if (!(key in pb) && pa[key] !== undefined) return false;
  return true;
}

const MINI_PAGE = '__collab_mini_page__';

/**
 * Normalises nodes built from registers the way `repairDocument` does, one
 * at a time: they are repaired inside a small document of their own and
 * given back their real parents and places. Null where repair would drop one.
 */
function normalizeNodes(raw: ReadonlyArray<Record<string, unknown>>): Array<DesignNode | null> {
  const nodes: Record<string, unknown> = { [MINI_PAGE]: { id: MINI_PAGE, type: 'PAGE', name: 'Page', parentId: null, order: 'a0' } };
  raw.forEach((node, i) => {
    nodes[node.id as string] = node.type === 'PAGE' ? node : { ...node, parentId: MINI_PAGE, order: `a${i.toString(36).padStart(8, '0')}` };
  });
  const { doc } = repairDocument({ id: 'mini', name: 'mini', nodes });
  return raw.map((node) => {
    const fixed = doc.nodes[node.id as string];
    if (!fixed) return null;
    return { ...fixed, parentId: fixed.type === 'PAGE' ? null : node.parentId, order: typeof node.order === 'string' ? node.order : fixed.order } as DesignNode;
  });
}

/** What changes when a full rebuild is used: the nodes, tables and fields that differ, keeping every node that did not change. */
function adoptRebuilt(current: Document, rebuilt: Document): Document {
  const changes: Record<NodeId, DesignNode | null> = {};
  for (const id in current.nodes) if (!rebuilt.nodes[id]) changes[id] = null;
  for (const id in rebuilt.nodes) {
    const node = rebuilt.nodes[id] as DesignNode;
    if (!sameNode(current.nodes[id], node)) changes[id] = node;
  }
  let doc = setNodes(current, changes);
  const fields: Partial<Document> = {};
  for (const field of ['name', 'styles', 'variables', 'variableCollections', 'publication', 'assets'] as const) {
    if (!sameJson(current[field], rebuilt[field])) (fields as Record<string, unknown>)[field] = rebuilt[field];
  }
  if (rebuilt.id !== current.id) fields.id = rebuilt.id;
  if (Object.keys(fields).length > 0) doc = { ...doc, ...fields };
  return doc;
}

/** The registers to write so that the registers say where the document places each of these nodes. */
function structuralFixes(doc: Document, map: RegisterMap, ids: Iterable<NodeId>): Fix[] {
  const fixes: Fix[] = [];
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    const values = map.nodeValues(id);
    if (!values) {
      // Made here (the first page of a document that never had one): all of it.
      const props = node as unknown as Record<string, unknown>;
      for (const prop in props) if (prop !== 'id' && props[prop] !== undefined) fixes.push({ k: nodeKey(id, prop), v: props[prop] });
      fixes.push({ k: nodeKey(id, EXISTS), v: true });
      continue;
    }
    if (values.parentId !== node.parentId) fixes.push({ k: nodeKey(id, 'parentId'), v: node.parentId });
    if (values.order !== node.order) fixes.push({ k: nodeKey(id, 'order'), v: node.order });
    if (values[EXISTS] !== true) fixes.push({ k: nodeKey(id, EXISTS), v: true });
  }
  return fixes;
}

function rebuildAll(current: Document, map: RegisterMap, docId: string = current.id): Applied {
  const built = buildDocument(map, { id: docId, name: current.name });
  const doc = adoptRebuilt(current, built.doc);
  return { doc, full: true, irregular: built.irregular, fixes: built.irregular ? structuralFixes(doc, map, Object.keys(doc.nodes)) : orderFixes(doc, map) };
}

/** Order keys the document has that its registers do not (layers that shared a key). */
function orderFixes(doc: Document, map: RegisterMap): Fix[] {
  const fixes: Fix[] = [];
  for (const id in doc.nodes) {
    const order = (doc.nodes[id] as DesignNode).order;
    if (map.nodeValues(id)?.order !== order) fixes.push({ k: nodeKey(id, 'order'), v: order });
  }
  return fixes;
}

/**
 * Brings a document up to date with registers that changed (the keys given),
 * touching only what they concern: the result is the same as rebuilding the
 * whole document from the registers (`buildDocument`), which it falls back to
 * when the change is one only a full rebuild settles (a page brought back, a
 * node `repairDocument` has to move), and whenever `irregular` is passed.
 * A document rebuilt whole takes `docId` as its ID when it is given.
 */
export function applyRegisters(current: Document, map: RegisterMap, keys: Iterable<string>, options: { irregular?: boolean; docId?: string } = {}): Applied {
  if (options.irregular) return rebuildAll(current, map, options.docId);

  const touched = new Set<NodeId>();
  const structural = new Set<NodeId>();
  const reordered = new Set<NodeId>();
  let fieldsChanged = false;
  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed.kind === 'node') {
      touched.add(parsed.nodeId);
      if (parsed.prop === EXISTS || parsed.prop === 'parentId' || parsed.prop === 'type') structural.add(parsed.nodeId);
      else if (parsed.prop === 'order') reordered.add(parsed.nodeId);
    } else if (parsed.kind !== 'unknown') fieldsChanged = true;
  }

  // A node whose presence or parent changed may take everything under it in or out of the document.
  // (In a regular document every node hangs where its registers say, so the registers' children are the document's.)
  const affected = new Set(touched);
  const walked = new Set(structural);
  const stack = [...structural];
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    for (const child of map.childrenOf(id)) {
      if (walked.has(child)) continue;
      walked.add(child);
      affected.add(child);
      stack.push(child);
    }
  }

  const memo = new Map<NodeId, Status>();
  const none = new Set<NodeId>();
  const shown: NodeId[] = [];
  const changes: Record<NodeId, DesignNode | null> = {};
  for (const id of [...affected].sort()) {
    const status = statusOf(map, id, memo, none);
    if (status === 'broken') return rebuildAll(current, map);
    if (status === 'shown') shown.push(id);
    else if (current.nodes[id]) changes[id] = null;
  }
  const normalized = normalizeNodes(shown.map((id) => rawNode(map, id)).map((node) => {
    const copy = { ...node };
    delete copy[EXISTS];
    return copy;
  }));
  for (let i = 0; i < shown.length; i++) {
    const node = normalized[i];
    if (!node) return rebuildAll(current, map);
    const id = shown[i] as NodeId;
    if (!sameNode(current.nodes[id], node)) changes[id] = node;
  }
  let doc = setNodes(current, changes);

  // Removing a page can leave none to design on, which only a full rebuild settles.
  if (structural.size > 0) {
    let designable = false;
    for (const id of map.childrenOf(null)) {
      const page = doc.nodes[id];
      if (page?.type === 'PAGE' && !page.library) {
        designable = true;
        break;
      }
    }
    if (!designable) return rebuildAll(current, map);
  }

  // The stacks that gained, lost or reordered members get their keys apart again.
  const fixes: Fix[] = [];
  const stacks = new Set<string>();
  for (const id of affected) {
    const cameOrWent = Boolean(current.nodes[id]) !== Boolean(doc.nodes[id]);
    if (!structural.has(id) && !reordered.has(id) && !cameOrWent) continue;
    const before = current.nodes[id];
    const after = doc.nodes[id];
    if (before) stacks.add(before.parentId ?? ROOT);
    if (after) stacks.add(after.parentId ?? ROOT);
  }
  const orders: Record<NodeId, DesignNode> = {};
  for (const parent of stacks) {
    const members: { id: NodeId; order: string }[] = [];
    for (const id of map.childrenOf(parent === ROOT ? null : parent)) {
      const node = doc.nodes[id];
      if (!node || (node.parentId ?? ROOT) !== parent) continue;
      const order = map.nodeValues(id)?.order;
      if (typeof order !== 'string') return rebuildAll(current, map);
      members.push({ id, order });
    }
    const separated = separateOrders(members);
    if (!separated) return rebuildAll(current, map);
    for (const member of members) {
      const order = separated.get(member.id) ?? member.order;
      const node = doc.nodes[member.id] as DesignNode;
      if (node.order !== order) orders[member.id] = { ...node, order } as DesignNode;
      if (separated.has(member.id)) fixes.push({ k: nodeKey(member.id, 'order'), v: order });
    }
  }
  doc = setNodes(doc, orders);

  if (fieldsChanged) {
    const fields = rawDocumentFields(map);
    const { doc: repaired } = repairDocument({ id: current.id, name: typeof fields.name === 'string' && fields.name ? fields.name : current.name, nodes: {}, assets: fields.assets, styles: fields.styles, variables: fields.variables, variableCollections: fields.variableCollections, publication: fields.publication });
    const next: Partial<Document> = {};
    for (const field of ['name', 'styles', 'variables', 'variableCollections', 'publication', 'assets'] as const) {
      if (!sameJson(doc[field], repaired[field])) (next as Record<string, unknown>)[field] = repaired[field];
    }
    if (Object.keys(next).length > 0) doc = { ...doc, ...next };
  }
  return { doc, full: false, irregular: false, fixes };
}

/** Whether a document places every node as its registers do (see `BuiltDocument.irregular`). */
export function isRegular(doc: Document, map: RegisterMap): boolean {
  for (const id in doc.nodes) {
    const node = doc.nodes[id] as DesignNode;
    const values = map.nodeValues(id);
    if (!values || values[EXISTS] !== true || values.parentId !== node.parentId) return false;
  }
  return true;
}
