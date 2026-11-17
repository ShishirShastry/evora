import { app, dialog, shell, type BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import type { UpdateStatus } from '../src/persistence/desktopContract.js';

/**
 * Automatic updates from the project's GitHub Releases (the "publish"
 * setting in package.json), with electron-updater. Only an installed build
 * updates itself: in development, and in the portable Windows build, the
 * menu item says so instead. Checked when the app starts (unless switched
 * off in the settings) and from Help ▸ Check for updates…; an update is
 * downloaded in the background and offered as "Restart to update".
 *
 * Builds are not signed yet. What that means for each system is in
 * electron/README.md ("Automatic updates"): Windows installs the update (SmartScreen may
 * warn about an unsigned installer), Linux AppImage updates, and macOS
 * refuses to install an update that is not signed, which is reported here
 * as an error with a link to the download page.
 */

export const RELEASES_URL = 'https://github.com/ShishirShastry/evora/releases';

type Updater = import('electron-updater').AppUpdater;

let updater: Updater | null = null;
let status: UpdateStatus = { state: 'idle', version: null, percent: null, message: null };
let listener: (status: UpdateStatus) => void = () => {};
let interactive = false;
let windowFor: () => BrowserWindow | null = () => null;

export function watchUpdates(callback: (status: UpdateStatus) => void, window: () => BrowserWindow | null): void {
  listener = callback;
  windowFor = window;
}

export function updateStatus(): UpdateStatus {
  return status;
}

function set(next: Partial<UpdateStatus>): UpdateStatus {
  status = { ...status, ...next };
  listener(status);
  return status;
}

/** Why this build cannot update itself, or null when it can. */
export function updatesUnsupported(): string | null {
  if (!app.isPackaged) return 'Automatic updates work in the installed app. This is a development build.';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'The portable version does not update itself. Download the new version from the releases page.';
  // Otherwise: the NSIS install on Windows, the AppImage and the .deb on Linux (through the system's package tools), and macOS (signed builds only).
  return null;
}

function load(): Updater {
  if (updater) return updater;
  // electron-updater is a CommonJS package.
  const require = createRequire(import.meta.url);
  const loaded = require('electron-updater') as typeof import('electron-updater');
  const instance = loaded.autoUpdater;
  instance.autoDownload = true;
  instance.autoInstallOnAppQuit = true;
  instance.on('checking-for-update', () => set({ state: 'checking', message: null }));
  instance.on('update-not-available', () => {
    set({ state: 'none', version: null, percent: null });
    if (interactive) void message('Evora is up to date.', `You have the latest version, ${app.getVersion()}.`);
    interactive = false;
  });
  instance.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0 }));
  instance.on('download-progress', (progress) => set({ state: 'downloading', percent: Math.round(progress.percent) }));
  instance.on('update-downloaded', (info) => {
    set({ state: 'ready', version: info.version, percent: 100 });
    interactive = false;
    void offerRestart(info.version);
  });
  instance.on('error', (error) => {
    const text = error instanceof Error ? error.message : String(error);
    set({ state: 'error', message: text });
    if (interactive) void failed(text);
    interactive = false;
  });
  updater = instance;
  return instance;
}

async function message(title: string, detail: string): Promise<void> {
  const window = windowFor();
  const options = { type: 'info' as const, message: title, detail, buttons: ['OK'] };
  if (window) await dialog.showMessageBox(window, options);
  else await dialog.showMessageBox(options);
}

async function failed(text: string): Promise<void> {
  const window = windowFor();
  const options = {
    type: 'warning' as const,
    message: 'Evora could not update itself.',
    detail: `${text}\n\nYou can download the newest version from the releases page.`,
    buttons: ['Open the releases page', 'Close'],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response === 0) void shell.openExternal(RELEASES_URL);
}

async function offerRestart(version: string): Promise<void> {
  const window = windowFor();
  const options = {
    type: 'info' as const,
    message: `Evora ${version} is ready.`,
    detail: 'Restart Evora to update. Your files are saved first. If you restart later, the update is installed when you quit.',
    buttons: ['Restart to update', 'Later'],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response === 0) installUpdate();
}

/** Checks for an update. `fromMenu` says the result (also "up to date") to the person. */
export async function checkForUpdates(fromMenu: boolean): Promise<UpdateStatus> {
  const unsupported = updatesUnsupported();
  if (unsupported) {
    set({ state: 'unsupported', message: unsupported });
    if (fromMenu) await message('Check for updates', unsupported);
    return status;
  }
  if (status.state === 'ready' && status.version) {
    if (fromMenu) await offerRestart(status.version);
    return status;
  }
  interactive = fromMenu;
  try {
    await load().checkForUpdates();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    set({ state: 'error', message: text });
    if (fromMenu) await failed(text);
    interactive = false;
  }
  return status;
}

/** Quits and installs the downloaded update (the windows are asked to save first, as on any quit). */
export function installUpdate(): void {
  if (status.state !== 'ready' || !updater) return;
  // Closing the windows first lets each one write what it has; quitAndInstall then quits.
  setImmediate(() => updater?.quitAndInstall(false, true));
}
