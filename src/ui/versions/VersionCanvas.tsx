import { useEffect, useRef, useState } from 'react';
import { getChildIds, getWorldBounds, isLayer, unionRects, type Document, type NodeId, type Rect } from '../../core';
import type { ImageSource } from '../../engine/images/imageCache';

/** Images to draw with; the editor's cache also says when one arrives. */
type Images = ImageSource & { onChange?(listener: () => void): () => void };
import { renderScene } from '../../engine/render/scene';
import { getBrowserMeasurer } from '../../engine/text/measure';
import { onFontsLoaded } from '../../engine/text/fonts';
import { clampZoom, fitRect, panBy, worldToScreen, zoomAt, type Size, type Viewport } from '../../engine/viewport';

/**
 * A page of a document drawn read-only by the editor's own renderer, with a
 * viewport of its own (drag or scroll to pan, Ctrl + wheel to zoom). The
 * viewport can be controlled, so two canvases can move together.
 */

export type Highlight = { id: NodeId; tone: 'added' | 'removed' | 'changed' | 'focus' };

const TONES: Record<Highlight['tone'], string> = {
  added: '#2fd27f',
  removed: '#ff5a5f',
  changed: '#ffa629',
  focus: '#0d99ff',
};

/** The bounds of everything visible on a page, or null when it is empty. */
export function pageBounds(doc: Document, pageId: NodeId): Rect | null {
  const rects: Rect[] = [];
  for (const id of getChildIds(doc, pageId)) {
    const node = doc.nodes[id];
    if (isLayer(node) && node.visible) rects.push(getWorldBounds(doc, id));
  }
  return unionRects(rects);
}

/** A viewport showing a page's content (or the origin, for an empty page). */
export function fitPage(doc: Document, pageId: NodeId, size: Size): Viewport {
  const bounds = pageBounds(doc, pageId);
  return bounds ? fitRect(bounds, size, 48, 1) : { x: -size.width / 2, y: -size.height / 2, zoom: 1 };
}

interface VersionCanvasProps {
  doc: Document;
  pageId: NodeId;
  images?: Images;
  /** Controlled viewport; without it the canvas keeps its own, fitted to the page at first. */
  viewport?: Viewport | null;
  onViewport?: (viewport: Viewport, size: Size) => void;
  highlights?: readonly Highlight[];
  /** For the overlay comparison. */
  opacity?: number;
  label: string;
  /** Lets pointer events through (the upper canvas of an overlay). */
  passThrough?: boolean;
  className?: string;
}

export function VersionCanvas({ doc, pageId, images, viewport, onViewport, highlights, opacity = 1, label, passThrough, className }: VersionCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [own, setOwn] = useState<Viewport | null>(null);
  const [fontsTick, setFontsTick] = useState(0);
  const [imagesTick, setImagesTick] = useState(0);
  const view = viewport ?? own;
  const latest = useRef({ view, size, onViewport });
  latest.current = { view, size, onViewport };

  const setView = (next: Viewport): void => {
    if (viewport === undefined) setOwn(next);
    latest.current.onViewport?.(next, latest.current.size);
  };
  const setViewRef = useRef(setView);
  setViewRef.current = setView;

  // The canvas follows the size of where it is.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = (): void => {
      const rect = host.getBoundingClientRect();
      setSize((current) => (current.width === Math.floor(rect.width) && current.height === Math.floor(rect.height) ? current : { width: Math.floor(rect.width), height: Math.floor(rect.height) }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Fitted to the page the first time there is a size, and when the page changes, unless someone else moves it.
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    if (viewport === undefined) setOwn(fitPage(doc, pageId, size));
    else if (viewport === null) setViewRef.current(fitPage(doc, pageId, size));
    // Only the page and the first size decide this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, size.width > 0 && size.height > 0]);

  useEffect(() => onFontsLoaded(() => setFontsTick((tick) => tick + 1)), []);
  useEffect(() => (images?.onChange ? images.onChange(() => setImagesTick((tick) => tick + 1)) : undefined), [images]);

  // Drawn whenever anything it shows changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || size.width === 0 || size.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx || !doc.nodes[pageId]) return;
    renderScene(ctx, doc, pageId, {
      size,
      dpr,
      viewport: view,
      measurer: getBrowserMeasurer() ?? undefined,
      images,
      createCanvas: (w, h) => {
        const scratch = document.createElement('canvas');
        scratch.width = w;
        scratch.height = h;
        return scratch;
      },
    });
    // What differs, outlined over the drawing.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const highlight of highlights ?? []) {
      if (!doc.nodes[highlight.id] || highlight.id === pageId) continue;
      const bounds = getWorldBounds(doc, highlight.id);
      const a = worldToScreen(view, { x: bounds.x, y: bounds.y });
      const b = worldToScreen(view, { x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      ctx.strokeStyle = TONES[highlight.tone];
      ctx.lineWidth = highlight.tone === 'focus' ? 2 : 1.5;
      ctx.setLineDash(highlight.tone === 'removed' ? [4, 3] : []);
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.max(1, Math.round(b.x - a.x)), Math.max(1, Math.round(b.y - a.y)));
    }
    ctx.setLineDash([]);
  }, [doc, pageId, view, size, images, highlights, fontsTick, imagesTick]);

  // Panning by dragging, and by the wheel; zooming with Ctrl (or a pinch) and the wheel.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || passThrough) return;
    const onWheel = (event: WheelEvent): void => {
      const current = latest.current.view;
      if (!current) return;
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        setViewRef.current(zoomAt(current, point, clampZoom(current.zoom * Math.exp(-event.deltaY * 0.01))));
      } else setViewRef.current(panBy(current, event.shiftKey ? event.deltaY : event.deltaX, event.shiftKey ? 0 : event.deltaY));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [passThrough]);

  const drag = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={hostRef}
      className={`relative min-h-0 min-w-0 overflow-hidden ${passThrough ? 'pointer-events-none' : 'cursor-grab active:cursor-grabbing'} ${className ?? ''}`}
      style={{ opacity }}
      onPointerDown={(event) => {
        if (passThrough) return;
        drag.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const from = drag.current;
        const current = latest.current.view;
        if (!from || !current) return;
        drag.current = { x: event.clientX, y: event.clientY };
        setViewRef.current(panBy(current, event.clientX - from.x, event.clientY - from.y));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} className="absolute inset-0 block h-full w-full" />
    </div>
  );
}

/** Zooms a viewport to a layer: what clicking a difference in the list does. */
export function zoomToLayer(doc: Document, id: NodeId, size: Size): Viewport | null {
  if (!doc.nodes[id] || size.width === 0) return null;
  return fitRect(getWorldBounds(doc, id), size, 96, 4);
}
