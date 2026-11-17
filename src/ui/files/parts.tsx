import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { create } from 'zustand';
import { localFavorites, localFilesVersion, localRecents, subscribeLocalFiles, type SortKey } from '../../collab/files';
import { timeAgo } from '../collab/hooks';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';

/**
 * The parts the file browser's lists share (Phase 9, advanced file
 * management): a toolbar to filter, sort and switch between grid and list,
 * the list view, a few icons of its own, and the favourites and recents of
 * this device.
 */

// ------------------------------------------------------------------ icons

const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const GLYPHS = {
  search: (
    <>
      <circle {...s} cx="7" cy="7" r="4.3" />
      <path {...s} d="M10.2 10.2l3.3 3.3" />
    </>
  ),
  grid: <path {...s} d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" />,
  list: <path {...s} d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5" />,
  folder: <path {...s} d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  globe: (
    <>
      <circle {...s} cx="8" cy="8" r="5.5" />
      <path {...s} d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5z" />
    </>
  ),
  clock: (
    <>
      <circle {...s} cx="8" cy="8" r="5.5" />
      <path {...s} d="M8 5v3.2l2 1.3" />
    </>
  ),
  starFilled: <path d="M8 2.2l1.7 3.7 4 .5-3 2.7.8 4L8 11.1l-3.5 2 .8-4-3-2.7 4-.5z" fill="currentColor" />,
  download: <path {...s} d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2M3 13.5h10" />,
  copy: <path {...s} d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />,
  restore: <path {...s} d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 3v2.6h2.6" />,
};

export type GlyphName = keyof typeof GLYPHS;

/** Icons this part of the app needs that the shared set does not have, drawn the same way. */
export function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {GLYPHS[name]}
    </svg>
  );
}

// ------------------------------------------------------------------ shared state

interface FilesState {
  /** Changes when projects or files change somewhere, so that lists read again. */
  version: number;
  bump: () => void;
}

/** A tiny store that tells the file browser's parts that something changed (a project made, a file moved). */
export const useFilesStore = create<FilesState>((set) => ({
  version: 0,
  bump: () => set((state) => ({ version: state.version + 1 })),
}));

/** The favourites and recents of this device, kept up to date. */
export function useLocalFileMarks(): { favorites: string[]; recents: { id: string; openedAt: string }[] } {
  useSyncExternalStore(subscribeLocalFiles, localFilesVersion, localFilesVersion);
  return { favorites: localFavorites(), recents: localRecents() };
}

// ------------------------------------------------------------------ list preferences

export type ViewMode = 'grid' | 'list';

export interface ListPrefs {
  view: ViewMode;
  sort: SortKey;
  filter: string;
}

const PREFS_KEY = 'evora:file-list';

function readPrefs(): { view: ViewMode; sort: SortKey } {
  try {
    const value = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { view?: unknown; sort?: unknown };
    return {
      view: value.view === 'list' ? 'list' : 'grid',
      sort: value.sort === 'name' || value.sort === 'created' ? value.sort : 'edited',
    };
  } catch {
    return { view: 'grid', sort: 'edited' };
  }
}

/** How a list is shown: grid or list and the sort order are remembered on this device; the filter is not. */
export function useListPrefs(): [ListPrefs, (changes: Partial<ListPrefs>) => void] {
  const [prefs, setPrefs] = useState<ListPrefs>(() => ({ ...readPrefs(), filter: '' }));
  const change = (changes: Partial<ListPrefs>): void =>
    setPrefs((current) => {
      const next = { ...current, ...changes };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ view: next.view, sort: next.sort }));
      } catch {
        // Not kept: fine.
      }
      return next;
    });
  return [prefs, change];
}

export const SORT_LABELS: Record<SortKey, string> = { edited: 'Last edited', created: 'Date created', name: 'Alphabetical' };

