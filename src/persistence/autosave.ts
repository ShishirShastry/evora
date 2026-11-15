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

  const write = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // One write at a time; a change that arrives meanwhile is picked up by the loop.
    while (writing) await writing;
    const doc = store.getState().doc;
    if (doc === savedDoc) {
      if (store.getState().saveStatus !== 'error') store.getState().setSaveStatus('saved');
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
    if (!disposed && store.getState().doc !== savedDoc && store.getState().saveStatus !== 'error') schedule();
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
    if (state.doc === savedDoc) return;
    if (state.saveStatus === 'saved') state.setSaveStatus('unsaved');
    // Do not write half-finished drags: the end of the gesture triggers the save.
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
