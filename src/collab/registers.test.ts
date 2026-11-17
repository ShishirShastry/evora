import { describe, expect, it } from 'vitest';
import {
  addLayer,
  addPage,
  createDocument,
  createStyle,
  deleteNodes,
  deletePage,
  diffDocuments,
  getChildIds,
  getPages,
  moveNodesBy,
  patchNode,
  reorderNodes,
  reparentNodes,
  solidPaint,
  updateStyle,
  deleteStyle,
  validateDocument,
  type Document,
  type NodeId,
} from '../core';
import { makeClock, observe, parseKey, type ClockState, type Register } from './protocol';
import {
  applyRegisters,
  buildDocument,
  diffForSync,
  documentFromRegisters,
  opsFromPatch,
  RegisterMap,
  registersFromDocument,
  separateOrders,
} from './registers';

/** A clock of a client of its own. */
function clockOf(clientId: string): ClockState {
  return { last: makeClock(0, 0, clientId), clientId };
}

/** A small document with a frame holding a rectangle and a text, a style and an image asset. */
function sampleDocument(): Document {
  let doc = createDocument('Shared');
  const page = getPages(doc)[0]!.id;
  const frame = addLayer(doc, 'FRAME', page, { x: 10, y: 20, width: 300, height: 200 });
  const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 5, y: 5, fills: [solidPaint({ r: 1, g: 0, b: 0 })] });
  const text = addLayer(rect.doc, 'TEXT', frame.id, { characters: 'Hello', x: 40, y: 40 });
  doc = text.doc;
  const style = createStyle(doc, rect.id, 'fills', 'Red');
  if (style) doc = style.doc;
  doc = { ...doc, assets: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { mimeType: 'image/png', width: 4, height: 4, name: 'dot.png' } } };
  return doc;
}

