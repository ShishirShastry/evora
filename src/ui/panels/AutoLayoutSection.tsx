import { useState } from 'react';
import {
  belongsToFlow,
  isAutoLayout,
  layoutDirection,
  patchNodes,
  setLayoutDirection,
  setLayoutSizing,
  sizingChoices,
  stretchedAcross,
  type CounterAxisAlign,
  type CounterAxisAlignContent,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayoutDirection,
  type LayoutSizing,
  type NodeId,
  type PrimaryAxisAlign,
} from '../../core';
import { getCommand, type Command } from '../../state/commands';
import { MIXED, NumberField, type Mixed } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext, useRunCommand } from '../editor/EditorContext';
import { Row, Section, SelectField, shared } from './panelParts';

/** What the direction menu offers. Wrapping is a row that carries on in new lines, so it is a third choice beside the two directions. */
type Direction = LayoutDirection;

const DIRECTIONS: readonly (readonly [Direction, string])[] = [
  ['HORIZONTAL', 'Horizontal'],
  ['VERTICAL', 'Vertical'],
  ['WRAP', 'Wrap'],
];

const directionOf = (frame: FrameNode): Direction => layoutDirection(frame) ?? 'HORIZONTAL';

/** The names of the alignments along and across a layout, which depend on which way it runs. */
function alignmentNames(direction: Direction | Mixed): {
  along: readonly (readonly [PrimaryAxisAlign, string])[];
  across: readonly (readonly [CounterAxisAlign, string])[];
} {
  const [start, end, top, bottom] =
    direction === MIXED ? ['Start', 'End', 'Start', 'End'] : direction === 'VERTICAL' ? ['Top', 'Bottom', 'Left', 'Right'] : ['Left', 'Right', 'Top', 'Bottom'];
  return {
    along: [
      ['MIN', start as string],
      ['CENTER', 'Center'],
      ['MAX', end as string],
      ['SPACE_BETWEEN', 'Space between'],
    ],
    across: [
      ['MIN', top as string],
      ['CENTER', 'Center'],
      ['MAX', bottom as string],
      ['STRETCH', 'Stretch'],
    ],
  };
}

const LINES: readonly (readonly [CounterAxisAlignContent, string])[] = [
  ['AUTO', 'Packed together'],
  ['SPACE_BETWEEN', 'Space between'],
];

/**
 * Auto Layout of the selected frames: switching it on and off, direction,
 * spacing, padding, alignment and order. Every control writes the frame's
 * own properties; the layout that follows is worked out by the document's
 * layout pass, not here.
 */
