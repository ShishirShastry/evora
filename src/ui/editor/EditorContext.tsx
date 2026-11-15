import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { Point } from '../../core';
import type { ImageCache } from '../../engine/images/imageCache';
import type { InteractionController } from '../../engine/input/controller';
import type { DocumentStorage } from '../../persistence/storage';
import type { AppActions, Command, CommandEnv } from '../../state/commands';
import { runCommand } from '../../state/commands';
import type { EditorActions, EditorState, EditorStore } from '../../state/editorStore';

export interface EditorContextValue {
  store: EditorStore;
  app: AppActions;
  /** The canvas registers its controller here so commands can cancel a drag. */
  controller: { current: InteractionController | null };
  storage: DocumentStorage;
  /** Decoded images for image fills, shared by the canvas and the panels. */
  images: ImageCache;
  /** Imports image files and places them on the page, at a page-space point or in the middle of the view. */
  placeFiles(files: readonly File[], at?: Point): Promise<void>;
  /** Lets the user choose one image file, imports it, and returns its asset hash. Null if they cancelled. */
  pickImage(): Promise<string | null>;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditorContext(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('This component must be rendered inside an editor');
  return value;
}

/**
 * Subscribes a component to part of the editor state. The selector must
 * return a value that is stable while nothing relevant changed (a primitive
 * or an object taken straight from the state), never a freshly built one.
 */
export function useEditor<T>(selector: (state: EditorState & EditorActions) => T): T {
  return useStore(useEditorContext().store, selector);
}

export function useCommandEnv(): CommandEnv {
  const { store, app } = useEditorContext();
  return { store, app };
}

/** Runs a command the same way a keyboard shortcut would. */
export function useRunCommand(): (command: Command) => void {
  const env = useCommandEnv();
  return (command) => void runCommand(command, env);
}
