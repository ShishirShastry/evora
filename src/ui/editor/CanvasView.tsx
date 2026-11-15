import { useEffect, useRef, useState } from 'react';
import { InteractionController, type PointerInput } from '../../engine/input/controller';
import { renderOverlay } from '../../engine/render/overlay';
import { renderScene } from '../../engine/render/scene';
import { getBrowserMeasurer } from '../../engine/text/measure';
import { zoomToFit } from '../../state/commands';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { useEditor, useEditorContext } from './EditorContext';
import { canvasMenu, layerMenu } from './menus';
import { TextEditor } from './TextEditor';

const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_DISTANCE = 6;

function toPointer(event: PointerEvent | MouseEvent, rect: DOMRect): PointerInput {
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    button: event.button,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey || event.metaKey,
    detail: event.detail,
  };
}

/**
 * Hosts the two canvases (design and overlay), feeds input to the interaction
 * controller and repaints when the store changes. It holds no design state.
 */
export function CanvasView() {
  const context = useEditorContext();
  const { store } = context;
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const editingTextId = useEditor((s) => s.editingTextId);

  useEffect(() => {
    const host = hostRef.current;
    const scene = sceneRef.current;
    const overlay = overlayRef.current;
    if (!host || !scene || !overlay) return;
    const sceneCtx = scene.getContext('2d');
    const overlayCtx = overlay.getContext('2d');
    if (!sceneCtx || !overlayCtx) return;

    let frame = 0;
    let dpr = window.devicePixelRatio || 1;
    let lastScene: { nodes: unknown; pageId: string; viewport: unknown; width: number; height: number; dpr: number; editing: string | null } | null = null;
    const measurer = getBrowserMeasurer() ?? undefined;
    // Pages that already have a viewport; a page seen for the first time is zoomed to fit.
    const visited = new Set(Object.keys(store.getState().viewports));

    const controller = new InteractionController(store, {
      requestRender: () => schedule(),
      setCursor: (cursor) => {
        overlay.style.cursor = cursor;
      },
    });
    context.controller.current = controller;

    const paint = (): void => {
      frame = 0;
      const state = store.getState();
      const size = state.canvasSize;
      if (size.width === 0 || size.height === 0) return;
      const sceneKey = {
        nodes: state.doc.nodes,
        pageId: state.pageId,
        viewport: state.viewport,
        width: size.width,
        height: size.height,
        dpr,
        editing: state.editingTextId,
      };
      const sceneChanged =
        !lastScene ||
        lastScene.nodes !== sceneKey.nodes ||
        lastScene.pageId !== sceneKey.pageId ||
        lastScene.viewport !== sceneKey.viewport ||
        lastScene.width !== sceneKey.width ||
        lastScene.height !== sceneKey.height ||
        lastScene.dpr !== sceneKey.dpr ||
        lastScene.editing !== sceneKey.editing;
      if (sceneChanged) {
        renderScene(sceneCtx, state.doc, state.pageId, {
          size,
          dpr,
          viewport: state.viewport,
          measurer,
          // The text being edited is shown by the in-place editor instead.
          hiddenIds: state.editingTextId ? new Set([state.editingTextId]) : undefined,
          createCanvas: (w, h) => {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            return canvas;
          },
        });
        lastScene = sceneKey;
      }
      const result = renderOverlay(overlayCtx, {
        doc: state.doc,
        pageId: state.pageId,
        viewport: state.viewport,
        size,
        dpr,
        selection: state.selection,
        hoveredId: state.hoveredId,
        marquee: controller.marquee,
        guides: controller.guides,
        showHandles: !controller.isTransforming && state.editingTextId === null,
      });
      controller.labels = result.labels;
    };

    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };

    const resize = (): void => {
      const rect = host.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      for (const canvas of [scene, overlay]) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      const first = store.getState().canvasSize.width === 0;
      store.getState().setCanvasSize({ width, height });
      if (first) showPage(store.getState().pageId);
      lastScene = null;
      schedule();
    };

    const showPage = (pageId: string): void => {
      if (visited.has(pageId)) return;
      visited.add(pageId);
      zoomToFit(store);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const unsubscribe = store.subscribe((state, previous) => {
      if (state.pageId !== previous.pageId && state.canvasSize.width > 0) showPage(state.pageId);
      if (state.tool !== previous.tool && !controller.isBusy) overlay.style.cursor = controller.idleCursor();
      schedule();
    });

    const rectOf = (): DOMRect => overlay.getBoundingClientRect();

    // Pointer events do not carry a click count (their `detail` is always 0),
    // so double-clicks are recognised here: a second press of the same button
    // soon after the first and in nearly the same place.
    let lastPress = { time: -Infinity, x: 0, y: 0, button: -1, count: 0 };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button === 2) return;
      // Leave any focused text field so its value is committed before the edit.
      (document.activeElement as HTMLElement | null)?.blur?.();
      overlay.setPointerCapture(event.pointerId);
      if (event.button === 1) event.preventDefault();
      const input = toPointer(event, rectOf());
      const repeat =
        event.button === lastPress.button &&
        event.timeStamp - lastPress.time < DOUBLE_CLICK_MS &&
        Math.hypot(input.x - lastPress.x, input.y - lastPress.y) < DOUBLE_CLICK_DISTANCE;
      input.detail = repeat ? lastPress.count + 1 : 1;
      lastPress = { time: event.timeStamp, x: input.x, y: input.y, button: event.button, count: input.detail };
      controller.pointerDown(input);
    };
    const onPointerMove = (event: PointerEvent): void => controller.pointerMove(toPointer(event, rectOf()));
    const onPointerUp = (event: PointerEvent): void => {
      if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
      controller.pointerUp(toPointer(event, rectOf()));
    };
    const onPointerCancel = (): void => void controller.cancel();
    const onPointerLeave = (): void => controller.pointerLeave();
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = rectOf();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      controller.wheel({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        deltaX: event.deltaX * scale,
        deltaY: event.deltaY * scale,
        ctrlKey: event.ctrlKey || event.metaKey,
        shiftKey: event.shiftKey,
      });
    };
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      if (controller.isBusy) return;
      const target = controller.contextTarget(toPointer(event, rectOf()));
      const env = { store, app: context.app };
      const state = store.getState();
      const items = target || state.selection.length > 0 ? layerMenu(env, state) : canvasMenu(env, state);
      setMenu({ x: event.clientX, y: event.clientY, items });
    };

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', onPointerCancel);
    overlay.addEventListener('pointerleave', onPointerLeave);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    overlay.addEventListener('contextmenu', onContextMenu);

    return () => {
      observer.disconnect();
      unsubscribe();
      if (frame !== 0) cancelAnimationFrame(frame);
      overlay.removeEventListener('pointerdown', onPointerDown);
      overlay.removeEventListener('pointermove', onPointerMove);
      overlay.removeEventListener('pointerup', onPointerUp);
      overlay.removeEventListener('pointercancel', onPointerCancel);
      overlay.removeEventListener('pointerleave', onPointerLeave);
      overlay.removeEventListener('wheel', onWheel);
      overlay.removeEventListener('contextmenu', onContextMenu);
      controller.cancel();
      if (context.controller.current === controller) context.controller.current = null;
    };
  }, [store, context]);

  return (
    <div ref={hostRef} className="relative h-full min-w-0 flex-1 overflow-hidden bg-bg">
      <canvas ref={sceneRef} className="absolute left-0 top-0 block" aria-hidden="true" />
      <canvas
        ref={overlayRef}
        className="absolute left-0 top-0 block touch-none outline-none"
        role="application"
        aria-label="Design canvas"
        tabIndex={0}
      />
      {editingTextId && (
        <TextEditor key={editingTextId} id={editingTextId} onDone={() => overlayRef.current?.focus({ preventScroll: true })} />
      )}
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="Canvas menu" onClose={() => setMenu(null)} />}
    </div>
  );
}
