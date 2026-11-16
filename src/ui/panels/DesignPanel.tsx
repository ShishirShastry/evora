import { useMemo } from 'react';
import {
  BLACK,
  BLEND_MODES,
  BOOLEAN_NAMES,
  clean,
  DEFAULT_SHAPE_FILL,
  hasCornerRadius,
  isLayer,
  isPage,
  lineBox,
  lineEndpoints,
  paintColor,
  patchNodes,
  resizeFromTopLeft,
  setLayerBox,
  stylesBetween,
  TYPE_LABELS,
  type ArrowType,
  type BlendMode,
  type BooleanOperation,
  type BooleanOperationNode,
  type CharacterStyle,
  type CornerRadii,
  type EllipseNode,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LineNode,
  type NodeId,
  type RangeStylePatch,
  type StrokeAlign,
  type StrokeCap,
  type StrokeJoin,
  type TextAlign,
  type TextListType,
  type TextAutoResize,
  type TextCase,
  type TextDecoration,
  type TextNode,
  type VectorNode,
  type VerticalAlign,
} from '../../core';
import { availableFonts } from '../../engine/text/measure';
import { getCommand, styleText, updateLayers, type Command } from '../../state/commands';
import { ColorField } from '../components/ColorField';
import { MIXED, NumberField, type Mixed } from '../components/Fields';
import { Icon, type IconName } from '../components/Icon';
import { useEditor, useEditorContext, useRunCommand } from '../editor/EditorContext';
import { EffectsSection } from './EffectsSection';
import { ConstraintsSection, LayoutGridSection } from './LayoutSections';
import { PaintList } from './PaintList';
import { applyLive, Row, Section, SelectField, shared } from './panelParts';
import { VectorSection } from './VectorSection';

const CORNER_NAMES = ['Top left', 'Top right', 'Bottom right', 'Bottom left'] as const;

const BLEND_NAMES: readonly (readonly [BlendMode, string])[] = BLEND_MODES.map((mode) => {
  const words = mode.toLowerCase().replace(/_/g, ' ');
  return [mode, words.charAt(0).toUpperCase() + words.slice(1)] as const;
});

const CAP_NAMES: readonly (readonly [StrokeCap, string])[] = [
  ['NONE', 'Flat ends'],
  ['ROUND', 'Round ends'],
  ['SQUARE', 'Square ends'],
];

const OPERATION_NAMES: readonly (readonly [BooleanOperation, string])[] = [
  ['UNION', 'Union'],
  ['SUBTRACT', 'Subtract'],
  ['INTERSECT', 'Intersect'],
  ['EXCLUDE', 'Exclude'],
];

const ARROW_NAMES: readonly (readonly [ArrowType, string])[] = [
  ['NONE', 'No arrow'],
  ['LINE', 'Line arrow'],
  ['TRIANGLE', 'Triangle'],
  ['CIRCLE', 'Circle'],
  ['DIAMOND', 'Diamond'],
];

const JOIN_NAMES: readonly (readonly [StrokeJoin, string])[] = [
  ['MITER', 'Sharp corners'],
  ['BEVEL', 'Cut corners'],
  ['ROUND', 'Round corners'],
];


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

const BOOLEAN_BUTTONS: { id: string; icon: IconName }[] = [
  { id: 'object.union', icon: 'union' },
  { id: 'object.subtract', icon: 'subtract' },
  { id: 'object.intersect', icon: 'intersect' },
  { id: 'object.exclude', icon: 'exclude' },
  { id: 'object.flatten', icon: 'vector' },
];

