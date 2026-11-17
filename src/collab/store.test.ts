import { describe, expect, it } from 'vitest';
import {
  addLayer,
  applyPatch,
  createDocument,
  deleteNodes,
  diffDocuments,
  getChildIds,
  getPages,
  moveNodesBy,
  patchNode,
  reparentNodes,
  solidPaint,
  validateDocument,
  addPage,
  deletePage,
  type Document,
  type NodeId,
} from '../core';
import { createEditorStore } from '../state/editorStore';

/**
 * The editor store's part in collaboration: changes from others shown
 * without entering the undo history, undo that touches only what its own
 * step changed and never breaks the document when others have deleted or
 * moved things since, and a read-only mode for people who may only view.
 */

function setup(): { doc: Document; page: NodeId; frame: NodeId; rect: NodeId; other: NodeId } {
  const base = createDocument('Shared');
  const page = getPages(base)[0]!.id;
  const frame = addLayer(base, 'FRAME', page, { x: 0, y: 0, width: 400, height: 300 });
  const rect = addLayer(frame.doc, 'RECTANGLE', frame.id, { x: 10, y: 10 });
  const other = addLayer(rect.doc, 'ELLIPSE', page, { x: 500, y: 0 });
  return { doc: other.doc, page, frame: frame.id, rect: rect.id, other: other.id };
}

describe('a patch applied after others changed the document', () => {
  it('does not bring a layer back under a parent someone else has deleted', () => {
    const { doc, frame, rect } = setup();
    const removed = deleteNodes(doc, [rect]);
    const patch = diffDocuments(doc, removed)!;
    // Someone else deletes the frame; then this person undoes their deletion of the rectangle.
    const theirs = deleteNodes(removed, [frame]);
    const undone = applyPatch(theirs, patch, 'backward');
    expect(undone.nodes[rect]).toBeUndefined();
    expect(validateDocument(undone)).toEqual([]);
  });

  it('leaves a layer as it is when the parent it would go back to is gone', () => {
    const { doc, frame, rect, page } = setup();
    const shifted = moveNodesBy(doc, [frame], 100, 0);
    const moved = reparentNodes(shifted, [rect], page);
    const patch = diffDocuments(shifted, moved)!;
    const theirs = deleteNodes(moved, [frame]);
    const undone = applyPatch(theirs, patch, 'backward');
    // Still on the page where it is, with its position on the page (not the one it had in the frame).
    expect(undone.nodes[rect]).toEqual(theirs.nodes[rect]);
    expect(undone.nodes[rect]?.parentId).toBe(page);
    expect(validateDocument(undone)).toEqual([]);
  });

  it('does not put a layer into one of its own descendants', () => {
    const { doc, frame, page } = setup();
    const second = addLayer(doc, 'FRAME', page, { x: 700, y: 0 });
    // This person moves the first frame into the second (and undoes it, then redoes it) ...
    const into = reparentNodes(second.doc, [frame], second.id);
    const patch = diffDocuments(second.doc, into)!;
    // ... while someone else has moved the second frame into the first.
    const theirs = reparentNodes(second.doc, [second.id], frame);
    expect(theirs.nodes[second.id]?.parentId).toBe(frame);
    const redone = applyPatch(theirs, patch, 'forward');
    // The first frame stays as it is, on the page, with its position.
    expect(redone.nodes[frame]).toEqual(theirs.nodes[frame]);
    expect(redone.nodes[second.id]?.parentId).toBe(frame);
    expect(validateDocument(redone)).toEqual([]);
  });

  it('gives a layer put back a place of its own when another layer has taken its key', () => {
    const { doc, frame, rect } = setup();
    const removed = deleteNodes(doc, [rect]);
    const patch = diffDocuments(doc, removed)!;
    // Someone else adds a layer that happens to take the same key.
    const theirs = addLayer(removed, 'RECTANGLE', frame);
    const same = patchNode(theirs.doc, theirs.id, { order: doc.nodes[rect]!.order });
    const undone = applyPatch(same, patch, 'backward');
    expect(undone.nodes[rect]).toBeDefined();
    expect(undone.nodes[rect]!.order).not.toBe(undone.nodes[theirs.id]!.order);
    expect(validateDocument(undone)).toEqual([]);
  });

  it('changes nothing when it applies to the document it was made from', () => {
    const { doc, rect } = setup();
    const moved = moveNodesBy(doc, [rect], 5, 5);
    const patch = diffDocuments(doc, moved)!;
    expect(applyPatch(moved, patch, 'backward').nodes).toEqual(doc.nodes);
  });
});