describe('registers from a document and back', () => {
  it('gives back the same document', () => {
    const doc = sampleDocument();
    const registers = registersFromDocument(doc, clockOf('a'), 1000);
    const back = documentFromRegisters(registers, { id: doc.id, name: 'Other name' });
    expect(back).toEqual(doc);
    expect(validateDocument(back)).toEqual([]);
  });

  it('writes every node property, its existence last, and every table entry, the name and the assets', () => {
    const doc = sampleDocument();
    const registers = registersFromDocument(doc, clockOf('a'), 1000);
    const keys = registers.map((register) => register.k);
    for (const id in doc.nodes) {
      const own = keys.filter((key) => key.startsWith(`n:${id}:`));
      expect(own[own.length - 1]).toBe(`n:${id}:@`);
      expect(own).toContain(`n:${id}:parentId`);
      expect(own).toContain(`n:${id}:order`);
      expect(own).not.toContain(`n:${id}:id`);
    }
    expect(keys).toContain('d:name');
    expect(keys).toContain('d:publication');
    expect(keys).toContain('a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(keys.some((key) => key.startsWith('t:styles:'))).toBe(true);
    // One change, one clock.
    expect(new Set(registers.map((register) => register.c)).size).toBe(1);
  });

  it('makes a document with one page, the same everywhere, from no registers at all', () => {
    const a = documentFromRegisters([], { id: 'doc1', name: 'Empty' });
    const b = documentFromRegisters([], { id: 'doc1', name: 'Empty' });
    expect(a).toEqual(b);
    expect(getPages(a)).toHaveLength(1);
    expect(validateDocument(a)).toEqual([]);
  });
});

describe('the registers a local change sets', () => {
  it('sets a created layer whole, a deleted one as gone and only what changed of the others', () => {
    const doc = sampleDocument();
    const page = getPages(doc)[0]!.id;
    const [frameId, rectId, textId] = getChildIds(doc, page).flatMap((id) => [id, ...getChildIds(doc, id)]) as NodeId[];
    let next = moveNodesBy(doc, [rectId!], 7, 0);
    next = deleteNodes(next, [textId!]);
    const added = addLayer(next, 'ELLIPSE', frameId!);
    next = added.doc;
    const patch = diffForSync(doc, next)!;
    const ops = opsFromPatch(patch, next, clockOf('a'), 2000);
    const byKey = new Map(ops.map((register) => [register.k, register.v]));
    expect(byKey.get(`n:${rectId}:x`)).toBe(12);
    expect([...byKey.keys()].filter((key) => key.startsWith(`n:${rectId}:`))).toEqual([`n:${rectId}:x`]);
    expect(byKey.get(`n:${textId}:@`)).toBe(false);
    expect([...byKey.keys()].filter((key) => key.startsWith(`n:${textId}:`))).toEqual([`n:${textId}:@`]);
    expect(byKey.get(`n:${added.id}:@`)).toBe(true);
    expect(byKey.get(`n:${added.id}:type`)).toBe('ELLIPSE');
    expect(byKey.get(`n:${added.id}:parentId`)).toBe(frameId);
  });

  it('writes a removed property as null, and table entries, the name, what is published and assets added', () => {
    const doc = sampleDocument();
    const styleId = Object.keys(doc.styles)[0]!;
    let next = updateStyle(doc, styleId, { name: 'Brand red' });
    next = { ...next, name: 'Renamed', assets: { ...next.assets, dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd: { mimeType: 'image/jpeg', width: 2, height: 2, name: 'b.jpg' } } };
    const rect = Object.values(next.nodes).find((node) => node.type === 'RECTANGLE')!;
    const { cornerRadii: _removed, ...withoutRadii } = rect as unknown as Record<string, unknown>;
    void _removed;
    next = { ...next, nodes: { ...next.nodes, [rect.id]: withoutRadii as unknown as typeof rect } };
    const ops = opsFromPatch(diffForSync(doc, next)!, next, clockOf('a'), 2000);
    const byKey = new Map(ops.map((register) => [register.k, register.v]));
    expect((byKey.get(`t:styles:${styleId}`) as { name: string }).name).toBe('Brand red');
    expect(byKey.get('d:name')).toBe('Renamed');
    expect(byKey.get('a:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')).toMatchObject({ name: 'b.jpg' });
    expect(byKey.has('a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(byKey.get(`n:${rect.id}:cornerRadii`)).toBeNull();

    const removed = deleteStyle(next, styleId);
    const gone = opsFromPatch(diffForSync(next, removed)!, removed, clockOf('a'), 3000);
    expect(gone.find((register) => register.k === `t:styles:${styleId}`)?.v).toBeNull();
  });

  it('makes no clock for a change that changes nothing', () => {
    const clock = clockOf('a');
    const before = clock.last;
    expect(opsFromPatch({ nodes: {} }, createDocument(), clock, 5000)).toEqual([]);
    expect(clock.last).toBe(before);
  });
});

describe('the register map', () => {
  const reg = (k: string, v: unknown, ms: number, client = 'x'): Register => ({ k, v, c: makeClock(ms, 0, client) });

  it('keeps the latest clock whatever the order and however often a register arrives', () => {
    const a = reg('n:A:x', 1, 100, 'p');
    const b = reg('n:A:x', 2, 200, 'q');
    const c = reg('n:A:x', 3, 150, 'r');
    const one = new RegisterMap([a, b, c]);
    const two = new RegisterMap([c, c, b, a, b]);
    expect(one.value('n:A:x')).toBe(2);
    expect(two.value('n:A:x')).toBe(2);
    // Equal times are settled by the client's ID.
    const tie = new RegisterMap([reg('d:name', 'from q', 100, 'q'), reg('d:name', 'from p', 100, 'p')]);
    expect(tie.value('d:name')).toBe('from q');
  });

  it('says which keys a merge changed', () => {
    const map = new RegisterMap([reg('n:A:x', 1, 100)]);
    expect(map.merge([reg('n:A:x', 0, 50), reg('n:A:y', 5, 60), reg('n:A:x', 9, 300)])).toEqual(['n:A:y', 'n:A:x']);
    expect(map.merge([reg('n:A:x', 9, 300)])).toEqual([]);
  });

  it('ignores a remote register older than a change made here, and gives way to a later one', () => {
    const map = new RegisterMap([reg('n:A:x', 1, 100)]);
    expect(map.setLocal(reg('n:A:x', 2, 300, 'me'))).toBe(true);
    expect(map.pendingCount).toBe(1);
    expect(map.merge([reg('n:A:x', 7, 200, 'other')])).toEqual([]);
    expect(map.value('n:A:x')).toBe(2);
    expect(map.isPending('n:A:x')).toBe(true);
    expect(map.merge([reg('n:A:x', 8, 400, 'other')])).toEqual(['n:A:x']);
    expect(map.value('n:A:x')).toBe(8);
    expect(map.isPending('n:A:x')).toBe(false);
  });

  it('clears a pending change when it is acknowledged, but not one changed again since', () => {
    const map = new RegisterMap();
    const first = reg('n:A:x', 1, 100, 'me');
    const second = reg('n:A:x', 2, 200, 'me');
    map.setLocal(first);
    map.setLocal(second);
    map.acknowledge([first]);
    expect(map.isPending('n:A:x')).toBe(true);
    map.acknowledge([second]);
    expect(map.pendingCount).toBe(0);
    expect(map.value('n:A:x')).toBe(2);
  });

  it('takes a refused change back to what the server holds', () => {
    const map = new RegisterMap([reg('n:A:x', 1, 100)]);
    const mine = reg('n:A:x', 5, 300, 'me');
    map.setLocal(mine);
    // Meanwhile the server took someone else's change, older than mine.
    map.merge([reg('n:A:x', 3, 200, 'other')]);
    expect(map.value('n:A:x')).toBe(5);
    expect(map.reject([mine])).toEqual(['n:A:x']);
    expect(map.value('n:A:x')).toBe(3);
    // A register the server never had goes away altogether.
    const created = reg('n:B:@', true, 400, 'me');
    map.setLocal(created);
    map.reject([created]);
    expect(map.get('n:B:@')).toBeUndefined();
  });

  it('takes back every pending change at once, and keeps what the server holds for the snapshot', () => {
    const map = new RegisterMap([reg('n:A:x', 1, 100), reg('n:A:y', 1, 100)]);
    map.setLocal(reg('n:A:x', 2, 300, 'me'));
    expect(map.confirmedRegisters().find((register) => register.k === 'n:A:x')?.v).toBe(1);
    expect(map.pendingRegisters().map((register) => register.k)).toEqual(['n:A:x']);
    expect(map.dropPending()).toEqual(['n:A:x']);
    expect(map.value('n:A:x')).toBe(1);
    expect(map.pendingCount).toBe(0);
  });

  it('knows which nodes each node holds, and the latest clock', () => {
    const map = new RegisterMap([reg('n:A:parentId', 'P', 100), reg('n:B:parentId', 'P', 100), reg('n:P:parentId', null, 100)]);
    expect([...map.childrenOf('P')].sort()).toEqual(['A', 'B']);
    expect([...map.childrenOf(null)]).toEqual(['P']);
    map.merge([reg('n:A:parentId', 'Q', 200)]);
    expect([...map.childrenOf('P')]).toEqual(['B']);
    expect([...map.childrenOf('Q')]).toEqual(['A']);
    expect(map.latestClock).toBe(makeClock(200, 0, 'x'));
    expect(map.size).toBe(3);
  });
});

/** One copy of a shared document: its registers, clock and document, and what it has sent. */
interface Replica {
  name: string;
  map: RegisterMap;
  clock: ClockState;
  doc: Document;
  irregular: boolean;
  sent: Register[][];
}

let time = 10_000;

function replica(name: string, start: Register[], base: Document): Replica {
  const map = new RegisterMap(start);
  const built = buildDocument(map, { id: base.id, name: base.name });
  const clock = clockOf(name);
  if (map.latestClock) observe(clock, map.latestClock);
  return { name, map, clock, doc: built.doc, irregular: built.irregular, sent: [] };
}

/** A change made on one copy, as the live engine makes it: its registers set here and sent. */
function local(r: Replica, change: (doc: Document) => Document): void {
  const next = change(r.doc);
  const patch = diffForSync(r.doc, next);
  if (!patch) return;
  const ops = opsFromPatch(patch, next, r.clock, (time += 3));
  for (const register of ops) r.map.setLocal(register);
  r.doc = next;
  // Where layers are is checked against the registers, as the engine does after a change of structure.
  receiveKeys(r, ops.map((register) => register.k).filter((key) => /:(@|parentId|order)$/.test(key)));
  r.sent.push(ops);
}

function receiveKeys(r: Replica, keys: string[]): void {
  const applied = applyRegisters(r.doc, r.map, keys, { irregular: r.irregular });
  r.doc = applied.doc;
  r.irregular = applied.irregular;
  if (applied.fixes.length > 0) {
    const c = makeClock((time += 3), 0, r.name);
    r.clock.last = c;
    const ops = applied.fixes.map((fix) => ({ k: fix.k, v: fix.v, c }));
    for (const register of ops) r.map.setLocal(register);
    r.sent.push(ops);
  }
}

/** Registers from another copy arrive, travelling as JSON does. */
function receive(r: Replica, ops: Register[]): void {
  const keys = r.map.merge(JSON.parse(JSON.stringify(ops)) as Register[], r.clock);
  receiveKeys(r, keys);
}

/** A seeded random number generator, so a failing run can be repeated. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function layersOf(doc: Document): NodeId[] {
  return Object.keys(doc.nodes)
    .filter((id) => doc.nodes[id]?.type !== 'PAGE')
    .sort();
}

/** One random edit of the kinds people make together: create, move, reparent, restyle, delete, retype, reorder, styles. */
function randomEdit(doc: Document, next: () => number): Document {
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(next() * list.length)];
  const pages = getPages(doc).map((page) => page.id);
  const layers = layersOf(doc);
  const frames = layers.filter((id) => doc.nodes[id]?.type === 'FRAME');
  const texts = layers.filter((id) => doc.nodes[id]?.type === 'TEXT');
  const roll = next();
  if (roll < 0.22 || layers.length < 3) {
    const parent = next() < 0.5 && frames.length > 0 ? (pick(frames) as NodeId) : (pick(pages) as NodeId);
    const type = pick(['RECTANGLE', 'ELLIPSE', 'FRAME', 'TEXT'] as const)!;
    const index = next() < 0.5 ? undefined : Math.floor(next() * 3);
    return addLayer(doc, type, parent, { x: Math.round(next() * 200), y: Math.round(next() * 200), ...(type === 'TEXT' ? { characters: 'Text' } : {}) }, index).doc;
  }
  const id = pick(layers) as NodeId;
  if (roll < 0.36) return moveNodesBy(doc, [id], Math.round(next() * 20 - 10), Math.round(next() * 20 - 10));
  if (roll < 0.46) return reparentNodes(doc, [id], next() < 0.6 && frames.length > 0 ? (pick(frames) as NodeId) : (pick(pages) as NodeId));
  if (roll < 0.58) return patchNode(doc, id, { name: `Layer ${Math.floor(next() * 100)}`, opacity: Math.round(next() * 10) / 10, fills: [solidPaint({ r: next(), g: next(), b: next() })] });
  if (roll < 0.66) return deleteNodes(doc, [id]);
  if (roll < 0.74 && texts.length > 0) return patchNode(doc, pick(texts) as NodeId, { characters: `Typed ${Math.floor(next() * 1000)}` });
  if (roll < 0.84) return reorderNodes(doc, [id], pick(['front', 'back', 'forward', 'backward'] as const)!);
  if (roll < 0.9) {
    const made = createStyle(doc, id, 'fills', `Style ${Math.floor(next() * 100)}`);
    return made ? made.doc : doc;
  }
  if (roll < 0.94) {
    const style = pick(Object.keys(doc.styles));
    return style ? (next() < 0.5 ? updateStyle(doc, style, { name: `Renamed ${Math.floor(next() * 100)}` }) : deleteStyle(doc, style)) : doc;
  }
  if (roll < 0.97) return addPage(doc).doc;
  const page = pick(pages);
  return page && pages.length > 1 ? deletePage(doc, page) : doc;
}

/** Delivers every batch any copy sent to every other copy, in a shuffled order and some of them twice. */
function exchange(replicas: Replica[], next: () => number): void {
  for (let round = 0; round < 10; round++) {
    const deliveries: { to: Replica; ops: Register[] }[] = [];
    for (const from of replicas) {
      const batches = from.sent.splice(0);
      for (const to of replicas) if (to !== from) for (const ops of batches) {
        deliveries.push({ to, ops });
        if (next() < 0.2) deliveries.push({ to, ops });
      }
    }
    if (deliveries.length === 0) return;
    for (let i = deliveries.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [deliveries[i], deliveries[j]] = [deliveries[j]!, deliveries[i]!];
    }
    for (const { to, ops } of deliveries) receive(to, ops);
  }
  throw new Error('The copies kept writing fixes');
}

function expectConverged(replicas: Replica[]): void {
  const first = replicas[0]!;
  const reference = documentFromRegisters(first.map, { id: first.doc.id, name: first.doc.name });
  expect(validateDocument(reference)).toEqual([]);
  for (const r of replicas) {
    // Every copy holds the same registers, and its document (kept up to date change by change) is what they say.
    expect(documentFromRegisters(r.map, { id: r.doc.id, name: r.doc.name })).toEqual(reference);
    expect(r.doc).toEqual(reference);
  }
}

describe('copies that change the document at the same time', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`end up with the same document (random run ${seed})`, () => {
      const next = random(seed);
      const base = sampleDocument();
      const start = registersFromDocument(base, clockOf('origin'), 1000);
      const replicas = ['a', 'b', 'c'].map((name) => replica(name, start, base));
      for (let round = 0; round < 12; round++) {
        // Each copy makes a few changes without seeing the others'.
        for (const r of replicas) for (let i = 0; i < 1 + Math.floor(next() * 4); i++) local(r, (doc) => randomEdit(doc, next));
        // Sometimes only part of the traffic gets through before the next changes.
        if (next() < 0.5) exchange(replicas, next);
      }
      exchange(replicas, next);
      expectConverged(replicas);
    });
  }
});

