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
  return (
    <Section title="Constraints">
      <Row>
        <span className="w-20 flex-none text-dim">Horizontal</span>
        <SelectField<ConstraintType>
          label="Horizontal constraint"
          value={shared(layers, (l) => l.constraints.horizontal)}
          options={HORIZONTAL}
          onChange={(value) => setAxis('horizontal', value)}
        />
      </Row>
      <Row>
        <span className="w-20 flex-none text-dim">Vertical</span>
        <SelectField<ConstraintType>
          label="Vertical constraint"
          value={shared(layers, (l) => l.constraints.vertical)}
          options={VERTICAL}
          onChange={(value) => setAxis('vertical', value)}
        />
      </Row>
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
          className="od-icon-button !h-6 !w-6"
          aria-label="Add layout grid"
          title="Add layout grid"
          onClick={() => setGrids('Add layout grid', [...grids, layoutGrid('GRID')])}
        >
          <Icon name="plus" size={14} />
        </button>
      }
    >
      {mixed && <p className="m-0 text-dim">The selected frames have different layout grids. Add one to replace them.</p>}
      {!mixed && grids.length === 0 && <p className="m-0 text-faint">No layout grid</p>}
      {grids.map((grid, index) => {
        const name = `Layout grid ${index + 1}`;
        const set = (patch: Partial<LayoutGrid>, label = 'Change layout grid', phase: 'live' | 'commit' = 'commit'): void =>
          replace(index, { ...grid, ...patch }, label, phase);
        const sections = grid.pattern !== 'GRID';
        const stretch = grid.alignment === 'STRETCH';
        return (
          <div key={index} role="group" aria-label={name} className="flex flex-col gap-1.5">
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
              <button
                type="button"
                className="od-icon-button !h-6 !w-6"
                aria-label={grid.visible ? `Hide layout grid ${index + 1}` : `Show layout grid ${index + 1}`}
                title={grid.visible ? 'Hide' : 'Show'}
                onClick={() => set({ visible: !grid.visible }, grid.visible ? 'Hide layout grid' : 'Show layout grid')}
              >
                <Icon name={grid.visible ? 'eye' : 'eyeOff'} size={13} />
              </button>
              <button
                type="button"
                className="od-icon-button !h-6 !w-6"
                aria-label={`Remove layout grid ${index + 1}`}
                title="Remove"
                onClick={() => setGrids('Remove layout grid', grids.filter((_, i) => i !== index))}
              >
                <Icon name="minus" size={13} />
              </button>
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