describe('changes from others in the editor store', () => {
  it('shows them without an undo step, keeping the selection to what exists', () => {
    const { doc, rect, other } = setup();
    const store = createEditorStore(doc);
    store.getState().setSelection([rect, other]);
    store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 1, 0));
    const undoBefore = store.getState().undoStack.length;
    const remote = deleteNodes(patchNode(store.getState().doc, rect, { name: 'Renamed remotely' }), [other]);
    store.getState().applyRemote(remote);
    const state = store.getState();
    expect(state.doc).toBe(remote);
    expect(state.remoteDoc).toBe(remote);
    expect(state.undoStack).toHaveLength(undoBefore);
    expect(state.selection).toEqual([rect]);
  });

  it('undoes only this person’s step and keeps what someone else changed since', () => {
    const { doc, rect } = setup();
    const store = createEditorStore(doc);
    store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 50, 0));
    store.getState().applyRemote(patchNode(store.getState().doc, rect, { fills: [solidPaint({ r: 0, g: 0, b: 1 })] }));
    store.getState().undo();
    const node = store.getState().doc.nodes[rect] as { x: number; fills: { color: { b: number } }[] };
    expect(node.x).toBe(10);
    expect(node.fills[0]!.color.b).toBe(1);
    store.getState().redo();
    expect((store.getState().doc.nodes[rect] as { x: number }).x).toBe(60);
  });

  it('undoes safely when someone else has deleted the layer', () => {
    const { doc, rect } = setup();
    const store = createEditorStore(doc);
    store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 50, 0));
    store.getState().applyRemote(deleteNodes(store.getState().doc, [rect]));
    expect(() => store.getState().undo()).not.toThrow();
    expect(store.getState().doc.nodes[rect]).toBeUndefined();
    expect(validateDocument(store.getState().doc)).toEqual([]);
  });

  it('shows another page when the page being looked at is deleted by someone else', () => {
    const { doc, page } = setup();
    const added = addPage(doc, 'Second');
    const store = createEditorStore(added.doc, { pageId: added.id });
    expect(store.getState().pageId).toBe(added.id);
    store.getState().applyRemote(deletePage(store.getState().doc, added.id));
    expect(store.getState().pageId).toBe(page);
  });

  it('carries a gesture on from a change made by someone else meanwhile', () => {
    const { doc, rect, other } = setup();
    const store = createEditorStore(doc);
    store.getState().setSelection([rect]);
    store.getState().beginGesture();
    store.getState().updateGesture((base) => moveNodesBy(base, [rect], 10, 0));
    // Someone else recolours the ellipse during the drag.
    store.getState().applyRemote(patchNode(store.getState().doc, other, { name: 'Theirs' }));
    store.getState().updateGesture((base) => moveNodesBy(base, [rect], 20, 0));
    expect(store.getState().doc.nodes[other]?.name).toBe('Theirs');
    expect((store.getState().doc.nodes[rect] as { x: number }).x).toBe(30);
    store.getState().commitGesture('Move');
    // The undo step holds the drag only.
    store.getState().undo();
    expect((store.getState().doc.nodes[rect] as { x: number }).x).toBe(10);
    expect(store.getState().doc.nodes[other]?.name).toBe('Theirs');
  });

  it('keeps a change made by someone else meanwhile when the gesture works from its own starting document', () => {
    // The tools work each step out from the document as it was when they began (the controller keeps it), not from the store's snapshot.
    const { doc, page, rect, other } = setup();
    const store = createEditorStore(doc);
    store.getState().setSelection([rect]);
    const start = store.getState().doc;
    store.getState().beginGesture();
    store.getState().updateGesture(() => moveNodesBy(start, [rect], 10, 0));
    // Someone else draws a layer, renames the ellipse and moves the rectangle down during the drag.
    const added = addLayer(store.getState().doc, 'STAR', page, { x: 900, y: 0 });
    const theirs = moveNodesBy(patchNode(added.doc, other, { name: 'Theirs' }), [rect], 0, 50);
    store.getState().applyRemote(theirs);
    store.getState().updateGesture(() => moveNodesBy(start, [rect], 20, 0));
    const after = store.getState().doc;
    expect(after.nodes[added.id]?.type).toBe('STAR');
    expect(after.nodes[other]?.name).toBe('Theirs');
    // Across the drag the rectangle keeps the other person's move down; along it, this drag.
    expect((after.nodes[rect] as { x: number; y: number }).x).toBe(30);
    expect((after.nodes[rect] as { x: number; y: number }).y).toBe(60);
    expect(validateDocument(after)).toEqual([]);
    store.getState().commitGesture('Move');
    // The undo step holds the drag only.
    store.getState().undo();
    expect((store.getState().doc.nodes[rect] as { x: number }).x).toBe(10);
    expect(store.getState().doc.nodes[added.id]).toBeDefined();
    expect(store.getState().doc.nodes[other]?.name).toBe('Theirs');
  });

  it('keeps what the gesture itself changes when someone else changed the same thing meanwhile', () => {
    const { doc, rect } = setup();
    const store = createEditorStore(doc);
    const start = store.getState().doc;
    store.getState().beginGesture();
    store.getState().updateGesture(() => moveNodesBy(start, [rect], 10, 0));
    // Someone else moves the same rectangle sideways; the drag here goes on and its next step stands.
    store.getState().applyRemote(moveNodesBy(store.getState().doc, [rect], 100, 0));
    store.getState().updateGesture(() => moveNodesBy(start, [rect], 25, 0));
    expect((store.getState().doc.nodes[rect] as { x: number }).x).toBe(35);
  });

  it('ends a gesture whose layer someone else deleted, keeping what it did as one step', () => {
    const { doc, rect } = setup();
    const store = createEditorStore(doc);
    store.getState().setSelection([rect]);
    store.getState().beginGesture();
    store.getState().updateGesture((base) => moveNodesBy(base, [rect], 10, 0));
    store.getState().applyRemote(deleteNodes(store.getState().doc, [rect]));
    expect(store.getState().gesture).toBeNull();
    expect(store.getState().undoStack.at(-1)?.label).toBe('Edit');
    expect(store.getState().selection).toEqual([]);
    // What the controller does next with the gesture is ignored.
    store.getState().updateGesture((base) => moveNodesBy(base, [rect], 20, 0));
    store.getState().commitGesture('Move');
    expect(store.getState().doc.nodes[rect]).toBeUndefined();
  });

  it('marks a change made here as not remote', () => {
    const { doc, rect } = setup();
    const store = createEditorStore(doc);
    store.getState().applyRemote(patchNode(doc, rect, { name: 'Remote' }));
    store.getState().apply('Rename', (d) => patchNode(d, rect, { name: 'Local' }));
    expect(store.getState().doc).not.toBe(store.getState().remoteDoc);
  });
});

