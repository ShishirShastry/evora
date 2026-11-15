import type { ReactNode } from 'react';
import {
  gradientAngle,
  gradientHandles,
  gradientPaint,
  isGradient,
  paintColor,
  patchNodes,
  solidPaint,
  WHITE,
  type GradientPaint,
  type GradientStop,
  type GradientType,
  type LayerNode,
  type LayerPatch,
  type NodeId,
  type Paint,
  type RGB,
} from '../../core';
import { ColorField, NumberField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useEditorContext } from '../editor/EditorContext';
import { applyLive, Row, sameList, Section, SelectField } from './panelParts';

type PaintType = Paint['type'];

const PAINT_TYPES: readonly (readonly [PaintType, string])[] = [
  ['SOLID', 'Solid'],
  ['GRADIENT_LINEAR', 'Linear'],
  ['GRADIENT_RADIAL', 'Radial'],
  ['GRADIENT_ANGULAR', 'Angular'],
  ['GRADIENT_DIAMOND', 'Diamond'],
];

/** Converts a paint to another kind, keeping as much of it as makes sense. */
export function convertPaint(paint: Paint, type: PaintType): Paint {
  if (paint.type === type) return paint;
  if (type === 'SOLID') return { ...solidPaint(paintColor(paint), paint.opacity), visible: paint.visible };
  if (isGradient(paint)) {
    // Between gradient kinds the stops carry over; the handles are reset to that kind's natural default.
    const fresh = gradientPaint(type as GradientType, WHITE, WHITE, type === 'GRADIENT_LINEAR' ? gradientAngle(paint) : 0);
    return { ...fresh, stops: paint.stops, opacity: paint.opacity, visible: paint.visible };
  }
  // Solid to gradient: from the solid colour to the same colour fully transparent.
  const gradient = gradientPaint(type as GradientType, paint.color, paint.color);
  const last = gradient.stops[1] as GradientStop;
  return { ...gradient, stops: [gradient.stops[0] as GradientStop, { ...last, opacity: 0 }], opacity: paint.opacity, visible: paint.visible };
}

/** Rotates a gradient's handles to an angle, keeping its centre and length. */
function withAngle(paint: GradientPaint, angle: number): GradientPaint {
  if (paint.type === 'GRADIENT_LINEAR') return { ...paint, ...gradientHandles(angle) };
  const length = Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y) || 0.5;
  const r = (angle * Math.PI) / 180;
  const tidy = (v: number): number => Math.round(v * 1e6) / 1e6;
  return { ...paint, to: { x: tidy(paint.from.x + Math.cos(r) * length), y: tidy(paint.from.y + Math.sin(r) * length) } };
}

function sortStops(stops: GradientStop[]): GradientStop[] {
  return stops
    .map((stop, index) => ({ stop, index }))
    .sort((a, b) => a.stop.position - b.stop.position || a.index - b.index)
    .map((entry) => entry.stop);
}

/** A new stop in the widest gap, with the colour halfway between its neighbours. */
function addStop(stops: GradientStop[]): GradientStop[] {
  let at = 0;
  for (let i = 1; i < stops.length - 1; i++) {
    const gap = (stops[i + 1] as GradientStop).position - (stops[i] as GradientStop).position;
    if (gap > (stops[at + 1] as GradientStop).position - (stops[at] as GradientStop).position) at = i;
  }
  const a = stops[at] as GradientStop;
  const b = stops[at + 1] as GradientStop;
  const mix = (x: number, y: number): number => (x + y) / 2;
  const middle: GradientStop = {
    position: Math.round(mix(a.position, b.position) * 100) / 100,
    color: { r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b) },
    opacity: mix(a.opacity, b.opacity),
  };
  return [...stops.slice(0, at + 1), middle, ...stops.slice(at + 1)];
}

interface PaintListProps {
  title: string;
  paintKey: 'fills' | 'strokes';
  layers: LayerNode[];
  defaultColor: RGB;
  children?: ReactNode;
}