export function AutoLayoutSection({ frames }: { frames: FrameNode[] }) {
  const { store } = useEditorContext();
  const run = useRunCommand();
  const [separate, setSeparate] = useState(false);
  const add = getCommand('object.autoLayout') as Command;
  const remove = getCommand('object.removeAutoLayout') as Command;
  const active = frames.filter((frame) => isAutoLayout(frame));

  if (active.length < frames.length) {
    return (
      <Section
        title="Auto layout"
        action={
          // "Add" on a single frame switches its layout on; on several it would put them into a new frame together.
          frames.length === 1 ? (
            <button type="button" className="od-icon-button !h-6 !w-6" aria-label={add.label} title={`${add.label} (${add.shortcut})`} onClick={() => run(add)}>
              <Icon name="plus" size={14} />
            </button>
          ) : undefined
        }
      >
        <p className="m-0 text-faint">
          {active.length === 0 ? 'No auto layout' : 'Some of the selected frames lay out their children and some do not.'}
        </p>
      </Section>
    );
  }

  /** Applies a patch worked out for each frame, as one undo step. */
  const setEach = (label: string, make: (frame: FrameNode) => LayerPatch): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const frame of frames) patches[frame.id] = make(frame);
    store.getState().apply(label, (doc) => patchNodes(doc, patches));
  };
  const set = (label: string, patch: LayerPatch): void => setEach(label, () => patch);

  const direction = shared(frames, (frame) => directionOf(frame as FrameNode));
  const wraps = frames.every((frame) => directionOf(frame) === 'WRAP');
  const names = alignmentNames(direction);
  const along = shared(frames, (frame) => (frame as FrameNode).primaryAxisAlignItems);
  const lines = shared(frames, (frame) => (frame as FrameNode).counterAxisAlignContent);
  const value = <K extends keyof FrameNode>(key: K): FrameNode[K] | Mixed => shared(frames, (frame) => (frame as FrameNode)[key]);
  /** One value for two opposite sides, or mixed when they differ anywhere. */
  const pair = (a: 'paddingLeft' | 'paddingTop', b: 'paddingRight' | 'paddingBottom'): number | Mixed => {
    const first = (frames[0] as FrameNode)[a];
    return frames.every((frame) => frame[a] === first && frame[b] === first) ? first : MIXED;
  };
  const horizontal = pair('paddingLeft', 'paddingRight');
  const vertical = pair('paddingTop', 'paddingBottom');
  // Sides that differ can only be shown separately.
  const foursome = separate || horizontal === MIXED || vertical === MIXED;

  return (
    <Section
      title="Auto layout"
      action={
        <button type="button" className="od-icon-button !h-6 !w-6" aria-label={remove.label} title={`${remove.label} (${remove.shortcut})`} onClick={() => run(remove)}>
          <Icon name="minus" size={14} />
        </button>
      }
    >
      <Row>
        <span className="w-20 flex-none text-dim">Direction</span>
        <SelectField<Direction>
          label="Layout direction"
          value={direction}
          options={DIRECTIONS}
          onChange={(next) =>
            store.getState().apply('Change layout direction', (doc) =>
              setLayoutDirection(
                doc,
                frames.map((frame) => frame.id),
                next,
              ),
            )
          }
        />
      </Row>
      <Row>
        <NumberField
          label="Spacing between items"
          prefix="Gap"
          min={-10000}
          max={10000}
          // Spread from edge to edge, the gaps are whatever is left over.
          disabled={along === 'SPACE_BETWEEN'}
          value={value('itemSpacing')}
          onCommit={(itemSpacing) => set('Change spacing', { itemSpacing })}
        />
        {wraps && (
          <NumberField
            label="Spacing between lines"
            prefix="Lines"
            min={-10000}
            max={10000}
            disabled={lines === 'SPACE_BETWEEN'}
            value={value('counterAxisSpacing')}
            onCommit={(counterAxisSpacing) => set('Change line spacing', { counterAxisSpacing })}
          />
        )}
      </Row>
      {foursome ? (
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField label="Left padding" prefix="L" min={0} max={100000} value={value('paddingLeft')} onCommit={(paddingLeft) => set('Change padding', { paddingLeft })} />
          <NumberField label="Right padding" prefix="R" min={0} max={100000} value={value('paddingRight')} onCommit={(paddingRight) => set('Change padding', { paddingRight })} />
          <NumberField label="Top padding" prefix="T" min={0} max={100000} value={value('paddingTop')} onCommit={(paddingTop) => set('Change padding', { paddingTop })} />
          <NumberField label="Bottom padding" prefix="B" min={0} max={100000} value={value('paddingBottom')} onCommit={(paddingBottom) => set('Change padding', { paddingBottom })} />
        </div>
      ) : (
        <Row>
          <NumberField
            label="Horizontal padding"
            prefix="↔"
            min={0}
            max={100000}
            value={horizontal}
            onCommit={(padding) => set('Change padding', { paddingLeft: padding, paddingRight: padding })}
          />
          <NumberField
            label="Vertical padding"
            prefix="↕"
            min={0}
            max={100000}
            value={vertical}
            onCommit={(padding) => set('Change padding', { paddingTop: padding, paddingBottom: padding })}
          />
        </Row>
      )}
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          className="accent-[var(--od-accent)]"
          aria-label="Separate padding"
          checked={foursome}
          // With sides that differ there is nothing to go back to until they are made equal.
          disabled={horizontal === MIXED || vertical === MIXED}
          onChange={(event) => setSeparate(event.currentTarget.checked)}
        />
        Padding for each side
      </label>
      <Row>
        <span className="w-20 flex-none text-dim">Along</span>
        <SelectField<PrimaryAxisAlign>
          label="Alignment along the layout"
          value={along}
          options={names.along}
          onChange={(primaryAxisAlignItems) => set('Change alignment', { primaryAxisAlignItems })}
        />
      </Row>
      <Row>
        <span className="w-20 flex-none text-dim">Across</span>
        <SelectField<CounterAxisAlign>
          label="Alignment across the layout"
          value={value('counterAxisAlignItems')}
          options={names.across}
          onChange={(counterAxisAlignItems) => set('Change alignment', { counterAxisAlignItems })}
        />
      </Row>
      {value('counterAxisAlignItems') === 'STRETCH' && (
        // Stretch overrides what each item says about its own size across the layout, so that is said here.
        <p role="note" aria-label="What Stretch does" className="m-0 text-faint">
          {direction === 'VERTICAL'
            ? 'Every item is as wide as the frame has room. An item’s own horizontal sizing, “Fill container” included, is not used while Stretch is on. Rotated items and text that sets its own width keep their width.'
            : 'Every item is as tall as the frame has room (in a wrapping row, as tall as its line). An item’s own vertical sizing, “Fill container” included, is not used while Stretch is on. Rotated items, lines and text that sets its own height keep their height.'}
        </p>
      )}
      {wraps && (
        <Row>
          <span className="w-20 flex-none text-dim">Lines</span>
          <SelectField<CounterAxisAlignContent>
            label="Line distribution"
            value={lines}
            options={LINES}
            onChange={(counterAxisAlignContent) => set('Change line distribution', { counterAxisAlignContent })}
          />
        </Row>
      )}
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          className="accent-[var(--od-accent)]"
          checked={frames.every((frame) => frame.itemsReversed)}
          onChange={(event) => set('Reverse order', { itemsReversed: event.currentTarget.checked })}
        />
        Reverse order
      </label>
    </Section>
  );
}

