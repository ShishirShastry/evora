import { useRef, useState } from 'react';
import { getCommand, setZoom, type Command } from '../../state/commands';
import type { SaveStatus, ToolId } from '../../state/editorStore';
import { NumberField, TextEdit } from '../components/Fields';
import { Icon, Logo, type IconName } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { useCommandEnv, useEditor, useEditorContext, useRunCommand } from './EditorContext';
import { commandItem, mainMenu } from './menus';

/**
 * The editor's chrome around the canvas, laid out as Figma lays its out: the
 * file (its menu, name and whether it is saved) heads the layers panel, the
 * tools float in a dock at the foot of the canvas, and undo, presenting and
 * zoom head the properties panel.
 */

/** The tools in the dock, in groups: selecting and moving about, frames, shapes, drawing, text. */
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
  const env = useCommandEnv();
  const name = useEditor((s) => s.doc.name);
  const saveStatus = useEditor((s) => s.saveStatus);
  const saveError = useEditor((s) => s.saveError);
  const [renaming, setRenaming] = useState(false);
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
            }}
          />
        ) : (
          <button
            type="button"
            className="-ml-1 max-w-full truncate rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-[12.5px] font-semibold transition-colors duration-150 hover:bg-hover"
            title="Rename file"
            aria-label={`File name: ${name}. Click to rename`}
            onClick={() => setRenaming(true)}
          >
            {name}
          </button>
        )}
        <span
          role="status"
          aria-live="polite"
          className={`flex items-center gap-1.5 text-[11px] ${saveStatus === 'error' ? 'text-danger' : 'text-dim'}`}
          title={saveStatus === 'error' ? (saveError ?? 'The file could not be saved') : 'Changes are saved automatically on this device'}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-1.5 w-1.5 rounded-full transition-colors duration-300 ${
              saveStatus === 'error' ? 'bg-danger' : saveStatus === 'saved' ? 'bg-success' : 'bg-[#f5a524]'
            }`}
          />
          {SAVE_LABELS[saveStatus]}
        </span>
      </div>
      {popup && <PopupMenu x={popup.x} y={popup.y} items={popup.items} label={popup.label} onClose={closePopup} />}
    </header>
  );
}

/** The tools, floating in a dock at the foot of the canvas. */
export function ToolDock() {
  const run = useRunCommand();
  const tool = useEditor((s) => s.tool);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
      <div role="toolbar" aria-label="Tools" className="ev-dock pointer-events-auto flex items-center gap-0.5">
        {TOOL_GROUPS.map((group, index) => (
          <div key={index} className="flex items-center gap-0.5">
            {index > 0 && <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />}
            {group.map(({ tool: id, icon }) => {
              const command = getCommand(`tool.${id}`) as Command;
              return (
                <button
                  key={id}
                  type="button"
                  className="ev-icon-button !h-8 !w-8 !rounded-[9px]"
                  aria-label={command.label}
                  aria-pressed={tool === id}
                  title={tip(command)}
                  onClick={() => run(command)}
                >
                  <Icon name={icon} />
                </button>
              );
            })}
          </div>
        ))}
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
    <header className="flex flex-none items-center gap-1 border-b border-line px-2 py-2">
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
      <button type="button" className="ev-button ev-button-primary ml-1 !h-7 flex-none !gap-1.5 !px-2.5" aria-label="Present prototype" title={tip(present)} onClick={() => run(present)}>
        <Icon name="play" size={12} />
        Present
      </button>
      {popup && <PopupMenu x={popup.x} y={popup.y} items={popup.items} label={popup.label} onClose={closePopup} />}
    </header>
  );
}
