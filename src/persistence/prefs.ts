/**
 * Editor preferences that apply to every file on this device, kept in the
 * browser's local storage. They are per user and never part of a document.
 */
export interface Preferences {
  snapping: boolean;
  showLayoutGrids: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { snapping: true, showLayoutGrids: true };

const KEY = 'open-design:preferences';

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadPreferences(storage: Storage | undefined = safeLocalStorage()): Preferences {
  if (!storage) return { ...DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? '{}') as Partial<Preferences>;
    const flag = (key: keyof Preferences): boolean => (typeof parsed[key] === 'boolean' ? (parsed[key] as boolean) : DEFAULT_PREFERENCES[key]);
    return { snapping: flag('snapping'), showLayoutGrids: flag('showLayoutGrids') };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(preferences: Preferences, storage: Storage | undefined = safeLocalStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // Storage full or unavailable: the preference simply is not remembered.
  }
}
