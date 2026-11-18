/**
 * Evora's desktop application (Phase 10): the web app in a native window, on
 * Windows, macOS and Linux, working fully offline.
 *
 * - The built app (dist/) is served from app://evora/ (electron/appProtocol.ts);
 *   `npm run desktop` loads Vite's development server instead (EVORA_DEV_URL).
 * - Windows are isolated: context isolation, the sandbox, no Node in pages, a
 *   strict Content-Security-Policy, navigation and new windows kept to the app
 *   (web links open in the system's browser), permissions refused unless listed.
 * - Files on disk: Open, Save, Save as, a copy as .fig, files given on the
 *   command line, by double-click (file associations), by a drop on the window
 *   or the dock, and by a second launch (one instance), Open Recent and the
 *   system's recent documents. Closing a window whose disk file has unsaved
 *   changes asks first; a copy is kept until it is saved and offered after a crash.
 * - Native menus wired to the app's commands; the collaboration server to work
 *   with, and a team server this computer can host; automatic updates.
 * - "Continue with Google" through the system's browser, coming back at
 *   evora://auth (electron/auth.ts).
 *
 * Environment: EVORA_DEV_URL (load a development server), EVORA_USER_DATA (the
 * data folder; the tests give each run its own).
 */
import { app, BrowserWindow, dialog, ipcMain, screen, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS, desktopCsp, normalizeServerUrl, type CloseAction, type DesktopInfo, type DiskLink, type DocState, type GoogleSignInResult, type NativeEdit, type RecoveryEntry, type SaveRequest, type ServerCheck } from '../src/persistence/desktopContract.js';
import { APP_ORIGIN, APP_URL, hasBuiltApp, registerAppScheme, serveApp } from './appProtocol.js';
import {
  AUTH_SCHEME,
  acceptReturn,
  authUrlInArgv,
  codeChallenge,
  googleDesktopStartUrl,
  newNonce,
  newVerifier,
  parseAuthUrl,
  redeemTicket,
  refusalMessage,
  refusalShown,
  type PendingSignIn,
  type RefusalReason,
} from './auth.js';
import { APP_ROOT } from './paths.js';
import {
  addRecent,
  clearRecovery,
  filesInArguments,
  grant,
  grantKnownPaths,
  linkByPath,
  linkFor,
  pendingRecoveries,
  readDiskFile,
  removeLink,
  saveFile,
  setLink,
  showOpenDialog,
  watchRecent,
  writeRecovery,
} from './files.js';
import { hostStatus, killHost, startHost, stopHost, watchHost } from './hostServer.js';
import { buildMenu, openProjectPage } from './menu.js';
import type { SpecialItem } from './menuSpec.js';
import { loadSettings, rememberWindow, saveSettings, savedWindowState } from './settings.js';
import { checkForUpdates, installUpdate, watchUpdates } from './updates.js';

const here = dirname(fileURLToPath(import.meta.url));

if (process.env.EVORA_USER_DATA) app.setPath('userData', resolve(process.env.EVORA_USER_DATA));
app.setAppUserModelId('org.evora.app');
registerAppScheme();

const DEV_URL = process.env.EVORA_DEV_URL ? new URL(process.env.EVORA_DEV_URL).origin : null;
/**
 * Set by the desktop tests (e2e/desktop.config.ts): windows open without taking the focus and
 * almost entirely off the screen, so a test run does not get in the way of the person at the
 * computer. Pages keep running at full speed there (no background throttling); the tests'
 * input does not depend on where the window is.
 */
const QUIET = process.env.EVORA_DESKTOP_E2E === '1';
const DIST = join(APP_ROOT, 'dist');
const PRELOAD = join(here, 'preload.cjs');

