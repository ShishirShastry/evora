import { useState } from 'react';
import {
  belongsToFlow,
  isAutoLayout,
  itemSpacingOf,
  lineSpacingOf,
  patchNodes,
  setItemSpacing,
  setLayoutDirection,
  setLayoutSizing,
  setLayoutWrap,
  setLineSpacing,
  sizingChoices,
  stretchedAcross,
  type CounterAxisAlign,
  type CounterAxisAlignContent,
  type FrameNode,
  type LayerNode,
  type LayerPatch,
  type LayoutDirection,
  type LayoutSizing,
  type LayoutSpacing,
  type NodeId,
  type PrimaryAxisAlign,
} from '../../core';
import { getCommand, type Command } from '../../state/commands';
import { MIXED, NumberField, type Mixed } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext, useRunCommand } from '../editor/EditorContext';
import { Row, Section, SelectField, shared } from './panelParts';

type Direction = LayoutDirection;

const DIRECTIONS: readonly (readonly [Direction, string])[] = [
  ['HORIZONTAL', 'Horizontal'],
  ['VERTICAL', 'Vertical'],
];

const directionOf = (frame: FrameNode): Direction => (frame.layoutMode === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL');

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
      // Text lines up in a row; in a column, which has no baseline to line up, the items keep to the start.
      ['BASELINE', 'Text baseline'],
    ],
  };
}

const LINES: readonly (readonly [CounterAxisAlignContent, string])[] = [
  ['AUTO', 'Packed together'],
  ['SPACE_BETWEEN', 'Space between'],
];

/** Display only: a checkbox with its words beside it, as one target. */
const CHECK_ROW = 'flex min-h-6 cursor-pointer select-none items-center gap-2';
const CHECKBOX = 'h-3.5 w-3.5 flex-none cursor-pointer accent-[var(--ev-accent)]';
/** Display only: a note that explains a setting, set into the panel as a soft well. */
const NOTE = 'm-0 rounded-[var(--ev-radius)] bg-field px-2.5 py-2 text-[11px] leading-[1.45] text-dim shadow-[var(--ev-sunk)]';
/** Display only: a short caption above a field. */
const CAPTION = 'text-[11px] leading-none text-dim';

const PREVIEW_JUSTIFY: Record<PrimaryAxisAlign, string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
// Bars have no text, so a baseline is their bottom edge; a column has no baseline and keeps to the start.
const PREVIEW_ALIGN: Record<CounterAxisAlign, string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', STRETCH: 'stretch', BASELINE: 'flex-end' };
const PREVIEW_SIZES = [0.45, 0.8, 0.6] as const;

/**
 * Display only: a small picture of the layout, Figma's alignment box, set in
 * a well beside the alignment fields. It shows which way the items run and
 * how they line up along and across; it is not a control, and the fields
 * beside it are what change the layout.
 */
function LayoutPreview({ direction, along, across }: { direction: Direction | Mixed; along: PrimaryAxisAlign | Mixed; across: CounterAxisAlign | Mixed }) {
  const column = direction === 'VERTICAL';
  const known = direction !== MIXED && along !== MIXED && across !== MIXED;
  const stretch = across === 'STRETCH';
  return (
    <div
      aria-hidden="true"
      className="flex w-[72px] flex-none cursor-default self-stretch rounded-[var(--ev-radius)] bg-field p-2 shadow-[var(--ev-sunk)]"
      style={{
        flexDirection: column ? 'column' : 'row',
        justifyContent: along === MIXED ? 'center' : PREVIEW_JUSTIFY[along],
        alignItems: across === MIXED ? 'center' : across === 'BASELINE' && column ? 'flex-start' : PREVIEW_ALIGN[across],
        gap: 4,
      }}
    >
      {PREVIEW_SIZES.map((size, index) => (
        <span
          key={index}
          className={`flex-none rounded-[2px] transition-[width,height,background-color] duration-150 ${known ? 'bg-accent' : 'bg-faint'}`}
          style={{
            [column ? 'height' : 'width']: 7,
            [column ? 'width' : 'height']: stretch ? 'auto' : `${size * 100}%`,
            boxShadow: known ? 'inset 0 1px 0 rgba(255, 255, 255, 0.28)' : undefined,
          }}
        />
      ))}
    </div>
  );
}

