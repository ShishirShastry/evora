import { useRef, useState } from 'react';
import { errorMessage } from '../../collab/api';
import { getCommand, setZoom, type Command } from '../../state/commands';
import type { SaveStatus, ToolId } from '../../state/editorStore';
import { NumberField, TextEdit } from '../components/Fields';
import { Icon, Logo, type IconName } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { useCollab, useCollabState } from '../collab/CollabContext';
import { CommentToolButton, PresenceAvatars, ShareButton, useReadOnly, ViewOnlyBadge } from '../collab/EditorChrome';
import { statusLabel, statusTone } from '../collab/session';
import { useCommandEnv, useEditor, useEditorContext, useRunCommand } from './EditorContext';
import { commandItem, mainMenu } from './menus';

/**
 * The editor's chrome around the canvas, laid out as Figma lays its out: the
 * file (its menu, name and whether it is saved) heads the layers panel, the
 * tools float in a dock at the foot of the canvas, and undo, presenting and
 * zoom head the properties panel.
 */

/** The tools in the dock, in groups: selecting and moving about, frames, shapes, drawing, text (and, after them, comments). */
const TOOL_GROUPS: { tool: ToolId; icon: IconName }[][] = [
  [
    { tool: 'move', icon: 'move' },
    { tool: 'hand', icon: 'hand' },
  ],
  [{ tool: 'frame', icon: 'frame' }],
  [
    { tool: 'rectangle', icon: 'rectangle' },
    { tool: 'ellipse', icon: 'ellipse' },
    { tool: 'line', icon: 'line' },
    { tool: 'polygon', icon: 'polygon' },
    { tool: 'star', icon: 'star' },
  ],
  [
    { tool: 'pen', icon: 'pen' },
    { tool: 'pencil', icon: 'pencil' },
  ],
  [{ tool: 'text', icon: 'text' }],
];

const SAVE_LABELS: Record<SaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Not saved',
};

/** The tools someone who may only look and comment can still use. */
const VIEWER_TOOLS: readonly ToolId[] = ['move', 'hand'];

function tip(command: Command): string {
  return command.shortcut ? `${command.label} (${command.shortcut})` : command.label;
}

type Popup = { x: number; y: number; items: MenuItem[]; label: string } | null;

function usePopup(): [Popup, (button: HTMLElement | null, items: MenuItem[], label: string, alignRight?: boolean) => void, () => void] {
  const [popup, setPopup] = useState<Popup>(null);
  const open = (button: HTMLElement | null, items: MenuItem[], label: string, alignRight = false): void => {
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setPopup({ x: alignRight ? rect.right - 220 : rect.left, y: rect.bottom + 6, items, label });
  };
  return [popup, open, () => setPopup(null)];
}

/** The head of the layers panel: the main menu behind the mark, the file's name, and whether it is saved. */
export function FileHeader() {
  const { store } = useEditorContext();
  const session = useCollab();
  const env = useCommandEnv();
  const name = useEditor((s) => s.doc.name);
  const saveStatus = useEditor((s) => s.saveStatus);
  const saveError = useEditor((s) => s.saveError);
  // A shared document is not saved on this device: its header says how it stands with the collaboration server.
  const shared = useCollabState((s) => s.docId !== null);
  const liveStatus = useCollabState((s) => s.status);
  const pending = useCollabState((s) => s.pending);
  const readOnly = useReadOnly();
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const tone = shared ? statusTone(liveStatus, pending) : saveStatus === 'error' ? 'bad' : saveStatus === 'saved' ? 'ok' : 'busy';
  const [popup, openBelow, closePopup] = usePopup();
  const menuButton = useRef<HTMLButtonElement>(null);

  return (
    <header className="flex flex-none items-center gap-1.5 border-b border-line px-2 py-2">
      <button
        ref={menuButton}
        type="button"
        className="flex h-9 flex-none items-center gap-1 rounded-[9px] border-0 bg-transparent px-1.5 transition-colors duration-150 hover:bg-hover"
        aria-label="Main menu"
        aria-haspopup="menu"
        title="Main menu"
        onClick={() => openBelow(menuButton.current, mainMenu(env, store.getState(), { renameFile: () => setRenaming(true) }), 'Main menu')}
      >
        <Logo size={24} />
        <span className="text-faint">
          <Icon name="chevronDown" size={10} />
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {renaming ? (
          <TextEdit
            label="File name"
            value={name}
            onCancel={() => setRenaming(false)}
            onCommit={(value) => {
              setRenaming(false);
              store.getState().renameDocument(value);
              // The shared document's name is also what its card in the workspace says.
              const trimmed = value.trim();
              if (shared && session.docId && trimmed)
                void session.api
                  .updateDocument(session.docId, { name: trimmed })
                  .then((info) => session.setInfo(info))
                  .catch((cause: unknown) => setRenameError(errorMessage(cause)));
            }}
          />
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="-ml-1 max-w-full truncate rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-[12.5px] font-semibold transition-colors duration-150 hover:bg-hover disabled:hover:bg-transparent"
              title={readOnly ? name : 'Rename file'}
              aria-label={`File name: ${name}. Click to rename`}
              disabled={readOnly}
              onClick={() => setRenaming(true)}
            >
              {name}
            </button>
            <ViewOnlyBadge />
          </div>
        )}
        <span
          role="status"
          aria-live="polite"
          className={`flex items-center gap-1.5 text-[11px] ${tone === 'bad' ? 'text-danger' : 'text-dim'}`}
          title={
            shared
              ? (renameError ?? 'Changes are sent to everyone in the file as you make them and kept on the collaboration server. Changes made offline are sent when the connection is back.')
              : saveStatus === 'error'
                ? (saveError ?? 'The file could not be saved')
                : 'Changes are saved automatically on this device'
          }
        >
          <span
            aria-hidden="true"
            className={`inline-block h-1.5 w-1.5 rounded-full transition-colors duration-300 ${tone === 'bad' ? 'bg-danger' : tone === 'ok' ? 'bg-success' : 'bg-[#f5a524]'}`}
          />
          {shared ? statusLabel(liveStatus, pending) : SAVE_LABELS[saveStatus]}
        </span>
      </div>
      {popup && <PopupMenu x={popup.x} y={popup.y} items={popup.items} label={popup.label} onClose={closePopup} />}
    </header>
  );
}

