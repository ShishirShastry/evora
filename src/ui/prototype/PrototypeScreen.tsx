import { useEffect, useMemo, useRef, useState } from 'react';
import {
  approximateMeasurer,
  DEVICE_SIZES,
  FileFormatError,
  flowsOf,
  getPageIdOf,
  getPages,
  isLayer,
  isPage,
  Player,
  PROTOTYPE_DEVICES,
  STAGE_ID,
  startFrame,
  type Document,
  type Flow,
  type NodeId,
  type PrototypeDevice,
  type Rect,
} from '../../core';
import { ImageCache } from '../../engine/images/imageCache';
import { renderScene } from '../../engine/render/scene';
import { bundledFonts, fontsUsedBy, loadFonts } from '../../engine/text/fonts';
import { getBrowserMeasurer, resetTextMeasurements } from '../../engine/text/measure';
import { openFile } from '../../persistence/files';
import type { DocumentStorage } from '../../persistence/storage';
import { Logo } from '../components/Icon';

/**
 * Presentation: plays the prototype of a file in the browser. The player
 * (core) decides what is shown and what an interaction does; this screen
 * paints its stage with the editor's own renderer, tells it where the
 * pointer is and what was pressed, and has the controls round it: the flow,
 * the device, the scale, full screen and the link.
 */

const DEVICE_LABELS: Record<PrototypeDevice, string> = { NONE: 'No device', PHONE: 'Phone', TABLET: 'Tablet', DESKTOP: 'Desktop' };
type Scale = 'FIT' | 'WIDTH' | 'ACTUAL';
const SCALE_LABELS: Record<Scale, string> = { FIT: 'Fit to window', WIDTH: 'Fit width', ACTUAL: 'Actual size' };

type LoadState = { status: 'loading' } | { status: 'missing' } | { status: 'error'; message: string } | { status: 'ready'; doc: Document };

interface PrototypeScreenProps {
  storage: DocumentStorage;
  fileId: string;
  /** The frame to start on, when the link names one. */
  startId?: string;
  onExit: () => void;
}

/** Every flow of the document, with the page it is on. */
function allFlows(doc: Document): Flow[] {
  return getPages(doc).flatMap((page) => flowsOf(doc, page.id));
}

export function PrototypeScreen({ storage, fileId, startId, onExit }: PrototypeScreenProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    openFile(storage, fileId)
      .then(async (opened) => {
        if (cancelled) return;
        if (!opened) {
          setLoad({ status: 'missing' });
          return;
        }
        await loadFonts([...bundledFonts(), ...fontsUsedBy(opened.doc)]);
        if (cancelled) return;
        resetTextMeasurements();
        setLoad({ status: 'ready', doc: opened.doc });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoad({ status: 'error', message: error instanceof FileFormatError ? error.message : `The file could not be opened. ${error instanceof Error ? error.message : ''}` });
      });
    return () => {
      cancelled = true;
    };
  }, [storage, fileId]);

  if (load.status === 'ready') return <Viewer storage={storage} doc={load.doc} startId={startId} onExit={onExit} />;
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <Logo size={40} />
      {load.status === 'loading' && <p className="m-0 text-dim">Opening prototype…</p>}
      {load.status === 'missing' && <p className="m-0">This file does not exist on this device. A prototype link opens in the browser that holds the file.</p>}
      {load.status === 'error' && (
        <p role="alert" className="m-0 max-w-md text-danger">
          {load.message}
        </p>
      )}
      {load.status !== 'loading' && (
        <button type="button" className="od-button" onClick={onExit}>
          Back to files
        </button>
      )}
    </main>
  );
}

