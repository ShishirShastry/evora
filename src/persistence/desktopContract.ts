/**
 * The contract between Evora's desktop application (Electron, `electron/`)
 * and the web app it shows. The preload script exposes an object of type
 * `EvoraDesktop` as `window.evoraDesktop`; in a browser there is none, and
 * everything that uses it checks first, so the web app is unchanged.
 *
 * This file has no imports: the Electron main process and preload compile it
 * with their own settings (`electron/tsconfig.json`), the app with its own.
 */

/** A file read from the disk by the desktop app. */
export interface DiskFile {
  /** Its full path on this computer. */
  path: string;
  /** Its name, e.g. "Landing page.evora". */
  name: string;
  bytes: Uint8Array;
  /** When it was last changed on disk (ms since 1970). */
  mtimeMs: number;
}

/**
 * A file of the app's own library (IndexedDB) that is the working copy of a
 * `.evora` file on disk: Save writes it there. `savedUpdatedAt` is the
 * library file's `updatedAt` when it last matched the disk (opened or saved),
 * `mtimeMs` the disk file's time then.
 */
export interface DiskLink {
  fileId: string;
  path: string;
  savedUpdatedAt: string;
  mtimeMs: number;
}

export type DiskFileKind = 'evora' | 'fig' | 'svg';

export interface SaveRequest {
  /** Where to write; null asks with the system's Save dialog. A path is written only if it was opened or chosen in this app. */
  path: string | null;
  /** The name the Save dialog suggests. */
  suggestedName: string;
  kind: 'evora' | 'fig';
  /** The file's content: text for `.evora`, bytes for `.fig`. */
  data: string | Uint8Array;
}

export interface SavedFile {
  path: string;
  mtimeMs: number;
}

/** A copy of an open file kept in the app's data folder until it is saved, offered back after a crash. */
export interface RecoveryEntry {
  fileId: string;
  /** The file on disk it belongs to. */
  path: string;
  name: string;
  /** The whole `.evora` text. */
  text: string;
  savedAt: string;
}

/** What the window shows, sent by the app whenever it changes. */
export interface DocState {
  /** Whether a file is open in the editor. */
  editor: boolean;
  /** The open library file's ID (its recovery copy is let go when the window closes normally). */
  fileId: string | null;
  /** The open file's name, or null. */
  title: string | null;
  /** The file on disk it is linked to, or null. */
  path: string | null;
  /** Whether it has changes not yet saved to that file. */
  dirty: boolean;
  /** Whether the open file is a shared one (on a collaboration server). */
  shared: boolean;
}

export interface DesktopSettings {
  /** The collaboration server's address, e.g. http://192.168.1.20:8787; null = local only. */
  serverUrl: string | null;
  /** The port "Host a team server" uses. */
  hostPort: number;
  /** Whether to check for updates when the app starts. */
  checkUpdates: boolean;
}

export interface HostStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  port: number | null;
  /** The addresses other people on the network use, e.g. http://192.168.1.20:8787. */
  addresses: string[];
  /** Where its data is kept. */
  dataDir: string;
  /** What went wrong, when state is "error". */
  message: string | null;
}

export interface UpdateStatus {
  state: 'idle' | 'unsupported' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';
  /** The new version, when there is one. */
  version: string | null;
  /** Download progress, 0 to 100. */
  percent: number | null;
  message: string | null;
}

export interface DesktopInfo {
  platform: 'win32' | 'darwin' | 'linux' | string;
  version: string;
  /** Whether this is an installed (packaged) build; automatic updates work only there. */
  packaged: boolean;
}

export type CloseAction = 'flush' | 'save' | 'discard';

export interface ServerCheck {
  ok: boolean;
  version: string | null;
  message: string | null;
}

/** Edit actions done by the system itself, in a text field. */
export type NativeEdit = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'delete';