/** The tools, floating in a dock at the foot of the canvas. */
export function ToolDock() {
  const run = useRunCommand();
  const session = useCollab();
  const tool = useEditor((s) => s.tool);
  const commentMode = useCollabState((s) => s.commentMode);
  const readOnly = useReadOnly();
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
      <div role="toolbar" aria-label="Tools" className="ev-dock pointer-events-auto flex items-center gap-0.5">
        {TOOL_GROUPS.map((group, index) => (
          <div key={index} className="flex items-center gap-0.5">
            {index > 0 && <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />}
            {group.map(({ tool: id, icon }) => {
              const command = getCommand(`tool.${id}`) as Command;
              // Someone who may only look can move about the canvas, not draw on it.
              const disabled = readOnly && !VIEWER_TOOLS.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  className="ev-icon-button !h-8 !w-8 !rounded-[9px]"
                  aria-label={command.label}
                  aria-pressed={tool === id && !commentMode}
                  title={disabled ? `${tip(command)}: you can view and comment on this file` : tip(command)}
                  disabled={disabled}
                  onClick={() => {
                    // Picking up another tool puts the Comment tool down.
                    session.setCommentMode(false);
                    run(command);
                  }}
                >
                  <Icon name={icon} />
                </button>
              );
            })}
          </div>
        ))}
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />
        <CommentToolButton />
      </div>
    </div>
  );
}

/** The head of the properties panel: undo and redo, presenting the prototype, and the zoom. */
export function ViewControls() {
  const { store } = useEditorContext();
  const env = useCommandEnv();
  const run = useRunCommand();
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  const zoom = useEditor((s) => s.viewport.zoom);
  const [popup, openBelow, closePopup] = usePopup();
  const zoomButton = useRef<HTMLButtonElement>(null);
  const undo = getCommand('edit.undo') as Command;
  const redo = getCommand('edit.redo') as Command;
  const present = getCommand('view.present') as Command;

  return (
    <header className="flex flex-none flex-col gap-1.5 border-b border-line px-2 py-2">
      {/* Who is here, sharing and presenting, as Figma heads its properties panel. */}
      <div className="flex min-w-0 items-center gap-1">
        <PresenceAvatars />
        <div className="flex-1" />
        <ShareButton />
        <button type="button" className="ev-button ev-button-primary ml-1 !h-7 flex-none !gap-1.5 !px-2.5" aria-label="Present prototype" title={tip(present)} onClick={() => run(present)}>
          <Icon name="play" size={12} />
          Present
        </button>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" className="ev-icon-button !h-7 !w-7" aria-label="Undo" title={tip(undo)} disabled={!canUndo} onClick={() => run(undo)}>
          <Icon name="undo" />
        </button>
        <button type="button" className="ev-icon-button !h-7 !w-7" aria-label="Redo" title={tip(redo)} disabled={!canRedo} onClick={() => run(redo)}>
          <Icon name="redo" />
        </button>
        <div className="flex-1" />
        {/* The zoom: typed in the field, or chosen from the menu beside it. */}
        <div className="w-[56px] flex-none">
          <NumberField label="Zoom percentage" suffix="%" min={2} max={25600} value={Math.round(zoom * 100)} onCommit={(value) => setZoom(store, value / 100)} />
        </div>
        <button
          ref={zoomButton}
          type="button"
          className="flex h-7 w-5 flex-none items-center justify-center rounded-[6px] border-0 bg-transparent text-dim transition-colors duration-150 hover:bg-hover hover:text-ink"
          aria-label={`Zoom: ${Math.round(zoom * 100)}%`}
          aria-haspopup="menu"
          title="Zoom"
          onClick={() => {
            const state = store.getState();
            const item = (id: string): MenuItem => commandItem(id, env, state);
            const preset = (value: number): MenuItem => ({
              label: `${value * 100}%`,
              checked: Math.abs(state.viewport.zoom - value) < 0.0005,
              onSelect: () => setZoom(store, value),
            });
            openBelow(
              zoomButton.current,
              [item('view.zoomIn'), item('view.zoomOut'), { type: 'separator' }, item('view.zoomFit'), item('view.zoomSelection'), { type: 'separator' }, preset(0.5), preset(1), preset(2), preset(4)],
              'Zoom',
              true,
            );
          }}
        >
          <Icon name="chevronDown" size={10} />
        </button>
      </div>
      {popup && <PopupMenu x={popup.x} y={popup.y} items={popup.items} label={popup.label} onClose={closePopup} />}
    </header>
  );
}
