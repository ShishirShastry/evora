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
  setLayerBox,
  solidPaint,
  TYPE_LABELS,
  type Document,
  type LayerNode,
  type LayerPatch,
  type NodeId,
  type Paint,
  type RGB,
  type StrokeAlign,
  type TextAlign,
  type TextAutoResize,
  type TextCase,
  type TextDecoration,
  type TextNode,
  type VerticalAlign,
} from '../../core';
import { availableFonts } from '../../engine/text/measure';
import { getCommand, updateLayers, type Command } from '../../state/commands';
import type { EditorStore } from '../../state/editorStore';
import { ColorField, MIXED, NumberField, type Mixed } from '../components/Fields';
import { Icon, type IconName } from '../components/Icon';
import { useEditor, useEditorContext, useRunCommand } from '../editor/EditorContext';

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

const ARRANGE_BUTTONS: { id: string; icon: IconName }[] = [
  { id: 'arrange.align.left', icon: 'alignLeft' },
  { id: 'arrange.align.centerX', icon: 'alignCenterX' },
  { id: 'arrange.align.right', icon: 'alignRight' },
  { id: 'arrange.align.top', icon: 'alignTop' },
  { id: 'arrange.align.centerY', icon: 'alignCenterY' },
  { id: 'arrange.align.bottom', icon: 'alignBottom' },
  { id: 'arrange.distribute.horizontal', icon: 'distributeH' },
  { id: 'arrange.distribute.vertical', icon: 'distributeV' },
];

/** Align and distribute buttons. They run the same commands as the Arrange menu and its shortcuts. */
function ArrangeBar() {
  const run = useRunCommand();
  // Re-render when anything that affects availability changes.
  const state = useEditor((s) => s);
  return (
    <div role="toolbar" aria-label="Align and distribute" className="flex h-10 items-center justify-between border-b border-line px-2">
      {ARRANGE_BUTTONS.map(({ id, icon }) => {
        const command = getCommand(id) as Command;
        return (
          <button
            key={id}
            type="button"
            className="od-icon-button !h-7 !w-7"
            aria-label={command.label}
            title={`${command.label} (${command.shortcut})`}
            disabled={command.enabled ? !command.enabled(state) : false}
            onClick={() => run(command)}
          >
            <Icon name={icon} />
          </button>
        );
      })}
    </div>
  );
}

const FONT_WEIGHTS: [number, string][] = [
  [100, 'Thin'],
  [200, 'Extra light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
  [900, 'Black'],
];

function ToggleGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | Mixed;
  options: { value: T; label: string; icon: IconName }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-1 gap-0.5 rounded-[5px] bg-field p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.label}
          title={option.label}
          className={`flex h-[22px] flex-1 items-center justify-center rounded border-0 ${
            value === option.value ? 'bg-hover text-ink' : 'bg-transparent text-dim hover:text-ink'
          }`}
          onClick={() => onChange(option.value)}
        >
          <Icon name={option.icon} size={14} />
        </button>
      ))}
    </div>
  );
}

