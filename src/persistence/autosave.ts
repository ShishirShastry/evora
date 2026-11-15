import type { Document, FileMeta } from '../core';
import type { EditorStore } from '../state/editorStore';
import { saveDocument } from './files';
import type { DocumentStorage } from './storage';

export interface Autosaver {
  /** Writes any pending change now. Resolves when the file is stored. */
  flush(): Promise<void>;
  /** Stops watching the store. Pending changes are flushed first. */
  dispose(): Promise<void>;
  /** The file's metadata as last written. */
  meta(): FileMeta;
}

export interface AutosaveOptions {
  /** Quiet time after the last change before writing, in milliseconds. */
  delay?: number;
}

/**
 * Saves the document to storage shortly after every change and reports the
 * true state through the store's `saveStatus`: "unsaved" while a write is
 * pending, "saving" while it runs, "saved" once storage confirms it, and
 * "error" (with the reason) if a write fails. A failed write is retried on the
 * next change or flush; nothing is ever reported as saved before it is.
 *
 * Only committed work is written. While a gesture is open (a drag, or text
 * being typed) the document as it was when the gesture began is what counts,
 * so a half-finished interaction can never end up in the stored file.
 */
export function createAutosaver(
  store: EditorStore,
  storage: DocumentStorage,
  initialMeta: FileMeta,
  options: AutosaveOptions = {},
): Autosaver {
  const delay = options.delay ?? 400;
  let meta = initialMeta;
  let savedDoc: Document = store.getState().doc;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> | null = null;
  let disposed = false;

  /** The document as of the last committed change. */
  const committed = (): Document => {
    const state = store.getState();
    return state.gesture ? state.gesture.doc : state.doc;
  };

  const write = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // One write at a time; a change that arrives meanwhile is picked up below.
    while (writing) await writing;
    const doc = committed();
    if (doc === savedDoc) {
      const state = store.getState();
      if (state.saveStatus !== 'error' && state.doc === savedDoc) state.setSaveStatus('saved');
      return;
    }
    store.getState().setSaveStatus('saving');
    writing = (async () => {
      try {
        meta = await saveDocument(storage, doc, meta.createdAt);
        savedDoc = doc;
        store.getState().setSaveStatus(store.getState().doc === doc ? 'saved' : 'unsaved');
      } catch (error) {
        store.getState().setSaveStatus('error', error instanceof Error ? error.message : String(error));
      } finally {
        writing = null;
      }
    })();
    await writing;
    if (!disposed && committed() !== savedDoc && store.getState().saveStatus !== 'error') schedule();
  };

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, delay);
  };

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.doc === previous.doc && state.gesture === previous.gesture) return;
    if (state.doc === savedDoc) {
      // Back to exactly what is stored, for example after a cancelled drag.
      if (state.saveStatus === 'unsaved' && !writing) state.setSaveStatus('saved');
      return;
    }
    if (state.saveStatus === 'saved') state.setSaveStatus('unsaved');
    // The end of a gesture, not each step of it, triggers the save.
    if (!state.gesture) schedule();
  });

  return {
    flush: write,
    async dispose() {
      disposed = true;
      unsubscribe();
      await write();
    },
    meta: () => meta,
  };
}