/** Only the app's own pages may use the bridge (a plugin's frame has none, and is not the app's origin). */
function fromApp(url: string): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`)) return true;
  return DEV_URL !== null && (url === DEV_URL || url.startsWith(`${DEV_URL}/`));
}

// ------------------------------------------------------------------ one instance

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

interface WindowRecord {
  window: BrowserWindow;
  doc: DocState | null;
  /** The page has its listeners (it asked for `info`). */
  ready: boolean;
  /** What waits for the page to be ready. */
  queue: Array<() => void>;
  allowClose: boolean;
  closing: boolean;
}

const records = new Map<number, WindowRecord>();
let quitting = false;
/** Files given before there was a window to open them in (macOS's open-file comes before ready). */
const filesAtStart: string[] = [];
let recoveriesAtStart: RecoveryEntry[] = [];

function recordOf(contents: WebContents): WindowRecord | null {
  for (const record of records.values()) if (!record.window.isDestroyed() && record.window.webContents === contents) return record;
  return null;
}

function whenReady(record: WindowRecord, action: () => void): void {
  if (record.ready) action();
  else record.queue.push(action);
}

function send(record: WindowRecord, channel: string, value?: unknown): void {
  whenReady(record, () => {
    if (!record.window.isDestroyed()) record.window.webContents.send(channel, value);
  });
}

function mainWindow(): WindowRecord | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    const record = records.get(focused.id);
    if (record) return record;
  }
  return [...records.values()][0] ?? null;
}

// ------------------------------------------------------------------ windows

/** Brings a window to the front, except in a test run (QUIET), which leaves the person's own windows in front. */
function bringForward(window: BrowserWindow): void {
  if (QUIET) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

/** In a test run: a place almost entirely off the bottom right of the main screen (a few pixels stay on it). */
function quietPlace(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - 8, y: area.y + area.height - 8 };
}

function createWindow(): WindowRecord {
  const place = QUIET ? { ...quietPlace(), width: 1440, height: 900, maximized: false } : savedWindowState();
  const window = new BrowserWindow({
    width: place?.width ?? 1440,
    height: place?.height ?? 900,
    x: place?.x,
    y: place?.y,
    skipTaskbar: QUIET,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Evora',
    backgroundColor: '#0b0b0d',
    // The Evora logo in the title bar and taskbar, also when running in development or unpacked (macOS takes the bundle's icon instead).
    icon: existsSync(join(APP_ROOT, 'build', 'icon.png')) ? join(APP_ROOT, 'build', 'icon.png') : undefined,
    autoHideMenuBar: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      // A test run's window is behind the person's own (QUIET): it must not be slowed down as hidden.
      backgroundThrottling: !QUIET,
    },
  });
  const record: WindowRecord = { window, doc: null, ready: false, queue: [], allowClose: false, closing: false };
  records.set(window.id, record);
  if (place?.maximized) window.maximize();
  // Shown once its page has painted (no white flash). Windows does not always paint a hidden window,
  // so 'ready-to-show' can fail to come at all (seen on 2026-11-18: the app ran with no window).
  // The page having loaded, or three seconds at the latest, also shows it.
  const reveal = (): void => {
    if (window.isDestroyed() || window.isVisible()) return;
    if (QUIET) window.showInactive();
    else window.show();
  };
  window.once('ready-to-show', reveal);
  window.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 3000).unref?.();

  // The window's title: the open file, with a mark while its disk file has unsaved changes.
  window.on('page-title-updated', (event) => {
    if (record.doc?.editor) event.preventDefault();
  });

  window.on('resize', () => rememberWindow(window));
  window.on('move', () => rememberWindow(window));
  window.on('close', (event) => onClose(record, event));
  window.on('closed', () => {
    records.delete(window.id);
    // A window closed normally: the copy kept for recovery is no longer needed.
    if (record.doc?.fileId) clearRecovery(record.doc.fileId);
  });

  const contents = window.webContents;
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      record.ready = false;
    }
  });
  contents.on('will-prevent-unload', (event) => {
    // The page asks to stay while its last change is written; the window waits for that itself (onClose), so it may go.
    event.preventDefault();
  });
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || window.isDestroyed()) return;
    record.ready = false;
    void dialog
      .showMessageBox(window, {
        type: 'error',
        message: 'Evora’s window stopped working.',
        detail: `(${details.reason}) Reload it to carry on: the file you had open is restored from what was saved automatically.`,
        buttons: ['Reload', 'Close window'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (window.isDestroyed()) return;
        if (response === 0) contents.reload();
        else {
          record.allowClose = true;
          window.close();
        }
      });
  });
  contents.on('unresponsive', () => {
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        message: 'Evora is not responding.',
        detail: 'You can wait for it, or reload the window. The file you had open is restored from what was saved automatically.',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(({ response }) => {
        if (response !== 1 || window.isDestroyed()) return;
        record.ready = false;
        contents.forcefullyCrashRenderer();
        contents.reload();
      });
  });

  void window.loadURL(DEV_URL ? `${DEV_URL}/` : APP_URL);
  return record;
}

/** Asks the page to write what it has (and, when chosen, to save its file to disk). Resolves with whether the window may close. */
let nextRequest = 1;
const waiting = new Map<number, (ok: boolean) => void>();

function askPage(record: WindowRecord, action: CloseAction): Promise<boolean> {
  if (!record.ready || record.window.isDestroyed() || record.window.webContents.isCrashed()) return Promise.resolve(action !== 'save');
  const requestId = nextRequest++;
  return new Promise<boolean>((resolvePromise) => {
    // A page that does not answer (it hangs) does not keep the window open, unless it was asked to save.
    const timer = setTimeout(() => finish(action !== 'save'), action === 'save' ? 10 * 60_000 : 5000);
    function finish(ok: boolean): void {
      clearTimeout(timer);
      waiting.delete(requestId);
      resolvePromise(ok);
    }
    waiting.set(requestId, finish);
    record.window.webContents.send(CHANNELS.prepareClose, { requestId, action });
  });
}

function onClose(record: WindowRecord, event: Electron.Event): void {
  if (record.allowClose) return;
  event.preventDefault();
  if (record.closing) return;
  record.closing = true;
  void (async () => {
    let action: CloseAction = 'flush';
    const doc = record.doc;
    if (doc?.editor && doc.dirty && doc.path) {
      bringForward(record.window);
      const { response } = await dialog.showMessageBox(record.window, {
        type: 'warning',
        message: `Save the changes to “${basename(doc.path)}” before closing?`,
        detail: 'If you do not save, the changes stay in Evora’s own files on this computer, but the file on disk keeps its last saved version.',
        buttons: ['Save', 'Don’t save', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 2) {
        record.closing = false;
        quitting = false;
        return;
      }
      action = response === 0 ? 'save' : 'discard';
    }
    const ok = await askPage(record, action);
    if (!ok) {
      record.closing = false;
      quitting = false;
      return;
    }
    record.allowClose = true;
    if (!record.window.isDestroyed()) {
      rememberWindow(record.window);
      record.window.close();
    }
  })();
}

// ------------------------------------------------------------------ opening files

function openPath(path: string, target: WindowRecord | null = mainWindow()): void {
  const full = resolve(path);
  grant(full);
  let file;
  try {
    file = readDiskFile(full);
  } catch (error) {
    void dialog.showMessageBox({ type: 'error', message: `${basename(full)} could not be opened.`, detail: error instanceof Error ? error.message : String(error) });
    return;
  }
  addRecent(full);
  const record = target ?? createWindow();
  bringForward(record.window);
  send(record, CHANNELS.openFile, file);
}

// ------------------------------------------------------------------ menus

function runSpecial(window: BrowserWindow | null, id: SpecialItem['id']): void {
  switch (id) {
    case 'newWindow':
      createWindow();
      return;
    case 'closeWindow':
      window?.close();
      return;
    case 'quit':
      app.quit();
      return;
    case 'checkUpdates':
      void checkForUpdates(true);
      return;
    case 'about': {
      const options = {
        type: 'info' as const,
        message: `Evora ${app.getVersion()}`,
        detail: `A free, open-source, local-first design tool. MIT licence.\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
        buttons: ['OK'],
      };
      if (window) void dialog.showMessageBox(window, options);
      else void dialog.showMessageBox(options);
      return;
    }
    case 'devtools':
      window?.webContents.toggleDevTools();
      return;
    case 'reload':
      if (window) {
        const record = records.get(window.id);
        void (record ? askPage(record, 'flush') : Promise.resolve(true)).then(() => {
          if (!window.isDestroyed()) window.webContents.reload();
        });
      }
      return;
    case 'fullscreen':
      window?.setFullScreen(!window.isFullScreen());
      return;
    case 'website':
      openProjectPage();
      return;
    case 'issues':
      openProjectPage('/issues');
      return;
    case 'dataFolder':
      void shell.openPath(app.getPath('userData'));
      return;
    case 'recent':
      return;
  }
}