describe('conflicts between two people', () => {
  function pair(): { a: Replica; b: Replica; frame: NodeId; rect: NodeId; page: NodeId } {
    const base = sampleDocument();
    const page = getPages(base)[0]!.id;
    const frame = getChildIds(base, page)[0]!;
    const rect = getChildIds(base, frame)[0]!;
    const start = registersFromDocument(base, clockOf('origin'), 1000);
    return { a: replica('a', start, base), b: replica('b', start, base), frame, rect, page };
  }

  it('deletes a layer one person deletes while the other changes it, and brings it back with the change when the deletion is undone', () => {
    const { a, b, rect } = pair();
    const before = a.doc;
    local(a, (doc) => deleteNodes(doc, [rect]));
    local(b, (doc) => patchNode(doc, rect, { name: 'Edited by B' }));
    exchange([a, b], random(9));
    expect(a.doc.nodes[rect]).toBeUndefined();
    expect(b.doc.nodes[rect]).toBeUndefined();
    // Undoing the deletion says the layer exists again; its properties are as the registers have them.
    const exists = { k: `n:${rect}:@`, v: true, c: makeClock((time += 5), 0, 'a') };
    a.map.setLocal(exists);
    receiveKeys(a, [exists.k]);
    a.sent.push([exists]);
    exchange([a, b], random(10));
    expect(a.doc.nodes[rect]?.name).toBe('Edited by B');
    expect(b.doc.nodes[rect]).toEqual(a.doc.nodes[rect]);
    expect({ ...a.doc.nodes[rect], name: before.nodes[rect]?.name }).toEqual(before.nodes[rect]);
  });

  it('hides a layer made inside a frame someone deleted at the same moment, and shows it again with the frame', () => {
    const { a, b, frame } = pair();
    local(a, (doc) => deleteNodes(doc, [frame]));
    let made = '';
    local(b, (doc) => {
      const added = addLayer(doc, 'ELLIPSE', frame);
      made = added.id;
      return added.doc;
    });
    exchange([a, b], random(11));
    expect(a.doc.nodes[made]).toBeUndefined();
    expect(b.doc.nodes[made]).toBeUndefined();
    expect(b.map.value(`n:${made}:@`)).toBe(true);
    expectConverged([a, b]);
    // The deletion undone (the frame and what it held exist again): the ellipse is back in it.
    const c = makeClock((time += 5), 0, 'a');
    const back = [frame, ...[...a.map.childrenOf(frame)].filter((id) => id !== made)].map((id) => ({ k: `n:${id}:@`, v: true, c }));
    for (const register of back) a.map.setLocal(register);
    receiveKeys(a, back.map((register) => register.k));
    a.sent.push(back);
    exchange([a, b], random(12));
    expect(b.doc.nodes[made]?.parentId).toBe(frame);
    expectConverged([a, b]);
  });

  it('keeps both layers put on top of the same stack at once, in the same order everywhere, and writes keys of their own', () => {
    const { a, b, frame } = pair();
    let fromA = '';
    let fromB = '';
    local(a, (doc) => {
      const added = addLayer(doc, 'RECTANGLE', frame, { name: 'A' });
      fromA = added.id;
      return added.doc;
    });
    local(b, (doc) => {
      const added = addLayer(doc, 'RECTANGLE', frame, { name: 'B' });
      fromB = added.id;
      return added.doc;
    });
    // Both took the same key.
    expect(a.doc.nodes[fromA]?.order).toBe(b.doc.nodes[fromB]?.order);
    exchange([a, b], random(13));
    const stackA = getChildIds(a.doc, frame);
    expect(stackA).toEqual(getChildIds(b.doc, frame));
    expect(stackA.slice(-2).sort()).toEqual([fromA, fromB].sort());
    // The keys were written apart, so a third layer put between them stays between them everywhere.
    expect(a.map.value(`n:${fromA}:order`)).not.toBe(a.map.value(`n:${fromB}:order`));
    const [lower, upper] = stackA.slice(-2) as [NodeId, NodeId];
    let between = '';
    local(a, (doc) => {
      const added = addLayer(doc, 'ELLIPSE', frame, {}, getChildIds(doc, frame).indexOf(upper));
      between = added.id;
      return added.doc;
    });
    exchange([a, b], random(14));
    expect(getChildIds(b.doc, frame).slice(-3)).toEqual([lower, between, upper]);
    expectConverged([a, b]);
  });

  it('gives the same order everywhere when both bring layers to the front at once', () => {
    const { a, b, frame } = pair();
    const [first, second] = getChildIds(a.doc, frame) as [NodeId, NodeId];
    local(a, (doc) => reorderNodes(doc, [first], 'front'));
    local(b, (doc) => reorderNodes(doc, [first], 'back'));
    local(b, (doc) => reorderNodes(doc, [second], 'front'));
    exchange([a, b], random(15));
    expect(getChildIds(a.doc, frame)).toEqual(getChildIds(b.doc, frame));
    expectConverged([a, b]);
  });

  it('keeps a valid document when two layers are moved into each other at once', () => {
    const base = createDocument('Cycle');
    const page = getPages(base)[0]!.id;
    const one = addLayer(base, 'FRAME', page, { name: 'One' });
    const two = addLayer(one.doc, 'FRAME', page, { name: 'Two', x: 300 });
    const start = registersFromDocument(two.doc, clockOf('origin'), 1000);
    const a = replica('a', start, two.doc);
    const b = replica('b', start, two.doc);
    local(a, (doc) => reparentNodes(doc, [one.id], two.id));
    local(b, (doc) => reparentNodes(doc, [two.id], one.id));
    exchange([a, b], random(16));
    expect(validateDocument(a.doc)).toEqual([]);
    expect(a.doc.nodes[one.id]).toBeDefined();
    expect(a.doc.nodes[two.id]).toBeDefined();
    expectConverged([a, b]);
    // What was put right was written down, so the registers no longer go round in a circle.
    expect(a.irregular).toBe(false);
  });

  it('brings back the page deleted last when both delete the last pages at once', () => {
    const base = addPage(sampleDocument(), 'Second').doc;
    const [first, second] = getPages(base).map((page) => page.id) as [NodeId, NodeId];
    const start = registersFromDocument(base, clockOf('origin'), 1000);
    const a = replica('a', start, base);
    const b = replica('b', start, base);
    local(a, (doc) => deletePage(doc, first));
    local(b, (doc) => deletePage(doc, second));
    exchange([a, b], random(17));
    expect(getPages(a.doc).map((page) => page.id)).toEqual([second]);
    expectConverged([a, b]);
  });

  it('keeps the last writer of a text when two people type in it at once', () => {
    const { a, b } = pair();
    const text = Object.values(a.doc.nodes).find((node) => node.type === 'TEXT')!.id;
    local(a, (doc) => patchNode(doc, text, { characters: 'From A' }));
    local(b, (doc) => patchNode(doc, text, { characters: 'From B, later' }));
    exchange([a, b], random(18));
    expect(a.doc.nodes[text]).toMatchObject({ characters: 'From B, later' });
    expectConverged([a, b]);
  });
});