/** Filter, sort, and grid or list: above each list of files, as in Figma's file browser. */
export function FileToolbar({ prefs, onChange, children }: { prefs: ListPrefs; onChange: (changes: Partial<ListPrefs>) => void; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {children}
      <div className="flex-1" />
      <label className="ev-input-shell flex h-7 w-48 items-center gap-1.5 px-2 text-dim">
        <Glyph name="search" size={14} />
        <input
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-ink outline-none placeholder:text-faint"
          aria-label="Filter files"
          placeholder="Filter"
          value={prefs.filter}
          onChange={(event) => onChange({ filter: event.target.value })}
        />
      </label>
      <select aria-label="Sort by" className="ev-field !h-7 !w-auto" value={prefs.sort} onChange={(event) => onChange({ sort: event.target.value as SortKey })}>
        {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
          <option key={key} value={key}>
            {SORT_LABELS[key]}
          </option>
        ))}
      </select>
      <div role="radiogroup" aria-label="Show files as" className="ev-segmented">
        {(['grid', 'list'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={prefs.view === mode}
            style={prefs.view === mode ? { background: 'var(--ev-button)', color: 'var(--ev-ink)', boxShadow: 'var(--ev-raise)' } : undefined}
            aria-label={mode === 'grid' ? 'Grid view' : 'List view'}
            title={mode === 'grid' ? 'Grid view' : 'List view'}
            className="ev-segment !flex !h-6 !w-8 !flex-none items-center justify-center"
            onClick={() => onChange({ view: mode })}
          >
            <Glyph name={mode} size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the list view

export interface FileRow {
  id: string;
  name: string;
  /** Where it is: "This device", a workspace, a project. */
  location: string;
  owner?: string;
  updatedAt: string;
  createdAt: string;
  favorite: boolean;
  shared: boolean;
  onOpen: () => void;
  menu: () => MenuItem[];
}

/** Files as rows of a table: name, where, last edited, created, and each one's menu. */
export function FileTable({ rows, label }: { rows: FileRow[]; label: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const now = Date.now();
  return (
    <>
      <table aria-label={label} className="w-full border-separate border-spacing-0 overflow-hidden rounded-[12px] bg-panel text-left shadow-[var(--ev-shadow-panel)]">
        <thead>
          <tr className="text-[11px] text-dim">
            <th className="border-b border-line py-2 pl-3 font-medium">Name</th>
            <th className="hidden border-b border-line py-2 font-medium sm:table-cell">Location</th>
            <th className="border-b border-line py-2 font-medium">Last edited</th>
            <th className="hidden border-b border-line py-2 font-medium md:table-cell">Created</th>
            <th className="w-10 border-b border-line py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="ev-row group hover:bg-hover"
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, items: row.menu() });
              }}
            >
              <td className="border-b border-line/60 py-1.5 pl-3">
                <button type="button" className="flex min-w-0 items-center gap-2 border-0 bg-transparent p-0 text-left text-ink" aria-label={`Open ${row.name}`} onClick={row.onOpen}>
                  <span aria-hidden="true" className="flex h-6 w-6 flex-none items-center justify-center rounded-[6px] bg-field text-dim shadow-[var(--ev-sunk)]">
                    <Glyph name={row.shared ? 'globe' : 'folder'} size={13} />
                  </span>
                  <span className="truncate text-[12.5px] font-medium">{row.name}</span>
                  {row.favorite && (
                    <span className="flex-none text-[#ffc21a]" title="Favorite">
                      <Glyph name="starFilled" size={12} />
                      <span className="sr-only">(favorite)</span>
                    </span>
                  )}
                </button>
              </td>
              <td className="hidden max-w-[220px] truncate border-b border-line/60 py-1.5 text-[11.5px] text-dim sm:table-cell">{row.location}</td>
              <td className="border-b border-line/60 py-1.5 text-[11.5px] text-dim">{timeAgo(row.updatedAt, now)}</td>
              <td className="hidden border-b border-line/60 py-1.5 text-[11.5px] text-dim md:table-cell">{timeAgo(row.createdAt, now)}</td>
              <td className="border-b border-line/60 py-1 pr-1.5 text-right">
                <button
                  type="button"
                  className="ev-icon-button"
                  aria-label={`More actions for ${row.name}`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: rect.right - 200, y: rect.bottom + 4, items: row.menu() });
                  }}
                >
                  <Icon name="more" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {menu && <PopupMenu x={menu.x} y={menu.y} items={menu.items} label="File menu" onClose={() => setMenu(null)} />}
    </>
  );
}

/** Asking before something that cannot be undone (or that takes a file away from others). */
export function Confirm({ title, action, children, onConfirm, onClose, danger = true }: { title: string; action: string; children: ReactNode; onConfirm: () => void; onClose: () => void; danger?: boolean }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ev-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`ev-button ${danger ? 'ev-button-danger' : 'ev-button-primary'}`}
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {action}
          </button>
        </>
      }
    >
      <p className="m-0 leading-relaxed text-dim">{children}</p>
    </Dialog>
  );
}

/** A note of failure above a list. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 mb-4 rounded-[8px] bg-danger/10 px-3 py-2.5 leading-relaxed text-danger ring-1 ring-danger/30 ring-inset">
      {children}
    </p>
  );
}
