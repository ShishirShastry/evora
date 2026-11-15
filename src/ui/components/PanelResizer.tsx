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
      className={`absolute top-0 z-20 h-full w-[7px] cursor-col-resize touch-none hover:bg-accent/40 focus-visible:bg-accent/60 ${
        side === 'left' ? '-right-1' : '-left-1'
      }`}
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