const SIZING_NAMES: Record<LayoutSizing, [string, string]> = {
  FIXED: ['Fixed width', 'Fixed height'],
  HUG: ['Hug contents', 'Hug contents'],
  FILL: ['Fill container', 'Fill container'],
};

interface LimitFieldProps {
  label: string;
  prefix: string;
  value: number | null | Mixed;
  onCommit: (value: number | null) => void;
}

/** A number that may be left empty, for a limit that may not be there. Enter, Tab or leaving the field commits; Escape reverts. */
function LimitField({ label, prefix, value, onCommit }: LimitFieldProps) {
  const shown = value === MIXED || value === null ? '' : String(Math.round(value * 100) / 100);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);

  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      // Emptying the field removes the limit; a field that was empty to begin with is left as it is.
      if (value !== null && value !== MIXED) onCommit(null);
      return;
    }
    const parsed = Number.parseFloat(trimmed.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      setText(shown);
      return;
    }
    const next = Math.max(0, parsed);
    setText(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <label className="flex h-[26px] min-w-0 flex-1 items-center rounded-[5px] border border-transparent bg-field pl-2 focus-within:border-accent hover:border-line">
      <span className="mr-1.5 flex-none text-dim">{prefix}</span>
      <input
        aria-label={label}
        className="h-full w-full min-w-0 border-0 bg-transparent p-0 outline-none"
        inputMode="decimal"
        spellCheck={false}
        placeholder={value === MIXED ? 'Mixed' : 'None'}
        value={editing ? text : shown}
        onFocus={(event) => {
          setText(shown);
          setEditing(true);
          event.currentTarget.select();
        }}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={(event) => {
          setEditing(false);
          commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit(event.currentTarget.value);
            event.currentTarget.select();
          } else if (event.key === 'Escape') {
            setText(shown);
            setEditing(false);
            const input = event.currentTarget;
            requestAnimationFrame(() => input.blur());
          }
          // Keep editor shortcuts from firing while typing.
          event.stopPropagation();
        }}
      />
    </label>
  );
}

/**
 * How the selected layers are sized in a layout: fixed, hugging what is in
 * them or filling the frame they are in, with limits, and whether the frame
 * places them at all. Shown where any of that can apply: for frames that lay
 * out their children, for text, and for layers inside such a frame.
 */
