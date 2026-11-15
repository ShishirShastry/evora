import { useRef, useState } from 'react';
import type { RGB } from '../../core';
import { ColorPicker } from './ColorPicker';
import { hexToRgb, rgbToHex } from './Fields';

interface ColorFieldProps {
  label: string;
  value: RGB;
  /**
   * `live` while the colour picker is being dragged, `commit` when a value is
   * final. Callers preview on `live` and record one undo step on `commit`.
   */
  onChange: (color: RGB, phase: 'live' | 'commit') => void;
}

/** A colour swatch that opens the colour picker, with an editable HEX value beside it. */
export function ColorField({ label, value, onChange }: ColorFieldProps) {
  const hex = rgbToHex(value);
  const [text, setText] = useState(hex);
  const [editing, setEditing] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const swatch = useRef<HTMLButtonElement>(null);

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
      <button
        ref={swatch}
        type="button"
        aria-label={`${label} picker`}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        className="ml-1.5 h-4 w-4 flex-none cursor-pointer rounded-[3px] border border-line p-0"
        style={{ background: `#${hex}` }}
        onClick={() => setAnchor(swatch.current?.getBoundingClientRect() ?? null)}
      />
      <input
        aria-label={`${label} hex`}
        className="h-full w-full min-w-0 border-0 bg-transparent px-2 uppercase outline-none"
        spellCheck={false}
        maxLength={7}
        // As in NumberField: the document's value, directly, while nobody is typing.
        value={editing ? text : hex}
        onFocus={(event) => {
          setText(hex);
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
      {anchor && <ColorPicker label={label} value={value} anchor={anchor} onChange={onChange} onClose={() => setAnchor(null)} />}
    </div>
  );
}