function Viewer({ storage, doc, startId, onExit }: { storage: DocumentStorage; doc: Document; startId?: string; onExit: () => void }) {
  const flows = useMemo(() => allFlows(doc), [doc]);
  // Where to start: the frame the link names, or the first flow, or the first frame of the first page that has one.
  const initial = useMemo<NodeId | null>(() => {
    const named = startId === undefined ? undefined : doc.nodes[startId];
    if (isLayer(named) && named.type === 'FRAME') return named.id;
    if (flows[0]) return flows[0].startId;
    for (const page of getPages(doc)) {
      const frame = startFrame(doc, page.id);
      if (frame) return frame;
    }
    return null;
  }, [doc, startId, flows]);
  const [start, setStart] = useState<NodeId | null>(initial);
  const pageOf = (frameId: NodeId | null): PrototypeDevice => {
    const pageId = frameId === null ? null : getPageIdOf(doc, frameId);
    const page = pageId === null ? undefined : doc.nodes[pageId];
    return isPage(page) ? page.prototypeDevice : 'NONE';
  };
  const [device, setDevice] = useState<PrototypeDevice>(() => pageOf(initial));
  const [scaleMode, setScaleMode] = useState<Scale>('FIT');
  const [screenName, setScreenName] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [room, setRoom] = useState({ width: 1, height: 1 });
  const [hints, setHints] = useState<Rect[]>([]);
  const [fullScreen, setFullScreen] = useState(false);
  const [copied, setCopied] = useState('');

  const images = useMemo(() => new ImageCache((hash) => storage.loadAsset(hash)), [storage]);
  const measurer = useMemo(() => getBrowserMeasurer() ?? undefined, []);
  const player = useMemo(() => {
    if (start === null) return null;
    const made = new Player({ doc, startId: start, measurer: measurer ?? approximateMeasurer, viewport: device === 'NONE' ? null : DEVICE_SIZES[device] });
    made.advance(performance.now());
    made.restart();
    return made;
  }, [doc, start, device, measurer]);

  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  // How much room there is for the screen.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const measure = (): void => setRoom({ width: Math.max(1, element.clientWidth - 48), height: Math.max(1, element.clientHeight - 48) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = scaleMode === 'ACTUAL' ? 1 : scaleMode === 'WIDTH' ? room.width / size.width : Math.min(1, room.width / size.width, room.height / size.height);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Painting: every frame the player is told the time; the stage is painted when it has changed.
  useEffect(() => {
    const element = canvas.current;
    if (!player || !element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    let frame = 0;
    let painted: { stage: Document; scale: number; dpr: number } | null = null;
    const unsubscribe = images.onChange(() => {
      painted = null;
    });
    // A button of a gamepad counts as a key, named Gamepad0, Gamepad1 and so on, when it goes down.
    const held = new Set<string>();
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      player.advance(performance.now());
      // Links the prototype asked to open, in a tab of their own; only addresses that go somewhere, nothing that runs.
      for (const url of player.links.splice(0)) if (/^(https?:\/\/|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad) continue;
        pad.buttons.forEach((padButton, index) => {
          const id = pad.index + ":" + index;
          if (padButton.pressed && !held.has(id)) {
            held.add(id);
            player.key("Gamepad" + index);
          } else if (!padButton.pressed) held.delete(id);
        });
      }
      const stage = player.stage();
      const now = player.size;
      const dpr = window.devicePixelRatio || 1;
      const zoom = scaleRef.current;
      if (painted && painted.stage === stage && painted.scale === zoom && painted.dpr === dpr) return;
      const width = Math.max(1, Math.round(now.width * zoom));
      const height = Math.max(1, Math.round(now.height * zoom));
      if (element.width !== Math.round(width * dpr) || element.height !== Math.round(height * dpr)) {
        element.width = Math.round(width * dpr);
        element.height = Math.round(height * dpr);
        element.style.width = `${width}px`;
        element.style.height = `${height}px`;
      }
      renderScene(ctx, stage, STAGE_ID, {
        size: { width, height },
        dpr,
        viewport: { x: 0, y: 0, zoom },
        measurer,
        images,
        createCanvas: (w, h) => {
          const scratch = document.createElement('canvas');
          scratch.width = w;
          scratch.height = h;
          return scratch;
        },
      });
      painted = { stage, scale: zoom, dpr };
      setSize((current) => (current.width === now.width && current.height === now.height ? current : now));
      const screen = player.doc.nodes[player.screenId];
      setScreenName(screen?.name ?? '');
      setCanGoBack(player.canGoBack);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [player, images, measurer]);

  // Keys go to the prototype first; R starts it again when the prototype has no use for it.
  useEffect(() => {
    if (!player) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'SELECT' || target.tagName === 'INPUT' || target.tagName === 'BUTTON') && event.key !== 'Escape') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (player.key(event.key)) event.preventDefault();
      else if (event.key === 'r' || event.key === 'R') player.restart();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);

  useEffect(() => {
    const onChange = (): void => setFullScreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    document.title = `${doc.name} – Prototype`;
    return () => {
      document.title = 'OPEN DESIGN';
    };
  }, [doc.name]);

  const at = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = (canvas.current as HTMLCanvasElement).getBoundingClientRect();
    return { x: (event.clientX - box.left) / scaleRef.current, y: (event.clientY - box.top) / scaleRef.current };
  };

  const link = `${window.location.origin}${window.location.pathname}#/proto/${doc.id}${start ? `/${start}` : ''}`;
  const frameChoices = useMemo(() => {
    const choices = flows.map((flow) => ({ id: flow.startId, name: flow.name }));
    if (start !== null && !choices.some((choice) => choice.id === start)) choices.push({ id: start, name: `From “${doc.nodes[start]?.name ?? 'frame'}”` });
    return choices;
  }, [flows, start, doc]);

  const bezel = device === 'PHONE' ? { padding: 12, borderRadius: 44 } : device === 'TABLET' ? { padding: 16, borderRadius: 32 } : device === 'DESKTOP' ? { padding: 10, borderRadius: 12 } : null;

  return (
    <div ref={root} className="flex h-full flex-col bg-bg">
      {!fullScreen && (
        <header className="flex h-11 flex-none items-center gap-2 border-b border-line bg-panel px-2" aria-label="Prototype controls">
          <button type="button" className="od-button !h-[28px] flex-none !px-2" onClick={onExit}>
            Back to the editor
          </button>
          <span className="min-w-0 truncate font-medium">{doc.name}</span>
          <span role="status" aria-label="Current screen" className="min-w-0 truncate text-dim">
            {screenName}
          </span>
          <div className="flex-1" />
          {frameChoices.length > 0 && (
            <select aria-label="Flow" className="od-field w-40 flex-none" value={start ?? ''} onChange={(event) => setStart(event.currentTarget.value)}>
              {frameChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
          )}
          <select aria-label="Device" className="od-field w-28 flex-none" value={device} onChange={(event) => setDevice(event.currentTarget.value as PrototypeDevice)}>
            {PROTOTYPE_DEVICES.map((entry) => (
              <option key={entry} value={entry}>
                {DEVICE_LABELS[entry]}
              </option>
            ))}
          </select>
          <select aria-label="Scale" className="od-field w-32 flex-none" value={scaleMode} onChange={(event) => setScaleMode(event.currentTarget.value as Scale)}>
            {(Object.keys(SCALE_LABELS) as Scale[]).map((entry) => (
              <option key={entry} value={entry}>
                {SCALE_LABELS[entry]}
              </option>
            ))}
          </select>
          <button type="button" className="od-button !h-[28px] flex-none !px-2" disabled={!canGoBack} onClick={() => player?.back()}>
            Back
          </button>
          <button type="button" className="od-button !h-[28px] flex-none !px-2" title="Start again (R)" onClick={() => player?.restart()}>
            Restart
          </button>
          <button
            type="button"
            className="od-button !h-[28px] flex-none !px-2"
            title="This link opens the prototype in this browser, where the file is kept"
            onClick={() => {
              const done = (): void => setCopied('Link copied');
              if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, () => setCopied(link));
              else setCopied(link);
            }}
          >
            Copy link
          </button>
          <button type="button" className="od-button !h-[28px] flex-none !px-2" onClick={() => void root.current?.requestFullscreen?.()}>
            Full screen
          </button>
        </header>
      )}
      {copied && !fullScreen && (
        <div role="status" aria-label="Prototype link" className="flex flex-none items-center gap-2 border-b border-line bg-field px-3 py-1.5 text-dim">
          <span className="min-w-0 flex-1 truncate">{copied === 'Link copied' ? `Link copied: ${link}` : copied}</span>
          <span className="flex-none">It opens in this browser, where the file is kept.</span>
          <button type="button" className="od-button !h-[24px] flex-none !px-2" onClick={() => setCopied('')}>
            Dismiss
          </button>
        </div>
      )}
      <div ref={area} className="flex min-h-0 flex-1 overflow-auto p-6">
        {player === null ? (
          <p className="m-auto text-dim">This file has no frame to show. Draw a frame in the editor, then present again.</p>
        ) : (
          <div className="relative m-auto flex-none" style={bezel ? { ...bezel, background: '#111', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' } : { boxShadow: '0 8px 40px rgba(0,0,0,0.35)' }} data-device={device}>
            <div className="relative overflow-hidden" style={bezel ? { borderRadius: bezel.borderRadius - bezel.padding } : undefined}>
              <canvas
                ref={canvas}
                role="application"
                aria-label="Prototype"
                tabIndex={0}
                className="block touch-none outline-none"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  player.pointerDown(at(event));
                }}
                onPointerMove={(event) => player.pointerMove(at(event))}
                onPointerUp={(event) => {
                  const before = player.missedAt;
                  player.pointerUp(at(event));
                  // A click that found nothing to do shows, for a moment, where a click does something.
                  if (player.missedAt !== before) {
                    setHints(player.hotspots());
                    window.setTimeout(() => setHints([]), 500);
                  }
                }}
                onPointerLeave={() => player.pointerLeave()}
                onWheel={(event) => player.wheel(at(event), event.deltaX / scaleRef.current, event.deltaY / scaleRef.current)}
              />
              {hints.map((hint, index) => (
                <div
                  key={index}
                  aria-hidden
                  className="pointer-events-none absolute rounded-sm"
                  style={{ left: hint.x * scale, top: hint.y * scale, width: hint.width * scale, height: hint.height * scale, background: 'rgba(25,194,179,0.3)', outline: '1px solid rgba(25,194,179,0.9)' }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

