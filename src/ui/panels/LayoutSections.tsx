import {
  layoutGrid,
  patchNodes,
  type ConstraintType,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayoutGrid,
  type LayoutGridAlignment,
  type LayoutGridPattern,
  type NodeId,
} from '../../core';
import { ColorField } from '../components/ColorField';
import { NumberField } from '../components/Fields';
import { Icon } from '../components/Icon';
import type { Mixed } from '../components/Fields';
import { useEditorContext } from '../editor/EditorContext';
import { applyLive, Row, Section, SelectField, shared } from './panelParts';

const HORIZONTAL: readonly (readonly [ConstraintType, string])[] = [
  ['MIN', 'Left'],
  ['MAX', 'Right'],
  ['CENTER', 'Center'],
  ['STRETCH', 'Left and right'],
  ['SCALE', 'Scale'],
];

const VERTICAL: readonly (readonly [ConstraintType, string])[] = [
  ['MIN', 'Top'],
  ['MAX', 'Bottom'],
  ['CENTER', 'Center'],
  ['STRETCH', 'Top and bottom'],
  ['SCALE', 'Scale'],
];

/**
 * A picture of the constraints, Figma's way: the frame, the layer in it, and
 * the edges and centres the layer is pinned to lit in the accent. It only
 * shows; the dropdowns beside it change them.
 */
function ConstraintsPreview({ horizontal, vertical }: { horizontal: ConstraintType | Mixed; vertical: ConstraintType | Mixed }) {
  return (
    <div aria-hidden="true" className="flex w-[76px] flex-none items-center justify-center rounded-[10px] bg-field shadow-[var(--ev-sunk)]">
      <svg width="60" height="60" viewBox="0 0 60 60">
        <rect x="3.5" y="3.5" width="53" height="53" rx="6" fill="none" stroke="currentColor" strokeOpacity="0.55" className="text-faint" />
        <rect x="20.5" y="20.5" width="19" height="19" rx="3" fill="none" stroke="currentColor" className="text-dim" />
        <Pin on={horizontal === 'MIN' || horizontal === 'STRETCH'} x1={8} y1={30} x2={15} y2={30} />
        <Pin on={horizontal === 'MAX' || horizontal === 'STRETCH'} x1={45} y1={30} x2={52} y2={30} />
        <Pin on={vertical === 'MIN' || vertical === 'STRETCH'} x1={30} y1={8} x2={30} y2={15} />
        <Pin on={vertical === 'MAX' || vertical === 'STRETCH'} x1={30} y1={45} x2={30} y2={52} />
        <Pin on={horizontal === 'CENTER'} x1={25.5} y1={30} x2={34.5} y2={30} />
        <Pin on={vertical === 'CENTER'} x1={30} y1={25.5} x2={30} y2={34.5} />
      </svg>
    </div>
  );
}

/** One of the preview's pins: faint, or lit when the layer is held there. */
function Pin({ on, ...at }: { on: boolean; x1: number; y1: number; x2: number; y2: number }) {
  return (
    <line
      {...at}
      stroke="currentColor"
      strokeWidth={on ? 2 : 1.5}
      strokeLinecap="round"
      strokeOpacity={on ? 1 : 0.7}
      className={`transition-colors duration-150 ${on ? 'text-accent' : 'text-faint'}`}
    />
  );
}

/**
 * How the selected layers behave when the frame they are in is resized.
 * Shown only for layers that sit directly inside a frame, since that is the
 * only place constraints have any effect.
 */
