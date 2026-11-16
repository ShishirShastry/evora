import { patchNodes } from '../document/mutate';
import {
  isLayer,
  type DesignNode,
  type Document,
  type LayerNode,
  type LayerPatch,
  type NodeId,
  type Paint,
  type RGB,
  type Style,
  type StyleRefs,
  type StyleType,
  type Variable,
  type VariableType,
  type VariableValue,
} from '../document/schema';
import { setLayerBox } from '../ops/transform';

/**
 * Styles and variables: what a design system is made of. A style is a named
 * set of paints, type settings, effects or layout grids; a variable is a
 * named colour, number, string or switch that can have a different value in
 * each mode of its collection (light and dark, say) and can stand for
 * another variable. A layer refers to a style (`styleRefs`) or binds one of
 * its properties to a variable (`boundVariables`).
 *
 * As with layouts and instances, what a layer then looks like is stored in
 * its ordinary properties: `applyTokens` writes the style's or the variable's
 * value into every layer that uses it, after every change, so that changing
 * a token changes everything bound to it in the same step and nothing else
 * in the application needs to know about tokens.
 */

type Props = Record<string, unknown>;
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The properties of a text layer that a text style sets. */
export const TEXT_STYLE_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'italic', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase'] as const;

/** For each way a layer can refer to a style: the type of style, and the properties of the layer it sets. */
export const STYLE_TARGETS: Record<keyof StyleRefs, { type: StyleType; keys: readonly string[] }> = {
  fills: { type: 'PAINT', keys: ['fills'] },
  strokes: { type: 'PAINT', keys: ['strokes'] },
  text: { type: 'TEXT', keys: TEXT_STYLE_KEYS },
  effects: { type: 'EFFECT', keys: ['effects'] },
  grids: { type: 'GRID', keys: ['layoutGrids'] },
};

/** What a style gives the layer properties it sets. */
function styleValues(style: Style, ref: keyof StyleRefs): Props {
  if (ref === 'fills') return { fills: style.paints };
  if (ref === 'strokes') return { strokes: style.paints };
  if (ref === 'effects') return { effects: style.effects };
  if (ref === 'grids') return { layoutGrids: style.grids };
  return { ...style.text };
}

/** Whether a kind of style can be used on a layer: text styles are for text, grid styles for frames. */
export function styleFits(node: LayerNode, ref: keyof StyleRefs): boolean {
  if (ref === 'text') return node.type === 'TEXT';
  if (ref === 'grids') return node.type === 'FRAME';
  if (ref === 'fills') return node.type !== 'GROUP' && node.type !== 'LINE';
  return node.type !== 'GROUP';
}

/** A property of a layer that a variable can be bound to: its name, the type of variable, and what kind of thing it is. */
export interface Bindable {
  key: string;
  label: string;
  type: VariableType;
  /** The scope a variable must allow to be offered for this property. */
  scope: VariableScope;
}

export type VariableScope = 'FILL' | 'STROKE' | 'SIZE' | 'GAP' | 'RADIUS' | 'OPACITY' | 'TEXT' | 'VISIBILITY';
export const VARIABLE_SCOPES: readonly VariableScope[] = ['FILL', 'STROKE', 'SIZE', 'GAP', 'RADIUS', 'OPACITY', 'TEXT', 'VISIBILITY'];

/** The properties of a layer that can be bound to a variable, as the layer is now. */
export function bindableKeys(node: LayerNode): Bindable[] {
  const out: Bindable[] = [];
  node.fills.forEach((paint, index) => {
    if (paint.type === 'SOLID') out.push({ key: `fills.${index}`, label: node.fills.length > 1 ? `Fill ${index + 1} colour` : 'Fill colour', type: 'COLOR', scope: 'FILL' });
  });
  node.strokes.forEach((paint, index) => {
    if (paint.type === 'SOLID') out.push({ key: `strokes.${index}`, label: node.strokes.length > 1 ? `Stroke ${index + 1} colour` : 'Stroke colour', type: 'COLOR', scope: 'STROKE' });
  });
  out.push({ key: 'width', label: 'Width', type: 'FLOAT', scope: 'SIZE' });
  if (node.type !== 'LINE') out.push({ key: 'height', label: 'Height', type: 'FLOAT', scope: 'SIZE' });
  out.push({ key: 'opacity', label: 'Opacity', type: 'FLOAT', scope: 'OPACITY' });
  out.push({ key: 'visible', label: 'Visible', type: 'BOOLEAN', scope: 'VISIBILITY' });
  if (node.type !== 'GROUP') out.push({ key: 'strokeWeight', label: 'Stroke weight', type: 'FLOAT', scope: 'STROKE' });
  if (node.type === 'FRAME' || node.type === 'RECTANGLE') out.push({ key: 'cornerRadius', label: 'Corner radius', type: 'FLOAT', scope: 'RADIUS' });
  if (node.type === 'FRAME' && node.layoutMode !== 'NONE') {
    out.push({ key: 'itemSpacing', label: 'Spacing between items', type: 'FLOAT', scope: 'GAP' });
    for (const side of ['Left', 'Right', 'Top', 'Bottom']) out.push({ key: `padding${side}`, label: `${side} padding`, type: 'FLOAT', scope: 'GAP' });
  }
  if (node.type === 'TEXT') {
    out.push({ key: 'characters', label: 'Text', type: 'STRING', scope: 'TEXT' });
    out.push({ key: 'fontFamily', label: 'Font family', type: 'STRING', scope: 'TEXT' });
    out.push({ key: 'fontSize', label: 'Font size', type: 'FLOAT', scope: 'TEXT' });
    out.push({ key: 'lineHeight', label: 'Line height', type: 'FLOAT', scope: 'TEXT' });
    out.push({ key: 'letterSpacing', label: 'Letter spacing', type: 'FLOAT', scope: 'TEXT' });
  }
  return out;
}

