import { patchNodes } from '../document/mutate';
import { isLayer, isPage, type Action, type ActionType, type Document, type Flow, type LayerNode, type NodeId, type Reaction, type Transition, type Trigger, type TriggerType } from '../document/schema';
import { createId } from '../ids';
import { getChildIds, getDescendantIds, getPageIdOf } from '../scene/tree';

/**
 * Building a prototype: the interactions on layers, and the flows of a
 * page. What an interaction does when the prototype is played is in
 * `core/prototype/player`.
 */

/** The transition a new interaction starts with. */
export const DEFAULT_TRANSITION: Transition = { type: 'DISSOLVE', direction: 'LEFT', duration: 300, delay: 0, easing: 'EASE_OUT', bezier: [0.42, 0, 0.58, 1] };

export function newTrigger(type: TriggerType, patch: Partial<Trigger> = {}): Trigger {
  return { type, delay: 800, key: type === 'ON_KEY' ? 'Enter' : '', ...patch };
}

/** An action of a type, with everything it does not use left empty. */
export function newAction(type: ActionType, patch: Partial<Omit<Action, 'type'>> = {}): Action {
  return { type, destinationId: null, transition: { ...DEFAULT_TRANSITION, bezier: [...DEFAULT_TRANSITION.bezier] }, variableId: null, expression: '', then: [], otherwise: [], ...patch };
}

/** The interactions of a layer as a designer sees them: on an instance's layer, the component's until changed. */
function reactionsOn(doc: Document, layerId: NodeId): Reaction[] | null {
  const node = doc.nodes[layerId];
  return isLayer(node) ? node.reactions : null;
}

/** Adds an interaction to a layer: a trigger and what it does. */
export function addReaction(doc: Document, layerId: NodeId, trigger: Trigger, actions: Action[]): { doc: Document; id: string } | null {
  const reactions = reactionsOn(doc, layerId);
  if (!reactions) return null;
  const reaction: Reaction = { id: createId(), trigger, actions };
  return { doc: patchNodes(doc, { [layerId]: { reactions: [...reactions, reaction] } }), id: reaction.id };
}

/** Changes an interaction's trigger or its actions. */
export function updateReaction(doc: Document, layerId: NodeId, reactionId: string, change: Partial<Omit<Reaction, 'id'>>): Document {
  const reactions = reactionsOn(doc, layerId);
  if (!reactions || !reactions.some((reaction) => reaction.id === reactionId)) return doc;
  return patchNodes(doc, { [layerId]: { reactions: reactions.map((reaction) => (reaction.id === reactionId ? { ...reaction, ...change } : reaction)) } });
}

export function removeReaction(doc: Document, layerId: NodeId, reactionId: string): Document {
  const reactions = reactionsOn(doc, layerId);
  if (!reactions || !reactions.some((reaction) => reaction.id === reactionId)) return doc;
  return patchNodes(doc, { [layerId]: { reactions: reactions.filter((reaction) => reaction.id !== reactionId) } });
}

/**
 * Connects a layer to a frame: a click on the layer goes to the frame. This
 * is what dragging from a layer to a frame on the canvas makes. Nothing is
 * connected to itself, to something inside it, or to what is not a frame.
 */
export function connect(doc: Document, fromId: NodeId, toId: NodeId): { doc: Document; id: string } | null {
  const from = doc.nodes[fromId];
  const to = doc.nodes[toId];
  if (!isLayer(from) || !isLayer(to) || to.type !== 'FRAME' || fromId === toId || getDescendantIds(doc, fromId).includes(toId)) return null;
  return addReaction(doc, fromId, newTrigger('ON_CLICK'), [newAction('NAVIGATE', { destinationId: toId })]);
}

/** The frames an interaction can go to or open: the frames laid out on a page, top first as the page shows them. */
export function prototypeFrames(doc: Document, pageId: NodeId): LayerNode[] {
  const out: LayerNode[] = [];
  for (const id of getChildIds(doc, pageId)) {
    const node = doc.nodes[id];
    if (isLayer(node) && node.type === 'FRAME' && node.kind !== 'COMPONENT_SET') out.push(node);
  }
  return out;
}

/** A connection from a layer to another: what the canvas draws an arrow for. */
export interface Connection {
  fromId: NodeId;
  toId: NodeId;
  reactionId: string;
  type: ActionType;
}

