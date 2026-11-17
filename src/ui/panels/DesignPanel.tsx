import { useMemo } from 'react';
import {
  BLACK,
  BLEND_MODES,
  BOOLEAN_NAMES,
  clean,
  DEFAULT_SHAPE_FILL,
  hasCornerRadius,
  isInFlow,
  isLayer,
  isPage,
  lineBox,
  lineEndpoints,
  paintColor,
  patchNodes,
  releaseSizing,
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
import { AutoLayoutSection, ResizingSection } from './AutoLayoutSection';
import { ComponentSection } from './ComponentSections';
import { LocalTokens, StylesSection, VariablesSection } from './TokenSections';
import { ExportSection, PageExportSection } from './ExportSection';
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

/**
 * How each strip of buttons is split into wells, Figma's way: horizontal
 * alignment, vertical alignment and distribution; the four boolean operations
 * and flattening. The buttons keep their order; only the wells are drawn.
 */
const ARRANGE_GROUPS = [3, 3, 2] as const;
const BOOLEAN_GROUPS = [4, 1] as const;

/** Consecutive groups of the given sizes, in order. */
function inGroups<T>(items: readonly T[], sizes: readonly number[]): T[][] {
  const groups: T[][] = [];
  let at = 0;
  for (const size of sizes) {
    groups.push(items.slice(at, at + size));
    at += size;
  }
  return groups;
}

/** A pressed-in well holding a group of icon buttons. Its share of the strip follows its number of buttons, so every button is as wide as the next. */
const WELL = 'flex min-w-0 basis-0 rounded-[8px] bg-field shadow-[var(--ev-sunk)]';
/** An icon button that fills its share of a well. */
const WELL_BUTTON = 'ev-icon-button !h-7 !w-auto min-w-0 !flex-1';

/** The icon of a layer, as the layers panel shows it. */
const TYPE_ICONS: Record<LayerNode['type'], IconName> = {
  FRAME: 'frame',
  GROUP: 'group',
  RECTANGLE: 'rectangle',
  ELLIPSE: 'ellipse',
  LINE: 'line',
  POLYGON: 'polygon',
  STAR: 'star',
  TEXT: 'text',
  VECTOR: 'vector',
  BOOLEAN_OPERATION: 'union',
};

function layerIcon(layer: LayerNode): IconName {
  if (layer.isMask) return 'mask';
  if (layer.type === 'BOOLEAN_OPERATION') return ({ UNION: 'union', SUBTRACT: 'subtract', INTERSECT: 'intersect', EXCLUDE: 'exclude' } as const)[layer.operation];
  if (layer.type === 'FRAME') {
    if (layer.kind === 'COMPONENT' || layer.kind === 'COMPONENT_SET') return 'component';
    if (layer.kind === 'INSTANCE') return 'instance';
    if (layer.layoutMode !== 'NONE') return layer.layoutMode === 'VERTICAL' ? 'layoutColumn' : 'layoutRow';
  }
  return TYPE_ICONS[layer.type];
}

/** A row's label, Figma's way: small and quiet, in a fixed column so the controls beside it line up. */
const LABEL = 'w-[72px] flex-none truncate text-[11px] text-dim';

/** A checkbox drawn as a small pressed-in well that fills with the accent when it is checked. */
const CHECKBOX =
  'peer m-0 block h-3.5 w-3.5 flex-none cursor-pointer appearance-none rounded-[4px] bg-field shadow-[var(--ev-sunk)] transition-[background-color,box-shadow] duration-150 hover:bg-hover checked:bg-accent checked:bg-[image:var(--ev-primary)] checked:shadow-[var(--ev-primary-shadow)]';
/** The label of a checkbox: the whole row is the target, the words are small. */
const CHECK_LABEL = 'flex h-6 cursor-pointer items-center gap-2 text-[11px] text-ink';

/** The tick drawn over a checked CHECKBOX. It follows the input, so the input's state can show it. */
function Tick() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="pointer-events-none absolute inset-0 h-3.5 w-3.5 text-accent-ink opacity-0 transition-opacity duration-150 peer-checked:opacity-100"
    >
      <path d="M4.3 8.4l2.4 2.4 5-5.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Buttons for combining shapes. They run the same commands as the Object menu and its shortcuts. */
function BooleanBar() {
  const run = useRunCommand();
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const state = useEditorContext().store.getState();
  void doc;
  void selection;
  return (
    <div role="toolbar" aria-label="Combine shapes" className="flex items-center gap-1">
      {inGroups(BOOLEAN_BUTTONS, BOOLEAN_GROUPS).map((group) => (
        <div key={group[0]?.id} className={WELL} style={{ flexGrow: group.length }}>
          {group.map(({ id, icon }) => {
            const command = getCommand(id) as Command;
            return (
              <button
                key={id}
                type="button"
                className={WELL_BUTTON}
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
      ))}
    </div>
  );
}

/** Align and distribute buttons. They run the same commands as the Arrange menu and its shortcuts. */
function ArrangeBar() {
  const run = useRunCommand();
  // Re-render when anything that affects availability changes.
  const state = useEditor((s) => s);
  return (
    <div role="toolbar" aria-label="Align and distribute" className="flex items-center gap-1">
      {inGroups(ARRANGE_BUTTONS, ARRANGE_GROUPS).map((group) => (
        <div key={group[0]?.id} className={WELL} style={{ flexGrow: group.length }}>
          {group.map(({ id, icon }) => {
            const command = getCommand(id) as Command;
            return (
              <button
                key={id}
                type="button"
                className={WELL_BUTTON}
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
      ))}
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
    <div role="radiogroup" aria-label={label} className="ev-segmented min-w-0 flex-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.label}
          title={option.label}
          className={`flex h-6 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-[7px] border-0 transition-[color,background-color,box-shadow] duration-150 ${
            value === option.value
              ? 'bg-[image:var(--ev-button)] text-ink shadow-[var(--ev-raise)]'
              : 'bg-transparent text-dim hover:text-ink'
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
          className="ev-field flex-1"
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
          className="ev-field flex-1"
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
          className="ev-icon-button !w-12 text-[11px] font-medium"
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
          className="ev-field flex-1"
          value={shared(layers, (l) => (l as TextNode).listType)}
          onChange={(event) => set('Change list', { listType: event.currentTarget.value as TextListType })}
        >
          {shared(layers, (l) => (l as TextNode).listType) === MIXED && <option value={MIXED}>Mixed</option>}
          <option value="NONE">No list</option>
          <option value="BULLETED">Bulleted list</option>
          <option value="NUMBERED">Numbered list</option>
        </select>
        <div className="w-[96px] flex-none" title="Space between paragraphs">
          <NumberField
            label="Paragraph spacing"
            prefix="Para"
            min={0}
            max={10000}
            value={shared(layers, (l) => (l as TextNode).paragraphSpacing)}
            onCommit={(value) => set('Change paragraph spacing', { paragraphSpacing: value })}
          />
        </div>
      </Row>
      <Row>
        <select
          aria-label="Text box sizing"
          className="ev-field flex-1"
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
          className="ev-field flex-1"
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
          className="ev-field flex-1"
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
            className="ev-icon-button !w-14 text-[11px] font-medium"
            aria-label="Use the layer's fill for the selected text"
            title="Use the layer's fill for the selected text"
            disabled={ownColour === null}
            onClick={() => style('Change text colour', { color: null })}
          >
            Reset
          </button>
        </Row>
      )}
      <label className={CHECK_LABEL}>
        <span className="relative flex flex-none">
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={font((s) => s.italic) === true}
            onChange={(event) => style('Change italic', { italic: event.currentTarget.checked })}
          />
          <Tick />
        </span>
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
        <span className={LABEL}>Background</span>
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
          <span className="min-w-0 flex-1 text-[11px] text-dim">
            {page.guides.length} {page.guides.length === 1 ? 'ruler guide' : 'ruler guides'}
          </span>
          <button
            type="button"
            className="ev-button !h-7 flex-none !px-2.5 text-[11px]"
            onClick={() => store.getState().apply('Remove all guides', (d) => patchNodes(d, { [pageId]: { guides: [] } }))}
          >
            Remove all
          </button>
        </Row>
      )}
      <p className="m-0 text-[11px] text-faint">Select a layer to see its properties.</p>
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
        <LocalTokens />
        <PageExportSection />
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
  // A layer that an Auto Layout frame places has no position of its own to type in, and no use for constraints.
  const placed = layers.some((layer) => isInFlow(doc, layer) || layer.sourceId !== null);
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
      // A size typed in stands: the layers no longer hug or fill in that direction.
      return releaseSizing(next, Object.keys(patches), { horizontal: size.width !== undefined, vertical: size.height !== undefined });
    });
  };

  const title = layers.length === 1 ? TYPE_LABELS[first.type] : `${layers.length} layers`;
  // The heading shows the kind of the selected layers as the layers panel draws it, or a stack where kinds differ.
  const icons = layers.map(layerIcon);
  const icon = icons.every((name) => name === icons[0]) ? (icons[0] as IconName) : 'group';

  return (
    <aside aria-label="Design properties" className="h-full overflow-y-auto pb-2" data-text-tools>
      <div className="flex h-11 items-center gap-2 px-3">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-[image:var(--ev-button)] text-dim shadow-[var(--ev-raise)]"
        >
          <Icon name={icon} size={13} />
        </span>
        <span className="min-w-0 truncate text-[12px] font-semibold text-ink">{title}</span>
      </div>
      <div className="flex flex-col gap-2 border-b border-line px-3 pb-3">
        <ArrangeBar />
        <BooleanBar />
      </div>

      <Section title="Position and size">
        <Row>
          <NumberField label="X position" prefix="X" disabled={placed} value={shared(layers, (l) => l.x)} onCommit={(x) => set('Move', { x })} />
          <NumberField label="Y position" prefix="Y" disabled={placed} value={shared(layers, (l) => l.y)} onCommit={(y) => set('Move', { y })} />
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
            // The radius and its per-corner switch share the second column, so the columns line up with X and Y above.
            <div className="flex min-w-0 flex-1 items-center gap-1">
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
                className="ev-icon-button"
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
            </div>
          ) : (
            <div className="flex-1" />
          )}
        </Row>
        {perCorner && (
          <div className="grid grid-cols-2 gap-2">
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
          <label className={CHECK_LABEL}>
            <span className="relative flex flex-none">
              <input
                type="checkbox"
                className={CHECKBOX}
                checked={frames.every((frame) => frame.clipsContent)}
                onChange={(event) => set('Change clip content', { clipsContent: event.currentTarget.checked })}
              />
              <Tick />
            </span>
            Clip content
          </label>
        )}
        {layers.length === 1 && first.type === 'FRAME' && first.guides.length > 0 && (
          <Row>
            <span className="min-w-0 flex-1 text-[11px] text-dim">
              {first.guides.length} {first.guides.length === 1 ? 'guide' : 'guides'} in this frame
            </span>
            <button
              type="button"
              className="ev-button !h-7 flex-none !px-2.5 text-[11px]"
              aria-label="Remove all guides of this frame"
              onClick={() => store.getState().apply('Remove all guides', (d) => patchNodes(d, { [first.id]: { guides: [] } }))}
            >
              Remove all
            </button>
          </Row>
        )}
      </Section>

      <ComponentSection layers={layers} />

      <ResizingSection layers={layers} />

      {frames.length === layers.length && <AutoLayoutSection frames={frames} />}

      {insideFrames && !placed && <ConstraintsSection layers={layers} />}

      {frames.length === layers.length && <LayoutGridSection frames={frames} />}

      {textLayers.length === layers.length && <TextSection layers={textLayers} />}

      {vectors.length === layers.length && <VectorSection layers={vectors} />}

      {booleans.length === layers.length && (
        <Section title="Boolean group">
          <Row>
            <span className={LABEL}>Operation</span>
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
          <span className={LABEL}>Opacity</span>
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
          <span className={LABEL}>Blend</span>
          <SelectField<BlendMode>
            label="Blend mode"
            value={shared(layers, (l) => l.blendMode)}
            options={BLEND_NAMES}
            onChange={(blendMode) => set('Change blend mode', { blendMode })}
          />
        </Row>
        <label className={CHECK_LABEL}>
          <span className="relative flex flex-none">
            <input
              type="checkbox"
              className={CHECKBOX}
              checked={layers.every((layer) => layer.isMask)}
              onChange={(event) => set(event.currentTarget.checked ? 'Use as mask' : 'Remove mask', { isMask: event.currentTarget.checked })}
            />
            <Tick />
          </span>
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
              className="ev-field flex-1"
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
        {layers.every((l) => l.type === 'FRAME' || l.type === 'RECTANGLE') && (
          <>
            <label className={CHECK_LABEL}>
              <span className="relative flex flex-none">
                <input
                  type="checkbox"
                  className={CHECKBOX}
                  checked={layers.every((l) => l.strokeSides !== null)}
                  onChange={(event) => {
                    if (!event.currentTarget.checked) return set('Same stroke on every side', { strokeSides: null });
                    // Each side starts at the weight the stroke has all round.
                    const patches: Record<NodeId, LayerPatch> = {};
                    for (const l of layers) if (l.strokeSides === null) patches[l.id] = { strokeSides: { top: l.strokeWeight, right: l.strokeWeight, bottom: l.strokeWeight, left: l.strokeWeight } };
                    store.getState().apply('Stroke each side', (doc) => patchNodes(doc, patches));
                  }}
                />
                <Tick />
              </span>
              A weight for each side
            </label>
            {layers.every((l) => l.strokeSides !== null) && (
              <div className="grid grid-cols-4 gap-1.5">
                {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                  <NumberField
                    key={side}
                    label={`Stroke weight, ${side}`}
                    prefix={side[0]!.toUpperCase()}
                    min={0}
                    value={shared(layers, (l) => l.strokeSides?.[side] ?? 0)}
                    onCommit={(weight) => {
                      const patches: Record<NodeId, LayerPatch> = {};
                      for (const l of layers) if (l.strokeSides) patches[l.id] = { strokeSides: { ...l.strokeSides, [side]: weight } };
                      store.getState().apply(`Change ${side} stroke weight`, (doc) => patchNodes(doc, patches));
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
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

      <StylesSection layers={layers} />

      <VariablesSection layers={layers} />

      <ExportSection ids={ids} name={layers.length === 1 ? first.name : `${layers.length} layers`} />
    </aside>
  );
}