/** The layer property a binding key writes to: "fills.0" writes into `fills`. */
function propOf(key: string): string {
  const dot = key.indexOf('.');
  return dot < 0 ? key : key.slice(0, dot);
}

/**
 * The properties of a layer that its styles and variables decide, given
 * its references. Whatever keeps a layer in step with something else (an
 * instance with its component) leaves these alone.
 */
export function tokenControlled(styleRefs: StyleRefs | undefined, boundVariables: Readonly<Record<string, string>> | undefined): Set<string> {
  const out = new Set<string>();
  for (const ref in styleRefs ?? {}) for (const key of STYLE_TARGETS[ref as keyof StyleRefs]?.keys ?? []) out.add(key);
  for (const key in boundVariables ?? {}) out.add(propOf(key));
  return out;
}

/**
 * The styles and bindings a layer of an instance takes from the component,
 * beside what the instance has changed: where the instance has its own value
 * for a property, the component's style or variable for it does not apply.
 */
export function refsBeside(
  styleRefs: StyleRefs,
  boundVariables: Readonly<Record<string, string>>,
  override: Readonly<Record<string, unknown>>,
): { styleRefs: StyleRefs; boundVariables: Record<string, string> } {
  const refs: StyleRefs = { ...styleRefs };
  const bound: Record<string, string> = { ...boundVariables };
  if (!('styleRefs' in override)) {
    for (const ref of Object.keys(refs) as (keyof StyleRefs)[]) if (STYLE_TARGETS[ref]?.keys.some((key) => key in override)) delete refs[ref];
  }
  if (!('boundVariables' in override)) {
    for (const key in bound) if (propOf(key) in override) delete bound[key];
  }
  return { styleRefs: refs, boundVariables: bound };
}

/** The mode of a collection that applies to a node: the nearest one set on it or above it, or the collection's first. */
export function modeFor(doc: Document, nodeId: NodeId, collectionId: string): string | null {
  const collection = doc.variableCollections[collectionId];
  if (!collection || collection.modes.length === 0) return null;
  const seen = new Set<NodeId>();
  let current: NodeId | null = nodeId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const node: DesignNode | undefined = doc.nodes[current];
    if (!node) break;
    const chosen = node.variableModes[collectionId];
    if (chosen && collection.modes.some((mode) => mode.id === chosen)) return chosen;
    current = node.parentId;
  }
  return (collection.modes[0] as { id: string }).id;
}

/**
 * The value of a variable for a node: its value in the mode that applies
 * there, following a variable that stands for another to the end. Null when
 * there is none (a variable that stands for itself, or for one that is gone).
 */
export function resolveVariable(doc: Document, variableId: string, nodeId: NodeId): RGB | number | string | boolean | null {
  let variable: Variable | undefined = doc.variables[variableId];
  for (let step = 0; variable && step < 30; step++) {
    const mode = modeFor(doc, nodeId, variable.collectionId);
    const value: VariableValue | undefined = mode === null ? undefined : variable.valuesByMode[mode];
    if (value === undefined) return null;
    if (typeof value === 'object' && value !== null && 'alias' in value) {
      const next: Variable | undefined = doc.variables[value.alias];
      // A variable stands only for one of its own type.
      if (!next || next.type !== variable.type) return null;
      variable = next;
      continue;
    }
    return value;
  }
  return null;
}

/** What a property of a layer is, read by its binding key. */
function read(node: LayerNode, key: string): unknown {
  const [prop, index] = key.split('.');
  if (index !== undefined) {
    const paint = (node as unknown as Record<string, Paint[]>)[prop as string]?.[Number(index)];
    return paint && paint.type === 'SOLID' ? paint.color : undefined;
  }
  if (key === 'opacity') return Math.round(node.opacity * 10000) / 100;
  return (node as unknown as Props)[key];
}

