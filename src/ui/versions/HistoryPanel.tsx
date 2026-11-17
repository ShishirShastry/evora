import { useEffect, useMemo, useState } from 'react';
import { getPages, type Document, type NodeId } from '../../core';
import { errorMessage } from '../../collab/api';
import { groupHistory, versionLabel, versionTime } from '../../collab/versions';
import type { ImageSource } from '../../engine/images/imageCache';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { PopupMenu, type MenuItem } from '../components/Menu';
import type { VersionEntry, VersionSource } from './source';
import { CURRENT, versionsActions } from './state';
import { VersionCanvas } from './VersionCanvas';

/**
 * The version history panel, as in Figma: it stands where the properties
 * panel is, lists the file's versions (named ones first-class, autosaves
 * grouped and expandable), and shows the version clicked read-only on the
 * canvas, with a banner to restore it or go back to the current file.
 */

export const PANEL_WIDTH = 288;

interface HistoryPanelProps {
  source: VersionSource;
  canEdit: boolean;
  /** Goes up when the list should be read again. */
  revision: number;
  viewingId: string | null;
  onView: (entry: VersionEntry | null) => void;
  onClose: () => void;
  /** Called after a restore, with what to say. */
  onRestored?: (message: string) => void;
  now?: () => number;
}

export function HistoryPanel({ source, canEdit, revision, viewingId, onView, onClose, onRestored, now = Date.now }: HistoryPanelProps) {
  const [versions, setVersions] = useState<VersionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; entry: VersionEntry } | null>(null);
  const [editing, setEditing] = useState<VersionEntry | null>(null);
  const [deleting, setDeleting] = useState<VersionEntry | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    source.list().then(
      (list) => {
        if (!current) return;
        setVersions(list);
        setError(null);
      },
      (reason: unknown) => {
        if (current) setError(errorMessage(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [source, revision]);

  const items = useMemo(() => groupHistory(versions ?? []), [versions]);

  const restore = (entry: VersionEntry): void => {
    setBusy(true);
    setMessage(null);
    source
      .restore(entry)
      .then((said) => {
        setMessage(said);
        onRestored?.(said);
        onView(null);
        versionsActions.changed();
      })
      .catch((reason: unknown) => setMessage(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  const menuItems = (entry: VersionEntry): MenuItem[] => [
    { label: entry.kind === 'auto' ? 'Name this version…' : 'Edit version info…', disabled: !canEdit, onSelect: () => setEditing(entry) },
    { label: 'Compare with current', onSelect: () => versionsActions.openCompare(entry.id, CURRENT) },
    { label: 'Restore this version', disabled: !canEdit || busy, onSelect: () => restore(entry) },
    { type: 'separator' },
    { label: 'Delete version', danger: true, disabled: !canEdit, onSelect: () => setDeleting(entry) },
  ];

  const row = (entry: VersionEntry, nested = false) => {
    const selected = viewingId === entry.id;
    return (
      <li key={entry.id} className="group relative">
        <button
          type="button"
          aria-current={selected ? 'true' : undefined}
          className={`ev-row flex w-full items-start gap-2.5 rounded-lg border-0 py-2 pr-9 text-left ${nested ? 'pl-7' : 'pl-3'} ${selected ? 'bg-selected' : 'bg-transparent hover:bg-hover'}`}
          onClick={() => onView(selected ? null : entry)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, entry });
          }}
        >
          <span aria-hidden className={`mt-[5px] size-2 flex-none rounded-full ${entry.kind === 'named' ? 'bg-accent' : 'border border-faint'}`} />
          <span className="min-w-0 flex-1">
            <span className={`block truncate ${entry.kind === 'named' ? 'font-semibold text-ink' : 'text-ink'}`}>{versionLabel(entry)}</span>
            <span className="block truncate text-[11px] text-dim">
              {versionTime(entry.createdAt, now())}
              {entry.author ? ` · ${entry.author.name}` : ''}
            </span>
            {entry.description && <span className="mt-0.5 block whitespace-pre-wrap break-words text-[11px] text-dim">{entry.description}</span>}
          </span>
        </button>
        <button
          type="button"
          className="ev-icon-button absolute right-1.5 top-1.5 opacity-60 group-hover:opacity-100"
          aria-label={`More actions for ${versionLabel(entry)}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4, entry });
          }}
        >
          <Icon name="more" />
        </button>
      </li>
    );
  };

  return (
    // 288 px (PANEL_WIDTH) beside the canvas; the whole width on a phone.
    <aside aria-label="Version history" className="ev-panel fixed bottom-1.5 right-1.5 top-1.5 z-40 flex w-[288px] flex-col overflow-hidden max-sm:left-1.5 max-sm:w-auto">
      <header className="flex h-11 flex-none items-center justify-between border-b border-line pl-3.5 pr-1.5">
        <h2 className="ev-section-title text-[12.5px]">Version history</h2>
        <div className="flex items-center gap-0.5">
          <button type="button" className="ev-icon-button" aria-label="Save to version history" title="Save to version history (Ctrl+Alt+S)" disabled={!canEdit} onClick={() => versionsActions.openSave()}>
            <Icon name="plus" />
          </button>
          <button type="button" className="ev-icon-button" aria-label="Close version history" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        <ul aria-label="Versions" className="m-0 flex list-none flex-col gap-0.5 p-0">
          <li>
            <button
              type="button"
              aria-current={viewingId === null ? 'true' : undefined}
              className={`ev-row flex w-full items-start gap-2.5 rounded-lg border-0 py-2 pl-3 pr-3 text-left ${viewingId === null ? 'bg-selected' : 'bg-transparent hover:bg-hover'}`}
              onClick={() => onView(null)}
            >
              <span aria-hidden className="mt-[5px] size-2 flex-none rounded-full bg-success" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Current version</span>
                <span className="block text-[11px] text-dim">{source.kind === 'shared' ? 'Kept on the server as it changes' : 'Saved on this device'}</span>
              </span>
            </button>
          </li>
          {items.map((item) => {
            if (item.type === 'named') return row(item.version);
            const key = item.versions[0]?.id ?? 'autos';
            const open = expanded[key] === true;
            const count = item.versions.length;
            return (
              <li key={`group-${key}`}>
                <button
                  type="button"
                  aria-expanded={open}
                  className="ev-row flex w-full items-center gap-1.5 rounded-lg border-0 bg-transparent py-1.5 pl-1.5 pr-3 text-left text-dim hover:bg-hover hover:text-ink"
                  onClick={() => setExpanded((all) => ({ ...all, [key]: !open }))}
                >
                  <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                  <span>
                    {count} {count === 1 ? 'autosave version' : 'autosave versions'}
                  </span>
                </button>
                {open && <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{item.versions.map((entry) => row(entry, true))}</ul>}
              </li>
            );
          })}
        </ul>
        {versions === null && !error && <p className="m-0 px-3 py-2 text-dim">Reading the history…</p>}
        {versions !== null && versions.length === 0 && (
          <p className="m-0 px-3 py-2 text-dim">
            No versions yet. Versions are saved automatically as the file changes; save one yourself with a name to find it again easily.
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 px-3 py-2 text-danger">
            {error}
          </p>
        )}
      </div>
      {message && (
        <p role="status" className="m-0 flex-none border-t border-line px-3.5 py-2.5 text-dim">
          {message}
        </p>
      )}
      <footer className="flex flex-none gap-2 border-t border-line p-2.5">
        <button type="button" className="ev-button flex-1" onClick={() => versionsActions.openCompare(viewingId, CURRENT)} disabled={(versions?.length ?? 0) === 0}>
          Compare…
        </button>
      </footer>
      {menu && <PopupMenu x={menu.x} y={menu.y} label="Version actions" items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
      {editing && (
        <VersionInfoDialog
          title={editing.kind === 'auto' ? 'Name this version' : 'Edit version info'}
          initial={{ name: editing.name, description: editing.description }}
          submitLabel="Save"
          onClose={() => setEditing(null)}
          onSubmit={async (name, description) => {
            await source.update(editing.id, { name, description });
            versionsActions.changed();
          }}
        />
      )}
      {deleting && (
        <Dialog
          title="Delete version"
          onClose={() => setDeleting(null)}
          width={380}
          footer={
            <>
              <button type="button" className="ev-button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="ev-button ev-button-danger"
                onClick={() => {
                  const entry = deleting;
                  setDeleting(null);
                  source.remove(entry.id).then(
                    () => {
                      if (viewingId === entry.id) onView(null);
                      versionsActions.changed();
                    },
                    (reason: unknown) => setMessage(errorMessage(reason)),
                  );
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p className="m-0">“{versionLabel(deleting)}” will be removed from the history. This cannot be undone; the file itself does not change.</p>
        </Dialog>
      )}
    </aside>
  );
}

/** Naming a version and describing it: "Save to version history", and editing a version's info. */
export function VersionInfoDialog({
  title,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial?: { name: string; description: string };
  submitLabel: string;
  onSubmit: (name: string, description: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    if (!name.trim()) {
      setError('Give the version a name.');
      return;
    }
    setBusy(true);
    onSubmit(name.trim(), description.trim())
      .then(onClose)
      .catch((reason: unknown) => {
        setError(errorMessage(reason));
        setBusy(false);
      });
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={400}
      footer={
        <>
          <button type="button" className="ev-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="ev-button ev-button-primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-dim">Title</span>
          <input data-autofocus className="ev-field h-8 px-2.5" value={name} maxLength={200} placeholder="What changed" onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-dim">Description</span>
          <textarea className="ev-field min-h-20 resize-y px-2.5 py-2" value={description} maxLength={5000} placeholder="Describe what changed (optional)" onChange={(event) => setDescription(event.target.value)} />
        </label>
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/**
 * The version being looked at, read-only, where the canvas is: its pages, the
 * page drawn by the editor's renderer, and the banner to restore it or go back.
 */
export function VersionViewer({
  entry,
  doc,
  images,
  canEdit,
  busy,
  onRestore,
  onBack,
}: {
  entry: VersionEntry;
  doc: Document;
  images?: ImageSource;
  canEdit: boolean;
  busy?: boolean;
  onRestore: () => void;
  onBack: () => void;
}) {
  const pages = getPages(doc);
  const [pageId, setPageId] = useState<NodeId | null>(pages[0]?.id ?? null);
  const shown = pageId !== null && doc.nodes[pageId] ? pageId : (pages[0]?.id ?? null);
  return (
    <section
      role="dialog"
      aria-label={`Viewing ${versionLabel(entry)}`}
      // Beside the history panel (PANEL_WIDTH + 12); over it, the whole screen, on a phone, where "Back to current" returns to the list.
      className="ev-panel fixed bottom-1.5 left-1.5 right-[300px] top-1.5 z-40 flex flex-col overflow-hidden max-sm:right-1.5 max-sm:z-[45]"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="flex min-h-11 flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-elevated px-3.5 py-1.5">
        <span aria-hidden className="size-2 flex-none rounded-full bg-accent" />
        <p className="m-0 min-w-[200px] flex-1 truncate">
          Viewing <strong>{versionLabel(entry)}</strong>
          <span className="text-dim"> — {versionTime(entry.createdAt)}. Read-only: the file is not changed until you restore.</span>
        </p>
        <button type="button" className="ev-button ev-button-primary flex-none" disabled={!canEdit || busy} onClick={onRestore}>
          Restore this version
        </button>
        <button type="button" className="ev-button flex-none" onClick={onBack}>
          Back to current
        </button>
      </div>
      {pages.length > 1 && (
        <div role="tablist" aria-label="Pages of this version" className="flex flex-none gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
          {pages.map((page) => (
            <button
              key={page.id}
              type="button"
              role="tab"
              aria-selected={page.id === shown}
              className={`h-7 flex-none rounded-md border-0 px-2.5 ${page.id === shown ? 'bg-selected text-ink' : 'bg-transparent text-dim hover:bg-hover hover:text-ink'}`}
              onClick={() => setPageId(page.id)}
            >
              {page.name}
            </button>
          ))}
        </div>
      )}
      {shown ? (
        <VersionCanvas key={`${entry.id}:${shown}`} doc={doc} pageId={shown} images={images} label={`${versionLabel(entry)}, ${doc.nodes[shown]?.name ?? 'page'}`} className="flex-1 bg-bg" />
      ) : (
        <p className="m-auto text-dim">This version has no pages.</p>
      )}
    </section>
  );
}