function rebuildMenu(): void {
  buildMenu({
    command: (window, id) => {
      const record = window ? records.get(window.id) : mainWindow();
      if (record) send(record, CHANNELS.menu, id);
      else if (id === 'desktop.open' || id === 'desktop.new') send(createWindow(), CHANNELS.menu, id);
    },
    special: runSpecial,
    openRecent: (path) => openPath(path),
  });
}

// ------------------------------------------------------------------ the bridge

function handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: T) => R | Promise<R>): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event.senderFrame?.url ?? '')) throw new Error('Not allowed.');
    return listener(event, ...(args as T));
  });
}

function on<T extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: T) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!fromApp(event.senderFrame?.url ?? '')) return;
    listener(event, ...(args as T));
  });
}

const windowOf = (event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow | null => BrowserWindow.fromWebContents(event.sender);

async function checkServer(origin: string): Promise<ServerCheck> {
  const normalized = normalizeServerUrl(origin);
  if (!normalized) return { ok: false, version: null, message: 'That is not a server address.' };
  try {
    const response = await fetch(`${normalized}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, version: null, message: `It answered ${response.status}.` };
    const body = (await response.json()) as { ok?: unknown; version?: unknown };
    return body.ok === true ? { ok: true, version: typeof body.version === 'string' ? body.version : null, message: null } : { ok: false, version: null, message: 'It is not an Evora server.' };
  } catch (error) {
    return { ok: false, version: null, message: error instanceof Error ? error.message : String(error) };
  }
}

function registerBridge(): void {
  handle(CHANNELS.info, (event): DesktopInfo => {
    const record = recordOf(event.sender);
    if (record && !record.ready) {
      record.ready = true;
      for (const action of record.queue.splice(0)) action();
    }
    return { platform: process.platform, version: app.getVersion(), packaged: app.isPackaged };
  });
  handle(CHANNELS.openDialog, async (event) => {
    const path = await showOpenDialog(windowOf(event));
    if (!path) return null;
    addRecent(path);
    return readDiskFile(path);
  });
  handle(CHANNELS.readPath, (_event, path: string) => readDiskFile(String(path)));
  handle(CHANNELS.openDropped, (_event, path: string) => {
    // The preload found this path from a File the person dropped (webUtils.getPathForFile).
    grant(String(path));
    addRecent(String(path));
    return readDiskFile(String(path));
  });
  handle(CHANNELS.save, (event, request: SaveRequest) => saveFile(windowOf(event), request));
  handle(CHANNELS.linkFor, (_event, fileId: string) => linkFor(String(fileId)));
  handle(CHANNELS.linkByPath, (_event, path: string) => linkByPath(String(path)));
  handle(CHANNELS.setLink, (_event, link: DiskLink) => setLink(link));
  handle(CHANNELS.removeLink, (_event, fileId: string) => removeLink(String(fileId)));
  handle(CHANNELS.writeRecovery, (_event, entry: Omit<RecoveryEntry, 'savedAt'>) => writeRecovery(entry));
  handle(CHANNELS.clearRecovery, (_event, fileId: string) => clearRecovery(String(fileId)));
  on(CHANNELS.docState, (event, state: DocState) => {
    const record = recordOf(event.sender);
    if (!record) return;
    record.doc = state;
    const window = record.window;
    const name = state.editor && state.title ? state.title : null;
    window.setTitle(name ? `${state.dirty ? '• ' : ''}${name} — Evora` : 'Evora');
    if (process.platform === 'darwin') {
      // The title bar's dot and the file's icon in it (macOS only).
      window.setDocumentEdited(state.dirty);
      window.setRepresentedFilename(state.path ?? '');
    }
  });
  on(CHANNELS.nativeEdit, (event, action: NativeEdit) => {
    const contents = event.sender;
    const run: Record<NativeEdit, () => void> = {
      undo: () => contents.undo(),
      redo: () => contents.redo(),
      cut: () => contents.cut(),
      copy: () => contents.copy(),
      paste: () => contents.paste(),
      selectAll: () => contents.selectAll(),
      delete: () => contents.delete(),
    };
    run[action]?.();
  });
  on(CHANNELS.prepareCloseDone, (_event, reply: { requestId: number; ok: boolean }) => waiting.get(reply.requestId)?.(reply.ok === true));
  handle(CHANNELS.settings, () => loadSettings());
  handle(CHANNELS.setSettings, async (_event, patch: Parameters<typeof saveSettings>[0]) => {
    const before = loadSettings();
    const after = saveSettings(patch);
    if (after.serverUrl !== before.serverUrl) {
      // The pages' security policy names the server, and the app reads it when it starts: each window saves and reloads.
      setTimeout(() => {
        for (const record of records.values()) {
          void askPage(record, 'flush').then(() => {
            if (!record.window.isDestroyed()) record.window.webContents.reload();
          });
        }
      }, 100);
    }
    return after;
  });
  handle(CHANNELS.checkServer, (_event, origin: string) => checkServer(String(origin)));
  handle(CHANNELS.hostStatus, () => hostStatus());
  handle(CHANNELS.startHost, async (_event, port: number) => {
    const status = await startHost(Number(port));
    if (status.state === 'running') saveSettings({ hostPort: Number(port) });
    return status;
  });
  handle(CHANNELS.stopHost, () => stopHost());
  handle(CHANNELS.checkUpdates, () => checkForUpdates(true));
  on(CHANNELS.installUpdate, () => installUpdate());
  on(CHANNELS.openExternal, (_event, url: string) => openExternal(String(url)));
  handle(CHANNELS.startGoogle, (event, request: { mode?: unknown; invite?: unknown }) => startGoogleSignIn(windowOf(event), request ?? {}));
}

function openExternal(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') void shell.openExternal(parsed.toString());
  } catch {
    // Not an address: nothing is opened.
  }
}

// ------------------------------------------------------------------ "Continue with Google" (electron/auth.ts)

/** The sign-in started in the system's browser and not yet back: one at a time, a new start replaces it. */
let pendingSignIn: PendingSignIn | null = null;
/** evora:// addresses given before there was a window (macOS's open-url can come before ready). */
const authUrlsAtStart: string[] = [];
/** Whether the first window was made: until then evora:// addresses wait (authUrlsAtStart). */
let firstWindowMade = false;

/** Makes this app the one the system opens evora:// addresses with. The installers register it too (build.protocols). */
function registerAuthScheme(): void {
  // Not in a test run: it would change which program this computer opens evora:// addresses with.
  if (QUIET) return;
  if (process.defaultApp) {
    // In development the executable is Electron itself, which needs the app's folder to start Evora.
    if (process.argv[1]) app.setAsDefaultProtocolClient(AUTH_SCHEME, process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(AUTH_SCHEME);
  }
}

async function startGoogleSignIn(window: BrowserWindow | null, request: { mode?: unknown; invite?: unknown }): Promise<{ ok: boolean; message: string | null }> {
  const server = normalizeServerUrl(loadSettings().serverUrl ?? '');
  if (!server) return { ok: false, message: 'Choose a collaboration server first (File ▸ Collaboration…).' };
  const nonce = newNonce();
  // The PKCE verifier stays here, in the main process: only its challenge goes into the address.
  const verifier = newVerifier();
  const url = googleDesktopStartUrl(
    server,
    request.mode === 'signup' ? 'signup' : 'login',
    typeof request.invite === 'string' ? request.invite : null,
    nonce,
    await codeChallenge(verifier),
  );
  if (!url) return { ok: false, message: 'The collaboration server’s address cannot be used to sign in.' };
  // Opened only at the configured server's own http(s) address (googleDesktopStartUrl builds nothing else).
  const pending: PendingSignIn = { nonce, verifier, server, startedAt: Date.now(), windowId: window?.id ?? -1 };
  pendingSignIn = pending;
  try {
    await shell.openExternal(url);
  } catch {
    if (pendingSignIn === pending) pendingSignIn = null;
    return { ok: false, message: 'Your browser could not be opened.' };
  }
  return { ok: true, message: null };
}

/** Whether a message about a refused return is on the screen: at most one at a time. */
let refusalShowing = false;

function showRefusal(reason: RefusalReason): void {
  if (refusalShowing || !refusalShown(reason)) return;
  refusalShowing = true;
  void dialog
    .showMessageBox({ type: 'warning', message: 'Signing in with Google', detail: refusalMessage(reason), buttons: ['OK'] })
    .finally(() => {
      refusalShowing = false;
    });
}

/**
 * An evora://auth address from the system: accepted only for the sign-in this app started (its nonce, in time, for
 * the same server, once). The ticket is redeemed here, with the verifier, and the session goes to the window that
 * started the sign-in, which keeps it without leaving what it shows.
 */
function handleAuthUrl(value: string): void {
  if (!firstWindowMade) {
    authUrlsAtStart.push(value);
    return;
  }
  const back = parseAuthUrl(value);
  const pending = pendingSignIn;
  const check = back ? acceptReturn(pending, back, Date.now(), loadSettings().serverUrl) : ({ ok: false, reason: 'none' } as const);
  if (!check.ok) {
    // No sign-in waits (or the address is not one): ignored, the app only comes to the front.
    if (check.reason === 'none') {
      const record = mainWindow();
      if (record) bringForward(record.window);
      return;
    }
    const record = (pending && records.get(pending.windowId)) || mainWindow();
    if (record) bringForward(record.window);
    // Too late, or for another server: that sign-in is over, and its window stops waiting.
    if ((check.reason === 'expired' || check.reason === 'server') && pending) {
      pendingSignIn = null;
      if (record) send(record, CHANNELS.googleReturn, { ok: false, message: refusalMessage(check.reason) } satisfies GoogleSignInResult);
    }
    showRefusal(check.reason);
    return;
  }
  pendingSignIn = null;
  const record = records.get(check.windowId) ?? mainWindow() ?? createWindow();
  bringForward(record.window);
  if (check.ticket === null) {
    send(record, CHANNELS.googleReturn, { ok: false, message: check.error } satisfies GoogleSignInResult);
    return;
  }
  const windowId = record.window.id;
  void redeemTicket(check.server, check.ticket, check.verifier).then((result) => {
    // To the same window, unless it was closed meanwhile.
    const target = records.get(windowId) ?? mainWindow();
    if (target) send(target, CHANNELS.googleReturn, result);
  });
}

// ------------------------------------------------------------------ security of every page

/** Permissions the app's pages use: writing to the clipboard (Copy as PNG/SVG/CSS) and full screen. Everything else is refused. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

function secure(): void {
  const appSession = session.defaultSession;
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && fromApp(details.requestingUrl ?? contents?.getURL() ?? ''));
  });
  appSession.setPermissionCheckHandler((_contents, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && fromApp(`${origin}/`));
  appSession.setDevicePermissionHandler(() => false);

  if (DEV_URL) {
    // The development server's pages get the same policy, with what Vite's live reloading needs.
    appSession.webRequest.onHeadersReceived({ urls: [`${DEV_URL}/*`] }, (details, callback) => {
      const headers = { ...details.responseHeaders };
      if (details.resourceType === 'mainFrame') headers['Content-Security-Policy'] = [desktopCsp(loadSettings().serverUrl, DEV_URL)];
      callback({ responseHeaders: headers });
    });
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (fromApp(url)) return;
      event.preventDefault();
      openExternal(url);
    });
    contents.on('will-redirect', (event, url) => {
      if (!fromApp(url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

// ------------------------------------------------------------------ start

async function offerRecovery(): Promise<void> {
  for (const entry of pendingRecoveries()) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `Evora closed unexpectedly. Recover “${entry.name}”?`,
      detail: `Changes to ${entry.path} that were not saved, as they were at ${new Date(entry.savedAt).toLocaleString()}.`,
      buttons: ['Recover', 'Discard'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      grant(entry.path);
      recoveriesAtStart.push(entry);
    } else {
      clearRecovery(entry.fileId);
      removeLink(entry.fileId);
    }
  }
}

function start(): void {
  // macOS: a file dropped on the Dock icon or double-clicked in the Finder; it can come before the app is ready.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    if (app.isReady() && records.size > 0) openPath(path);
    else filesAtStart.push(path);
  });

  // "Continue with Google" comes back at evora://auth: on macOS as open-url, on Windows and Linux as a second launch.
  registerAuthScheme();
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAuthUrl(url);
  });

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const authUrl = authUrlInArgv(argv.slice(1));
    if (authUrl) {
      handleAuthUrl(authUrl);
      return;
    }
    const files = filesInArguments(argv.slice(1), workingDirectory);
    const record = mainWindow() ?? createWindow();
    bringForward(record.window);
    for (const file of files) openPath(file, record);
  });

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => killHost());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || quitting) app.quit();
  });
  app.on('activate', () => {
    if (records.size === 0 && app.isReady()) createWindow();
  });

  void app.whenReady().then(async () => {
    secure();
    if (!DEV_URL) {
      if (!hasBuiltApp(DIST)) {
        dialog.showErrorBox('Evora cannot start', `The app is missing from ${DIST}. Run "npm run desktop:build" first.`);
        app.quit();
        return;
      }
      serveApp(session.defaultSession, DIST, () => loadSettings().serverUrl);
    }
    grantKnownPaths();
    registerBridge();
    watchRecent(rebuildMenu);
    rebuildMenu();
    watchHost((status) => {
      for (const record of records.values()) send(record, CHANNELS.hostChanged, status);
    });
    watchUpdates(
      (status) => {
        for (const record of records.values()) send(record, CHANNELS.updateChanged, status);
      },
      () => mainWindow()?.window ?? null,
    );

    await offerRecovery();
    const first = createWindow();
    for (const entry of recoveriesAtStart) send(first, CHANNELS.recover, entry);
    recoveriesAtStart = [];
    // Files from the command line (Windows and Linux file associations open the app with the file's path).
    for (const path of [...filesInArguments(process.argv.slice(1), process.cwd()), ...filesAtStart.splice(0)]) openPath(path, first);
    firstWindowMade = true;
    // An evora:// address that started the app: no sign-in was waiting in it, so it is ignored.
    const startUrl = authUrlInArgv(process.argv.slice(1));
    for (const url of [...(startUrl ? [startUrl] : []), ...authUrlsAtStart.splice(0)]) handleAuthUrl(url);

    if (app.isPackaged && loadSettings().checkUpdates) {
      setTimeout(() => void checkForUpdates(false), 8000);
    }
  });
}

