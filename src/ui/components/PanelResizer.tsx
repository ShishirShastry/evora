import { useRef } from 'react';

interface PanelResizerProps {
  /** Accessible name, for example "Resize the layers panel". */
  label: string;
  width: number;
  min: number;
  max: number;
  /** The width a double-click goes back to. */
  reset: number;
  /** Which side of the window the panel is on: dragging away from that side makes it wider. */
  side: 'left' | 'right';
  /** Called with every new width while dragging. */
  onChange: (width: number) => void;
  /** Called once with the width a drag, a key press or a reset ends on. */
  onCommit: (width: number) => void;
}

const STEP = 16;
const BIG_STEP = 48;

/**
 * Invisible until wanted: the grab strip lies along the inside of the panel's
 * edge (the panel clips what lies outside it), and a slim accent line grows
 * along that edge on hover, shows fully while dragging, and marks the
 * keyboard's place in place of the focus ring.
 */
const STRIP =
  'absolute top-0 z-20 h-full w-1.5 cursor-col-resize touch-none focus-visible:!outline-none ' +
  'after:pointer-events-none after:absolute after:inset-y-3 after:w-0.5 after:rounded-full after:bg-accent after:opacity-0 after:scale-y-75 ' +
  'after:transition-[opacity,scale,box-shadow] after:duration-150 after:ease-[var(--ev-ease)] ' +
  'hover:after:scale-y-100 hover:after:opacity-60 hover:after:delay-75 ' +
  'active:after:scale-y-100 active:after:opacity-100 active:after:delay-0 active:after:shadow-[0_0_10px_var(--ev-ring)] ' +
  'focus-visible:after:scale-y-100 focus-visible:after:opacity-100 focus-visible:after:shadow-[0_0_10px_var(--ev-ring)]';

/**
 * The edge of a side panel that faces the canvas: drag it to make the panel
 * wider or narrower, double-click to put it back, or focus it and use the
 * arrow keys (Shift for bigger steps, Home and End for the limits).
 */
export function PanelResizer({ label, width, min, max, reset, side, onChange, onCommit }: PanelResizerProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const clamp = (value: number): number => Math.round(Math.min(max, Math.max(min, value)));
  const dragged = (clientX: number, from: { startX: number; startWidth: number }): number =>
    clamp(from.startWidth + (side === 'left' ? clientX - from.startX : from.startX - clientX));
  const set = (next: number): void => {
    const value = clamp(next);
    onChange(value);
    onCommit(value);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className={`${STRIP} ${side === 'left' ? 'right-0 after:right-0' : 'left-0 after:left-0'}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
      }}
      onPointerMove={(event) => {
        if (drag.current) onChange(dragged(event.clientX, drag.current));
      }}
      onPointerUp={(event) => {
        const from = drag.current;
        if (!from) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit(dragged(event.clientX, from));
      }}
      onPointerCancel={() => {
        const from = drag.current;
        drag.current = null;
        if (from) set(from.startWidth);
      }}
      onDoubleClick={() => set(reset)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? BIG_STEP : STEP;
        // The arrow that points away from the panel's own side of the window makes it wider.
        const wider = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
        const narrower = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
        if (event.key === wider) set(width + step);
        else if (event.key === narrower) set(width - step);
        else if (event.key === 'Home') set(min);
        else if (event.key === 'End') set(max);
        else return;
        event.preventDefault();
        // The arrow keys also nudge the selection: not while this has the keyboard.
        event.stopPropagation();
      }}
    />
  );
}