function destinations(actions: readonly Action[], into: { id: NodeId; type: ActionType }[]): void {
  for (const action of actions) {
    if (action.destinationId !== null && (action.type === 'NAVIGATE' || action.type === 'OPEN_OVERLAY' || action.type === 'SWAP_OVERLAY' || action.type === 'SCROLL_TO')) into.push({ id: action.destinationId, type: action.type });
    destinations(action.then, into);
    destinations(action.otherwise, into);
  }
}

/** Every connection between layers of a page, for drawing them. Connections to something that is gone or on another page are left out. */
export function connectionsOn(doc: Document, pageId: NodeId): Connection[] {
  const out: Connection[] = [];
  for (const id of getDescendantIds(doc, pageId)) {
    const node = doc.nodes[id];
    // The layers an instance mirrors repeat the component's connections; the component's own are enough to see.
    if (!isLayer(node) || node.reactions.length === 0 || node.sourceId !== null) continue;
    for (const reaction of node.reactions) {
      const found: { id: NodeId; type: ActionType }[] = [];
      destinations(reaction.actions, found);
      for (const destination of found) {
        if (destination.id !== id && isLayer(doc.nodes[destination.id]) && getPageIdOf(doc, destination.id) === pageId) out.push({ fromId: id, toId: destination.id, reactionId: reaction.id, type: destination.type });
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------- flows

/** The flows of a page whose starting frame still exists. */
export function flowsOf(doc: Document, pageId: NodeId): Flow[] {
  const page = doc.nodes[pageId];
  if (!isPage(page)) return [];
  return page.flows.filter((flow) => isLayer(doc.nodes[flow.startId]) && getPageIdOf(doc, flow.startId) === pageId);
}

/** The flow that starts on a frame, if one does. */
export function flowAt(doc: Document, frameId: NodeId): Flow | null {
  const pageId = getPageIdOf(doc, frameId);
  return pageId === null ? null : (flowsOf(doc, pageId).find((flow) => flow.startId === frameId) ?? null);
}

/** Makes a frame the start of a flow. A frame starts one flow at most. */
export function addFlow(doc: Document, frameId: NodeId, name?: string): { doc: Document; id: string } | null {
  const frame = doc.nodes[frameId];
  const pageId = getPageIdOf(doc, frameId);
  const page = pageId === null ? undefined : doc.nodes[pageId];
  if (!isLayer(frame) || frame.type !== 'FRAME' || !isPage(page) || page.library || flowAt(doc, frameId)) return null;
  const flows = flowsOf(doc, page.id);
  const taken = flows.map((flow) => flow.name);
  let chosen = name?.trim() || `Flow ${flows.length + 1}`;
  for (let n = flows.length + 2; taken.includes(chosen); n++) chosen = `Flow ${n}`;
  const flow: Flow = { id: createId(), name: chosen, startId: frameId };
  return { doc: patchNodes(doc, { [page.id]: { flows: [...flows, flow] } }), id: flow.id };
}

export function renameFlow(doc: Document, pageId: NodeId, flowId: string, name: string): Document {
  const page = doc.nodes[pageId];
  if (!isPage(page) || name.trim() === '' || !page.flows.some((flow) => flow.id === flowId)) return doc;
  return patchNodes(doc, { [pageId]: { flows: page.flows.map((flow) => (flow.id === flowId ? { ...flow, name: name.trim() } : flow)) } });
}

export function removeFlow(doc: Document, pageId: NodeId, flowId: string): Document {
  const page = doc.nodes[pageId];
  if (!isPage(page) || !page.flows.some((flow) => flow.id === flowId)) return doc;
  return patchNodes(doc, { [pageId]: { flows: page.flows.filter((flow) => flow.id !== flowId) } });
}

/**
 * Where a prototype of a page starts when no flow is named: its first flow,
 * or without one the selected frame, or the first frame on the page.
 */
export function startFrame(doc: Document, pageId: NodeId, selected?: NodeId): NodeId | null {
  const flows = flowsOf(doc, pageId);
  if (flows[0]) return flows[0].startId;
  const frames = prototypeFrames(doc, pageId);
  if (selected !== undefined && frames.some((frame) => frame.id === selected)) return selected;
  return frames[0]?.id ?? null;
}
