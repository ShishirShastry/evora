import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface PopoverProps {
  /** The element it hangs from; it opens below it, kept inside the window. */
  anchor: HTMLElement | null;
  label: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** Line it up with the anchor's right edge rather than its left. */
  alignRight?: boolean;
}

/** A panel that floats below a button (the notifications list): closes on Escape or a press anywhere outside it and its button. */
export function Popover({ anchor, label, onClose, children, width = 320, alignRight = false }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const left = alignRight ? rect.right - width : rect.left;
    setPlace({ left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top: rect.bottom + 6 });
  }, [anchor, width, alignRight]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && (ref.current?.contains(target) || anchor?.contains(target))) return;
      close.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchor]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className="ev-popover fixed z-50 flex max-h-[min(520px,80vh)] flex-col overflow-hidden"
      style={{ width, left: place?.left ?? -9999, top: place?.top ?? -9999 }}
    >
      {children}
    </div>
  );
}
