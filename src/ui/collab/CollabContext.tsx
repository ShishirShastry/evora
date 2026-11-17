import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { CollabSession, CollabState } from './session';

/** The collaboration session of the open file, provided by the editor around everything it shows. */
export const CollabContext = createContext<CollabSession | null>(null);

export function useCollab(): CollabSession {
  const session = useContext(CollabContext);
  if (!session) throw new Error('This component must be rendered inside an editor');
  return session;
}

/** The session when there is one (components that are also shown outside an editor). */
export function useOptionalCollab(): CollabSession | null {
  return useContext(CollabContext);
}

/** Subscribes a component to part of the collaboration state. Like `useEditor`, the selector must return a stable value. */
export function useCollabState<T>(selector: (state: CollabState) => T): T {
  return useStore(useCollab().store, selector);
}
