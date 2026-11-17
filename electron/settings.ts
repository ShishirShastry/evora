import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import { join } from 'node:path';
import { normalizeServerUrl, type DesktopSettings } from '../src/persistence/desktopContract.js';
import { readJson, writeJson } from './jsonStore.js';

/** The desktop app's own settings, in its data folder. */

const DEFAULTS: DesktopSettings = { serverUrl: null, hostPort: 8787, checkUpdates: true };
const settingsPath = (): string => join(app.getPath('userData'), 'settings.json');

export function loadSettings(): DesktopSettings {
  const stored = readJson<Partial<DesktopSettings>>(settingsPath(), {});
  return sanitize({ ...DEFAULTS, ...stored });
}

function sanitize(settings: DesktopSettings): DesktopSettings {
  const serverUrl = typeof settings.serverUrl === 'string' ? normalizeServerUrl(settings.serverUrl) : null;
  const hostPort = Number.isInteger(settings.hostPort) && settings.hostPort >= 1024 && settings.hostPort <= 65535 ? settings.hostPort : DEFAULTS.hostPort;
  return { serverUrl, hostPort, checkUpdates: settings.checkUpdates !== false };
}

export function saveSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const next = sanitize({ ...loadSettings(), ...pick(patch) });
  writeJson(settingsPath(), next);
  return next;
}

function pick(patch: Partial<DesktopSettings>): Partial<DesktopSettings> {
  const out: Partial<DesktopSettings> = {};
  if ('serverUrl' in patch) out.serverUrl = patch.serverUrl ?? null;
  if (typeof patch.hostPort === 'number') out.hostPort = patch.hostPort;
  if (typeof patch.checkUpdates === 'boolean') out.checkUpdates = patch.checkUpdates;
  return out;
}

// ------------------------------------------------------------------ where windows were

interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

const windowPath = (): string => join(app.getPath('userData'), 'window-state.json');

export interface WindowPlace {
  width: number;
  height: number;
  /** Left out when the place is no longer on any screen. */
  x?: number;
  y?: number;
  maximized: boolean;
}

/** The last window's size, and its place if that is still on one of the screens. */
export function savedWindowState(): WindowPlace | null {
  const state = readJson<WindowState | null>(windowPath(), null);
  if (!state || typeof state.bounds?.width !== 'number') return null;
  const { bounds } = state;
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return bounds.x < area.x + area.width - 80 && bounds.x + bounds.width > area.x + 80 && bounds.y >= area.y - 20 && bounds.y < area.y + area.height - 80;
  });
  const width = Math.max(640, bounds.width);
  const height = Math.max(480, bounds.height);
  return visible ? { width, height, x: bounds.x, y: bounds.y, maximized: state.maximized } : { width, height, maximized: state.maximized };
}

export function rememberWindow(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
  writeJson(windowPath(), { bounds: window.isMaximized() ? window.getNormalBounds() : window.getBounds(), maximized: window.isMaximized() });
}