/** The change to a layer that gives a property, by its binding key, a value. Null when the value does not fit it. */
function write(node: LayerNode, key: string, value: RGB | number | string | boolean): LayerPatch | null {
  const [prop, index] = key.split('.');
  if (index !== undefined) {
    const paints = (node as unknown as Record<string, Paint[]>)[prop as string];
    const paint = paints?.[Number(index)];
    if (!paint || paint.type !== 'SOLID' || typeof value !== 'object') return null;
    return { [prop as string]: paints.map((entry, i) => (i === Number(index) ? { ...paint, color: { ...value } } : entry)) } as LayerPatch;
  }
  if (typeof value === 'object') return null;
  if (key === 'opacity') return typeof value === 'number' ? { opacity: Math.min(1, Math.max(0, value / 100)) } : null;
  if (key === 'visible') return typeof value === 'boolean' ? { visible: value } : null;
  if (key === 'characters' || key === 'fontFamily') return typeof value === 'string' && (key === 'characters' || value.trim() !== '') ? ({ [key]: value } as LayerPatch) : null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // Sizes and weights are not negative; a font is at least a pixel.
  const least = key === 'fontSize' || key === 'lineHeight' || key === 'width' || key === 'height' ? 1 : key === 'letterSpacing' ? -200 : 0;
  return { [key]: Math.max(least, value) } as LayerPatch;
}

/** Whether a variable of a type can be bound to a property, by its binding key. */
function typeFor(key: string): VariableType {
  if (key.includes('.')) return 'COLOR';
  if (key === 'visible') return 'BOOLEAN';
  if (key === 'characters' || key === 'fontFamily') return 'STRING';
  return 'FLOAT';
}

/**
 * Writes the value of every style and variable into the layers that use it.
 * With `capture`, a layer whose styled or bound property was changed by the
 * last edit (`previous` is the document before it) is taken off the style or
 * variable instead: changing such a property by hand detaches it. A
 * reference to a style or variable that no longer exists, or that does not
 * fit, is dropped. Returns the same document when nothing needs doing.
 */
export function applyTokens(previous: Document, doc: Document, capture: boolean): Document {
  let any = false;
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (isLayer(node) && (Object.keys(node.styleRefs).length > 0 || Object.keys(node.boundVariables).length > 0)) {
      any = true;
      break;
    }
  }
  if (!any) return doc;

  const patches: Record<NodeId, LayerPatch> = {};
  const sizes: [NodeId, { width?: number; height?: number }][] = [];
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!isLayer(node)) continue;
    const refs = Object.keys(node.styleRefs) as (keyof StyleRefs)[];
    const bound = Object.keys(node.boundVariables);
    if (refs.length === 0 && bound.length === 0) continue;
    const before = previous.nodes[id];
    const was = capture && isLayer(before) ? before : null;
    const patch: Props = {};
    const styleRefs: StyleRefs = { ...node.styleRefs };
    const boundVariables: Record<string, string> = { ...node.boundVariables };
    const styled = new Set<string>();

    for (const ref of refs) {
      const style = doc.styles[node.styleRefs[ref] as string];
      const target = STYLE_TARGETS[ref];
      if (!style || !target || style.type !== target.type || !styleFits(node, ref)) {
        delete styleRefs[ref];
        continue;
      }
      const values = styleValues(style, ref);
      const now = node as unknown as Props;
      const differs = target.keys.some((key) => !same(now[key], values[key]));
      if (differs && was && was.styleRefs[ref] === node.styleRefs[ref] && same(previous.styles[style.id], style)) {
        const then = was as unknown as Props;
        // It was in step before the edit and the style has not changed: the edit changed the layer, which detaches it.
        if (target.keys.every((key) => same(then[key], values[key]))) {
          delete styleRefs[ref];
          continue;
        }
      }
      for (const key of target.keys) {
        styled.add(key);
        if (!same(now[key], values[key])) patch[key] = values[key];
      }
    }

    for (const key of bound) {
      const variable = doc.variables[node.boundVariables[key] as string];
      if (!variable || variable.type !== typeFor(key)) {
        delete boundVariables[key];
        continue;
      }
      // A style on the same property decides it; the binding waits.
      if (styled.has(propOf(key))) continue;
      // A size the layout decides is the layout's.
      if (key === 'width' && node.layoutSizingHorizontal !== 'FIXED') continue;
      if (key === 'height' && node.layoutSizingVertical !== 'FIXED') continue;
      const value = resolveVariable(doc, variable.id, id);
      if (value === null) continue;
      const current = read({ ...node, ...(patch as LayerPatch) } as LayerNode, key);
      if (same(current, value)) continue;
      if (was && was.boundVariables[key] === node.boundVariables[key]) {
        const then = read(was, key);
        // In step before the edit, with a value that has not changed since: the edit changed the layer, which unbinds it.
        if (same(then, resolveVariable(previous, variable.id, id)) && same(then, value) && !same(current, then)) {
          delete boundVariables[key];
          continue;
        }
      }
      const change = write({ ...node, ...(patch as LayerPatch) } as LayerNode, key, value);
      if (!change) continue;
      if (key === 'width' || key === 'height') sizes.push([id, change as { width?: number; height?: number }]);
      else Object.assign(patch, change);
    }

    if (!same(styleRefs, node.styleRefs)) patch.styleRefs = styleRefs;
    if (!same(boundVariables, node.boundVariables)) patch.boundVariables = boundVariables;
    if (Object.keys(patch).length > 0) patches[id] = patch as LayerPatch;
  }
  let next = patchNodes(doc, patches);
  // A size goes through the operation that keeps what is in a layer in step with its box.
  for (const [id, size] of sizes) next = setLayerBox(next, id, size);
  return next;
}
