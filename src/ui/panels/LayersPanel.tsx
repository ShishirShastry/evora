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

/** Height of one row of the list in pixels: the `h-7` of a row. */
export const LAYER_ROW_HEIGHT = 28;
/** Rows kept either side of the ones in view, so that scrolling does not show a gap. */
const OVERSCAN_ROWS = 8;

/**
 * Which rows of the list need to exist: the ones in view and a few either
 * side. A page can hold thousands of layers; the list never makes more
 * elements than fit on screen.
 */
export function visibleRows(count: number, scrollTop: number, viewHeight: number, rowHeight = LAYER_ROW_HEIGHT, overscan = OVERSCAN_ROWS): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.min(count - 1, Math.floor(top / rowHeight));
  const last = Math.max(first + 1, Math.ceil((top + Math.max(0, viewHeight)) / rowHeight));
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
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

  // Only the rows in view are rendered. What is in view follows the list's scroll position and height.
  const [view, setView] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = (): void =>
      setView((current) => (current.top === list.scrollTop && current.height === list.clientHeight ? current : { top: list.scrollTop, height: list.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  const { start, end } = visibleRows(rows.length, view.top, view.height);

  // Keep the selected layer in view when it was selected on the canvas. Its row may not exist yet,
  // so the list is scrolled to where the row is rather than to the row.
  const firstSelected = selection[0];
  useEffect(() => {
    const list = listRef.current;
    if (firstSelected === undefined || !list) return;
    const index = rows.findIndex((row) => row.node.id === firstSelected);
    if (index < 0) return;
    const top = index * LAYER_ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + LAYER_ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + LAYER_ROW_HEIGHT - list.clientHeight;
    // Only a change of selection moves the list; the rows are read as they are at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * How a row is lit: 2 when it is selected, 1 when a layer it sits inside is
   * selected (Figma's lighter tint for the contents of a selection), 0 when not.
   * Lit neighbours join into one block with rounded ends. Display only.
   */
  const lit = (index: number): 0 | 1 | 2 => {
    const row = rows[index];
    if (!row || selected.size === 0) return 0;
    if (selected.has(row.node.id)) return 2;
    for (let parent = doc.nodes[row.node.parentId]; isLayer(parent); parent = doc.nodes[parent.parentId]) {
      if (selected.has(parent.id)) return 1;
    }
    return 0;
  };

  return (
    <section aria-label="Layers" className="flex min-h-0 flex-1 flex-col">
      {/* Figma's section head: a quiet sentence-case title. */}
      <header className="flex h-9 flex-none items-center pl-3 pr-1.5">
        <h2 className="ev-section-title">Layers</h2>
      </header>
      {/* No padding above the rows: row N sits at N × LAYER_ROW_HEIGHT, which the scrolling and the virtual list rely on. */}
      <div
        ref={listRef}
        role="tree"
        aria-label="Layers"
        aria-multiselectable="true"
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
        onScroll={(event) => {
          const { scrollTop, clientHeight } = event.currentTarget;
          setView((current) => (current.top === scrollTop && current.height === clientHeight ? current : { top: scrollTop, height: clientHeight }));
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) store.getState().setSelection([]);
        }}
      >
        {rows.length === 0 && (
          // An empty page: a soft well pressed into the panel, with a raised frame mark in it.
          <div className="mx-1.5 mt-1 flex flex-col items-center gap-2.5 rounded-[10px] bg-field px-4 py-5 text-center" style={{ boxShadow: 'var(--ev-sunk)' }}>
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-dim"
              style={{ background: 'var(--ev-button)', boxShadow: 'var(--ev-raise)' }}
            >
              <Icon name="frame" size={15} />
            </span>
            <p className="m-0 text-[11px] leading-relaxed text-dim">
              This page is empty. Pick a shape or frame tool in the toolbar and drag on the canvas.
            </p>
          </div>
        )}
        {/* The space of the rows above the ones in view, so the scroll bar is that of the whole list. */}
        {start > 0 && <div role="presentation" style={{ height: start * LAYER_ROW_HEIGHT }} />}
        {rows.slice(start, end).map((row, offset) => {
          const { node } = row;
          const isSelected = selected.has(node.id);
          const dropHere = drop?.id === node.id ? drop.position : null;
          // Display only: the row's tint, its corners where it joins lit neighbours, and its icon's colour.
          const index = start + offset;
          const level = lit(index);
          const joinUp = level > 0 && lit(index - 1) > 0;
          const joinDown = level > 0 && lit(index + 1) > 0;
          const corners = joinUp ? (joinDown ? '' : 'rounded-b-md') : joinDown ? 'rounded-t-md' : 'rounded-md';
          const hovered = hoveredId === node.id;
          const tint =
            level === 2
              ? 'bg-selected'
              : level === 1
                ? hovered
                  ? 'bg-selected/70'
                  : 'bg-selected/40 hover:bg-selected/70'
                : hovered
                  ? 'bg-hover'
                  : 'hover:bg-hover';
          const isComponent = node.type === 'FRAME' && (node.kind === 'COMPONENT' || node.kind === 'COMPONENT_SET' || node.kind === 'INSTANCE');
          const iconTone = !node.visible ? 'text-faint' : isComponent ? 'text-accent' : isSelected ? 'text-ink' : 'text-dim';
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
              className={`ev-row group relative flex h-7 cursor-default items-center pr-1 ${corners} ${tint} ${
                dropHere === 'inside' ? 'outline outline-1 -outline-offset-1 outline-accent' : ''
              } ${node.visible ? '' : 'text-faint'}`}
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
                  className="pointer-events-none absolute right-1 z-10 h-0.5 rounded-full bg-accent"
                  style={{ left: 6 + row.depth * 14, [dropHere === 'above' ? 'top' : 'bottom']: -1 }}
                >
                  {/* Figma's insertion mark: a small ring where the line starts. */}
                  <span aria-hidden="true" className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full border-2 border-accent bg-panel" />
                </span>
              )}
              <button
                type="button"
                className={`flex h-5 w-4 flex-none items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors duration-150 hover:text-ink ${
                  isSelected ? 'text-dim' : 'text-faint group-hover:text-dim'
                }`}
                style={{ visibility: row.hasChildren ? 'visible' : 'hidden' }}
                aria-label={row.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  store.getState().setCollapsed(node.id, row.expanded);
                }}
              >
                {/* One chevron that turns, rather than two that swap. */}
                <span aria-hidden="true" className={`flex transition-transform duration-150 ease-out ${row.expanded ? 'rotate-90' : ''}`}>
                  <Icon name="chevronRight" size={10} />
                </span>
              </button>
              <span className={`mr-1.5 flex flex-none items-center transition-colors duration-150 ${iconTone}`}>
                <Icon
                  name={
                    node.isMask
                      ? 'mask'
                      : node.type === 'BOOLEAN_OPERATION'
                        ? OPERATION_ICONS[node.operation]
                        : node.type === 'FRAME' && (node.kind === 'COMPONENT' || node.kind === 'COMPONENT_SET')
                          ? 'component'
                          : node.type === 'FRAME' && node.kind === 'INSTANCE'
                            ? 'instance'
                            : // A frame that lays out its children shows which way.
                              node.type === 'FRAME' && node.layoutMode !== 'NONE'
                          ? node.layoutMode === 'VERTICAL'
                            ? 'layoutColumn'
                            : 'layoutRow'
                          : TYPE_ICONS[node.type]
                  }
                  size={13}
                />
              </span>
              {renamingId === node.id ? (
                <TextEdit
                  label="Layer name"
                  value={node.name}
                  className="-ml-1.5 flex-1 !px-1.5"
                  onCancel={() => store.getState().setRenaming(null)}
                  onCommit={(name) => {
                    store.getState().setRenaming(null);
                    renameNode(store, node.id, name);
                  }}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
              )}
              {/* Lock and visibility: quiet until the row is hovered or a key reaches them; always shown while they are on. */}
              <span
                className={`flex flex-none transition-opacity duration-150 ${
                  node.locked || !node.visible ? '' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
                }`}
              >
                <button
                  type="button"
                  className={`ev-icon-button !h-6 !w-6 ${node.locked ? '' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'}`}
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
                  className={`ev-icon-button !h-6 !w-6 ${node.visible ? 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100' : ''}`}
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
        {end < rows.length && <div role="presentation" style={{ height: (rows.length - end) * LAYER_ROW_HEIGHT }} />}
      </div>
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="Layer menu" onClose={() => setMenu(null)} />}
    </section>
  );
}