/** Editable stack of paints (fills or strokes) for the selected layers: solid colours and gradients. */
export function PaintList({ title, paintKey, layers, defaultColor, children }: PaintListProps) {
  const { store } = useEditorContext();
  const ids = layers.map((layer) => layer.id);
  const mixed = !sameList(layers, paintKey);
  const paints = mixed ? [] : (layers[0] as LayerNode)[paintKey];
  const noun = paintKey === 'fills' ? 'fill' : 'stroke';

  const setPaints = (label: string, next: Paint[], phase: 'live' | 'commit' = 'commit'): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const id of ids) patches[id] = { [paintKey]: next };
    applyLive(store, label, phase, (doc) => patchNodes(doc, patches));
  };
  const replace = (index: number, paint: Paint, label: string, phase: 'live' | 'commit' = 'commit'): void =>
    setPaints(label, paints.map((other, i) => (i === index ? paint : other)), phase);

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
      {paints.map((paint, index) => {
        const name = `${title} ${index + 1}`;
        return (
          <div key={index} role="group" aria-label={name} className="flex flex-col gap-1.5">
            <Row>
              <SelectField<PaintType>
                label={`${name} type`}
                value={paint.type}
                options={PAINT_TYPES}
                onChange={(type) => replace(index, convertPaint(paint, type), `Change ${noun} type`)}
              />
              <div className="w-16 flex-none">
                <NumberField
                  label={`${name} opacity`}
                  suffix="%"
                  value={Math.round(paint.opacity * 100)}
                  min={0}
                  max={100}
                  onCommit={(value) => replace(index, { ...paint, opacity: value / 100 }, `Change ${noun} opacity`)}
                />
              </div>
              <button
                type="button"
                className="od-icon-button !h-6 !w-6"
                aria-label={paint.visible ? `Hide ${noun} ${index + 1}` : `Show ${noun} ${index + 1}`}
                title={paint.visible ? 'Hide' : 'Show'}
                onClick={() => replace(index, { ...paint, visible: !paint.visible }, paint.visible ? `Hide ${noun}` : `Show ${noun}`)}
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

            {paint.type === 'SOLID' ? (
              <Row>
                <ColorField
                  label={`${name} colour`}
                  value={paint.color}
                  onChange={(color, phase) => replace(index, { ...paint, color }, `Change ${noun} colour`, phase)}
                />
              </Row>
            ) : (
              <>
                <Row>
                  <NumberField
                    label={`${name} angle`}
                    prefix="Angle"
                    suffix="°"
                    min={0}
                    max={360}
                    value={gradientAngle(paint)}
                    onCommit={(angle) => replace(index, withAngle(paint, angle), 'Change gradient angle')}
                  />
                  <button
                    type="button"
                    className="od-button !h-[26px] flex-none !px-2"
                    aria-label={`Add stop to ${name}`}
                    title="Add a colour stop"
                    onClick={() => replace(index, { ...paint, stops: addStop(paint.stops) }, 'Add gradient stop')}
                  >
                    + Stop
                  </button>
                </Row>
                {paint.stops.map((stop, stopIndex) => {
                  const stopName = `${name} stop ${stopIndex + 1}`;
                  const setStop = (patch: Partial<GradientStop>, label: string, phase: 'live' | 'commit' = 'commit'): void =>
                    replace(
                      index,
                      // Stops are kept in position order, except while a colour is being dragged.
                      { ...paint, stops: (phase === 'live' ? (s: GradientStop[]) => s : sortStops)(paint.stops.map((s, i) => (i === stopIndex ? { ...s, ...patch } : s))) },
                      label,
                      phase,
                    );
                  return (
                    <Row key={stopIndex}>
                      <ColorField label={`${stopName} colour`} value={stop.color} onChange={(color, phase) => setStop({ color }, 'Change stop colour', phase)} />
                      <div className="w-[54px] flex-none">
                        <NumberField
                          label={`${stopName} position`}
                          suffix="%"
                          min={0}
                          max={100}
                          value={Math.round(stop.position * 100)}
                          onCommit={(value) => setStop({ position: value / 100 }, 'Move gradient stop')}
                        />
                      </div>
                      <div className="w-[54px] flex-none">
                        <NumberField
                          label={`${stopName} opacity`}
                          suffix="%"
                          min={0}
                          max={100}
                          value={Math.round(stop.opacity * 100)}
                          onCommit={(value) => setStop({ opacity: value / 100 }, 'Change stop opacity')}
                        />
                      </div>
                      <button
                        type="button"
                        className="od-icon-button !h-6 !w-6"
                        aria-label={`Remove ${stopName}`}
                        title="Remove stop"
                        disabled={paint.stops.length <= 2}
                        onClick={() => replace(index, { ...paint, stops: paint.stops.filter((_, i) => i !== stopIndex) }, 'Remove gradient stop')}
                      >
                        <Icon name="minus" size={13} />
                      </button>
                    </Row>
                  );
                })}
              </>
            )}
          </div>
        );
      })}
      {!mixed && paints.length > 0 && children}
    </Section>
  );
}
