import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import {
  getChildIds,
  isContainer,
  isLayer,
  reparentNodes,
  type Document,
  type LayerNode,
  type NodeId,
} from '../../core';
import { renameNode, toggleLocked, toggleVisible } from '../../state/commands';
import { TextEdit } from '../components/Fields';
import { Icon, type IconName } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { layerMenu } from '../editor/menus';

interface Row {
  node: LayerNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

const TYPE_ICONS: Record<LayerNode['type'], IconName> = {
  FRAME: 'frame',
  GROUP: 'group',
  RECTANGLE: 'rectangle',
  ELLIPSE: 'ellipse',
  LINE: 'line',
  POLYGON: 'polygon',
  STAR: 'star',
  TEXT: 'text',
  VECTOR: 'vector',
  BOOLEAN_OPERATION: 'union',
};

const OPERATION_ICONS = { UNION: 'union', SUBTRACT: 'subtract', INTERSECT: 'intersect', EXCLUDE: 'exclude' } as const;

/** Flattens the page's tree into the rows shown in the panel: top-most layer first. */
export function buildRows(doc: Document, pageId: NodeId, collapsed: Readonly<Record<NodeId, true>>): Row[] {
  const rows: Row[] = [];
  const walk = (parentId: NodeId, depth: number): void => {
    const children = getChildIds(doc, parentId);
    for (let i = children.length - 1; i >= 0; i--) {
      const node = doc.nodes[children[i] as NodeId];
      if (!isLayer(node)) continue;
      const hasChildren = getChildIds(doc, node.id).length > 0;
      const expanded = hasChildren && !collapsed[node.id];
      rows.push({ node, depth, hasChildren, expanded });
      if (expanded) walk(node.id, depth + 1);
    }
  };
  walk(pageId, 0);
  return rows;
}

type DropPosition = 'above' | 'below' | 'inside';

/**
 * The layer tree of the current page. It is a direct view of the document:
 * selecting, renaming, hiding, locking, reordering and nesting here all go
 * through the same store and operations as the canvas.
 */
export function LayersPanel() {
  const context = useEditorContext();
  const { store } = context;
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const selection = useEditor((s) => s.selection);
  const collapsed = useEditor((s) => s.collapsed);
  const hoveredId = useEditor((s) => s.hoveredId);
  const renamingId = useEditor((s) => s.renamingId);

  const rows = useMemo(() => buildRows(doc, pageId, collapsed), [doc, pageId, collapsed]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const anchor = useRef<NodeId | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [drop, setDrop] = useState<{ id: NodeId; position: DropPosition } | null>(null);
  const dragging = useRef<NodeId[]>([]);

  // Keep the selected layer in view when it was selected on the canvas.
  const firstSelected = selection[0];
  useEffect(() => {
    if (firstSelected === undefined) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-layer-id="${firstSelected}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [firstSelected]);

  const onRowClick = (event: MouseEvent, id: NodeId): void => {
    const state = store.getState();
    if (event.shiftKey && anchor.current) {
      const from = rows.findIndex((row) => row.node.id === anchor.current);
      const to = rows.findIndex((row) => row.node.id === id);
      if (from >= 0 && to >= 0) {
        const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.node.id);
        state.setSelection(range);
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      state.setSelection(selected.has(id) ? selection.filter((other) => other !== id) : [...selection, id]);
    } else {
      state.setSelection([id]);
    }
    anchor.current = id;
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>, row: Row): void => {
    if (dragging.current.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    const container = isContainer(row.node);
    const position: DropPosition = container
      ? ratio < 0.28
        ? 'above'
        : ratio > 0.72
          ? 'below'
          : 'inside'
      : ratio < 0.5
        ? 'above'
        : 'below';
    if (drop?.id !== row.node.id || drop.position !== position) setDrop({ id: row.node.id, position });
  };

  const onDrop = (): void => {
    const ids = dragging.current;
    const target = drop;
    dragging.current = [];
    setDrop(null);
    if (!target || ids.length === 0 || ids.includes(target.id)) return;
    store.getState().apply('Move layers', (d) => {
      const node = d.nodes[target.id];
      if (!isLayer(node)) return d;
      if (target.position === 'inside') return reparentNodes(d, ids, target.id);
      // The panel lists the top-most layer first, so "above" a row means a higher index.
      const siblings = getChildIds(d, node.parentId).filter((id) => !ids.includes(id));
      const index = siblings.indexOf(target.id) + (target.position === 'above' ? 1 : 0);
      return reparentNodes(d, ids, node.parentId, index);
    });
    if (target.position === 'inside') store.getState().setCollapsed(target.id, false);
  };

  return (
    <section aria-label="Layers" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-9 flex-none items-center pl-3">
        <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-dim">Layers</h2>
      </header>
      <div
        ref={listRef}
        role="tree"
        aria-label="Layers"
        aria-multiselectable="true"
        className="min-h-0 flex-1 overflow-y-auto pb-3"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) store.getState().setSelection([]);
        }}
      >
        {rows.length === 0 && (
          <p className="m-0 px-3 py-2 text-dim">
            This page is empty. Pick a shape or frame tool in the toolbar and drag on the canvas.
          </p>
        )}
        {rows.map((row) => {
          const { node } = row;
          const isSelected = selected.has(node.id);
          const dropHere = drop?.id === node.id ? drop.position : null;
          return (
            <div
              key={node.id}
              role="treeitem"
              data-layer-id={node.id}
              aria-label={node.name}
              aria-selected={isSelected}
              aria-level={row.depth + 1}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              draggable={renamingId !== node.id}
              className={`group relative flex h-7 cursor-default items-center pr-1 ${
                isSelected ? 'bg-selected' : hoveredId === node.id ? 'bg-hover' : 'hover:bg-hover'
              } ${dropHere === 'inside' ? 'outline outline-1 -outline-offset-1 outline-accent' : ''} ${
                node.visible ? '' : 'text-faint'
              }`}
              style={{ paddingLeft: 6 + row.depth * 14 }}
              onClick={(event) => onRowClick(event, node.id)}
              onDoubleClick={() => store.getState().setRenaming(node.id)}
              onMouseEnter={() => store.getState().setHovered(node.id)}
              onMouseLeave={() => store.getState().setHovered(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!isSelected) store.getState().setSelection([node.id]);
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: layerMenu({ store, app: context.app }, store.getState()),
                });
              }}
              onDragStart={(event) => {
                dragging.current = isSelected ? [...selection] : [node.id];
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', node.name);
              }}
              onDragEnd={() => {
                dragging.current = [];
                setDrop(null);
              }}
              onDragOver={(event) => onDragOver(event, row)}
              onDrop={(event) => {
                event.preventDefault();
                onDrop();
              }}
            >
              {dropHere && dropHere !== 'inside' && (
                <span
                  className="pointer-events-none absolute right-0 h-0.5 bg-accent"
                  style={{ left: 6 + row.depth * 14, [dropHere === 'above' ? 'top' : 'bottom']: -1 }}
                />
              )}
              <button
                type="button"
                className="flex h-5 w-4 flex-none items-center justify-center border-0 bg-transparent p-0 text-dim"
                style={{ visibility: row.hasChildren ? 'visible' : 'hidden' }}
                aria-label={row.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  store.getState().setCollapsed(node.id, row.expanded);
                }}
              >
                <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={10} />
              </button>
              <span className={`mr-1.5 flex-none ${isSelected ? 'text-accent' : 'text-dim'}`}>
                <Icon name={node.isMask ? 'mask' : node.type === 'BOOLEAN_OPERATION' ? OPERATION_ICONS[node.operation] : TYPE_ICONS[node.type]} size={13} />
              </span>
              {renamingId === node.id ? (
                <TextEdit
                  label="Layer name"
                  value={node.name}
                  className="flex-1"
                  onCancel={() => store.getState().setRenaming(null)}
                  onCommit={(name) => {
                    store.getState().setRenaming(null);
                    renameNode(store, node.id, name);
                  }}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
              )}
              <span className={`flex flex-none ${node.locked || !node.visible ? '' : 'opacity-0 group-hover:opacity-100'}`}>
                <button
                  type="button"
                  className={`od-icon-button !h-6 !w-6 ${node.locked ? '' : 'opacity-0 group-hover:opacity-100'}`}
                  aria-label={node.locked ? `Unlock ${node.name}` : `Lock ${node.name}`}
                  title={node.locked ? 'Unlock' : 'Lock'}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleLocked(store, [node.id]);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <Icon name={node.locked ? 'lock' : 'unlock'} size={13} />
                </button>
                <button
                  type="button"
                  className={`od-icon-button !h-6 !w-6 ${node.visible ? 'opacity-0 group-hover:opacity-100' : ''}`}
                  aria-label={node.visible ? `Hide ${node.name}` : `Show ${node.name}`}
                  title={node.visible ? 'Hide' : 'Show'}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleVisible(store, [node.id]);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <Icon name={node.visible ? 'eye' : 'eyeOff'} size={13} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="Layer menu" onClose={() => setMenu(null)} />}
    </section>
  );
}
