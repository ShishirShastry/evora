import type { ReactNode } from 'react';
import type { Document, LayerNode } from '../../core';
import type { EditorStore } from '../../state/editorStore';
import { MIXED, type Mixed } from '../components/Fields';

/** Building blocks shared by the sections of the properties panel. */

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-line px-3 pb-3 pt-2.5 last:border-b-0">
      <header className="mb-2 flex h-6 items-center justify-between">
        <h3 className="ev-section-title">{title}</h3>
        {action}
      </header>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2">{children}</div>;
}

/** The shared value of a property across layers, or MIXED when they differ. */
export function shared<T>(layers: readonly LayerNode[], get: (layer: LayerNode) => T): T | Mixed {
  const first = get(layers[0] as LayerNode);
  return layers.every((layer) => get(layer) === first) ? first : MIXED;
}

/** Whether a list-valued property (fills, strokes, effects) is identical on every layer. */
export function sameList(layers: readonly LayerNode[], key: 'fills' | 'strokes' | 'effects'): boolean {
  const first = JSON.stringify((layers[0] as LayerNode)[key]);
  return layers.every((layer) => JSON.stringify(layer[key]) === first);
}

/**
 * Applies a change as a live preview (inside a gesture) or as a committed
 * undo step. Used by the colour picker, which reports many values while it is
 * dragged and one final value when it closes.
 */
export function applyLive(store: EditorStore, label: string, phase: 'live' | 'commit', change: (doc: Document) => Document): void {
  const state = store.getState();
  if (phase === 'live') {
    state.beginGesture();
    store.getState().updateGesture(change);
    return;
  }
  if (state.gesture) {
    state.updateGesture(change);
    store.getState().commitGesture(label);
  } else {
    state.apply(label, change);
  }
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T | Mixed;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
}

/** A dropdown for an enumerated property, showing "Mixed" when the selected layers differ. */
export function SelectField<T extends string>({ label, value, options, onChange, className, disabled }: SelectFieldProps<T>) {
  return (
    <select
      aria-label={label}
      className={`ev-field ${className ?? 'flex-1'}`}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value as T)}
    >
      {value === MIXED && <option value={MIXED}>Mixed</option>}
      {options.map(([option, name]) => (
        <option key={option} value={option}>
          {name}
        </option>
      ))}
    </select>
  );
}
