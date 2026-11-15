import { useMemo, type ReactNode } from 'react';
import {
  BLACK,
  clean,
  DEFAULT_SHAPE_FILL,
  hasCornerRadius,
  isLayer,
  isPage,
  lineBox,
  lineEndpoints,
  patchNodes,
  resizeFromTopLeft,
  solidPaint,
  TYPE_LABELS,
  type Document,
  type LayerNode,
  type LayerPatch,
  type NodeId,
  type Paint,
  type RGB,
  type StrokeAlign,
} from '../../core';
import { updateLayers } from '../../state/commands';
import type { EditorStore } from '../../state/editorStore';
import { ColorField, MIXED, NumberField, type Mixed } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext } from '../editor/EditorContext';

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-line px-3 py-2.5">
      <header className="mb-2 flex h-6 items-center justify-between">
        <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-dim">{title}</h3>
        {action}
      </header>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-1.5">{children}</div>;
}

/** The shared value of a property across layers, or MIXED when they differ. */
function shared<T>(layers: readonly LayerNode[], get: (layer: LayerNode) => T): T | Mixed {
  const first = get(layers[0] as LayerNode);
  return layers.every((layer) => get(layer) === first) ? first : MIXED;
}

function samePaints(layers: readonly LayerNode[], key: 'fills' | 'strokes'): boolean {
  const first = JSON.stringify((layers[0] as LayerNode)[key]);
  return layers.every((layer) => JSON.stringify(layer[key]) === first);
}

/**
 * Applies a per-layer change as a live preview (inside a gesture) or as a
 * committed undo step. Used by the colour picker, which reports many values
 * while it is dragged and one final value when it closes.
 */
function applyLive(
  store: EditorStore,
  label: string,
  phase: 'live' | 'commit',
  change: (doc: Document) => Document,
): void {
  const state = store.getState();
  if (phase === 'live') {
    state.beginGesture();
    store.getState().updateGesture(change);
    return;
  }
  if (state.gesture) {
    state.updateGesture(change);
    store.getState().commitGesture(label);
  } else {
    state.apply(label, change);
  }
}

interface PaintListProps {
  title: string;
  paintKey: 'fills' | 'strokes';
  layers: LayerNode[];
  defaultColor: RGB;
  children?: ReactNode;
}

/** Editable stack of solid paints (fills or strokes) for the selected layers. */
function PaintList({ title, paintKey, layers, defaultColor, children }: PaintListProps) {
  const { store } = useEditorContext();
  const ids = layers.map((layer) => layer.id);
  const mixed = !samePaints(layers, paintKey);
  const paints = mixed ? [] : (layers[0] as LayerNode)[paintKey];
  const noun = paintKey === 'fills' ? 'fill' : 'stroke';

  const setPaints = (label: string, next: Paint[], phase: 'live' | 'commit' = 'commit'): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const id of ids) patches[id] = { [paintKey]: next };
    applyLive(store, label, phase, (doc) => patchNodes(doc, patches));
  };
  const update = (index: number, patch: Partial<Paint>, label: string, phase: 'live' | 'commit' = 'commit'): void =>
    setPaints(label, paints.map((paint, i) => (i === index ? { ...paint, ...patch } : paint)), phase);

  return (
    <Section
      title={title}
      action={
        <button
          type="button"
          className="od-icon-button !h-6 !w-6"
          aria-label={`Add ${noun}`}
          title={`Add ${noun}`}
          onClick={() => setPaints(`Add ${noun}`, [...paints, solidPaint(defaultColor)])}
        >
          <Icon name="plus" size={14} />
        </button>
      }
    >
      {mixed && <p className="m-0 text-dim">The selected layers have different {noun}s. Add one to replace them.</p>}
      {!mixed && paints.length === 0 && <p className="m-0 text-faint">No {noun}</p>}
      {paints.map((paint, index) => (
        <Row key={index}>
          <ColorField
            label={`${title} ${index + 1} colour`}
            value={paint.color}
            onChange={(color, phase) => update(index, { color }, `Change ${noun} colour`, phase)}
          />
          <div className="w-16 flex-none">
            <NumberField
              label={`${title} ${index + 1} opacity`}
              suffix="%"
              value={Math.round(paint.opacity * 100)}
              min={0}
              max={100}
              onCommit={(value) => update(index, { opacity: value / 100 }, `Change ${noun} opacity`)}
            />
          </div>
          <button
            type="button"
            className="od-icon-button !h-6 !w-6"
            aria-label={paint.visible ? `Hide ${noun} ${index + 1}` : `Show ${noun} ${index + 1}`}
            title={paint.visible ? 'Hide' : 'Show'}
            onClick={() => update(index, { visible: !paint.visible }, paint.visible ? `Hide ${noun}` : `Show ${noun}`)}
          >
            <Icon name={paint.visible ? 'eye' : 'eyeOff'} size={13} />
          </button>
          <button
            type="button"
            className="od-icon-button !h-6 !w-6"
            aria-label={`Remove ${noun} ${index + 1}`}
            title="Remove"
            onClick={() => setPaints(`Remove ${noun}`, paints.filter((_, i) => i !== index))}
          >
            <Icon name="minus" size={13} />
          </button>
        </Row>
      ))}
      {!mixed && paints.length > 0 && children}
    </Section>
  );
}

