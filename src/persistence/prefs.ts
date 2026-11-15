/**
 * Editor preferences that apply to every file on this device, kept in the
 * browser's local storage. They are per user and never part of a document.
 */
export interface Preferences {
  snapping: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { snapping: true };

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
    return { snapping: typeof parsed.snapping === 'boolean' ? parsed.snapping : DEFAULT_PREFERENCES.snapping };
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
