import { useRef, useState } from 'react';
import { getCommand, setZoom, type Command } from '../../state/commands';
import type { SaveStatus, ToolId } from '../../state/editorStore';
import { NumberField, TextEdit } from '../components/Fields';
import { Icon, Logo, type IconName } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { useCommandEnv, useEditor, useEditorContext, useRunCommand } from './EditorContext';
import { commandItem, mainMenu } from './menus';

const TOOLS: { tool: ToolId; icon: IconName }[] = [
  { tool: 'move', icon: 'move' },
  { tool: 'hand', icon: 'hand' },
  { tool: 'frame', icon: 'frame' },
  { tool: 'rectangle', icon: 'rectangle' },
  { tool: 'ellipse', icon: 'ellipse' },
  { tool: 'line', icon: 'line' },
  { tool: 'polygon', icon: 'polygon' },
  { tool: 'star', icon: 'star' },
  { tool: 'text', icon: 'text' },
  { tool: 'pen', icon: 'pen' },
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

/** The top toolbar: main menu, tools, file name and save status, undo/redo and zoom. */
export function TopBar() {
  const { store } = useEditorContext();
  const env = useCommandEnv();
  const run = useRunCommand();
  const tool = useEditor((s) => s.tool);
  const name = useEditor((s) => s.doc.name);
  const saveStatus = useEditor((s) => s.saveStatus);
  const saveError = useEditor((s) => s.saveError);
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  const zoom = useEditor((s) => s.viewport.zoom);
  const [popup, setPopup] = useState<Popup>(null);
  const [renaming, setRenaming] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const zoomButton = useRef<HTMLButtonElement>(null);

  const openBelow = (button: HTMLElement | null, items: MenuItem[], label: string, alignRight = false): void => {
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setPopup({ x: alignRight ? rect.right - 220 : rect.left, y: rect.bottom + 4, items, label });
  };

  const undo = getCommand('edit.undo') as Command;
  const redo = getCommand('edit.redo') as Command;

  return (
    <header className="flex h-11 flex-none items-center gap-1 border-b border-line bg-panel px-1.5">
      <button
        ref={menuButton}
        type="button"
        className="flex h-8 items-center gap-1 rounded-md border-0 bg-transparent px-1.5 hover:bg-hover"
        aria-label="Main menu"
        aria-haspopup="menu"
        title="Main menu"
        onClick={() =>
          openBelow(menuButton.current, mainMenu(env, store.getState(), { renameFile: () => setRenaming(true) }), 'Main menu')
        }
      >
        <Logo />
        <span className="text-dim">
          <Icon name="chevronDown" size={10} />
        </span>
      </button>

      <div className="mx-1 h-5 w-px bg-line" />

      <div role="toolbar" aria-label="Tools" className="flex items-center gap-0.5">
        {TOOLS.map(({ tool: id, icon }) => {
          const command = getCommand(`tool.${id}`) as Command;
          return (
            <button
              key={id}
              type="button"
              className="od-icon-button"
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

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-2">
        {renaming ? (
          <div className="w-56">
            <TextEdit
              label="File name"
              value={name}
              onCancel={() => setRenaming(false)}
              onCommit={(value) => {
                setRenaming(false);
                store.getState().renameDocument(value);
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className="max-w-[40%] truncate rounded-md border-0 bg-transparent px-2 py-1 font-medium hover:bg-hover"
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
          className={`flex-none ${saveStatus === 'error' ? 'text-danger' : 'text-dim'}`}
          title={saveStatus === 'error' ? (saveError ?? 'The file could not be saved') : 'Changes are saved automatically on this device'}
        >
          {SAVE_LABELS[saveStatus]}
        </span>
      </div>

      <button type="button" className="od-icon-button" aria-label="Undo" title={tip(undo)} disabled={!canUndo} onClick={() => run(undo)}>
        <Icon name="undo" />
      </button>
      <button type="button" className="od-icon-button" aria-label="Redo" title={tip(redo)} disabled={!canRedo} onClick={() => run(redo)}>
        <Icon name="redo" />
      </button>

      <div className="mx-1 h-5 w-px bg-line" />

      <button
        ref={zoomButton}
        type="button"
        className="flex h-8 w-[68px] flex-none items-center justify-between rounded-md border-0 bg-transparent px-2 hover:bg-hover"
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
            [
              item('view.zoomIn'),
              item('view.zoomOut'),
              { type: 'separator' },
              item('view.zoomFit'),
              item('view.zoomSelection'),
              { type: 'separator' },
              preset(0.5),
              preset(1),
              preset(2),
              preset(4),
            ],
            'Zoom',
            true,
          );
        }}
      >
        <span>{Math.round(zoom * 100)}%</span>
        <span className="text-dim">
          <Icon name="chevronDown" size={10} />
        </span>
      </button>
      <div className="w-[74px] flex-none">
        <NumberField
          label="Zoom percentage"
          suffix="%"
          min={2}
          max={25600}
          value={Math.round(zoom * 100)}
          onCommit={(value) => setZoom(store, value / 100)}
        />
      </div>

      {popup && <PopupMenu x={popup.x} y={popup.y} items={popup.items} label={popup.label} onClose={() => setPopup(null)} />}
    </header>
  );
}
