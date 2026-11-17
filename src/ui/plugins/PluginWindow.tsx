import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditor } from '../editor/EditorContext';
import { Icon } from '../components/Icon';
import { UI_SANDBOX_FLAGS, uiDocument } from '../../plugins/runtime';

/** A plugin window's frame, for the mount to send it messages: those sent before it has loaded wait in `queue`. */
export interface UiFrameHandle {
  frame: HTMLIFrameElement | null;
  queue: unknown[];
  loaded?: boolean;
}

interface PluginWindowProps {
  title: string;
  width: number;
  height: number;
  html: string;
  handle: UiFrameHandle;
  onClose(): void;
}

/**
 * A plugin's window, as in Figma: a floating panel over the editor with the
 * plugin's name and a close button, moved by dragging its title bar. What is
 * in it is the plugin's own HTML, in a sandboxed frame of its own (scripts
 * only, an opaque origin, no network), which talks to the plugin through
 * `parent.postMessage({ pluginMessage })`.
 */
export function PluginWindow({ title, width, height, html, handle, onClose }: PluginWindowProps) {
  const theme = useEditor((s) => s.theme);
  const [place, setPlace] = useState(() => ({ x: Math.max(16, window.innerWidth - width - 280), y: 72 }));
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  // The document is made once: a new theme or HTML would reload the window and lose what is in it.
  const [srcDoc] = useState(() => uiDocument(html, theme));

  useEffect(() => {
    // Kept inside the window when the window is resized.
    const keep = (): void =>
      setPlace((p) => ({ x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - width)), y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 40)) }));
    window.addEventListener('resize', keep);
    return () => window.removeEventListener('resize', keep);
  }, [width]);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('button')) return;
    drag.current = { dx: event.clientX - place.x, dy: event.clientY - place.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!drag.current) return;
    setPlace({
      x: Math.min(Math.max(0, event.clientX - drag.current.dx), window.innerWidth - 80),
      y: Math.min(Math.max(0, event.clientY - drag.current.dy), window.innerHeight - 40),
    });
  };
  const onPointerUp = (): void => {
    drag.current = null;
  };

  return (
    // A region, not a dialog: the canvas and its shortcuts keep working while a plugin's window is open, as in Figma.
    <section
      aria-label={title}
      className="ev-popover fixed z-40 flex flex-col overflow-hidden !rounded-[12px]"
      style={{ left: place.x, top: place.y, width }}
      onKeyDown={(event) => {
        // Keys pressed in the window are for the window, not for the canvas behind it.
        event.stopPropagation();
        if (event.key === 'Escape') onClose();
      }}
    >
      <header
        className="flex h-10 flex-none cursor-grab select-none items-center justify-between border-b border-line pl-3 pr-1.5 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <h2 className="m-0 truncate text-[12px] font-semibold text-ink">{title}</h2>
        <button type="button" className="ev-icon-button" aria-label={`Close ${title}`} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <iframe
        ref={(frame) => {
          handle.frame = frame;
          if (!frame) handle.loaded = false;
        }}
        title={title}
        sandbox={UI_SANDBOX_FLAGS}
        srcDoc={srcDoc}
        className="block flex-none border-0 bg-transparent"
        style={{ width, height }}
        onLoad={(event) => {
          handle.loaded = true;
          const target = event.currentTarget.contentWindow;
          for (const message of handle.queue.splice(0)) target?.postMessage({ pluginMessage: message }, '*');
        }}
      />
    </section>
  );
}
