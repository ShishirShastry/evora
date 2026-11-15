import {
  applyToPoint,
  getLocalMatrix,
  invert,
  isVector,
  moveVertices,
  patchNodes,
  setNetwork,
  type LayerPatch,
  type NodeId,
  type VectorNode,
  type WindingRule,
} from '../../core';
import { getCommand, type Command } from '../../state/commands';
import { MIXED, NumberField } from '../components/Fields';
import { useEditor, useEditorContext, useRunCommand } from '../editor/EditorContext';
import { Row, Section, SelectField } from './panelParts';

const RULES: readonly (readonly [WindingRule, string])[] = [
  ['NONZERO', 'Everything inside'],
  ['EVENODD', 'Inner shapes are holes'],
];

/**
 * Properties of vector layers: how overlapping outlines are filled and, for a
 * single vector, the editing of its points. While points are being edited
 * this shows the selected point's position and the point commands.
 */
export function VectorSection({ layers }: { layers: VectorNode[] }) {
  const { store } = useEditorContext();
  const edit = useEditor((s) => s.vectorEdit);
  const run = useRunCommand();
  const single = layers.length === 1 ? (layers[0] as VectorNode) : null;
  const editing = single && edit && edit.id === single.id ? edit : null;
  const first = (layers[0] as VectorNode).windingRule;
  const rule = layers.every((layer) => layer.windingRule === first) ? first : MIXED;

  const setRule = (windingRule: WindingRule): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const layer of layers) patches[layer.id] = { windingRule };
    store.getState().apply('Change fill rule', (doc) => patchNodes(doc, patches));
  };

  // A point's position is shown in the same space as the layer's own X and Y.
  const index = editing && editing.vertices.length === 1 ? (editing.vertices[0] as number) : null;
  const vertex = single && index !== null ? single.network.vertices[index] : undefined;
  const position = single && vertex ? applyToPoint(getLocalMatrix(single), vertex) : null;
  const movePoint = (target: { x?: number; y?: number }): void => {
    if (!single || index === null || !position) return;
    store.getState().apply('Move point', (doc) => {
      const node = doc.nodes[single.id];
      const at = isVector(node) ? node.network.vertices[index] : undefined;
      if (!isVector(node) || !at) return doc;
      const local = applyToPoint(invert(getLocalMatrix(node)), { x: target.x ?? position.x, y: target.y ?? position.y });
      return setNetwork(doc, single.id, moveVertices(node.network, [index], local.x - at.x, local.y - at.y));
    });
  };

  const selected = editing?.vertices.length ?? 0;
  const button = (id: string, label: string, enabled: boolean) => (
    <button type="button" className="od-button flex-1 !px-1 disabled:opacity-40" disabled={!enabled} onClick={() => run(getCommand(id) as Command)}>
      {label}
    </button>
  );

  return (
    <Section title="Vector">
      <Row>
        <span className="w-20 flex-none text-dim">Fill covers</span>
        <SelectField<WindingRule> label="Fill rule" value={rule} options={RULES} onChange={setRule} />
      </Row>
      {single && (
        <Row>
          <button
            type="button"
            className="od-button flex-1"
            aria-pressed={editing !== null}
            onClick={() => run(getCommand('object.editVector') as Command)}
          >
            {editing ? 'Done editing points' : 'Edit points'}
          </button>
        </Row>
      )}
      {editing && single && (
        <>
          <p className="m-0 text-dim" aria-live="polite">
            {editing.vertices.length === 0
              ? `${single.network.vertices.length} points. Click one to select it.`
              : `${editing.vertices.length} of ${single.network.vertices.length} points selected`}
          </p>
          {position && (
            <Row>
              <NumberField label="Point X position" prefix="X" value={position.x} onCommit={(x) => movePoint({ x })} />
              <NumberField label="Point Y position" prefix="Y" value={position.y} onCommit={(y) => movePoint({ y })} />
            </Row>
          )}
          <Row>
            {button('vector.corner', 'Corner', selected > 0)}
            {button('vector.smooth', 'Smooth', selected > 0)}
          </Row>
          <Row>
            {button('vector.join', 'Join', selected === 2)}
            {button('vector.cut', 'Cut', selected > 0)}
            {button('edit.delete', 'Delete', selected > 0)}
          </Row>
        </>
      )}
    </Section>
  );
}
