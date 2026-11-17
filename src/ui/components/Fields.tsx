import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RGB } from '../../core';

export const MIXED = 'mixed' as const;
export type Mixed = typeof MIXED;

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

interface NumberFieldProps {
  /** Accessible name, for example "X position". */
  label: string;
  /** Short visible prefix inside the field, for example "X". */
  prefix?: ReactNode;
  suffix?: string;
  value: number | Mixed;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}

/**
 * A numeric input that edits the document only when the value is committed
 * (Enter, Tab or blur), so one edit is one undo step. Escape reverts. The
 * arrow keys step by 1, or by 10 with Shift.
 */
export function NumberField({ label, prefix, suffix, value, onCommit, min, max, disabled }: NumberFieldProps) {
  const shown = value === MIXED ? '' : formatNumber(value);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  // Committed with Enter and not typed in since: the field shows the document's value again, also when someone else changes it.
  const [committed, setCommitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // While nobody is typing, the field shows the document's value directly, in
  // the very render in which that value changes. (Copying it into state in an
  // effect would rewrite the input a moment later, which loses the selection
  // of someone who has already clicked into the field and started typing.)
  const display = editing && !committed ? text : shown;
  // After Enter the whole value is selected, ready to be typed over; a value that changes after that stays so.
  useEffect(() => {
    if (committed && document.activeElement === inputRef.current) inputRef.current?.select();
  }, [committed, shown]);

  const clamp = (n: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

  const commit = (raw: string): void => {
    const parsed = Number.parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      setText(shown);
      return;
    }
    const next = clamp(parsed);
    setText(formatNumber(next));
    if (value === MIXED || next !== value) onCommit(next);
  };

  return (
    <label className="ev-input-shell">
      {prefix !== undefined && <span className="mr-1.5 flex-none text-dim">{prefix}</span>}
      <input
        ref={inputRef}
        aria-label={label}
        className="h-full w-full min-w-0 border-0 bg-transparent p-0 text-ink tabular-nums outline-none placeholder:text-dim disabled:text-faint"
        inputMode="decimal"
        spellCheck={false}
        disabled={disabled}
        placeholder={value === MIXED ? 'Mixed' : undefined}
        value={display}
        onFocus={(event) => {
          setText(shown);
          setEditing(true);
          setCommitted(false);
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setCommitted(false);
        }}
        onBlur={(event) => {
          setEditing(false);
          setCommitted(false);
          if (!committed) commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit(event.currentTarget.value);
            setCommitted(true);
            event.currentTarget.select();
          } else if (event.key === 'Escape') {
            setText(shown);
            setEditing(false);
            requestAnimationFrame(() => inputRef.current?.blur());
          } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && value !== MIXED) {
            event.preventDefault();
            const step = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
            const base = Number.parseFloat(event.currentTarget.value.replace(',', '.'));
            const next = clamp((Number.isFinite(base) ? base : value) + step);
            setText(formatNumber(next));
            if (next !== value) onCommit(next);
          }
          // Keep editor shortcuts from firing while typing.
          event.stopPropagation();
        }}
      />
      {suffix && <span className="mr-2 flex-none text-dim">{suffix}</span>}
    </label>
  );
}

export function rgbToHex(color: RGB): string {
  const part = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `${part(color.r)}${part(color.g)}${part(color.b)}`.toUpperCase();
}

export function hexToRgb(input: string): RGB | null {
  let hex = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.replace(/./g, (c) => c + c);
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = Number.parseInt(hex, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

interface TextEditProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}

/**
 * The rename box: shorter than a field so it fits inside a list row, with a
 * crisp accent edge as in Figma (it is only ever on screen while it is being
 * typed in).
 */
const TEXT_EDIT_CLASS = 'ev-field !h-[22px] !rounded-[5px] !px-1.5 text-ink !shadow-[inset_0_0_0_1px_var(--ev-accent)]';

/** An inline text editor for renaming: Enter or blur commits, Escape cancels. */
export function TextEdit({ label, value, onCommit, onCancel, className }: TextEditProps) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean, text: string): void => {
    if (finished.current) return;
    finished.current = true;
    if (commit && text.trim() && text.trim() !== value) onCommit(text.trim());
    else onCancel();
  };

  return (
    <input
      ref={ref}
      aria-label={label}
      className={`${TEXT_EDIT_CLASS} ${className ?? ''}`}
      defaultValue={value}
      spellCheck={false}
      onBlur={(event) => finish(true, event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true, event.currentTarget.value);
        else if (event.key === 'Escape') finish(false, '');
        event.stopPropagation();
      }}
    />
  );
}
