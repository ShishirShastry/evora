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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setText(shown);
  }, [shown, editing]);

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
    <label className="flex h-[26px] min-w-0 flex-1 items-center rounded-[5px] border border-transparent bg-field pl-2 focus-within:border-accent hover:border-line">
      {prefix !== undefined && <span className="mr-1.5 flex-none text-dim">{prefix}</span>}
      <input
        ref={inputRef}
        aria-label={label}
        className="h-full w-full min-w-0 border-0 bg-transparent p-0 outline-none disabled:text-faint"
        inputMode="decimal"
        spellCheck={false}
        disabled={disabled}
        placeholder={value === MIXED ? 'Mixed' : undefined}
        value={text}
        onFocus={(event) => {
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

interface ColorFieldProps {
  label: string;
  value: RGB;
  /**
   * `live` while the colour picker is being dragged, `commit` when a value is
   * final. Callers preview on `live` and record one undo step on `commit`.
   */
  onChange: (color: RGB, phase: 'live' | 'commit') => void;
}

/** A colour swatch that opens the system colour picker, with an editable HEX value beside it. */
export function ColorField({ label, value, onChange }: ColorFieldProps) {
  const hex = rgbToHex(value);
  const [text, setText] = useState(hex);
  const [editing, setEditing] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    if (!editing) setText(hex);
  }, [hex, editing]);

  // React's onChange fires continuously for colour inputs; the native
  // "change" event fires once, when the picker is closed.
  useEffect(() => {
    const picker = pickerRef.current;
    if (!picker) return;
    const onCommit = (): void => {
      const rgb = hexToRgb(picker.value);
      if (rgb) latest.current(rgb, 'commit');
    };
    picker.addEventListener('change', onCommit);
    return () => picker.removeEventListener('change', onCommit);
  }, []);

  const commitText = (raw: string): void => {
    const rgb = hexToRgb(raw);
    if (!rgb) {
      setText(hex);
      return;
    }
    setText(rgbToHex(rgb));
    if (rgbToHex(rgb) !== hex) onChange(rgb, 'commit');
  };

  return (
    <div className="flex h-[26px] min-w-0 flex-1 items-center rounded-[5px] border border-transparent bg-field focus-within:border-accent hover:border-line">
      <span
        className="relative ml-1.5 h-4 w-4 flex-none overflow-hidden rounded-[3px] border border-line"
        style={{ background: `#${hex}` }}
      >
        <input
          ref={pickerRef}
          type="color"
          aria-label={`${label} picker`}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={`#${hex.toLowerCase()}`}
          onInput={(event) => {
            const rgb = hexToRgb(event.currentTarget.value);
            if (rgb) onChange(rgb, 'live');
          }}
          onChange={() => undefined}
        />
      </span>
      <input
        aria-label={`${label} hex`}
        className="h-full w-full min-w-0 border-0 bg-transparent px-2 uppercase outline-none"
        spellCheck={false}
        maxLength={7}
        value={text}
        onFocus={(event) => {
          setEditing(true);
          event.currentTarget.select();
        }}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={(event) => {
          setEditing(false);
          commitText(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitText(event.currentTarget.value);
          else if (event.key === 'Escape') {
            setText(hex);
            event.currentTarget.blur();
          }
          event.stopPropagation();
        }}
      />
    </div>
  );
}

interface TextEditProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}

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
      className={`od-field ${className ?? ''}`}
      style={{ height: 22, borderColor: 'var(--od-accent)' }}
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
