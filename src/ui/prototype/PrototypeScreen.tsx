import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clearGuest, currentAuth } from '../../collab/account';
import { api as defaultApi, errorMessage, type EvoraApi } from '../../collab/api';
import { linkOrigin } from '../../collab/endpoint';
import { cloudAssetLoader, loadSharedDocument } from '../../collab/live';
import type { LinkAccess } from '../../collab/protocol';
import type { StoredAsset } from '../../persistence/storage';
import { AccountDialog } from '../collab/AccountDialog';
import { useAccount, useGuest } from '../collab/hooks';
import { GuestPrompt } from '../collab/Screens';
import { copyPrototypeLink, planPrototypeLink, refusalNotice, SHARE_FIRST_REASON } from './links';
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
import { Icon, Logo } from '../components/Icon';

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

/**
 * The look of the presentation, Framer's way: the screen floats on the dark
 * ground under a soft light, and a device is a dark shell whose edge
 * catches that light. The shell is the device's own colour, the same in
 * both themes.
 */
const DEVICE_SHELL = {
  background: 'linear-gradient(180deg, #2a2a2e 0%, #121214 55%, #0c0c0e 100%)',
  boxShadow:
    'inset 0 1px 0 rgba(255,255,255,0.16), inset 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 1px rgba(0,0,0,0.7), 0 2px 6px rgba(0,0,0,0.35), 0 44px 96px -32px rgba(0,0,0,0.8)',
};
const SCREEN_SHADOW = '0 0 0 1px rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.3), 0 36px 90px -30px rgba(0,0,0,0.75)';

