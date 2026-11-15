import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { InteractionController } from '../../engine/input/controller';
import type { AppActions, Command, CommandEnv } from '../../state/commands';
import { runCommand } from '../../state/commands';
import type { EditorActions, EditorState, EditorStore } from '../../state/editorStore';

export interface EditorContextValue {
  store: EditorStore;
  app: AppActions;
  /** The canvas registers its controller here so commands can cancel a drag. */
  controller: { current: InteractionController | null };
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
