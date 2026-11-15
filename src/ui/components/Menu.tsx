import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

export type MenuItem =
  | { type?: 'item'; label: string; shortcut?: string; disabled?: boolean; checked?: boolean; danger?: boolean; onSelect: () => void }
  | { type: 'separator' }
  | { type: 'submenu'; label: string; items: MenuItem[] };

interface MenuListProps {
  items: MenuItem[];
  label: string;
  onClose: () => void;
  /** Called when Left is pressed in a submenu, to return to the parent. */
  onBack?: () => void;
  autoFocus?: boolean;
}

function focusSibling(current: HTMLElement, direction: 1 | -1): void {
  const menu = current.closest('[role="menu"]');
  if (!menu) return;
  const items = [...menu.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"]:not([aria-disabled="true"])')];
  const index = items.indexOf(current);
  const next = items[(index + direction + items.length) % items.length];
  next?.focus();
}

function MenuList({ items, label, onClose, onBack, autoFocus }: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.querySelector<HTMLElement>(':scope > [role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [autoFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number, item: MenuItem): void => {
    const target = event.currentTarget;
    if (event.key === 'ArrowDown') focusSibling(target, 1);
    else if (event.key === 'ArrowUp') focusSibling(target, -1);
    else if (event.key === 'ArrowRight' && item.type === 'submenu') setOpenIndex(index);
    else if (event.key === 'ArrowLeft' && onBack) onBack();
    else if (event.key === 'Escape') onClose();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="min-w-[200px] rounded-lg border border-line bg-panel py-1 shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
    >
      {items.map((item, index) => {
        if (item.type === 'separator') return <div key={index} role="separator" className="my-1 h-px bg-line" />;
        if (item.type === 'submenu') {
          const open = openIndex === index;
          return (
            <div
              key={index}
              role="menuitem"
              tabIndex={-1}
              aria-haspopup="menu"
              aria-expanded={open}
              className="relative flex h-7 cursor-default items-center justify-between px-3 outline-none hover:bg-hover focus:bg-hover"
              onMouseEnter={() => setOpenIndex(index)}
              onClick={() => setOpenIndex(index)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setOpenIndex(index);
                  event.preventDefault();
                } else onKeyDown(event, index, item);
              }}
            >
              <span>{item.label}</span>
              <span className="text-dim">
                <Icon name="chevronRight" size={12} />
              </span>
              {open && (
                <div className="absolute left-full top-[-5px] z-10 pl-1">
                  <MenuList
                    items={item.items}
                    label={item.label}
                    onClose={onClose}
                    autoFocus
                    onBack={() => {
                      setOpenIndex(null);
                      ref.current?.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"]')[
                        items.slice(0, index).filter((i) => i.type !== 'separator').length
                      ]?.focus();
                    }}
                  />
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            key={index}
            type="button"
            role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={item.checked}
            tabIndex={-1}
            aria-disabled={item.disabled ? 'true' : undefined}
            className={`flex h-7 w-full cursor-default items-center justify-between gap-6 border-0 bg-transparent px-3 text-left outline-none ${
              item.disabled ? 'text-faint' : `hover:bg-hover focus:bg-hover ${item.danger ? 'text-danger' : ''}`
            }`}
            onMouseEnter={() => setOpenIndex(null)}
            onClick={(event) => {
              event.stopPropagation();
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
            onKeyDown={(event) => onKeyDown(event, index, item)}
          >
            <span className="flex items-center gap-2">
              {item.checked !== undefined && (
                <span className="w-3 text-accent">{item.checked ? <Icon name="check" size={12} /> : null}</span>
              )}
              {item.label}
            </span>
            {item.shortcut && <span className="text-dim">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

interface PopupMenuProps {
  /** Viewport position of the menu's top-left corner. */
  x: number;
  y: number;
  items: MenuItem[];
  label: string;
  onClose: () => void;
}

/** A menu shown at a point: used for context menus and for menus opened from buttons. */
export function PopupMenu({ x, y, items, label, onClose }: PopupMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

  // Return focus to where it was when the menu closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="absolute" style={position}>
        <MenuList items={items} label={label} onClose={onClose} autoFocus />
      </div>
    </div>
  );
}