function PageProperties() {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const page = doc.nodes[pageId];
  if (!isPage(page)) return null;
  return (
    <Section title="Page">
      <Row>
        <span className="w-20 flex-none text-dim">Background</span>
        <ColorField
          label="Page background"
          value={page.backgroundColor}
          onChange={(color, phase) =>
            applyLive(store, 'Change page background', phase, (d) => patchNodes(d, { [pageId]: { backgroundColor: color } }))
          }
        />
      </Row>
      <p className="m-0 mt-1 text-faint">Select a layer to see its properties.</p>
    </Section>
  );
}

/**
 * The Design tab of the right sidebar. Everything shown is read from the
 * selected layers in the document and every edit is an undoable document
 * change; nothing here is display-only.
 */
export function DesignPanel() {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const layers = useMemo(() => selection.map((id) => doc.nodes[id]).filter(isLayer), [doc, selection]);

  if (layers.length === 0) {
    return (
      <aside aria-label="Design properties" className="h-full overflow-y-auto">
        <PageProperties />
      </aside>
    );
  }

  const ids = layers.map((layer) => layer.id);
  const first = layers[0] as LayerNode;
  const allLines = layers.every((layer) => layer.type === 'LINE');
  const anyLine = layers.some((layer) => layer.type === 'LINE');
  const radiusLayers = layers.filter(hasCornerRadius);
  const frames = layers.filter((layer) => layer.type === 'FRAME');
  const pointLayers = layers.filter((layer) => layer.type === 'POLYGON' || layer.type === 'STAR');
  const stars = layers.filter((layer) => layer.type === 'STAR');
  const set = (label: string, patch: LayerPatch): void => updateLayers(store, label, ids, patch);

  /** Changes width and/or height, keeping each layer's top-left corner in place. */
  const setSize = (label: string, size: { width?: number; height?: number }): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const layer of layers) {
      if (layer.type === 'LINE') {
        if (size.width === undefined) continue;
        // A line keeps its start point and direction; only its length changes.
        const [start] = lineEndpoints(layer);
        const r = (layer.rotation * Math.PI) / 180;
        const end = { x: start.x + Math.cos(r) * size.width, y: start.y + Math.sin(r) * size.width };
        patches[layer.id] = { ...lineBox(start, end), rotation: layer.rotation };
        continue;
      }
      patches[layer.id] = resizeFromTopLeft(layer, size.width ?? layer.width, size.height ?? layer.height);
    }
    store.getState().apply(label, (d) => patchNodes(d, patches));
  };

  const title = layers.length === 1 ? TYPE_LABELS[first.type] : `${layers.length} layers`;

  return (
    <aside aria-label="Design properties" className="h-full overflow-y-auto">
      <div className="flex h-9 items-center border-b border-line px-3 font-medium">{title}</div>

      <Section title="Position and size">
        <Row>
          <NumberField label="X position" prefix="X" value={shared(layers, (l) => l.x)} onCommit={(x) => set('Move', { x })} />
          <NumberField label="Y position" prefix="Y" value={shared(layers, (l) => l.y)} onCommit={(y) => set('Move', { y })} />
        </Row>
        <Row>
          <NumberField
            label="Width"
            prefix="W"
            min={allLines ? 0 : 1}
            value={shared(layers, (l) => l.width)}
            onCommit={(width) => setSize('Resize', { width })}
          />
          <NumberField
            label="Height"
            prefix="H"
            min={1}
            disabled={anyLine}
            value={shared(layers, (l) => l.height)}
            onCommit={(height) => setSize('Resize', { height })}
          />
        </Row>
        <Row>
          <NumberField
            label="Rotation"
            prefix="∠"
            suffix="°"
            min={-180}
            max={180}
            value={shared(layers, (l) => l.rotation)}
            onCommit={(rotation) => set('Rotate', { rotation: clean(rotation) })}
          />
          {radiusLayers.length === layers.length ? (
            <NumberField
              label="Corner radius"
              prefix="R"
              min={0}
              value={shared(radiusLayers, (l) => (hasCornerRadius(l) ? l.cornerRadius : 0))}
              onCommit={(cornerRadius) => set('Change corner radius', { cornerRadius })}
            />
          ) : (
            <div className="flex-1" />
          )}
        </Row>
        {pointLayers.length === layers.length && (
          <Row>
            <NumberField
              label="Point count"
              prefix="Points"
              min={3}
              max={60}
              value={shared(pointLayers, (l) => ('pointCount' in l ? l.pointCount : 3))}
              onCommit={(value) => set('Change point count', { pointCount: Math.round(value) })}
            />
            {stars.length === layers.length ? (
              <NumberField
                label="Inner radius"
                prefix="Ratio"
                suffix="%"
                min={0}
                max={100}
                value={shared(stars, (l) => (l.type === 'STAR' ? Math.round(l.innerRadius * 100) : 0))}
                onCommit={(value) => set('Change star ratio', { innerRadius: value / 100 })}
              />
            ) : (
              <div className="flex-1" />
            )}
          </Row>
        )}
        {frames.length === layers.length && (
          <label className="mt-0.5 flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="accent-[var(--od-accent)]"
              checked={frames.every((frame) => frame.type === 'FRAME' && frame.clipsContent)}
              onChange={(event) => set('Change clip content', { clipsContent: event.currentTarget.checked })}
            />
            Clip content
          </label>
        )}
      </Section>

      <Section title="Layer">
        <Row>
          <span className="w-20 flex-none text-dim">Opacity</span>
          <NumberField
            label="Layer opacity"
            suffix="%"
            min={0}
            max={100}
            value={shared(layers, (l) => Math.round(l.opacity * 100))}
            onCommit={(value) => set('Change opacity', { opacity: value / 100 })}
          />
        </Row>
      </Section>

      {!allLines && <PaintList title="Fill" paintKey="fills" layers={layers.filter((l) => l.type !== 'LINE')} defaultColor={DEFAULT_SHAPE_FILL} />}

      <PaintList title="Stroke" paintKey="strokes" layers={layers} defaultColor={BLACK}>
        <Row>
          <NumberField
            label="Stroke weight"
            prefix="Weight"
            min={0}
            value={shared(layers, (l) => l.strokeWeight)}
            onCommit={(strokeWeight) => set('Change stroke weight', { strokeWeight })}
          />
          {!anyLine && (
            <select
              aria-label="Stroke position"
              className="od-field flex-1"
              value={shared(layers, (l) => l.strokeAlign)}
              onChange={(event) => set('Change stroke position', { strokeAlign: event.currentTarget.value as StrokeAlign })}
            >
              {shared(layers, (l) => l.strokeAlign) === MIXED && <option value={MIXED}>Mixed</option>}
              <option value="INSIDE">Inside</option>
              <option value="CENTER">Center</option>
              <option value="OUTSIDE">Outside</option>
            </select>
          )}
        </Row>
      </PaintList>
    </aside>
  );
}