/** Line glyphs for the presentation's controls, drawn on the editor icons' 16px grid. */
const GLYPHS = {
  chevronLeft: ['M10 3.5L5.5 8 10 12.5'],
  arrowLeft: ['M13 8H3.5M7.5 4L3.5 8l4 4'],
  restart: ['M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.83L2 5.33', 'M2 2v3.33h3.33'],
  link: ['M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71l-1.15 1.14', 'M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14'],
} as const;

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {GLYPHS[name].map((d) => (
        <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/** A hairline between groups of controls in the bar. */
function Divider() {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px flex-none bg-line" />;
}

interface PrototypeScreenProps {
  storage: DocumentStorage;
  /** The file on this device, or the shared document's ID on the collaboration server. */
  fileId: string;
  /** The frame to start on, when the link names one. */
  startId?: string;
  /** Leaves the presentation: back to the file's editor. */
  onExit: () => void;
  /**
   * Where the file comes from: this device (`#/proto/<file>`, the default),
   * or the collaboration server (`#/doc/<id>/present`), read as it is there
   * now, for anyone the file's access lets open it.
   */
  source?: 'local' | 'shared';
  /** For a file on this device: back to its editor with the Share dialog open, so it can be shared and linked to. */
  onShare?: () => void;
  /** For a shared file that could not be opened: to the file browser. */
  onHome?: () => void;
  /** How a shared file is read (tests give their own). */
  loadShared?: (docId: string) => Promise<{ doc: Document; fromCache?: boolean }>;
  /** The collaboration API (tests give their own). */
  api?: EvoraApi;
}

/** Every flow of the document, with the page it is on. */
function allFlows(doc: Document): Flow[] {
  return getPages(doc).flatMap((page) => flowsOf(doc, page.id));
}

/** The loading and message screen: the mark, glowing, with what is happening under it. */
function Backdrop({ pulse, children }: { pulse: boolean; children: ReactNode }) {
  return (
    <main className="relative isolate flex h-full flex-col items-center justify-center gap-4 overflow-hidden bg-bg px-6 text-center">
      {/* A soft glow of the accent behind the mark. */}
      <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[360px] w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/10 blur-[80px]" />
      <span aria-hidden="true" className={`flex [filter:drop-shadow(0_10px_24px_color-mix(in_srgb,var(--ev-accent)_45%,transparent))] ${pulse ? 'motion-safe:animate-pulse' : ''}`}>
        <Logo size={40} />
      </span>
      {children}
    </main>
  );
}

export function PrototypeScreen(props: PrototypeScreenProps) {
  if (props.source === 'shared') return <SharedPrototypeScreen {...props} />;
  return <LocalPrototypeScreen {...props} />;
}

/** A file on this device, read from its storage. */
function LocalPrototypeScreen({ storage, fileId, startId, onExit, onShare }: PrototypeScreenProps) {
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

  const loadAsset = useCallback((hash: string) => storage.loadAsset(hash), [storage]);
  if (load.status === 'ready') return <Viewer loadAsset={loadAsset} doc={load.doc} startId={startId} onExit={onExit} target={{ kind: 'local', onShare }} />;
  return (
    <Backdrop pulse={load.status === 'loading'}>
      {load.status === 'loading' && <p className="m-0 text-dim">Opening prototype…</p>}
      {load.status === 'missing' && (
        <p className="m-0 max-w-md leading-[1.5]">
          This file does not exist on this device. A link to a file on a device opens only in the browser that holds the file; to show a prototype to others, share the file and copy its prototype link.
        </p>
      )}
      {load.status === 'error' && (
        <p role="alert" className="m-0 max-w-md leading-[1.5] text-danger">
          {load.message}
        </p>
      )}
      {load.status !== 'loading' && (
        <button type="button" className="ev-button !h-8 !px-4" onClick={onExit}>
          Back to files
        </button>
      )}
    </Backdrop>
  );
}

type SharedState =
  | { status: 'identify' }
  | { status: 'loading' }
  | { status: 'refused'; code: number; message: string }
  /** `fromCache`: the server could not be reached, so this is the copy kept on this device, perhaps out of date. */
  | { status: 'ready'; doc: Document; fromCache: boolean };

/** The status of a refusal from the server: its HTTP status, or 0 when it could not be reached. */
function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 0;
}

/**
 * A shared file (`#/doc/<id>/present`): read as it is on the collaboration
 * server now (with the changes this device made and has not sent yet), for
 * anyone who can open it: members of every role, and guests when its link
 * lets anyone view. Someone with neither an account nor a guest name is
 * first asked for one; someone refused is told why and what to do.
 */
function SharedPrototypeScreen({ storage, fileId: docId, startId, onExit, onHome, loadShared, api = defaultApi }: PrototypeScreenProps) {
  const account = useAccount();
  const guest = useGuest();
  const identity = account?.token ?? guest?.guestToken ?? null;
  const [load, setLoad] = useState<SharedState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [signIn, setSignIn] = useState(false);
  const [linkAccess, setLinkAccess] = useState<LinkAccess | null>(null);
  const accountToken = account?.token ?? null;

  useEffect(() => {
    if (identity === null) {
      setLoad({ status: 'identify' });
      return;
    }
    let cancelled = false;
    setLoad({ status: 'loading' });
    const read = loadShared ?? ((id: string) => loadSharedDocument(id, currentAuth()));
    read(docId)
      .then(async ({ doc, fromCache }) => {
        if (cancelled) return;
        await loadFonts([...bundledFonts(), ...fontsUsedBy(doc)]);
        if (cancelled) return;
        resetTextMeasurements();
        setLoad({ status: 'ready', doc, fromCache: fromCache === true });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const code = statusOf(error);
        // A guest name the server no longer knows (its data was reset, say) is forgotten, so a new one is asked for.
        if (code === 401 && accountToken === null) {
          clearGuest();
          return;
        }
        setLoad({ status: 'refused', code, message: errorMessage(error) });
      });
    // Who else the link opens for, said when it is copied; not knowing it stops nothing.
    api
      .getDocument(docId)
      .then((info) => !cancelled && setLinkAccess(info.linkAccess))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [docId, identity, attempt, loadShared, api, accountToken]);

  const loadAsset = useMemo(() => cloudAssetLoader({ docId, auth: currentAuth(), storage }), [docId, storage, identity]);
  const home = onHome ?? onExit;

  if (load.status === 'identify') return <GuestPrompt api={api} onReady={() => setAttempt((count) => count + 1)} onBack={home} />;
  if (load.status === 'ready') return <Viewer loadAsset={loadAsset} doc={load.doc} startId={startId} onExit={onExit} target={{ kind: 'shared', docId, linkAccess }} offline={load.fromCache} />;
  const notice = load.status === 'refused' ? refusalNotice(load.code, { signedIn: account !== null, name: account?.user.name ?? null }, load.code === 401 || load.code === 403 || load.code === 404 ? '' : load.message) : null;
  return (
    <Backdrop pulse={load.status === 'loading'}>
      {load.status === 'loading' && <p className="m-0 text-dim">Opening prototype…</p>}
      {notice && (
        <div role="alert" aria-label="Prototype not opened" className="flex max-w-md flex-col items-center gap-1.5">
          <p className="m-0 font-semibold text-ink">{notice.title}</p>
          <p className="m-0 leading-[1.5] text-dim">{notice.detail}</p>
        </div>
      )}
      {notice && (
        <div className="flex flex-wrap justify-center gap-2">
          {notice.offerSignIn && (
            <button type="button" className="ev-button ev-button-primary !h-8 !px-4" onClick={() => setSignIn(true)}>
              {account ? 'Sign in with another account' : 'Sign in'}
            </button>
          )}
          <button type="button" className="ev-button !h-8 !px-4" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </button>
          <button type="button" className="ev-button !h-8 !px-4" onClick={home}>
            Back to files
          </button>
        </div>
      )}
      {signIn && (
        <AccountDialog
          api={api}
          reason="Sign in with an account this file is shared with to view its prototype."
          onClose={() => setSignIn(false)}
          onDone={() => setAttempt((count) => count + 1)}
        />
      )}
    </Backdrop>
  );
}

/** Where the presentation's file is, which decides what its prototype link is. */
type LinkTarget = { kind: 'shared'; docId: string; linkAccess: LinkAccess | null } | { kind: 'local'; onShare?: () => void };

/** The card under the bar after "Copy prototype link": the link and who it opens for, or why there is none yet. */
type LinkCard = { kind: 'copied'; url: string; note: string; done: boolean } | { kind: 'share-first' } | null;

function Viewer({
  loadAsset,
  doc,
  startId,
  onExit,
  target,
  offline = false,
}: {
  loadAsset: (hash: string) => Promise<StoredAsset | null>;
  doc: Document;
  startId?: string;
  onExit: () => void;
  target: LinkTarget;
  /** The shared file is the copy kept on this device, as the server could not be reached: said in the bar. */
  offline?: boolean;
}) {
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
  // The screen's name is known before its first paint: the frame it starts on.
  const [screenName, setScreenName] = useState(() => (initial === null ? '' : (doc.nodes[initial]?.name ?? '')));
  const [canGoBack, setCanGoBack] = useState(false);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [room, setRoom] = useState({ width: 1, height: 1 });
  const [hints, setHints] = useState<Rect[]>([]);
  const [fullScreen, setFullScreen] = useState(false);
  const [card, setCard] = useState<LinkCard>(null);

  const images = useMemo(() => new ImageCache(loadAsset), [loadAsset]);
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
      // A modifier key on its own is not a key press yet: it waits for the key it is held with.
      if (event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift' || event.key === 'Meta' || event.key === 'AltGraph') return;
      // With modifiers held a key goes to the prototype ("Ctrl+K"); one it has no use for is left to the browser.
      if (player.key(event.key, event)) event.preventDefault();
      else if ((event.key === 'r' || event.key === 'R') && !event.ctrlKey && !event.metaKey && !event.altKey) player.restart();
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
      document.title = 'Evora';
    };
  }, [doc.name]);

  const at = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = (canvas.current as HTMLCanvasElement).getBoundingClientRect();
    return { x: (event.clientX - box.left) / scaleRef.current, y: (event.clientY - box.top) / scaleRef.current };
  };

  // A shared file's link opens for anyone its access allows; a file on this device's only in this browser.
  const clipboard = (): ((text: string) => Promise<void>) | undefined => (navigator.clipboard?.writeText ? (text) => navigator.clipboard.writeText(text) : undefined);
  const copyLink = (): void => {
    const plan = planPrototypeLink({ sharedId: target.kind === 'shared' ? target.docId : null, linkAccess: target.kind === 'shared' ? target.linkAccess : null, startId: start, origin: linkOrigin() });
    void copyPrototypeLink(plan, {
      writeText: clipboard(),
      said: (url, note, copied) => setCard({ kind: 'copied', url, note, done: copied }),
      shareFirst: () => setCard({ kind: 'share-first' }),
    });
  };
  // A link to a file on this device, which opens only in this browser.
  const copyLocalLink = (): void => {
    const url = `${window.location.origin}${window.location.pathname}#/proto/${doc.id}${start ? `/${start}` : ''}`;
    void copyPrototypeLink(
      { kind: 'link', url, audience: 'This link opens only in this browser, where the file is kept.' },
      { writeText: clipboard(), said: (copiedUrl, note, copied) => setCard({ kind: 'copied', url: copiedUrl, note, done: copied }), shareFirst: () => undefined },
    );
  };
  const frameChoices = useMemo(() => {
    const choices = flows.map((flow) => ({ id: flow.startId, name: flow.name }));
    if (start !== null && !choices.some((choice) => choice.id === start)) choices.push({ id: start, name: `From “${doc.nodes[start]?.name ?? 'frame'}”` });
    return choices;
  }, [flows, start, doc]);

  const bezel = device === 'PHONE' ? { padding: 12, borderRadius: 44 } : device === 'TABLET' ? { padding: 16, borderRadius: 32 } : device === 'DESKTOP' ? { padding: 10, borderRadius: 12 } : null;

  return (
    <div ref={root} className="flex h-full flex-col bg-bg">
      {!fullScreen && (
        // A quiet bar floating above the stage: leaving on the left, where you are in the middle, the controls on the right.
        // On a narrow window the controls wrap onto a second line rather than run off the edge.
        <header className="ev-dock mx-3 mt-3 flex flex-none flex-wrap items-center justify-end gap-1 !p-2" aria-label="Prototype controls">
          <button type="button" className="ev-button !h-7 flex-none !gap-0.5 !pl-1.5 !pr-2.5" onClick={onExit}>
            <Glyph name="chevronLeft" />
            Back to the editor
          </button>
          <Divider />
          {/* Where you are: the file, and the screen of it that is showing. It takes the room the controls leave. */}
          <div className="flex min-w-[96px] flex-1 items-center gap-1.5 px-1">
            <span className="min-w-0 truncate font-semibold text-ink">{doc.name}</span>
            {screenName && (
              <span aria-hidden="true" className="flex flex-none text-faint">
                <Icon name="chevronRight" size={12} />
              </span>
            )}
            <span role="status" aria-label="Current screen" className="min-w-0 truncate text-dim">
              {screenName}
            </span>
          </div>
          {offline && (
            <span role="status" aria-label="Offline" title="The server cannot be reached, so this may not be the latest version of the file." className="flex-none rounded-[6px] bg-hover px-2 py-0.5 text-[11px] text-dim">
              Offline: showing the copy kept on this device
            </span>
          )}
          {frameChoices.length > 0 && (
            <select aria-label="Flow" className="ev-field !w-32 flex-none" value={start ?? ''} onChange={(event) => setStart(event.currentTarget.value)}>
              {frameChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
          )}
          <select aria-label="Device" className="ev-field !w-[100px] flex-none" value={device} onChange={(event) => setDevice(event.currentTarget.value as PrototypeDevice)}>
            {PROTOTYPE_DEVICES.map((entry) => (
              <option key={entry} value={entry}>
                {DEVICE_LABELS[entry]}
              </option>
            ))}
          </select>
          <select aria-label="Scale" className="ev-field !w-[116px] flex-none" value={scaleMode} onChange={(event) => setScaleMode(event.currentTarget.value as Scale)}>
            {(Object.keys(SCALE_LABELS) as Scale[]).map((entry) => (
              <option key={entry} value={entry}>
                {SCALE_LABELS[entry]}
              </option>
            ))}
          </select>
          <Divider />
          <button type="button" className="ev-button !h-7 flex-none !gap-1 !pl-1.5 !pr-2.5" disabled={!canGoBack} onClick={() => player?.back()}>
            <Glyph name="arrowLeft" />
            Back
          </button>
          <button type="button" className="ev-button !h-7 flex-none !gap-1 !pl-1.5 !pr-2.5" title="Start again (R)" onClick={() => player?.restart()}>
            <Glyph name="restart" />
            Restart
          </button>
          <Divider />
          <button
            type="button"
            className="ev-button ev-button-primary !h-7 flex-none !gap-1 !pl-2 !pr-2.5"
            title={target.kind === 'shared' ? 'A link that opens this prototype, from the frame showing in Flow' : 'Prototype links for others need the file to be shared first'}
            onClick={copyLink}
          >
            <Glyph name="link" />
            Copy prototype link
          </button>
          <button type="button" className="ev-button !h-7 flex-none !gap-1 !pl-2 !pr-2.5" onClick={() => void root.current?.requestFullscreen?.()}>
            <Icon name="corners" size={14} />
            Full screen
          </button>
        </header>
      )}
      {card && !fullScreen && (
        // What was copied, or why nothing was, in a card that drops in under the bar.
        <div role="status" aria-label="Prototype link" className="ev-popover mx-auto mt-2 flex w-[min(760px,calc(100%-24px))] flex-none flex-wrap items-center gap-2 py-1.5 pl-3 pr-1.5 text-dim">
          {card.kind === 'copied' ? (
            <>
              <span className="min-w-0 flex-1 truncate text-ink" title={card.url}>
                {card.done ? 'Link copied: ' : 'Copy this link: '}
                <span className="select-all">{card.url}</span>
              </span>
              <span className="min-w-0 basis-full text-[11px] sm:basis-auto">{card.note}</span>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 leading-[1.4] text-ink">{SHARE_FIRST_REASON}</span>
              {target.kind === 'local' && target.onShare && (
                <button type="button" className="ev-button ev-button-primary !h-6 flex-none !rounded-[7px] !px-2.5 text-[11px]" onClick={target.onShare}>
                  Share this file…
                </button>
              )}
              <button type="button" className="ev-button !h-6 flex-none !rounded-[7px] !px-2.5 text-[11px]" onClick={copyLocalLink}>
                Copy a link for this browser
              </button>
            </>
          )}
          <button type="button" className="ev-button !h-6 flex-none !rounded-[7px] !px-2.5 text-[11px]" onClick={() => setCard(null)}>
            Dismiss
          </button>
        </div>
      )}
      {/* The stage: the prototype centred on the dark ground, under a faint pool of light. */}
      <div ref={area} className="flex min-h-0 flex-1 overflow-auto bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--ev-panel)_75%,transparent),transparent_70%)] p-6">
        {player === null ? (
          <p className="m-auto max-w-sm text-center leading-[1.5] text-dim">This file has no frame to show. Draw a frame in the editor, then present again.</p>
        ) : (
          <div className="relative m-auto flex-none" style={bezel ? { ...bezel, ...DEVICE_SHELL } : { boxShadow: SCREEN_SHADOW }} data-device={device}>
            <div className="relative overflow-hidden" style={bezel ? { borderRadius: bezel.borderRadius - bezel.padding, boxShadow: '0 0 0 1px rgba(0,0,0,0.6)' } : undefined}>
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
                  style={{ left: hint.x * scale, top: hint.y * scale, width: hint.width * scale, height: hint.height * scale, background: 'color-mix(in srgb, var(--ev-accent) 28%, transparent)', outline: '1px solid var(--ev-accent)' }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