export function ResizingSection({ layers }: { layers: LayerNode[] }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const ids = layers.map((layer) => layer.id);
  const inLayout = layers.every((layer) => isAutoLayout(doc.nodes[layer.parentId]));
  // Limits are kept by the layout: for the frames it sizes and the layers it places.
  const limited = layers.every((layer) => isAutoLayout(layer) || belongsToFlow(doc, layer));
  const choices = (axis: 'horizontal' | 'vertical'): LayoutSizing[] =>
    (['FIXED', 'HUG', 'FILL'] as const).filter((sizing) => ids.every((id) => sizingChoices(doc, id, axis).includes(sizing)));
  const horizontal = choices('horizontal');
  const vertical = choices('vertical');
  if (!inLayout && !limited && horizontal.length < 2 && vertical.length < 2) return null;
  // The direction in which the frame's Stretch alignment sizes these layers, if it sizes them all the same way.
  const stretched = shared(layers, (layer) => stretchedAcross(doc, layer));

  const size = (axis: 'horizontal' | 'vertical', sizing: LayoutSizing): void =>
    store.getState().apply('Change sizing', (d) => setLayoutSizing(d, ids, axis, sizing));
  const set = (label: string, patch: LayerPatch): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const id of ids) patches[id] = patch;
    store.getState().apply(label, (d) => patchNodes(d, patches));
  };

  return (
    <Section title="Resizing">
      <Row>
        <span className="w-20 flex-none text-dim">Horizontal</span>
        <SelectField<LayoutSizing>
          label="Horizontal sizing"
          disabled={stretched === 'horizontal'}
          value={shared(layers, (layer) => layer.layoutSizingHorizontal)}
          options={horizontal.map((sizing) => [sizing, SIZING_NAMES[sizing][0]] as const)}
          onChange={(sizing) => size('horizontal', sizing)}
        />
      </Row>
      <Row>
        <span className="w-20 flex-none text-dim">Vertical</span>
        <SelectField<LayoutSizing>
          label="Vertical sizing"
          disabled={stretched === 'vertical'}
          value={shared(layers, (layer) => layer.layoutSizingVertical)}
          options={vertical.map((sizing) => [sizing, SIZING_NAMES[sizing][1]] as const)}
          onChange={(sizing) => size('vertical', sizing)}
        />
      </Row>
      {(stretched === 'horizontal' || stretched === 'vertical') && (
        <p role="note" aria-label="Stretched by the frame" className="m-0 text-faint">
          {stretched === 'horizontal' ? 'Width' : 'Height'}: stretched by the frame’s alignment across its layout. The {stretched} sizing above is not used while
          that alignment is Stretch.
        </p>
      )}
      {limited && (
        <div className="grid grid-cols-2 gap-1.5">
          <LimitField label="Minimum width" prefix="Min W" value={shared(layers, (layer) => layer.minWidth)} onCommit={(minWidth) => set('Change size limit', { minWidth })} />
          <LimitField label="Maximum width" prefix="Max W" value={shared(layers, (layer) => layer.maxWidth)} onCommit={(maxWidth) => set('Change size limit', { maxWidth })} />
          <LimitField label="Minimum height" prefix="Min H" value={shared(layers, (layer) => layer.minHeight)} onCommit={(minHeight) => set('Change size limit', { minHeight })} />
          <LimitField label="Maximum height" prefix="Max H" value={shared(layers, (layer) => layer.maxHeight)} onCommit={(maxHeight) => set('Change size limit', { maxHeight })} />
        </div>
      )}
      {inLayout && (
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-[var(--od-accent)]"
            checked={layers.every((layer) => layer.layoutPositioning === 'ABSOLUTE')}
            onChange={(event) =>
              set(event.currentTarget.checked ? 'Take out of the layout' : 'Put back into the layout', {
                layoutPositioning: event.currentTarget.checked ? 'ABSOLUTE' : 'AUTO',
              })
            }
          />
          Ignore auto layout
        </label>
      )}
    </Section>
  );
}
