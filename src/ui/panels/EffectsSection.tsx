import {
  BLACK,
  dropShadow,
  isShadow,
  patchNodes,
  type Effect,
  type EffectType,
  type LayerNode,
  type LayerPatch,
  type NodeId,
  type ShadowEffect,
} from '../../core';
import { ColorField } from '../components/ColorField';
import { NumberField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useEditorContext } from '../editor/EditorContext';
import { applyLive, Row, sameList, Section, SelectField } from './panelParts';

const EFFECT_NAMES: readonly (readonly [EffectType, string])[] = [
  ['DROP_SHADOW', 'Drop shadow'],
  ['INNER_SHADOW', 'Inner shadow'],
  ['LAYER_BLUR', 'Layer blur'],
  ['BACKGROUND_BLUR', 'Background blur'],
];

/** Converts an effect to another kind, keeping what the two kinds have in common. */
export function convertEffect(effect: Effect, type: EffectType): Effect {
  if (effect.type === type) return effect;
  const toShadow = type === 'DROP_SHADOW' || type === 'INNER_SHADOW';
  if (toShadow) {
    if (isShadow(effect)) return { ...effect, type };
    return { ...dropShadow(), type, blur: effect.radius, visible: effect.visible };
  }
  return { type, radius: isShadow(effect) ? effect.blur : effect.radius, visible: effect.visible };
}

/** The effect stack of the selected layers: shadows and blurs, each editable, hideable and removable. */
export function EffectsSection({ layers }: { layers: LayerNode[] }) {
  const { store } = useEditorContext();
  const ids = layers.map((layer) => layer.id);
  const mixed = !sameList(layers, 'effects');
  const effects = mixed ? [] : (layers[0] as LayerNode).effects;

  const setEffects = (label: string, next: Effect[], phase: 'live' | 'commit' = 'commit'): void => {
    const patches: Record<NodeId, LayerPatch> = {};
    for (const id of ids) patches[id] = { effects: next };
    applyLive(store, label, phase, (doc) => patchNodes(doc, patches));
  };
  const replace = (index: number, effect: Effect, label: string, phase: 'live' | 'commit' = 'commit'): void =>
    setEffects(label, effects.map((other, i) => (i === index ? effect : other)), phase);

  return (
    <Section
      title="Effects"
      action={
        <button
          type="button"
          className="ev-icon-button -my-0.5"
          aria-label="Add effect"
          title="Add effect"
          onClick={() => setEffects('Add effect', [...effects, dropShadow()])}
        >
          <Icon name="plus" size={14} />
        </button>
      }
    >
      {mixed && <p className="m-0 text-[11px] text-dim">The selected layers have different effects. Add one to replace them.</p>}
      {!mixed && effects.length === 0 && <p className="m-0 text-[11px] text-faint">No effects</p>}
      {effects.map((effect, index) => {
        const name = `Effect ${index + 1}`;
        const setShadow = (patch: Partial<ShadowEffect>, label: string, phase: 'live' | 'commit' = 'commit'): void => {
          if (isShadow(effect)) replace(index, { ...effect, ...patch }, label, phase);
        };
        return (
          // Each effect after the first stands a little apart, so its rows read as one.
          <div key={index} role="group" aria-label={name} className={`flex flex-col gap-1.5 ${index > 0 ? 'mt-1' : ''}`}>
            <Row>
              <SelectField<EffectType>
                label={`${name} type`}
                value={effect.type}
                options={EFFECT_NAMES}
                onChange={(type) => replace(index, convertEffect(effect, type), 'Change effect type')}
              />
              {/* Show and remove, kept together at the end of the row. */}
              <div className="flex flex-none items-center">
                <button
                  type="button"
                  className="ev-icon-button"
                  aria-label={effect.visible ? `Hide effect ${index + 1}` : `Show effect ${index + 1}`}
                  title={effect.visible ? 'Hide' : 'Show'}
                  onClick={() => replace(index, { ...effect, visible: !effect.visible }, effect.visible ? 'Hide effect' : 'Show effect')}
                >
                  <Icon name={effect.visible ? 'eye' : 'eyeOff'} size={14} />
                </button>
                <button
                  type="button"
                  className="ev-icon-button"
                  aria-label={`Remove effect ${index + 1}`}
                  title="Remove"
                  onClick={() => setEffects('Remove effect', effects.filter((_, i) => i !== index))}
                >
                  <Icon name="minus" size={14} />
                </button>
              </div>
            </Row>
            {isShadow(effect) ? (
              <>
                <Row>
                  <NumberField label={`${name} X offset`} prefix="X" value={effect.offsetX} onCommit={(offsetX) => setShadow({ offsetX }, 'Change shadow offset')} />
                  <NumberField label={`${name} Y offset`} prefix="Y" value={effect.offsetY} onCommit={(offsetY) => setShadow({ offsetY }, 'Change shadow offset')} />
                </Row>
                <Row>
                  <NumberField label={`${name} blur`} prefix="Blur" min={0} max={1000} value={effect.blur} onCommit={(blur) => setShadow({ blur }, 'Change shadow blur')} />
                  <NumberField
                    label={`${name} spread`}
                    prefix="Spread"
                    min={-1000}
                    max={1000}
                    value={effect.spread}
                    onCommit={(spread) => setShadow({ spread }, 'Change shadow spread')}
                  />
                </Row>
                <Row>
                  <ColorField
                    label={`${name} colour`}
                    value={effect.color ?? BLACK}
                    onChange={(color, phase) => setShadow({ color }, 'Change shadow colour', phase)}
                  />
                  <div className="w-16 flex-none">
                    <NumberField
                      label={`${name} opacity`}
                      suffix="%"
                      min={0}
                      max={100}
                      value={Math.round(effect.opacity * 100)}
                      onCommit={(value) => setShadow({ opacity: value / 100 }, 'Change shadow opacity')}
                    />
                  </div>
                </Row>
              </>
            ) : (
              <Row>
                <NumberField
                  label={`${name} radius`}
                  prefix="Radius"
                  min={0}
                  max={1000}
                  value={effect.radius}
                  onCommit={(radius) => replace(index, { ...effect, radius }, 'Change blur radius')}
                />
              </Row>
            )}
          </div>
        );
      })}
    </Section>
  );
}
