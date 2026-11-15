import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { hslToRgb, hsvToRgb, rgbToHsl, rgbToHsv, type HSV, type RGB } from '../../core';
import { hexToRgb, NumberField, rgbToHex } from './Fields';

const WIDTH = 232;
const HEIGHT = 318;

interface ColorPickerProps {
  /** What is being coloured, for the dialog's name: "Fill 1 colour". */
  label: string;
  value: RGB;
  /** The swatch the picker was opened from, which it is placed beside. */
  anchor: DOMRect;
  /** `live` while something is being dragged, `commit` when a value is final. */
  onChange: (color: RGB, phase: 'live' | 'commit') => void;
  onClose: () => void;
}

interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}

const clamp = (v: number): number => Math.min(1, Math.max(0, v));
const sameColor = (a: RGB, b: RGB): boolean => rgbToHex(a) === rgbToHex(b);

/**
 * The application's colour picker: a square for saturation and brightness, a
 * strip for hue, the colour as HEX, RGB and HSL numbers, and where the
 * browser can do it a dropper that takes a colour from anywhere on screen.
 * Dragging previews; letting go, or entering a number, is one undo step.
 */
export function ColorPicker({ label, value, anchor, onChange, onClose }: ColorPickerProps) {
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(value));
  const dragging = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const [hexText, setHexText] = useState<string | null>(null);

  // Follow the colour when it changes from outside (undo, a number typed in), but
  // keep the hue and saturation that a grey or black cannot say for themselves.
  useEffect(() => {
    if (dragging.current) return;
    setHsv((current) => {
      if (sameColor(hsvToRgb(current), value)) return current;
      const next = rgbToHsv(value);
      return { h: next.s === 0 || next.v === 0 ? current.h : next.h, s: next.v === 0 ? current.s : next.s, v: next.v };
    });
  }, [value]);

  // Close on Escape and on a press anywhere else.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const onPress = (event: PointerEvent): void => {
      if (panel.current && event.target instanceof Node && !panel.current.contains(event.target)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPress, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPress, true);
    };
  }, [onClose]);

  const choose = (next: HSV, phase: 'live' | 'commit'): void => {
    setHsv(next);
    onChange(hsvToRgb(next), phase);
  };

  /** Drag handling shared by the square and the hue strip: `at` turns a position within the element into a colour. */
  const dragHandlers = (at: (x: number, y: number) => HSV) => {
    const pick = (event: ReactPointerEvent<HTMLDivElement>, phase: 'live' | 'commit'): void => {
      const rect = event.currentTarget.getBoundingClientRect();
      choose(at(clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)), phase);
    };
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        pick(event, 'live');
      },
      onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (dragging.current) pick(event, 'live');
      },
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragging.current) return;
        dragging.current = false;
        pick(event, 'commit');
      },
    };
  };

  const stepKeys = (event: ReactKeyboardEvent, change: (dx: number, dy: number) => HSV): void => {
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    event.stopPropagation();
    choose(change(move[0], move[1]), 'commit');
  };

  const rgb = hsvToRgb(hsv);
  const hsl = rgbToHsl(value);
  const hex = rgbToHex(value);
  const left = anchor.left - WIDTH - 12 >= 8 ? anchor.left - WIDTH - 12 : Math.min(window.innerWidth - WIDTH - 8, anchor.right + 12);
  const top = Math.max(8, Math.min(window.innerHeight - HEIGHT - 8, anchor.top - 24));
  const dropper = (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
  const channel = (n: number): number => Math.round(n * 255);
  const setRgb = (part: Partial<RGB>): void => onChange({ ...value, ...part }, 'commit');
  const setHsl = (part: Partial<{ h: number; s: number; l: number }>): void => {
    const next = { ...hsl, ...part };
    // Keep the picker on the hue that was asked for, even when the colour itself has none to show.
    setHsv((current) => ({ ...current, h: next.h }));
    onChange(hslToRgb(next), 'commit');
  };

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={`${label} picker`}
      className="fixed z-50 flex flex-col gap-2 rounded-lg border border-line bg-panel p-2 shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
      style={{ left, top, width: WIDTH }}
    >
      <div
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        aria-valuenow={Math.round(hsv.s * 100)}
        className="relative h-[140px] cursor-crosshair touch-none rounded"
        style={{ background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))` }}
        {...dragHandlers((x, y) => ({ h: hsv.h, s: x, v: 1 - y }))}
        onKeyDown={(event) => stepKeys(event, (dx, dy) => ({ h: hsv.h, s: clamp(hsv.s + dx / 100), v: clamp(hsv.v + dy / 100) }))}
      >
        <span
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: `#${rgbToHex(rgb)}` }}
        />
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        className="relative h-3 cursor-pointer touch-none rounded"
        style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
        {...dragHandlers((x) => ({ h: Math.min(359.99, x * 360), s: hsv.s, v: hsv.v }))}
        onKeyDown={(event) => stepKeys(event, (dx, dy) => ({ h: (((hsv.h + dx + dy) % 360) + 360) % 360, s: hsv.s, v: hsv.v }))}
      >
        <span
          className="pointer-events-none absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          style={{ left: `${(hsv.h / 360) * 100}%` }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <span className="h-[26px] w-[26px] flex-none rounded border border-line" style={{ background: `#${hex}` }} />
        <label className="flex h-[26px] min-w-0 flex-1 items-center rounded-[5px] border border-transparent bg-field pl-2 focus-within:border-accent hover:border-line">
          <span className="mr-1.5 flex-none text-dim">#</span>
          <input
            aria-label="Hex colour"
            className="h-full w-full min-w-0 border-0 bg-transparent p-0 uppercase outline-none"
            spellCheck={false}
            maxLength={7}
            value={hexText ?? hex}
            onFocus={(event) => {
              setHexText(hex);
              event.currentTarget.select();
            }}
            onChange={(event) => setHexText(event.currentTarget.value)}
            onBlur={(event) => {
              const parsed = hexToRgb(event.currentTarget.value);
              setHexText(null);
              if (parsed && !sameColor(parsed, value)) onChange(parsed, 'commit');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key !== 'Escape') event.stopPropagation();
            }}
          />
        </label>
        {dropper && (
          <button
            type="button"
            className="od-icon-button !h-[26px] !w-[26px]"
            aria-label="Pick a colour from the screen"
            title="Pick a colour from the screen"
            onClick={() => {
              void new dropper()
                .open()
                .then((result) => {
                  const picked = hexToRgb(result.sRGBHex);
                  if (picked) onChange(picked, 'commit');
                })
                // Leaving the dropper with Escape is not an error.
                .catch(() => undefined);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10.2 2.6l3.2 3.2-1.6 1.6-.8-.8-5.4 5.4-2.6.8.8-2.6 5.4-5.4-.8-.8z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <NumberField label="Red" prefix="R" min={0} max={255} value={channel(value.r)} onCommit={(n) => setRgb({ r: Math.round(n) / 255 })} />
        <NumberField label="Green" prefix="G" min={0} max={255} value={channel(value.g)} onCommit={(n) => setRgb({ g: Math.round(n) / 255 })} />
        <NumberField label="Blue" prefix="B" min={0} max={255} value={channel(value.b)} onCommit={(n) => setRgb({ b: Math.round(n) / 255 })} />
      </div>
      <div className="flex items-center gap-1.5">
        <NumberField label="Hue" prefix="H" min={0} max={360} value={Math.round(hsl.s === 0 ? hsv.h : hsl.h)} onCommit={(n) => setHsl({ h: n })} />
        <NumberField label="Saturation" prefix="S" min={0} max={100} value={Math.round(hsl.s * 100)} onCommit={(n) => setHsl({ s: n / 100 })} />
        <NumberField label="Lightness" prefix="L" min={0} max={100} value={Math.round(hsl.l * 100)} onCommit={(n) => setHsl({ l: n / 100 })} />
      </div>
    </div>
  );
}