describe('a read-only editor store', () => {
  it('refuses every change to the document but still selects', () => {
    const { doc, rect, frame } = setup();
    const store = createEditorStore(doc);
    store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 5, 0));
    store.getState().setReadOnly(true);
    const before = store.getState().doc;
    store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 5, 0));
    store.getState().beginGesture();
    store.getState().updateGesture((base) => moveNodesBy(base, [rect], 5, 0));
    store.getState().commitGesture('Move');
    store.getState().undo();
    store.getState().renameDocument('Renamed');
    store.getState().addAssets({ ['f'.repeat(64)]: { mimeType: 'image/png', width: 1, height: 1, name: 'x' } });
    expect(store.getState().doc).toBe(before);
    expect(store.getState().undoStack).toHaveLength(1);
    store.getState().setSelection([frame]);
    expect(store.getState().selection).toEqual([frame]);
    // Changes from others still show.
    store.getState().applyRemote(patchNode(before, rect, { name: 'From an editor' }));
    expect(store.getState().doc.nodes[rect]?.name).toBe('From an editor');
  });

  it('puts back what a gesture in progress changed when editing is taken away', () => {
    const { doc, rect } = setup();
    const store = createEditorStore(doc);
    store.getState().beginGesture();
    store.getState().updateGesture((base) => moveNodesBy(base, [rect], 30, 0));
    store.getState().setReadOnly(true);
    expect(store.getState().gesture).toBeNull();
    expect(store.getState().doc).toBe(doc);
    store.getState().setReadOnly(false);
    store.getState().apply('Move', (d) => moveNodesBy(d, [rect], 5, 0));
    expect((store.getState().doc.nodes[rect] as { x: number }).x).toBe(15);
    void getChildIds;
  });
});
