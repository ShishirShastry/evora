import { useMemo, useRef, useState } from 'react';
import {
  ACTION_TYPES,
  addFlow,
  addReaction,
  EASING_TYPES,
  expressionProblem,
  flowAt,
  flowsOf,
  getAncestorIds,
  getDescendantIds,
  getPageIdOf,
  instanceOf,
  keyComboOf,
  isFrame,
  isInstance,
  isLayer,
  isPage,
  listVariables,
  newAction,
  newTrigger,
  normalizeKeyCombo,
  OVERFLOWS,
  OVERLAY_POSITIONS,
  patchNodes,
  PROTOTYPE_DEVICES,
  prototypeFrames,
  removeFlow,
  removeReaction,
  renameFlow,
  SCROLL_BEHAVIORS,
  setOf,
  TRANSITION_DIRECTIONS,
  TRANSITION_TYPES,
  TRIGGER_TYPES,
  updateReaction,
  variantsOf,
  type Action,
  type ActionType,
  type Document,
  type EasingType,
  type LayerNode,
  type NodeId,
  type Overflow,
  type OverlayPosition,
  type PrototypeDevice,
  type Reaction,
  type ScrollBehavior,
  type Transition,
  type TransitionDirection,
  type TransitionType,
  type TriggerType,
} from '../../core';
import { ColorField } from '../components/ColorField';
import { NumberField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { applyLive, Row, Section } from './panelParts';
import { CommitInput } from './TokenSections';

/**
 * The Prototype tab of the right sidebar: the interactions of the selected
 * layer, how a frame scrolls and opens as an overlay, where flows start,
 * and the device the prototype is shown on. Everything here changes the
 * document through the operations in `core/ops/prototype`.
 */

const TRIGGER_LABELS: Record<TriggerType, string> = { ON_CLICK: 'On click or tap', ON_DRAG: 'On drag', MOUSE_ENTER: 'While hovering', ON_PRESS: 'While pressing', AFTER_DELAY: 'After delay', ON_KEY: 'Key press', MOUSE_LEAVE: 'Mouse leave', MOUSE_UP: 'Mouse up' };
const ACTION_LABELS: Record<ActionType, string> = {
  NAVIGATE: 'Navigate to',
  OPEN_OVERLAY: 'Open overlay',
  SWAP_OVERLAY: 'Swap overlay',
  CLOSE_OVERLAY: 'Close overlay',
  SCROLL_TO: 'Scroll to',
  BACK: 'Back',
  CHANGE_TO: 'Change to',
  SET_VARIABLE: 'Set variable',
  CONDITIONAL: 'Conditional',
  INPUT: 'Type into variable',
  OPEN_LINK: 'Open link',
};
const TRANSITION_LABELS: Record<TransitionType, string> = { INSTANT: 'Instant', DISSOLVE: 'Dissolve', SMART_ANIMATE: 'Smart Animate', MOVE_IN: 'Move in', MOVE_OUT: 'Move out', PUSH: 'Push', SLIDE_IN: 'Slide in', SLIDE_OUT: 'Slide out' };
const DIRECTION_LABELS: Record<TransitionDirection, string> = { LEFT: 'To the left', RIGHT: 'To the right', TOP: 'Upwards', BOTTOM: 'Downwards' };
const EASING_LABELS: Record<EasingType, string> = { LINEAR: 'Linear', EASE_IN: 'Ease in', EASE_OUT: 'Ease out', EASE_IN_OUT: 'Ease in and out', CUSTOM: 'Custom curve' };
const OVERFLOW_LABELS: Record<Overflow, string> = { NONE: 'No scrolling', HORIZONTAL: 'Horizontal', VERTICAL: 'Vertical', BOTH: 'Both directions' };
const SCROLL_LABELS: Record<ScrollBehavior, string> = { SCROLLS: 'Scrolls with the frame', FIXED: 'Fixed: stays in place', STICKY: 'Sticky: stops at the top' };
const POSITION_LABELS: Record<OverlayPosition, string> = { CENTER: 'Centre', TOP_LEFT: 'Top left', TOP_CENTER: 'Top centre', TOP_RIGHT: 'Top right', BOTTOM_LEFT: 'Bottom left', BOTTOM_CENTER: 'Bottom centre', BOTTOM_RIGHT: 'Bottom right' };
const DEVICE_LABELS: Record<PrototypeDevice, string> = { NONE: 'None: as big as the frame', PHONE: 'Phone (390 × 844)', TABLET: 'Tablet (820 × 1180)', DESKTOP: 'Desktop (1440 × 900)' };

/** A rounded well pressed into the panel: what an interaction or a flow sits in. */
const WELL = 'rounded-[10px] bg-bg/50 shadow-[var(--ev-sunk)]';
/** An action inside an interaction: a raised card lifted out of the interaction's well. */
const CARD = 'rounded-[8px] bg-panel shadow-[var(--ev-raise)]';
/** What an empty list says, in a quiet dashed outline where its rows would be. */
const EMPTY = 'm-0 rounded-[8px] border border-dashed border-line px-3 py-2.5 text-center leading-[1.45] text-faint';
/** A note under the controls it is about. */
const NOTE = 'm-0 leading-[1.45] text-faint';
/** A small accent tile marking where a flow starts. */
const FLOW_TILE = 'flex flex-none items-center justify-center rounded-[7px] bg-selected text-accent';

const TAKES_DESTINATION: readonly ActionType[] = ['NAVIGATE', 'OPEN_OVERLAY', 'SWAP_OVERLAY', 'SCROLL_TO', 'CHANGE_TO'];
const TAKES_TRANSITION: readonly ActionType[] = ['NAVIGATE', 'OPEN_OVERLAY', 'SWAP_OVERLAY', 'CLOSE_OVERLAY', 'SCROLL_TO', 'CHANGE_TO'];
const DIRECTIONAL: readonly TransitionType[] = ['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'];

function Select<T extends string>({ label, value, options, onChange, className }: { label: string; value: T | ''; options: readonly (readonly [T | '', string])[]; onChange: (value: T) => void; className?: string }) {
  return (
    <select aria-label={label} className={`ev-field ${className ?? 'min-w-0 flex-1'}`} value={value} onChange={(event) => onChange(event.currentTarget.value as T)}>
      {options.map(([option, name]) => (
        <option key={option} value={option}>
          {name}
        </option>
      ))}
    </select>
  );
}

/** What an action of a type can point at, for the layer the interaction is on. */
function destinationChoices(doc: Document, layer: LayerNode, type: ActionType): [NodeId, string][] {
  const pageId = getPageIdOf(doc, layer.id);
  if (pageId === null) return [];
  if (type === 'CHANGE_TO') {
    // The variants of the set the layer belongs to: as a variant, as a layer of one, or as an instance of one.
    const within = [layer.id, ...getAncestorIds(doc, layer.id)];
    const instance = isInstance(layer) ? layer : instanceOf(doc, layer.id);
    const set = within.map((id) => setOf(doc, id)).find((found) => found) ?? (instance?.componentId ? setOf(doc, instance.componentId) : null);
    return set ? variantsOf(doc, set.id).map((variant) => [variant.id, variant.name]) : [];
  }
  if (type === 'SCROLL_TO') {
    // The layers of the same screen.
    const top = [layer.id, ...getAncestorIds(doc, layer.id)].filter((id) => doc.nodes[id]?.parentId === pageId)[0];
    if (top === undefined) return [];
    return getDescendantIds(doc, top)
      .map((id) => doc.nodes[id])
      .filter((node): node is LayerNode => isLayer(node) && node.sourceId === null && node.id !== layer.id)
      .map((node) => [node.id, node.name]);
  }
  return prototypeFrames(doc, pageId)
    .filter((frame) => frame.id !== layer.id)
    .map((frame) => [frame.id, frame.name]);
}

function TransitionEditor({ label, value, onChange }: { label: string; value: Transition; onChange: (next: Transition) => void }) {
  const timed = value.type !== 'INSTANT';
  return (
    <>
      <Row>
        <Select label={`${label} transition`} value={value.type} options={TRANSITION_TYPES.map((type) => [type, TRANSITION_LABELS[type]] as const)} onChange={(type) => onChange({ ...value, type })} />
        {DIRECTIONAL.includes(value.type) && (
          <Select label={`${label} direction`} value={value.direction} options={TRANSITION_DIRECTIONS.map((direction) => [direction, DIRECTION_LABELS[direction]] as const)} onChange={(direction) => onChange({ ...value, direction })} />
        )}
      </Row>
      {timed && (
        <>
          <Row>
            <div className="min-w-0 flex-1">
              <NumberField label={`${label} duration in milliseconds`} prefix="Time" suffix="ms" value={value.duration} min={0} max={10000} onCommit={(duration) => onChange({ ...value, duration })} />
            </div>
            <div className="min-w-0 flex-1">
              <NumberField label={`${label} delay in milliseconds`} prefix="Wait" suffix="ms" value={value.delay} min={0} max={10000} onCommit={(delay) => onChange({ ...value, delay })} />
            </div>
          </Row>
          <Row>
            <Select label={`${label} easing`} value={value.easing} options={EASING_TYPES.map((easing) => [easing, EASING_LABELS[easing]] as const)} onChange={(easing) => onChange({ ...value, easing })} />
          </Row>
          {value.easing === 'CUSTOM' && (
            <Row>
              {value.bezier.map((part, index) => (
                <div key={index} className="min-w-0 flex-1">
                  <NumberField
                    label={`${label} curve ${['x1', 'y1', 'x2', 'y2'][index]}`}
                    value={part}
                    min={index % 2 === 0 ? 0 : -2}
                    max={index % 2 === 0 ? 1 : 3}
                    onCommit={(next) => onChange({ ...value, bezier: value.bezier.map((old, at) => (at === index ? next : old)) as Transition['bezier'] })}
                  />
                </div>
              ))}
            </Row>
          )}
        </>
      )}
    </>
  );
}

function ActionList({ label, layer, actions, depth, onChange }: { label: string; layer: LayerNode; actions: readonly Action[]; depth: number; onChange: (next: Action[]) => void }) {
  const doc = useEditor((s) => s.doc);
  const variables = listVariables(doc);
  const names = variables.flatMap((variable) => [variable.name, `${doc.variableCollections[variable.collectionId]?.name}/${variable.name}`]);
  const set = (index: number, next: Action): void => onChange(actions.map((action, at) => (at === index ? next : action)));
  return (
    <div className="flex flex-col gap-1.5">
      {actions.map((action, index) => {
        const name = `${label} action ${index + 1}`;
        const choices = TAKES_DESTINATION.includes(action.type) ? destinationChoices(doc, layer, action.type) : [];
        const missing = action.destinationId !== null && !choices.some(([id]) => id === action.destinationId);
        const problem = action.type === 'SET_VARIABLE' || action.type === 'CONDITIONAL' ? (action.expression.trim() === '' ? null : expressionProblem(action.expression, names)) : null;
        return (
          // The actions of an interaction are cards in its well; the branches of a condition hang from a rail inside their card.
          <div key={index} className={depth === 0 ? `flex flex-col gap-1.5 p-1.5 ${CARD}` : 'flex flex-col gap-1.5 border-l-2 border-line py-0.5 pl-2'}>
            <Row>
              <Select
                label={`${name} type`}
                value={action.type}
                options={ACTION_TYPES.filter((type) => depth < 2 || type !== 'CONDITIONAL').map((type) => [type, ACTION_LABELS[type]] as const)}
                // What the new type has no use for is cleared, so that nothing stale is kept.
                onChange={(type) => set(index, newAction(type, { transition: action.transition }))}
              />
              <button type="button" className="ev-icon-button flex-none" aria-label={`Remove ${name}`} title="Remove action" onClick={() => onChange(actions.filter((_, at) => at !== index))}>
                <Icon name="close" />
              </button>
            </Row>
            {TAKES_DESTINATION.includes(action.type) && (
              <Row>
                <Select
                  label={`${name} destination`}
                  value={action.destinationId ?? ''}
                  options={[['', action.type === 'CHANGE_TO' ? 'Choose a variant' : action.type === 'SCROLL_TO' ? 'Choose a layer' : 'Choose a frame'], ...(missing ? [[action.destinationId as string, 'Missing'] as const] : []), ...choices]}
                  onChange={(destinationId) => set(index, { ...action, destinationId: destinationId || null })}
                />
              </Row>
            )}
            {action.type === 'CHANGE_TO' && choices.length === 0 && <p className={NOTE}>“Change to” is for a variant, a layer of one, or an instance of one: it shows another variant of the same set.</p>}
            {TAKES_TRANSITION.includes(action.type) && <TransitionEditor label={name} value={action.transition} onChange={(transition) => set(index, { ...action, transition })} />}
            {action.type === 'OPEN_LINK' && <CommitInput label={`${name} address`} value={action.expression} className="w-full" placeholder="https://…" onCommit={(expression) => set(index, { ...action, expression: expression.trim() })} />}
            {(action.type === 'SET_VARIABLE' || action.type === 'INPUT') && (
              <Row>
                <Select
                  label={`${name} variable`}
                  value={action.variableId ?? ''}
                  options={[['', 'Choose a variable'], ...variables.filter((variable) => action.type !== 'INPUT' || variable.type === 'STRING').map((variable) => [variable.id, variable.name] as const)]}
                  onChange={(variableId) => set(index, { ...action, variableId: variableId || null })}
                />
              </Row>
            )}
            {action.type === 'INPUT' && <p className={NOTE}>What is typed goes into this text variable until Enter. Bind a text layer to the variable to show it.</p>}
            {(action.type === 'SET_VARIABLE' || action.type === 'CONDITIONAL') && (
              <>
                <CommitInput
                  label={action.type === 'CONDITIONAL' ? `${name} condition` : `${name} value`}
                  value={action.expression}
                  className="w-full"
                  placeholder={action.type === 'CONDITIONAL' ? 'Condition, for example {count} >= 3' : 'Value, for example {count} + 1'}
                  onCommit={(expression) => set(index, { ...action, expression })}
                />
                {problem && (
                  <p role="alert" className="m-0 leading-[1.45] text-danger">
                    {problem}
                  </p>
                )}
              </>
            )}
            {action.type === 'CONDITIONAL' && (
              <>
                <span className="mt-0.5 text-[11px] font-medium text-dim">If it holds</span>
                <ActionList label={`${name} then`} layer={layer} actions={action.then} depth={depth + 1} onChange={(then) => set(index, { ...action, then })} />
                <span className="mt-0.5 text-[11px] font-medium text-dim">Otherwise</span>
                <ActionList label={`${name} else`} layer={layer} actions={action.otherwise} depth={depth + 1} onChange={(otherwise) => set(index, { ...action, otherwise })} />
              </>
            )}
          </div>
        );
      })}
      <button type="button" className="ev-button !h-6 self-start !gap-1 !rounded-[7px] !pl-1.5 !pr-2 text-[11px]" aria-label={`Add an action to ${label}`} onClick={() => onChange([...actions, newAction('NAVIGATE')])}>
        <Icon name="plus" size={12} />
        Add action
      </button>
    </div>
  );
}

const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock'];

/**
 * The key of a "key press" trigger. It can be typed ("Enter", "Ctrl+K",
 * "shift+enter", written the one way triggers keep keys when it is
 * committed), or recorded: after "Record", the next key pressed in the field,
 * with the modifier keys held, is the key.
 */
function KeyField({ label, value, onCommit }: { label: string; value: string; onCommit: (key: string) => void }) {
  const [recording, setRecording] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const commit = (text: string): void => {
    const key = text === ' ' ? text : normalizeKeyCombo(text.trim());
    if (key !== '' && key !== value) onCommit(key);
  };
  return (
    <Row>
      <input
        key={value}
        ref={input}
        aria-label={label}
        className="ev-field min-w-0 flex-1 placeholder:text-faint"
        defaultValue={value}
        placeholder={recording ? 'Press a key…' : 'Enter, ArrowRight, a, Ctrl+K, or Gamepad0 for a gamepad button'}
        spellCheck={false}
        onBlur={(event) => {
          setRecording(false);
          if (event.currentTarget.value !== value) commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (recording) {
            // Modifiers on their own wait for the key they are held with.
            if (MODIFIER_KEYS.includes(event.key)) return;
            event.preventDefault();
            const key = keyComboOf(event);
            event.currentTarget.value = key;
            setRecording(false);
            if (key !== value) onCommit(key);
            return;
          }
          if (event.key === 'Enter') event.currentTarget.blur();
          else if (event.key === 'Escape') {
            event.currentTarget.value = value;
            event.currentTarget.blur();
          }
        }}
      />
      <button
        type="button"
        className="ev-icon-button !w-14 flex-none text-[11px] font-medium"
        aria-label={`Record ${label}`}
        aria-pressed={recording}
        title="Press the key to use, with any modifier keys held"
        onClick={() => {
          setRecording(true);
          input.current?.focus();
          input.current?.select();
        }}
      >
        Record
      </button>
    </Row>
  );
}

function ReactionEditor({ layer, reaction, index }: { layer: LayerNode; reaction: Reaction; index: number }) {
  const { store } = useEditorContext();
  const label = `Interaction ${index + 1}`;
  const change = (text: string, patch: Partial<Omit<Reaction, 'id'>>): void => store.getState().apply(text, (d) => updateReaction(d, layer.id, reaction.id, patch));
  return (
    <li className={`flex flex-col gap-1.5 p-1.5 ${WELL}`} aria-label={label}>
      <Row>
        <Select label={`${label} trigger`} value={reaction.trigger.type} options={TRIGGER_TYPES.map((type) => [type, TRIGGER_LABELS[type]] as const)} onChange={(type) => change('Change trigger', { trigger: newTrigger(type) })} />
        <button type="button" className="ev-icon-button flex-none" aria-label={`Remove ${label}`} title="Remove interaction" onClick={() => store.getState().apply('Remove interaction', (d) => removeReaction(d, layer.id, reaction.id))}>
          <Icon name="close" />
        </button>
      </Row>
      {reaction.trigger.type === 'AFTER_DELAY' && (
        <NumberField label={`${label} delay in milliseconds`} prefix="After" suffix="ms" value={reaction.trigger.delay} min={0} max={600000} onCommit={(delay) => change('Change delay', { trigger: { ...reaction.trigger, delay } })} />
      )}
      {reaction.trigger.type === 'ON_KEY' && (
        <KeyField label={`${label} key`} value={reaction.trigger.key} onCommit={(key) => change('Change key', { trigger: { ...reaction.trigger, key } })} />
      )}
      <ActionList label={label} layer={layer} actions={reaction.actions} depth={0} onChange={(actions) => change('Change interaction', { actions })} />
    </li>
  );
}

function LayerPrototype({ layer }: { layer: LayerNode }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const pageId = getPageIdOf(doc, layer.id);
  const flow = flowAt(doc, layer.id);
  const parent = doc.nodes[layer.parentId];
  const mirrored = layer.sourceId !== null;
  return (
    <>
      {isFrame(layer) && pageId !== null && (
        <Section title="Flow starting point">
          {flow ? (
            <Row>
              <span aria-hidden="true" className={`h-7 w-7 ${FLOW_TILE}`}>
                <Icon name="play" size={11} />
              </span>
              <CommitInput label="Flow name" value={flow.name} onCommit={(name) => store.getState().apply('Rename flow', (d) => renameFlow(d, pageId, flow.id, name))} />
              <button type="button" className="ev-button !h-7 flex-none !px-2.5" onClick={() => store.getState().apply('Remove flow', (d) => removeFlow(d, pageId, flow.id))}>
                Remove
              </button>
            </Row>
          ) : (
            <button type="button" className="ev-button !h-7 w-full !gap-1.5" onClick={() => store.getState().apply('Add flow', (d) => addFlow(d, layer.id)?.doc ?? d)}>
              <span aria-hidden="true" className="flex text-accent">
                <Icon name="play" size={10} />
              </span>
              Start a flow here
            </button>
          )}
        </Section>
      )}
      <Section title="Interactions">
        {mirrored && <p className={NOTE}>This layer is part of an instance: it has its component’s interactions until they are changed here.</p>}
        {isInstance(layer) && <p className={NOTE}>An instance also has the interactions of the component it shows.</p>}
        {layer.reactions.length === 0 && <p className={EMPTY}>No interactions. Add one here, or drag from the circle on the layer’s edge to a frame.</p>}
        <ul className="m-0 flex list-none flex-col gap-2 p-0 empty:hidden">
          {layer.reactions.map((reaction, index) => (
            <ReactionEditor key={reaction.id} layer={layer} reaction={reaction} index={index} />
          ))}
        </ul>
        <button type="button" className="ev-button !h-7 w-full !gap-1.5" onClick={() => store.getState().apply('Add interaction', (d) => addReaction(d, layer.id, newTrigger('ON_CLICK'), [newAction('NAVIGATE')])?.doc ?? d)}>
          <Icon name="plus" size={12} />
          Add interaction
        </button>
      </Section>
      {(isFrame(layer) || isFrame(parent)) && (
        <Section title="Scrolling">
          {isFrame(layer) && (
            <Row>
              <span className="w-20 flex-none text-dim">Overflow</span>
              <Select label="Overflow scrolling" value={layer.overflow} options={OVERFLOWS.map((overflow) => [overflow, OVERFLOW_LABELS[overflow]] as const)} onChange={(overflow) => store.getState().apply('Change scrolling', (d) => patchNodes(d, { [layer.id]: { overflow } }))} />
            </Row>
          )}
          {isFrame(parent) && !mirrored && (
            <Row>
              <span className="w-20 flex-none text-dim">Position</span>
              <Select
                label="Position when scrolling"
                value={layer.scrollBehavior}
                options={SCROLL_BEHAVIORS.map((behavior) => [behavior, SCROLL_LABELS[behavior]] as const)}
                onChange={(scrollBehavior) => store.getState().apply('Change scroll position', (d) => patchNodes(d, { [layer.id]: { scrollBehavior } }))}
              />
            </Row>
          )}
        </Section>
      )}
      {isFrame(layer) && (
        <Section title="As an overlay">
          <Row>
            <span className="w-20 flex-none text-dim">Position</span>
            <Select label="Overlay position" value={layer.overlayPosition} options={OVERLAY_POSITIONS.map((position) => [position, POSITION_LABELS[position]] as const)} onChange={(overlayPosition) => store.getState().apply('Change overlay position', (d) => patchNodes(d, { [layer.id]: { overlayPosition } }))} />
          </Row>
          <label className="-mx-1 flex h-7 cursor-pointer items-center gap-2 rounded-[6px] px-1 transition-colors duration-100 hover:bg-hover">
            <input type="checkbox" className="h-3.5 w-3.5 flex-none cursor-pointer" checked={layer.overlayCloseOutside} onChange={(event) => store.getState().apply('Change overlay', (d) => patchNodes(d, { [layer.id]: { overlayCloseOutside: event.currentTarget.checked } }))} />
            Close when clicking outside
          </label>
          <label className="-mx-1 flex h-7 cursor-pointer items-center gap-2 rounded-[6px] px-1 transition-colors duration-100 hover:bg-hover">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 flex-none cursor-pointer"
              checked={layer.overlayBackground !== null}
              onChange={(event) => store.getState().apply('Change overlay background', (d) => patchNodes(d, { [layer.id]: { overlayBackground: event.currentTarget.checked ? { color: { r: 0, g: 0, b: 0 }, opacity: 0.5 } : null } }))}
            />
            Background behind it
          </label>
          {layer.overlayBackground && (
            <Row>
              <ColorField
                label="Overlay background"
                value={layer.overlayBackground.color}
                onChange={(color, phase) => applyLive(store, 'Change overlay background', phase, (d) => patchNodes(d, { [layer.id]: { overlayBackground: { color, opacity: layer.overlayBackground?.opacity ?? 0.5 } } }))}
              />
              <div className="w-20 flex-none">
                <NumberField
                  label="Overlay background opacity"
                  suffix="%"
                  value={Math.round(layer.overlayBackground.opacity * 100)}
                  min={0}
                  max={100}
                  onCommit={(percent) => store.getState().apply('Change overlay background', (d) => patchNodes(d, { [layer.id]: { overlayBackground: { color: layer.overlayBackground?.color ?? { r: 0, g: 0, b: 0 }, opacity: percent / 100 } } }))}
                />
              </div>
            </Row>
          )}
        </Section>
      )}
    </>
  );
}

function PagePrototype() {
  const { store, app } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const page = doc.nodes[pageId];
  const flows = useMemo(() => flowsOf(doc, pageId), [doc, pageId]);
  if (!isPage(page)) return null;
  return (
    <>
      <Section title="Prototype">
        <Row>
          <span className="w-14 flex-none text-dim">Device</span>
          <Select label="Prototype device" value={page.prototypeDevice} options={PROTOTYPE_DEVICES.map((device) => [device, DEVICE_LABELS[device]] as const)} onChange={(prototypeDevice) => store.getState().apply('Change prototype device', (d) => patchNodes(d, { [pageId]: { prototypeDevice } }))} />
        </Row>
        <button type="button" className="ev-button !h-7 w-full !gap-1.5" onClick={() => app.present?.()}>
          <span aria-hidden="true" className="flex text-accent">
            <Icon name="play" size={10} />
          </span>
          Present
        </button>
      </Section>
      <Section title="Flows">
        {flows.length === 0 && <p className={EMPTY}>No flows yet. Select a frame and choose “Start a flow here”. Without a flow, the prototype starts on the selected frame or the first one.</p>}
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 empty:hidden">
          {flows.map((flow) => (
            // A flow, as Figma lists them: its name beside the flow mark, and under it the frame it starts on.
            <li key={flow.id} className={`flex flex-col gap-1 p-1.5 ${WELL}`}>
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`h-7 w-7 ${FLOW_TILE}`}>
                  <Icon name="play" size={11} />
                </span>
                <CommitInput label={`Name of flow ${flow.name}`} value={flow.name} onCommit={(name) => store.getState().apply('Rename flow', (d) => renameFlow(d, pageId, flow.id, name))} />
              </div>
              <div className="flex items-center gap-1.5 pl-2">
                <span aria-hidden="true" className="flex flex-none text-faint">
                  <Icon name="frame" size={12} />
                </span>
                <span className="min-w-0 flex-1 truncate text-dim" title="The frame it starts on">
                  {doc.nodes[flow.startId]?.name}
                </span>
                <button type="button" className="ev-button !h-6 flex-none !gap-1 !rounded-[7px] !pl-1.5 !pr-2 text-[11px]" aria-label={`Present flow ${flow.name}`} onClick={() => app.present?.(flow.startId)}>
                  <span aria-hidden="true" className="flex text-accent">
                    <Icon name="play" size={9} />
                  </span>
                  Present
                </button>
                <button type="button" className="ev-icon-button flex-none" aria-label={`Remove flow ${flow.name}`} title="Remove flow" onClick={() => store.getState().apply('Remove flow', (d) => removeFlow(d, pageId, flow.id))}>
                  <Icon name="close" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

export function PrototypePanel() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const layers = selection.map((id) => doc.nodes[id]).filter(isLayer);
  return (
    <aside aria-label="Prototype properties" className="h-full overflow-y-auto" data-text-tools>
      {layers.length === 0 && <PagePrototype />}
      {layers.length === 1 && <LayerPrototype layer={layers[0] as LayerNode} />}
      {layers.length > 1 && (
        <Section title="Interactions">
          <p className={EMPTY}>Select one layer to see and change its interactions.</p>
        </Section>
      )}
    </aside>
  );
}