interface SpacingFieldProps {
  /** Accessible name of the field; the button beside it is "Automatic" followed by it. */
  label: string;
  prefix: string;
  /** The spacing as it is: a number, or AUTO. */
  value: LayoutSpacing | Mixed;
  /** The fixed gap the frame goes back to when automatic spacing is switched off. */
  fixed: number | Mixed;
  onCommit: (value: LayoutSpacing) => void;
}

/**
 * A gap of a layout, which is a number or "Auto". Typing a number sets a
 * fixed gap; typing "auto", or pressing the Auto button, spreads the items
 * from end to end. While it is automatic the field says "Auto" and not the
 * number that is no longer in use. Enter, Tab or leaving the field commits;
 * Escape reverts; the arrow keys step a number by 1, or by 10 with Shift.
 */
function SpacingField({ label, prefix, value, fixed, onCommit }: SpacingFieldProps) {
  const format = (n: number): string => String(Math.round(n * 100) / 100);
  const shown = value === MIXED ? '' : value === 'AUTO' ? 'Auto' : format(value);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const clamp = (n: number): number => Math.min(10000, Math.max(-10000, n));

  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === 'auto') {
      setText('Auto');
      if (value !== 'AUTO') onCommit('AUTO');
      return;
    }
    const parsed = Number.parseFloat(trimmed.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      setText(shown);
      return;
    }
    const next = clamp(parsed);
    setText(format(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <label className="ev-input-shell">
        <span className="mr-1.5 flex-none text-dim">{prefix}</span>
        <input
          aria-label={label}
          className="h-full w-full min-w-0 border-0 bg-transparent p-0 outline-none placeholder:text-faint"
          spellCheck={false}
          placeholder={value === MIXED ? 'Mixed' : undefined}
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
            } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && typeof value === 'number') {
              event.preventDefault();
              const base = Number.parseFloat(event.currentTarget.value.replace(',', '.'));
              const next = clamp((Number.isFinite(base) ? base : value) + (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1));
              setText(format(next));
              if (next !== value) onCommit(next);
            }
            // Keep editor shortcuts from firing while typing.
            event.stopPropagation();
          }}
        />
      </label>
      {/* A toggle key: quiet with a hairline while off, lit in the accent while the spacing is automatic. */}
      <button
        type="button"
        className="ev-icon-button !w-11 flex-none !text-[11px] !font-medium shadow-[inset_0_0_0_1px_var(--ev-line)]"
        aria-label={`Automatic ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
        aria-pressed={value === 'AUTO'}
        title="Automatic spacing: spread from end to end, with whatever is left over as the gaps"
        // Switched off, the frame goes back to the fixed gap it had.
        onClick={() => onCommit(value === 'AUTO' ? (fixed === MIXED ? 0 : fixed) : 'AUTO')}
      >
        Auto
      </button>
    </div>
  );
}

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
            <button type="button" className="ev-icon-button !h-6 !w-6" aria-label={add.label} title={`${add.label} (${add.shortcut})`} onClick={() => run(add)}>
              <Icon name="plus" size={14} />
            </button>
          ) : undefined
        }
      >
        <p className="m-0 text-[11px] leading-[1.45] text-faint">
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
  const ids = frames.map((frame) => frame.id);

  const direction = shared(frames, (frame) => directionOf(frame as FrameNode));
  const wraps = frames.every((frame) => frame.layoutWrap === 'WRAP');
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
        <button type="button" className="ev-icon-button !h-6 !w-6" aria-label={remove.label} title={`${remove.label} (${remove.shortcut})`} onClick={() => run(remove)}>
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
            store.getState().apply('Change layout direction', (doc) => setLayoutDirection(doc, ids, next))
          }
        />
      </Row>
      <label className={CHECK_ROW}>
        <input
          type="checkbox"
          className={CHECKBOX}
          aria-label="Wrap"
          checked={wraps}
          onChange={(event) => {
            const wrap = event.currentTarget.checked;
            store.getState().apply(wrap ? 'Wrap layout' : 'Stop wrapping layout', (doc) => setLayoutWrap(doc, ids, wrap));
          }}
        />
        {direction === 'VERTICAL' ? 'Wrap into further columns' : direction === 'HORIZONTAL' ? 'Wrap into further rows' : 'Wrap'}
      </label>
      <Row>
        <SpacingField
          label="Spacing between items"
          prefix="Gap"
          // Automatic spacing is the alignment "space between" seen from the gap: the two are shown in step.
          value={shared(frames, (frame) => itemSpacingOf(frame as FrameNode))}
          fixed={value('itemSpacing')}
          onCommit={(spacing) => store.getState().apply('Change spacing', (doc) => setItemSpacing(doc, ids, spacing))}
        />
      </Row>
      {wraps && (
        <Row>
          <SpacingField
            label="Spacing between lines"
            prefix="Lines"
            value={shared(frames, (frame) => lineSpacingOf(frame as FrameNode))}
            fixed={value('counterAxisSpacing')}
            onCommit={(spacing) => store.getState().apply('Change line spacing', (doc) => setLineSpacing(doc, ids, spacing))}
          />
        </Row>
      )}
      {foursome ? (
        <div className="grid grid-cols-2 gap-2">
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
      <label className={`${CHECK_ROW} has-[:disabled]:cursor-default has-[:disabled]:text-faint`}>
        <input
          type="checkbox"
          className={`${CHECKBOX} disabled:cursor-default`}
          aria-label="Separate padding"
          checked={foursome}
          // With sides that differ there is nothing to go back to until they are made equal.
          disabled={horizontal === MIXED || vertical === MIXED}
          onChange={(event) => setSeparate(event.currentTarget.checked)}
        />
        Padding for each side
      </label>
      {/* Figma's alignment block: a picture of the layout in a well, the two alignments beside it. */}
      <div className="flex gap-2">
        <LayoutPreview direction={direction} along={along} across={value('counterAxisAlignItems')} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className={CAPTION}>Along</span>
            <SelectField<PrimaryAxisAlign>
              label="Alignment along the layout"
              value={along}
              options={names.along}
              className="w-full"
              onChange={(primaryAxisAlignItems) => set('Change alignment', { primaryAxisAlignItems })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className={CAPTION}>Across</span>
            <SelectField<CounterAxisAlign>
              label="Alignment across the layout"
              value={value('counterAxisAlignItems')}
              options={names.across}
              className="w-full"
              onChange={(counterAxisAlignItems) => set('Change alignment', { counterAxisAlignItems })}
            />
          </div>
        </div>
      </div>
      {value('counterAxisAlignItems') === 'STRETCH' && (
        // Stretch overrides what each item says about its own size across the layout, so that is said here.
        <p role="note" aria-label="What Stretch does" className={NOTE}>
          {direction === 'VERTICAL'
            ? 'Every item is as wide as the frame has room (in a wrapping column, as wide as its column). An item’s own horizontal sizing, “Fill container” included, is not used while Stretch is on. Rotated items and text that sets its own width keep their width.'
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
      <label className={CHECK_ROW}>
        <input
          type="checkbox"
          className={CHECKBOX}
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
    <label className="ev-input-shell">
      <span className="mr-1.5 flex-none text-[11px] text-dim">{prefix}</span>
      <input
        aria-label={label}
        className="h-full w-full min-w-0 border-0 bg-transparent p-0 outline-none placeholder:text-faint"
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
        <p role="note" aria-label="Stretched by the frame" className={NOTE}>
          {stretched === 'horizontal' ? 'Width' : 'Height'}: stretched by the frame’s alignment across its layout. The {stretched} sizing above is not used while
          that alignment is Stretch.
        </p>
      )}
      {limited && (
        <div className="grid grid-cols-2 gap-2">
          <LimitField label="Minimum width" prefix="Min W" value={shared(layers, (layer) => layer.minWidth)} onCommit={(minWidth) => set('Change size limit', { minWidth })} />
          <LimitField label="Maximum width" prefix="Max W" value={shared(layers, (layer) => layer.maxWidth)} onCommit={(maxWidth) => set('Change size limit', { maxWidth })} />
          <LimitField label="Minimum height" prefix="Min H" value={shared(layers, (layer) => layer.minHeight)} onCommit={(minHeight) => set('Change size limit', { minHeight })} />
          <LimitField label="Maximum height" prefix="Max H" value={shared(layers, (layer) => layer.maxHeight)} onCommit={(maxHeight) => set('Change size limit', { maxHeight })} />
        </div>
      )}
      {inLayout && (
        <label className={CHECK_ROW}>
          <input
            type="checkbox"
            className={CHECKBOX}
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