/** Font and paragraph settings for the selected text layers. */
function TextSection({ layers }: { layers: TextNode[] }) {
  const { store } = useEditorContext();
  const ids = layers.map((layer) => layer.id);
  const set = (label: string, patch: LayerPatch): void => updateLayers(store, label, ids, patch);
  const family = shared(layers, (l) => (l as TextNode).fontFamily);
  const weight = shared(layers, (l) => (l as TextNode).fontWeight);
  const lineHeight = shared(layers, (l) => (l as TextNode).lineHeight);
  const fontSize = shared(layers, (l) => (l as TextNode).fontSize);
  const fonts = availableFonts(family === MIXED ? undefined : family);
  const autoLine = lineHeight === null;

  return (
    <Section title="Text">
      <Row>
        <select
          aria-label="Font family"
          className="od-field flex-1"
          value={family}
          onChange={(event) => set('Change font', { fontFamily: event.currentTarget.value })}
        >
          {family === MIXED && <option value={MIXED}>Mixed</option>}
          {fonts.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </select>
      </Row>
      <Row>
        <select
          aria-label="Font weight"
          className="od-field flex-1"
          value={weight}
          onChange={(event) => set('Change font weight', { fontWeight: Number(event.currentTarget.value) })}
        >
          {weight === MIXED && <option value={MIXED}>Mixed</option>}
          {FONT_WEIGHTS.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <div className="w-[76px] flex-none">
          <NumberField label="Font size" min={1} max={2000} value={fontSize} onCommit={(value) => set('Change font size', { fontSize: value })} />
        </div>
      </Row>
      <Row>
        <NumberField
          label="Line height"
          prefix="Line"
          min={1}
          value={lineHeight === MIXED ? MIXED : (lineHeight ?? (fontSize === MIXED ? MIXED : Math.round(fontSize * 1.2)))}
          onCommit={(value) => set('Change line height', { lineHeight: value })}
        />
        <button
          type="button"
          className="od-icon-button !h-[26px] !w-12 text-[11px]"
          aria-label="Automatic line height"
          aria-pressed={autoLine}
          title="Automatic line height (1.2 × font size)"
          onClick={() => set('Change line height', { lineHeight: null })}
        >
          Auto
        </button>
        <NumberField
          label="Letter spacing"
          prefix="Space"
          min={-200}
          max={2000}
          value={shared(layers, (l) => (l as TextNode).letterSpacing)}
          onCommit={(value) => set('Change letter spacing', { letterSpacing: value })}
        />
      </Row>
      <Row>
        <ToggleGroup<TextAlign>
          label="Horizontal alignment"
          value={shared(layers, (l) => (l as TextNode).textAlign)}
          onChange={(value) => set('Change text alignment', { textAlign: value })}
          options={[
            { value: 'LEFT', label: 'Align text left', icon: 'textLeft' },
            { value: 'CENTER', label: 'Align text centre', icon: 'textCenter' },
            { value: 'RIGHT', label: 'Align text right', icon: 'textRight' },
          ]}
        />
        <ToggleGroup<VerticalAlign>
          label="Vertical alignment"
          value={shared(layers, (l) => (l as TextNode).verticalAlign)}
          onChange={(value) => set('Change vertical alignment', { verticalAlign: value })}
          options={[
            { value: 'TOP', label: 'Align text top', icon: 'textTop' },
            { value: 'MIDDLE', label: 'Align text middle', icon: 'textMiddle' },
            { value: 'BOTTOM', label: 'Align text bottom', icon: 'textBottom' },
          ]}
        />
      </Row>
      <Row>
        <select
          aria-label="Text box sizing"
          className="od-field flex-1"
          value={shared(layers, (l) => (l as TextNode).textAutoResize)}
          onChange={(event) => set('Change text sizing', { textAutoResize: event.currentTarget.value as TextAutoResize })}
        >
          {shared(layers, (l) => (l as TextNode).textAutoResize) === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="WIDTH_AND_HEIGHT">Auto width</option>
          <option value="HEIGHT">Auto height</option>
          <option value="NONE">Fixed size</option>
        </select>
      </Row>
      <Row>
        <select
          aria-label="Letter case"
          className="od-field flex-1"
          value={shared(layers, (l) => (l as TextNode).textCase)}
          onChange={(event) => set('Change letter case', { textCase: event.currentTarget.value as TextCase })}
        >
          {shared(layers, (l) => (l as TextNode).textCase) === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="ORIGINAL">As typed</option>
          <option value="UPPER">UPPERCASE</option>
          <option value="LOWER">lowercase</option>
          <option value="TITLE">Title Case</option>
        </select>
        <select
          aria-label="Text decoration"
          className="od-field flex-1"
          value={shared(layers, (l) => (l as TextNode).textDecoration)}
          onChange={(event) => set('Change text decoration', { textDecoration: event.currentTarget.value as TextDecoration })}
        >
          {shared(layers, (l) => (l as TextNode).textDecoration) === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="NONE">No decoration</option>
          <option value="UNDERLINE">Underline</option>
          <option value="STRIKETHROUGH">Strikethrough</option>
        </select>
      </Row>
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          className="accent-[var(--od-accent)]"
          checked={layers.every((layer) => layer.italic)}
          onChange={(event) => set('Change italic', { italic: event.currentTarget.checked })}
        />
        Italic
      </label>
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
  // Groups have no appearance of their own, so they are left out of fills and strokes.
  const paintable = layers.filter((layer) => layer.type !== 'GROUP');
  const textLayers = layers.filter((layer): layer is TextNode => layer.type === 'TEXT');
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
    // setLayerBox scales the contents of groups along with their box.
    store.getState().apply(label, (d) => {
      let next = d;
      for (const id in patches) next = setLayerBox(next, id, patches[id] as LayerPatch);
      return next;
    });
  };

  const title = layers.length === 1 ? TYPE_LABELS[first.type] : `${layers.length} layers`;

  return (
    <aside aria-label="Design properties" className="h-full overflow-y-auto">
      <div className="flex h-9 items-center border-b border-line px-3 font-medium">{title}</div>
      <ArrangeBar />

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

      {textLayers.length === layers.length && <TextSection layers={textLayers} />}

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

      {paintable.some((l) => l.type !== 'LINE') && (
        <PaintList title="Fill" paintKey="fills" layers={paintable.filter((l) => l.type !== 'LINE')} defaultColor={DEFAULT_SHAPE_FILL} />
      )}

      {paintable.length > 0 && (
      <PaintList title="Stroke" paintKey="strokes" layers={paintable} defaultColor={BLACK}>
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
      )}
    </aside>
  );
}
