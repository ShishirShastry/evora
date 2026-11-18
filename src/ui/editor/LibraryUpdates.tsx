import { createContext, useContext, useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { findLibraryUpdates, listLibraries, updatesToOffer } from '../../core';
import type { FoundUpdate, LibraryUpdates } from '../../collab/libraries';
import { useEditor } from './EditorContext';

/**
 * "Library updates available": the libraries a file uses that were published
 * again, offered in a quiet notice above the canvas and in the Libraries
 * dialog. "Update" takes them all as one undo step; "Not now" hides them
 * until a newer version still is published.
 */

/** The library updates of the open file, provided by the editor. */
export const LibraryUpdatesContext = createContext<LibraryUpdates | null>(null);

export function useOptionalLibraryUpdates(): LibraryUpdates | null {
  return useContext(LibraryUpdatesContext);
}

/** How often the server is asked again while a file is open (and the computer online): every five minutes at most. */
export const LIBRARY_CHECK_INTERVAL = 5 * 60_000;

/** The least time between two checks when the page is shown again or the computer is back online. */
export const LIBRARY_CHECK_GAP = 30_000;

/**
 * Whether to look for library updates now: never while offline, while the
 * page is hidden, or for someone who may only view the file (they are never
 * offered any), and not again within `gap` of the last look.
 */
export function shouldCheckLibraries(state: { online: boolean; visible: boolean; canTake: boolean; sinceLast: number; gap: number }): boolean {
  return state.online && state.visible && state.canTake && state.sinceLast >= state.gap;
}

/** Every newer version of the libraries the open file uses, and those of them still offered (not declined). */
export function useLibraryUpdateList(updates: LibraryUpdates): { all: FoundUpdate[]; offered: FoundUpdate[] } {
  const doc = useEditor((s) => s.doc);
  const latest = useStore(updates.store, (s) => s.latest);
  const declined = useStore(updates.store, (s) => s.declined);
  return useMemo(() => {
    const all = latest ? findLibraryUpdates(listLibraries(doc), latest) : [];
    return { all, offered: updatesToOffer(all, declined) };
  }, [doc, latest, declined]);
}

/**
 * Looks for newer versions when the file is opened, then every few minutes
 * while it stays open, the page is visible and the computer online, and at
 * once (at most every `gap`) when the page is shown again or the computer is
 * back online. Nothing is asked of anyone while the file uses no library, or
 * for someone who may only view it.
 */
export function useLibraryUpdateChecks(updates: LibraryUpdates, interval: number = LIBRARY_CHECK_INTERVAL, gap: number = LIBRARY_CHECK_GAP): void {
  useEffect(() => {
    let last = -Infinity;
    const run = (minimum: number): void => {
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
      if (!shouldCheckLibraries({ online, visible, canTake: updates.canTake(), sinceLast: Date.now() - last, gap: minimum })) return;
      last = Date.now();
      void updates.check();
    };
    run(0);
    const timer = setInterval(() => run(0), interval);
    const again = (): void => run(gap);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') again();
    };
    if (typeof window !== 'undefined') window.addEventListener('online', again);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      if (typeof window !== 'undefined') window.removeEventListener('online', again);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [updates, interval, gap]);
}

/** "Name: version 1 → 2". */
export function updateLine(update: { name: string; from: number; to: number }): string {
  return `${update.name}: version ${update.from} → ${update.to}`;
}

/**
 * The list of updates with "Update" and "Not now", for the editor (above the
 * canvas) and the Libraries dialog. Shows nothing when there is nothing to
 * offer, or to someone who may only view the file.
 */
export function LibraryUpdatesNotice({ updates, className = '' }: { updates: LibraryUpdates; className?: string }) {
  const { offered } = useLibraryUpdateList(updates);
  const busy = useStore(updates.store, (s) => s.busy);
  const problem = useStore(updates.store, (s) => s.problem);
  const readOnly = useEditor((s) => s.readOnly);
  if (readOnly || (offered.length === 0 && !problem)) return null;
  if (offered.length === 0) {
    // Taken, with something to say about it (an image that could not be fetched).
    return (
      <section aria-label="Library updates" className={`flex flex-none items-start gap-3 px-3 py-2 ${className}`}>
        <p role="alert" className="m-0 min-w-0 flex-1 text-danger">
          {problem}
        </p>
        <button type="button" className="ev-button flex-none !px-3" onClick={() => updates.store.setState({ problem: '' })}>
          Dismiss
        </button>
      </section>
    );
  }
  return (
    <section aria-label="Library updates available" className={`flex flex-none items-start gap-3 px-3 py-2 ${className}`}>
      <div role="status" className="min-w-0 flex-1">
        <strong className="font-medium text-ink">Library updates available</strong>
        <ul className="m-0 mt-0.5 list-none p-0 text-dim">
          {offered.map((update) => (
            <li key={update.id}>{updateLine(update)}</li>
          ))}
        </ul>
        {problem && <p role="alert" className="m-0 mt-1 text-danger">{problem}</p>}
      </div>
      <button type="button" className="ev-button ev-button-primary flex-none !px-3" disabled={busy} onClick={() => void updates.accept()}>
        {busy ? 'Updating…' : offered.length === 1 ? 'Update' : 'Update all'}
      </button>
      <button type="button" className="ev-button flex-none !px-3" disabled={busy} onClick={() => updates.decline()}>
        Not now
      </button>
    </section>
  );
}