/** Buttons for combining shapes. They run the same commands as the Object menu and its shortcuts. */
function BooleanBar() {
  const run = useRunCommand();
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const state = useEditorContext().store.getState();
  void doc;
  void selection;
  return (
    <div role="toolbar" aria-label="Combine shapes" className="flex h-10 items-center gap-1 border-b border-line px-2">
      {BOOLEAN_BUTTONS.map(({ id, icon }) => {
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
  const editingId = useEditor((s) => s.editingTextId);
  const textSelection = useEditor((s) => s.textSelection);
  const ids = layers.map((layer) => layer.id);
  const set = (label: string, patch: LayerPatch): void => updateLayers(store, label, ids, patch);
  // While part of the text being edited is selected, the font settings are those of that part and change only it.
  const part = layers.length === 1 && layers[0]?.id === editingId && textSelection !== null && textSelection.end > textSelection.start ? textSelection : null;
  const style = (label: string, patch: RangeStylePatch): void => styleText(store, label, ids, patch);
  /** A font property over the text in question: its one value, or mixed where stretches of it differ. */
  const font = <T,>(pick: (found: CharacterStyle) => T): T | Mixed => {
    let value: T | undefined;
    let first = true;
    for (const layer of layers) {
      for (const found of stylesBetween(layer, part ? part.start : 0, part ? part.end : layer.characters.length)) {
        const next = pick(found);
        if (first) value = next;
        else if (next !== value) return MIXED;
        first = false;
      }
    }
    return value as T;
  };
  const family = font((s) => s.fontFamily);
  const weight = font((s) => s.fontWeight);
  const lineHeight = shared(layers, (l) => (l as TextNode).lineHeight);
  const fontSize = font((s) => s.fontSize);
  const decoration = font((s) => s.textDecoration);
  // The colour of the selected part: its own, or else what the layer's fill gives it.
  const partStyles = part && layers[0] ? stylesBetween(layers[0], part.start, part.end) : [];
  const ownColour = partStyles.find((found) => found.color !== null)?.color ?? null;
  const layerFill = layers[0]?.fills.find((paint) => paint.visible);
  const partColour = ownColour ?? (layerFill ? paintColor(layerFill) : BLACK);
  const fonts = availableFonts(family === MIXED ? undefined : family);
  const autoLine = lineHeight === null;

  return (
    <Section title={part ? 'Text (selected part)' : 'Text'}>
      <Row>
        <select
          aria-label="Font family"
          className="od-field flex-1"
          value={family}
          onChange={(event) => style('Change font', { fontFamily: event.currentTarget.value })}
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
          onChange={(event) => style('Change font weight', { fontWeight: Number(event.currentTarget.value) })}
        >
          {weight === MIXED && <option value={MIXED}>Mixed</option>}
          {FONT_WEIGHTS.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <div className="w-[76px] flex-none">
          <NumberField label="Font size" min={1} max={2000} value={fontSize} onCommit={(value) => style('Change font size', { fontSize: value })} />
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
          value={font((s) => s.letterSpacing)}
          onCommit={(value) => style('Change letter spacing', { letterSpacing: value })}
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
            { value: 'JUSTIFIED', label: 'Justify text', icon: 'textJustify' },
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
          aria-label="List"
          className="od-field flex-1"
          value={shared(layers, (l) => (l as TextNode).listType)}
          onChange={(event) => set('Change list', { listType: event.currentTarget.value as TextListType })}
        >
          {shared(layers, (l) => (l as TextNode).listType) === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="NONE">No list</option>
          <option value="BULLETED">Bulleted list</option>
          <option value="NUMBERED">Numbered list</option>
        </select>
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
          value={decoration}
          onChange={(event) => style('Change text decoration', { textDecoration: event.currentTarget.value as TextDecoration })}
        >
          {decoration === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="NONE">No decoration</option>
          <option value="UNDERLINE">Underline</option>
          <option value="STRIKETHROUGH">Strikethrough</option>
        </select>
      </Row>
      {part && (
        <Row>
          <ColorField label="Selected text colour" value={partColour} onChange={(color, phase) => phase === 'commit' && style('Change text colour', { color })} />
          <button
            type="button"
            className="od-icon-button !h-[26px] !w-14 text-[11px]"
            aria-label="Use the layer's fill for the selected text"
            title="Use the layer's fill for the selected text"
            disabled={ownColour === null}
            onClick={() => style('Change text colour', { color: null })}
          >
            Reset
          </button>
        </Row>
      )}
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          className="accent-[var(--od-accent)]"
          checked={font((s) => s.italic) === true}
          onChange={(event) => style('Change italic', { italic: event.currentTarget.checked })}
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
      {page.guides.length > 0 && (
        <Row>
          <span className="flex-1 text-dim">
            {page.guides.length} {page.guides.length === 1 ? 'ruler guide' : 'ruler guides'}
          </span>
          <button
            type="button"
            className="od-button !h-[26px] flex-none !px-2"
            onClick={() => store.getState().apply('Remove all guides', (d) => patchNodes(d, { [pageId]: { guides: [] } }))}
          >
            Remove all
          </button>
        </Row>
      )}
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
      <aside aria-label="Design properties" className="h-full overflow-y-auto" data-text-tools>
        <PageProperties />
      </aside>
    );
  }

  const ids = layers.map((layer) => layer.id);
  const first = layers[0] as LayerNode;
  const allLines = layers.every((layer) => layer.type === 'LINE');
  const anyLine = layers.some((layer) => layer.type === 'LINE');
  const radiusLayers = layers.filter(hasCornerRadius);
  const frames = layers.filter((layer): layer is FrameNode => layer.type === 'FRAME');
  // Constraints only do something for a layer that sits directly inside a frame.
  const insideFrames = layers.every((layer) => doc.nodes[layer.parentId]?.type === 'FRAME');
  const pointLayers = layers.filter((layer) => layer.type === 'POLYGON' || layer.type === 'STAR');
  // Groups have no appearance of their own, so they are left out of fills and strokes.
  const paintable = layers.filter((layer) => layer.type !== 'GROUP');
  const textLayers = layers.filter((layer): layer is TextNode => layer.type === 'TEXT');
  const stars = layers.filter((layer) => layer.type === 'STAR');
  const vectors = layers.filter((layer): layer is VectorNode => layer.type === 'VECTOR');
  const ellipses = layers.filter((layer): layer is EllipseNode => layer.type === 'ELLIPSE');
  const booleans = layers.filter((layer): layer is BooleanOperationNode => layer.type === 'BOOLEAN_OPERATION');
  // Arrowheads go on strokes that have ends: lines, and vectors (where they show on open paths).
  const arrowLayers = layers.filter((layer): layer is LineNode | VectorNode => layer.type === 'LINE' || layer.type === 'VECTOR');
  const set = (label: string, patch: LayerPatch): void => updateLayers(store, label, ids, patch);
  /** Applies a patch computed separately for each layer, as one undo step. */
  const setEach = (label: string, targets: readonly LayerNode[], make: (layer: LayerNode) => LayerPatch): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const layer of targets) patches[layer.id] = make(layer);
    store.getState().apply(label, (d) => patchNodes(d, patches));
  };
  const allHaveRadius = radiusLayers.length === layers.length;
  const perCorner = allHaveRadius && radiusLayers.every((layer) => layer.cornerRadii !== null);
  const cornersOf = (layer: LayerNode): CornerRadii =>
    hasCornerRadius(layer) ? (layer.cornerRadii ?? [layer.cornerRadius, layer.cornerRadius, layer.cornerRadius, layer.cornerRadius]) : [0, 0, 0, 0];
  const setDash = (dash: number | undefined, gap: number | undefined): void =>
    setEach('Change stroke dashes', paintable, (layer) => {
      const length = dash ?? layer.dashPattern[0] ?? 0;
      const space = gap ?? layer.dashPattern[1] ?? length;
      return { dashPattern: length > 0 ? [length, space > 0 ? space : length] : [] };
    });

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
    <aside aria-label="Design properties" className="h-full overflow-y-auto" data-text-tools>
      <div className="flex h-9 items-center border-b border-line px-3 font-medium">{title}</div>
      <ArrangeBar />
      <BooleanBar />

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
          {allHaveRadius ? (
            <>
              <NumberField
                label="Corner radius"
                prefix="R"
                min={0}
                disabled={perCorner}
                value={perCorner ? MIXED : shared(radiusLayers, (l) => (hasCornerRadius(l) ? l.cornerRadius : 0))}
                onCommit={(cornerRadius) => set('Change corner radius', { cornerRadius })}
              />
              <button
                type="button"
                className="od-icon-button !h-[26px] !w-[26px]"
                aria-label="Separate corner radii"
                aria-pressed={perCorner}
                title="Set each corner separately"
                onClick={() =>
                  setEach('Change corner radius', radiusLayers, (layer) =>
                    perCorner ? { cornerRadii: null, cornerRadius: Math.max(...cornersOf(layer)) } : { cornerRadii: cornersOf(layer) },
                  )
                }
              >
                <Icon name="corners" size={14} />
              </button>
            </>
          ) : (
            <div className="flex-1" />
          )}
        </Row>
        {perCorner && (
          <div className="grid grid-cols-2 gap-1.5">
            {/* Shown in reading order: top row, then bottom row. */}
            {[0, 1, 3, 2].map((corner) => (
              <NumberField
                key={corner}
                label={`${CORNER_NAMES[corner]} radius`}
                prefix={['TL', 'TR', 'BR', 'BL'][corner]}
                min={0}
                value={shared(radiusLayers, (l) => cornersOf(l)[corner] as number)}
                onCommit={(value) =>
                  setEach('Change corner radius', radiusLayers, (layer) => {
                    const radii = [...cornersOf(layer)] as CornerRadii;
                    radii[corner] = value;
                    return { cornerRadii: radii };
                  })
                }
              />
            ))}
          </div>
        )}
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
        {ellipses.length === layers.length && (
          <>
            <Row>
              <NumberField
                label="Arc start"
                prefix="Start"
                suffix="°"
                min={-360}
                max={360}
                value={shared(ellipses, (l) => (l.type === 'ELLIPSE' ? l.arcStart : 0))}
                onCommit={(arcStart) => set('Change arc', { arcStart })}
              />
              <NumberField
                label="Arc sweep"
                prefix="Sweep"
                suffix="°"
                min={1}
                max={360}
                value={shared(ellipses, (l) => (l.type === 'ELLIPSE' ? l.arcSweep : 360))}
                onCommit={(arcSweep) => set('Change arc', { arcSweep })}
              />
            </Row>
            <Row>
              <NumberField
                label="Arc ratio"
                prefix="Ratio"
                suffix="%"
                min={0}
                max={99}
                value={shared(ellipses, (l) => (l.type === 'ELLIPSE' ? Math.round(l.arcRatio * 100) : 0))}
                onCommit={(value) => set('Change arc', { arcRatio: value / 100 })}
              />
              <div className="flex-1" />
            </Row>
          </>
        )}
        {frames.length === layers.length && (
          <label className="mt-0.5 flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="accent-[var(--od-accent)]"
              checked={frames.every((frame) => frame.clipsContent)}
              onChange={(event) => set('Change clip content', { clipsContent: event.currentTarget.checked })}
            />
            Clip content
          </label>
        )}
        {layers.length === 1 && first.type === 'FRAME' && first.guides.length > 0 && (
          <Row>
            <span className="min-w-0 flex-1 text-dim">
              {first.guides.length} {first.guides.length === 1 ? 'guide' : 'guides'} in this frame
            </span>
            <button
              type="button"
              className="od-button !h-[26px] flex-none !px-2"
              aria-label="Remove all guides of this frame"
              onClick={() => store.getState().apply('Remove all guides', (d) => patchNodes(d, { [first.id]: { guides: [] } }))}
            >
              Remove all
            </button>
          </Row>
        )}
      </Section>

      {insideFrames && <ConstraintsSection layers={layers} />}

      {frames.length === layers.length && <LayoutGridSection frames={frames} />}

      {textLayers.length === layers.length && <TextSection layers={textLayers} />}

      {vectors.length === layers.length && <VectorSection layers={vectors} />}

      {booleans.length === layers.length && (
        <Section title="Boolean group">
          <Row>
            <span className="w-20 flex-none text-dim">Operation</span>
            <SelectField<BooleanOperation>
              label="Boolean operation"
              value={shared(booleans, (l) => (l.type === 'BOOLEAN_OPERATION' ? l.operation : 'UNION'))}
              options={OPERATION_NAMES}
              onChange={(operation) =>
                setEach('Change boolean operation', booleans, (layer) => ({
                  operation,
                  // A group still called after its operation is renamed with it.
                  ...(layer.type === 'BOOLEAN_OPERATION' && layer.name === BOOLEAN_NAMES[layer.operation] ? { name: BOOLEAN_NAMES[operation] } : {}),
                }))
              }
            />
          </Row>
        </Section>
      )}

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
        <Row>
          <span className="w-20 flex-none text-dim">Blend</span>
          <SelectField<BlendMode>
            label="Blend mode"
            value={shared(layers, (l) => l.blendMode)}
            options={BLEND_NAMES}
            onChange={(blendMode) => set('Change blend mode', { blendMode })}
          />
        </Row>
        <label className="mt-0.5 flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-[var(--od-accent)]"
            checked={layers.every((layer) => layer.isMask)}
            onChange={(event) => set(event.currentTarget.checked ? 'Use as mask' : 'Remove mask', { isMask: event.currentTarget.checked })}
          />
          Mask the layers above
        </label>
      </Section>

      {paintable.some((l) => l.type !== 'LINE') && (
        <PaintList
          title="Fill"
          paintKey="fills"
          layers={paintable.filter((l) => l.type !== 'LINE')}
          defaultColor={DEFAULT_SHAPE_FILL}
          allowImage={textLayers.length === 0}
        />
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
        <Row>
          <SelectField<StrokeCap>
            label="Stroke ends"
            value={shared(paintable, (l) => l.strokeCap)}
            options={CAP_NAMES}
            onChange={(strokeCap) => updateLayers(store, 'Change stroke ends', paintable.map((l) => l.id), { strokeCap })}
          />
          <SelectField<StrokeJoin>
            label="Stroke corners"
            value={shared(paintable, (l) => l.strokeJoin)}
            options={JOIN_NAMES}
            onChange={(strokeJoin) => updateLayers(store, 'Change stroke corners', paintable.map((l) => l.id), { strokeJoin })}
          />
        </Row>
        <Row>
          <NumberField
            label="Dash length"
            prefix="Dash"
            min={0}
            value={shared(paintable, (l) => l.dashPattern[0] ?? 0)}
            onCommit={(dash) => setDash(dash, undefined)}
          />
          <NumberField
            label="Dash gap"
            prefix="Gap"
            min={0}
            value={shared(paintable, (l) => l.dashPattern[1] ?? l.dashPattern[0] ?? 0)}
            onCommit={(gap) => setDash(undefined, gap)}
          />
        </Row>
        {arrowLayers.length === layers.length && (
          <Row>
            <SelectField<ArrowType>
              label="Start arrow"
              value={shared(arrowLayers, (l) => (l.type === 'LINE' || l.type === 'VECTOR' ? l.startArrow : 'NONE'))}
              options={ARROW_NAMES}
              onChange={(startArrow) => set('Change arrowhead', { startArrow })}
            />
            <SelectField<ArrowType>
              label="End arrow"
              value={shared(arrowLayers, (l) => (l.type === 'LINE' || l.type === 'VECTOR' ? l.endArrow : 'NONE'))}
              options={ARROW_NAMES}
              onChange={(endArrow) => set('Change arrowhead', { endArrow })}
            />
          </Row>
        )}
      </PaintList>
      )}

      <EffectsSection layers={layers} />
    </aside>
  );
}
