/**
 * Editor preferences that apply to every file on this device, kept in the
 * browser's local storage. They are per user and never part of a document.
 */

/** The colours of the application itself. The colours of a design are part of its document and do not change with it. */
export type Theme = 'dark' | 'light';

export interface Preferences {
  snapping: boolean;
  pixelSnap: boolean;
  showLayoutGrids: boolean;
  showRulers: boolean;
  theme: Theme;
  /** Widths of the panels beside the canvas, in pixels. */
  leftPanelWidth: number;
  rightPanelWidth: number;
}

/** The narrowest and widest a side panel can be dragged. */
export const PANEL_WIDTH_MIN = 180;
export const PANEL_WIDTH_MAX = 480;

export const DEFAULT_PREFERENCES: Preferences = {
  snapping: true,
  pixelSnap: true,
  showLayoutGrids: true,
  showRulers: false,
  theme: 'dark',
  leftPanelWidth: 240,
  rightPanelWidth: 252,
};

const KEY = 'open-design:preferences';

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** A panel width kept within what a panel can be; anything that is not a number is the fallback. */
export function clampPanelWidth(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, value)));
}

export function loadPreferences(storage: Storage | undefined = safeLocalStorage()): Preferences {
  if (!storage) return { ...DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const flag = (key: 'snapping' | 'pixelSnap' | 'showLayoutGrids' | 'showRulers'): boolean =>
      typeof parsed[key] === 'boolean' ? (parsed[key] as boolean) : DEFAULT_PREFERENCES[key];
    return {
      snapping: flag('snapping'),
      pixelSnap: flag('pixelSnap'),
      showLayoutGrids: flag('showLayoutGrids'),
      showRulers: flag('showRulers'),
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      leftPanelWidth: clampPanelWidth(parsed.leftPanelWidth, DEFAULT_PREFERENCES.leftPanelWidth),
      rightPanelWidth: clampPanelWidth(parsed.rightPanelWidth, DEFAULT_PREFERENCES.rightPanelWidth),
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Remembers the preferences given; the ones left out stay as they were. */
export function savePreferences(preferences: Partial<Preferences>, storage: Storage | undefined = safeLocalStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ ...loadPreferences(storage), ...preferences }));
  } catch {
    // Storage full or unavailable: the preference simply is not remembered.
  }
}
