import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/** A modal dialog: closes on Escape or a click outside, and returns focus to where it was. */
export function Dialog({ title, onClose, children, footer, width = 420 }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = ref.current?.querySelector<HTMLElement>('[data-autofocus], button, input');
    (focusable ?? ref.current)?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-full flex-col rounded-xl border border-line bg-panel shadow-[0_16px_60px_rgba(0,0,0,0.6)] outline-none"
        style={{ width }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="flex h-11 flex-none items-center justify-between border-b border-line pl-4 pr-2">
          <h2 className="m-0 text-[13px] font-semibold">{title}</h2>
          <button type="button" className="od-icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex flex-none justify-end gap-2 border-t border-line p-3">{footer}</footer>}
      </div>
    </div>
  );
}