describe('applying changed registers', () => {
  it('touches only the layers a change concerns', () => {
    const base = sampleDocument();
    const start = registersFromDocument(base, clockOf('origin'), 1000);
    const map = new RegisterMap(start);
    const doc = documentFromRegisters(map, { id: base.id, name: base.name });
    const rect = Object.values(doc.nodes).find((node) => node.type === 'RECTANGLE')!.id;
    const keys = map.merge([{ k: `n:${rect}:x`, v: 99, c: makeClock(5000, 0, 'b') }]);
    const applied = applyRegisters(doc, map, keys);
    expect(applied.full).toBe(false);
    expect(applied.doc.nodes[rect]).toMatchObject({ x: 99 });
    for (const id in doc.nodes) if (id !== rect) expect(applied.doc.nodes[id]).toBe(doc.nodes[id]);
  });

  it('separates keys shared in a stack keeping the order shown, and refuses malformed ones', () => {
    expect(separateOrders([{ id: 'b', order: 'a1' }, { id: 'a', order: 'a1' }, { id: 'c', order: 'a2' }])).toEqual(new Map([['b', expect.any(String)]]));
    const keys = separateOrders([{ id: 'b', order: 'a1' }, { id: 'a', order: 'a1' }, { id: 'c', order: 'a2' }])!;
    expect(keys.get('b')! > 'a1' && keys.get('b')! < 'a2').toBe(true);
    expect(separateOrders([{ id: 'x', order: '' }, { id: 'y', order: '' }])).toBeNull();
  });

  it('gives the same document as a full rebuild after every change of a long random run', () => {
    const next = random(42);
    const base = sampleDocument();
    const start = registersFromDocument(base, clockOf('origin'), 1000);
    const a = replica('a', start, base);
    const b = replica('b', start, base);
    for (let step = 0; step < 120; step++) {
      local(a, (doc) => randomEdit(doc, next));
      for (const ops of a.sent.splice(0)) receive(b, ops);
      b.sent.splice(0);
      expect(b.doc).toEqual(documentFromRegisters(b.map, { id: b.doc.id, name: b.doc.name }));
    }
    expect(diffDocuments(a.doc, b.doc)).toBeNull();
  });

  it('reads a key it does not know without failing', () => {
    const map = new RegisterMap(registersFromDocument(sampleDocument(), clockOf('origin'), 1000));
    const doc = documentFromRegisters(map, { id: 'x', name: 'x' });
    const keys = map.merge([{ k: 'z:future', v: 1, c: makeClock(9000, 0, 'b') }]);
    expect(parseKey(keys[0]!).kind).toBe('unknown');
    expect(applyRegisters(doc, map, keys).doc).toBe(doc);
  });
});
