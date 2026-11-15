import type { SessionState } from '../state/editorStore';

const PREFIX = 'open-design:session:';

/**
 * Remembers, per file, which page was open and where each page was scrolled
 * and zoomed. This is per-user editor state, so it is kept in the browser's
 * local storage and never written into the document.
 */
export function loadSession(docId: string, storage: Storage | undefined = safeLocalStorage()): Partial<SessionState> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PREFIX + docId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    const viewports: SessionState['viewports'] = {};
    for (const [pageId, v] of Object.entries(parsed.viewports ?? {})) {
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) && v.zoom > 0) {
        viewports[pageId] = { x: v.x, y: v.y, zoom: v.zoom };
      }
    }
    return { pageId: typeof parsed.pageId === 'string' ? parsed.pageId : undefined, viewports };
  } catch {
    return {};
  }
}

export function saveSession(docId: string, session: SessionState, storage: Storage | undefined = safeLocalStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(PREFIX + docId, JSON.stringify(session));
  } catch {
    // Storage full or unavailable: losing the remembered viewport is harmless.
  }
}

export function clearSession(docId: string, storage: Storage | undefined = safeLocalStorage()): void {
  try {
    storage?.removeItem(PREFIX + docId);
  } catch {
    // Ignore.
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