export function ConstraintsSection({ layers }: { layers: LayerNode[] }) {
  const { store } = useEditorContext();
  const setAxis = (axis: 'horizontal' | 'vertical', value: ConstraintType): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const layer of layers) patches[layer.id] = { constraints: { ...layer.constraints, [axis]: value } };
    store.getState().apply('Change constraints', (doc) => patchNodes(doc, patches));
  };
  const horizontal = shared(layers, (l) => l.constraints.horizontal);
  const vertical = shared(layers, (l) => l.constraints.vertical);
  return (
    <Section title="Constraints">
      <div className="flex gap-2">
        <ConstraintsPreview horizontal={horizontal} vertical={vertical} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-dim">Horizontal</span>
            <div className="flex">
              <SelectField<ConstraintType>
                label="Horizontal constraint"
                value={horizontal}
                options={HORIZONTAL}
                onChange={(value) => setAxis('horizontal', value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-dim">Vertical</span>
            <div className="flex">
              <SelectField<ConstraintType>
                label="Vertical constraint"
                value={vertical}
                options={VERTICAL}
                onChange={(value) => setAxis('vertical', value)}
              />
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

const PATTERNS: readonly (readonly [LayoutGridPattern, string])[] = [
  ['GRID', 'Grid'],
  ['COLUMNS', 'Columns'],
  ['ROWS', 'Rows'],
];

function alignmentNames(pattern: LayoutGridPattern): readonly (readonly [LayoutGridAlignment, string])[] {
  return [
    ['STRETCH', 'Stretch'],
    ['MIN', pattern === 'ROWS' ? 'Top' : 'Left'],
    ['CENTER', 'Center'],
    ['MAX', pattern === 'ROWS' ? 'Bottom' : 'Right'],
  ];
}

/** The layout grids of the selected frames: uniform grids, columns and rows, each editable, hideable and removable. */
export function LayoutGridSection({ frames }: { frames: FrameNode[] }) {
  const { store } = useEditorContext();
  const first = JSON.stringify((frames[0] as FrameNode).layoutGrids);
  const mixed = !frames.every((frame) => JSON.stringify(frame.layoutGrids) === first);
  const grids = mixed ? [] : (frames[0] as FrameNode).layoutGrids;

  const setGrids = (label: string, next: LayoutGrid[], phase: 'live' | 'commit' = 'commit'): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const frame of frames) patches[frame.id] = { layoutGrids: next };
    applyLive(store, label, phase, (doc) => patchNodes(doc, patches));
  };
  const replace = (index: number, grid: LayoutGrid, label: string, phase: 'live' | 'commit' = 'commit'): void =>
    setGrids(label, grids.map((other, i) => (i === index ? grid : other)), phase);

  return (
    <Section
      title="Layout grid"
      action={
        <button
          type="button"
          className="ev-icon-button -my-0.5"
          aria-label="Add layout grid"
          title="Add layout grid"
          onClick={() => setGrids('Add layout grid', [...grids, layoutGrid('GRID')])}
        >
          <Icon name="plus" size={14} />
        </button>
      }
    >
      {mixed && <p className="m-0 text-[11px] text-dim">The selected frames have different layout grids. Add one to replace them.</p>}
      {!mixed && grids.length === 0 && <p className="m-0 text-[11px] text-faint">No layout grid</p>}
      {grids.map((grid, index) => {
        const name = `Layout grid ${index + 1}`;
        const set = (patch: Partial<LayoutGrid>, label = 'Change layout grid', phase: 'live' | 'commit' = 'commit'): void =>
          replace(index, { ...grid, ...patch }, label, phase);
        const sections = grid.pattern !== 'GRID';
        const stretch = grid.alignment === 'STRETCH';
        return (
          // Each grid after the first stands a little apart, so its rows read as one.
          <div key={index} role="group" aria-label={name} className={`flex flex-col gap-1.5 ${index > 0 ? 'mt-1' : ''}`}>
            <Row>
              <SelectField<LayoutGridPattern>
                label={`${name} type`}
                value={grid.pattern}
                options={PATTERNS}
                // Switching kind starts from that kind's defaults, keeping the colour.
                onChange={(pattern) =>
                  replace(index, { ...layoutGrid(pattern), color: grid.color, opacity: grid.opacity, visible: grid.visible }, 'Change layout grid type')
                }
              />
              {/* Show and remove, kept together at the end of the row. */}
              <div className="flex flex-none items-center">
                <button
                  type="button"
                  className="ev-icon-button"
                  aria-label={grid.visible ? `Hide layout grid ${index + 1}` : `Show layout grid ${index + 1}`}
                  title={grid.visible ? 'Hide' : 'Show'}
                  onClick={() => set({ visible: !grid.visible }, grid.visible ? 'Hide layout grid' : 'Show layout grid')}
                >
                  <Icon name={grid.visible ? 'eye' : 'eyeOff'} size={14} />
                </button>
                <button
                  type="button"
                  className="ev-icon-button"
                  aria-label={`Remove layout grid ${index + 1}`}
                  title="Remove"
                  onClick={() => setGrids('Remove layout grid', grids.filter((_, i) => i !== index))}
                >
                  <Icon name="minus" size={14} />
                </button>
              </div>
            </Row>
            {!sections && (
              <Row>
                <NumberField label={`${name} size`} prefix="Size" min={1} max={10000} value={grid.size} onCommit={(size) => set({ size })} />
              </Row>
            )}
            {sections && (
              <>
                <Row>
                  <NumberField
                    label={`${name} count`}
                    prefix="Count"
                    min={1}
                    max={200}
                    value={grid.count}
                    onCommit={(count) => set({ count: Math.round(count) })}
                  />
                  <NumberField label={`${name} gutter`} prefix="Gutter" min={0} max={10000} value={grid.gutter} onCommit={(gutter) => set({ gutter })} />
                </Row>
                <Row>
                  <SelectField<LayoutGridAlignment>
                    label={`${name} alignment`}
                    value={grid.alignment}
                    options={alignmentNames(grid.pattern)}
                    onChange={(alignment) => set({ alignment })}
                  />
                </Row>
                <Row>
                  <NumberField
                    label={`${name} ${stretch ? 'margin' : 'offset'}`}
                    prefix={stretch ? 'Margin' : 'Offset'}
                    min={-10000}
                    max={10000}
                    value={grid.offset}
                    onCommit={(offset) => set({ offset })}
                  />
                  {!stretch && (
                    <NumberField
                      label={`${name} ${grid.pattern === 'ROWS' ? 'row height' : 'column width'}`}
                      prefix={grid.pattern === 'ROWS' ? 'Height' : 'Width'}
                      min={0}
                      max={100000}
                      value={grid.sectionSize}
                      onCommit={(sectionSize) => set({ sectionSize })}
                    />
                  )}
                </Row>
              </>
            )}
            <Row>
              <ColorField label={`${name} colour`} value={grid.color} onChange={(color, phase) => set({ color }, 'Change layout grid colour', phase)} />
              <div className="w-16 flex-none">
                <NumberField
                  label={`${name} opacity`}
                  suffix="%"
                  min={0}
                  max={100}
                  value={Math.round(grid.opacity * 100)}
                  onCommit={(value) => set({ opacity: value / 100 })}
                />
              </div>
            </Row>
          </div>
        );
      })}
    </Section>
  );
}