export interface EvoraDesktop {
  info(): Promise<DesktopInfo>;
  /** The system's Open dialog: .evora, .opendesign, .fig and .svg files. Null when cancelled. */
  openDialog(): Promise<DiskFile | null>;
  /** Reads a file this app was given (opened, chosen, dropped, from the command line). */
  readPath(path: string): Promise<DiskFile>;
  /** Reads a file dropped on the window. Null when it is not a file on disk. */
  openDropped(file: File): Promise<DiskFile | null>;
  save(request: SaveRequest): Promise<SavedFile | null>;
  linkFor(fileId: string): Promise<DiskLink | null>;
  linkByPath(path: string): Promise<DiskLink | null>;
  setLink(link: DiskLink): Promise<void>;
  removeLink(fileId: string): Promise<void>;
  writeRecovery(entry: Omit<RecoveryEntry, 'savedAt'>): Promise<void>;
  clearRecovery(fileId: string): Promise<void>;
  setDocState(state: DocState): void;
  nativeEdit(action: NativeEdit): void;
  settings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  /** Asks a server's GET /api/health. */
  checkServer(origin: string): Promise<ServerCheck>;
  hostStatus(): Promise<HostStatus>;
  startHost(port: number): Promise<HostStatus>;
  stopHost(): Promise<HostStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): void;
  openExternal(url: string): void;
  /** A file to open: from the command line, a double-click, the dock, a second launch or Open Recent. */
  onOpenFile(callback: (file: DiskFile) => void): () => void;
  /** A menu item was chosen: the ID of an app command (src/state/commands.ts) or a `desktop.*` one. */
  onMenu(callback: (id: string) => void): () => void;
  /**
   * The window is closing. `flush`: write what is pending to the library; `save`: the person chose to save the open
   * file to its file on disk first; `discard`: they chose not to (its link to the disk file is let go, the changes
   * stay in the library). Resolve with whether the window may close.
   */
  onPrepareClose(callback: (action: CloseAction) => Promise<boolean>): () => void;
  /** After a crash: a copy of a file to recover. */
  onRecover(callback: (entry: RecoveryEntry) => void): () => void;
  onHostStatus(callback: (status: HostStatus) => void): () => void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
}

/** The IPC channels (main ⇄ preload). */
export const CHANNELS = {
  info: 'evora:info',
  openDialog: 'evora:open-dialog',
  readPath: 'evora:read-path',
  openDropped: 'evora:open-dropped',
  save: 'evora:save',
  linkFor: 'evora:link-for',
  linkByPath: 'evora:link-by-path',
  setLink: 'evora:set-link',
  removeLink: 'evora:remove-link',
  writeRecovery: 'evora:write-recovery',
  clearRecovery: 'evora:clear-recovery',
  docState: 'evora:doc-state',
  nativeEdit: 'evora:native-edit',
  settings: 'evora:settings',
  setSettings: 'evora:set-settings',
  checkServer: 'evora:check-server',
  hostStatus: 'evora:host-status',
  startHost: 'evora:start-host',
  stopHost: 'evora:stop-host',
  checkUpdates: 'evora:check-updates',
  installUpdate: 'evora:install-update',
  openExternal: 'evora:open-external',
  // main → app
  openFile: 'evora:open-file',
  menu: 'evora:menu',
  prepareClose: 'evora:prepare-close',
  prepareCloseDone: 'evora:prepare-close-done',
  recover: 'evora:recover',
  hostChanged: 'evora:host-changed',
  updateChanged: 'evora:update-changed',
} as const;

/** The kinds of files the desktop app opens, by name. */
export function diskFileKind(name: string): DiskFileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.evora') || lower.endsWith('.opendesign')) return 'evora';
  if (lower.endsWith('.fig') || lower.endsWith('.jam')) return 'fig';
  if (lower.endsWith('.svg')) return 'svg';
  return null;
}

/** Whether Save can write back to this file: only `.evora` (a `.opendesign`, `.fig` or `.svg` file is saved as a new `.evora`). */
export function canSaveInPlace(path: string): boolean {
  return path.toLowerCase().endsWith('.evora');
}

/** Turns an address typed by someone into a server origin (http(s)://host[:port]), or null when it is not one. */
export function normalizeServerUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  return url.origin;
}

/** The WebSocket address of a server origin: ws://host:port/ws or wss://… */
export function socketUrlFor(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}/ws`;
}

/**
 * The Content-Security-Policy of the app's pages in the desktop app.
 * `server` adds the collaboration server (its HTTP and WebSocket origins).
 *
 * Scripts: the app's own files, and inline scripts. Inline scripts are needed
 * by the plugin sandbox, not by the app: a plugin's frame is an `srcdoc`
 * document (src/plugins/runtime.ts), and such a document inherits the policy
 * of the page that holds it, so without 'unsafe-inline' no plugin runs. The
 * frame stays sandboxed (`allow-scripts` only: an opaque origin, without the
 * desktop bridge) under its own, stricter policy (no network). The app writes
 * no HTML from strings; eval, object, other origins' scripts, <base> and form
 * submissions stay blocked.
 */
export function desktopCsp(server: string | null, devOrigin: string | null = null): string {
  const connect = ["'self'", 'blob:', 'data:'];
  if (server) connect.push(server, socketUrlFor(server).replace(/\/ws$/, ''));
  const script = ["'self'", "'unsafe-inline'"];
  if (devOrigin) {
    // Vite's development server: its modules and its live-reload socket.
    connect.push(devOrigin, devOrigin.replace(/^http/, 'ws'));
    script.push(devOrigin);
  }
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
