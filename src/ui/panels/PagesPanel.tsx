import { useMemo, useState } from 'react';
import { getPages, movePage, patchNodes, type NodeId } from '../../core';
import { copyPage, createPage, removePage } from '../../state/commands';
import { TextEdit } from '../components/Fields';
import { Icon } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { useEditor, useEditorContext } from '../editor/EditorContext';

/** The list of pages in the file: switch, add, rename, duplicate, reorder and delete. */
export function PagesPanel() {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const pages = useMemo(() => getPages(doc), [doc]);
  const [renaming, setRenaming] = useState<NodeId | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const openMenu = (id: NodeId, x: number, y: number): void => {
    const index = pages.findIndex((page) => page.id === id);
    const move = (to: number, label: string): void =>
      store.getState().apply(label, (d) => movePage(d, id, to));
    setMenu({
      x,
      y,
      items: [
        { label: 'Rename', onSelect: () => setRenaming(id) },
        { label: 'Duplicate', onSelect: () => copyPage(store, id) },
        { type: 'separator' },
        { label: 'Move up', disabled: index <= 0, onSelect: () => move(index - 1, 'Move page up') },
        { label: 'Move down', disabled: index >= pages.length - 1, onSelect: () => move(index + 1, 'Move page down') },
        { type: 'separator' },
        { label: 'Delete', danger: true, disabled: pages.length <= 1, onSelect: () => removePage(store, id) },
      ],
    });
  };

  return (
    <section aria-label="Pages" className="flex max-h-[38%] flex-none flex-col border-b border-line">
      <header className="flex h-9 flex-none items-center justify-between pl-3 pr-1.5">
        <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-dim">Pages</h2>
        <button type="button" className="od-icon-button" aria-label="Add page" title="Add page" onClick={() => createPage(store)}>
          <Icon name="plus" />
        </button>
      </header>
      <ul role="listbox" aria-label="Pages" className="m-0 min-h-0 list-none overflow-y-auto p-0 pb-1.5">
        {pages.map((page) => {
          const selected = page.id === pageId;
          return (
            <li
              key={page.id}
              role="option"
              aria-selected={selected}
              tabIndex={0}
              className={`flex h-7 cursor-default items-center gap-2 pl-3 pr-2 outline-none ${
                selected ? 'bg-selected font-medium' : 'hover:bg-hover'
              }`}
              onClick={() => store.getState().setPage(page.id)}
              onDoubleClick={() => setRenaming(page.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(page.id, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  store.getState().setPage(page.id);
                  event.preventDefault();
                } else if (event.key === 'F2') setRenaming(page.id);
              }}
            >
              <span className="w-3 flex-none text-accent">{selected ? <Icon name="check" size={12} /> : null}</span>
              {renaming === page.id ? (
                <TextEdit
                  label="Page name"
                  value={page.name}
                  onCancel={() => setRenaming(null)}
                  onCommit={(name) => {
                    setRenaming(null);
                    store.getState().apply('Rename page', (d) => patchNodes(d, { [page.id]: { name } }));
                  }}
                />
              ) : (
                <span className="truncate">{page.name}</span>
              )}
            </li>
          );
        })}
      </ul>
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="Page menu" onClose={() => setMenu(null)} />}
    </section>
  );
}
