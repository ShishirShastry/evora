import { useEffect, useMemo, useState } from 'react';
import { getPages, type Document, type NodeId } from '../../core';
import { errorMessage } from '../../collab/api';
import { diffCounts, diffList, versionLabel, versionTime, type LayerDiff } from '../../collab/versions';
import type { ImageSource } from '../../engine/images/imageCache';
import type { Size, Viewport } from '../../engine/viewport';
import { Icon } from '../components/Icon';
import type { VersionEntry, VersionSource } from './source';
import { CURRENT } from './state';
import { VersionCanvas, zoomToLayer, type Highlight } from './VersionCanvas';

/**
 * Comparing two versions of a file (or a version and the file as it is now):
 * side by side, two canvases of the same page moving together; overlaid,
 * one over the other with a slider; and the list of the layers that differ,
 * each of which can be clicked to go to it.
 */

type Mode = 'side' | 'overlay';

export function DiffListView({ diffs, focused, onFocus, empty }: { diffs: readonly LayerDiff[]; focused?: NodeId | null; onFocus?: (diff: LayerDiff) => void; empty?: string }) {
  const counts = diffCounts(diffs);
  if (diffs.length === 0) return <p className="m-0 px-3 py-2 text-dim">{empty ?? 'No differences.'}</p>;
  const tone = { added: 'text-success', removed: 'text-danger', changed: 'text-warning' } as const;
  const word = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;
  return (
    <div className="flex flex-col">
      <p className="m-0 px-3 pb-1.5 pt-2 text-[11px] text-dim">
        {counts.added} added · {counts.removed} removed · {counts.changed} changed
      </p>
      <ul aria-label="Differences" className="m-0 flex list-none flex-col gap-0.5 p-0 px-1.5">
        {diffs.map((diff) => (
          <li key={diff.id}>
            <button
              type="button"
              aria-current={focused === diff.id ? 'true' : undefined}
              className={`ev-row flex w-full flex-col items-start rounded-lg border-0 px-2.5 py-1.5 text-left ${focused === diff.id ? 'bg-selected' : 'bg-transparent hover:bg-hover'}`}
              onClick={() => onFocus?.(diff)}
            >
              <span className="flex w-full items-center gap-2">
                <span className={`flex-none text-[10.5px] font-semibold uppercase tracking-wide ${tone[diff.kind]}`}>{word[diff.kind]}</span>
                <span className="min-w-0 flex-1 truncate">{diff.name || diff.type}</span>
                <span className="flex-none text-[11px] capitalize text-faint">{diff.type.toLowerCase()}</span>
              </span>
              {diff.props.length > 0 && <span className="text-[11px] text-dim">{diff.props.join(', ')}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The outlines to draw over each side: what was removed on the older side, what was added or changed on the newer. */
export function highlightsFor(diffs: readonly LayerDiff[], side: 'before' | 'after', focused: NodeId | null): Highlight[] {
  const out: Highlight[] = [];
  for (const diff of diffs) {
    if (diff.type === 'PAGE') continue;
    if (side === 'before' && diff.kind === 'added') continue;
    if (side === 'after' && diff.kind === 'removed') continue;
    out.push({ id: diff.id, tone: diff.id === focused ? 'focus' : diff.kind });
  }
  return out;
}

interface CompareViewProps {
  source: VersionSource;
  /** The file as it is now. */
  current: Document;
  images?: ImageSource;
  initial: { a: string | null; b: string };
  onClose: () => void;
}

export function CompareView({ source, current, images, initial, onClose }: CompareViewProps) {
  const [versions, setVersions] = useState<VersionEntry[] | null>(null);
  const [a, setA] = useState<string | null>(initial.a);
  const [b, setB] = useState<string>(initial.b);
  const [docs, setDocs] = useState<Record<string, Document>>({});
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('side');
  const [mix, setMix] = useState(50);
  const [pageId, setPageId] = useState<NodeId | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [focused, setFocused] = useState<NodeId | null>(null);

  useEffect(() => {
    let live = true;
    source.list().then(
      (list) => {
        if (!live) return;
        setVersions(list);
        // Without a choice: the newest version against the file now.
        setA((chosen) => chosen ?? list[0]?.id ?? CURRENT);
      },
      (reason: unknown) => live && setError(errorMessage(reason)),
    );
    return () => {
      live = false;
    };
  }, [source]);

  // The documents of both sides, read once each.
  useEffect(() => {
    let live = true;
    for (const id of [a, b]) {
      if (!id || id === CURRENT || docs[id] || !versions) continue;
      const entry = versions.find((version) => version.id === id);
      if (!entry) continue;
      source.content(entry).then(
        (doc) => live && setDocs((all) => ({ ...all, [id]: doc })),
        (reason: unknown) => live && setError(errorMessage(reason)),
      );
    }
    return () => {
      live = false;
    };
  }, [a, b, versions, source, docs]);

  const docOf = (id: string | null): Document | null => (id === CURRENT ? current : id ? (docs[id] ?? null) : null);
  const before = docOf(a);
  const after = docOf(b);
  const diffs = useMemo(() => (before && after ? diffList(before, after) : []), [before, after]);

  const pages = useMemo(() => {
    const seen = new Map<NodeId, string>();
    for (const doc of [after, before]) if (doc) for (const page of getPages(doc)) if (!seen.has(page.id)) seen.set(page.id, page.name);
    return [...seen];
  }, [before, after]);
  const page = pageId !== null && pages.some(([id]) => id === pageId) ? pageId : (pages[0]?.[0] ?? null);

  const label = (id: string | null): string => {
    if (id === CURRENT) return 'Current version';
    const entry = versions?.find((version) => version.id === id);
    return entry ? `${versionLabel(entry)} (${versionTime(entry.createdAt)})` : 'Version';
  };

  const focus = (diff: LayerDiff): void => {
    setFocused(diff.id);
    if (diff.type === 'PAGE') {
      setPageId(diff.id);
      setViewport(null);
      return;
    }
    if (diff.pageId) setPageId(diff.pageId);
    const doc = diff.kind === 'removed' ? before : after;
    const next = doc ? zoomToLayer(doc, diff.id, size) : null;
    if (next) setViewport(next);
  };

  const options = (
    <>
      <option value={CURRENT}>Current version</option>
      {(versions ?? []).map((version) => (
        <option key={version.id} value={version.id}>
          {versionLabel(version)} — {versionTime(version.createdAt)}
        </option>
      ))}
    </>
  );

  const onViewport = (next: Viewport, at: Size): void => {
    setViewport(next);
    setSize(at);
  };

  const canvas = (doc: Document | null, side: 'before' | 'after', extra: { opacity?: number; passThrough?: boolean; className?: string } = {}) =>
    doc && page && doc.nodes[page] ? (
      <VersionCanvas
        doc={doc}
        pageId={page}
        images={images}
        viewport={viewport}
        onViewport={onViewport}
        highlights={highlightsFor(diffs, side, focused)}
        label={`${side === 'before' ? label(a) : label(b)}, ${doc.nodes[page]?.name ?? 'page'}`}
        {...extra}
      />
    ) : (
      <div className={`flex items-center justify-center text-dim ${extra.className ?? ''}`}>{doc ? 'This page is not in this version.' : 'Reading…'}</div>
    );

  return (
    <div role="dialog" aria-modal="true" aria-label="Compare versions" className="fixed inset-0 z-50 flex flex-col gap-1.5 bg-bg p-1.5" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <header className="ev-panel flex flex-none flex-wrap items-center gap-2.5 px-3 py-2">
        <h2 className="ev-section-title mr-1 text-[12.5px]">Compare versions</h2>
        <label className="flex items-center gap-1.5">
          <span className="text-dim">From</span>
          <select aria-label="Older side" className="ev-field h-7 max-w-64 px-2 max-sm:max-w-56" value={a ?? ''} onChange={(event) => setA(event.target.value)}>
            {options}
          </select>
        </label>
        <button
          type="button"
          className="ev-icon-button"
          aria-label="Swap sides"
          onClick={() => {
            setA(b);
            setB(a ?? CURRENT);
          }}
        >
          <Icon name="distributeH" />
        </button>
        <label className="flex items-center gap-1.5">
          <span className="text-dim">To</span>
          <select aria-label="Newer side" className="ev-field h-7 max-w-64 px-2 max-sm:max-w-56" value={b} onChange={(event) => setB(event.target.value)}>
            {options}
          </select>
        </label>
        <div role="tablist" aria-label="Comparison" className="ev-segmented ml-2 w-56">
          {(
            [
              ['side', 'Side by side'],
              ['overlay', 'Overlay'],
            ] as const
          ).map(([id, text]) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id} className="ev-segment text-[11.5px]" onClick={() => setMode(id)}>
              {text}
            </button>
          ))}
        </div>
        {pages.length > 1 && (
          <select aria-label="Page" className="ev-field h-7 max-w-48 px-2" value={page ?? ''} onChange={(event) => (setPageId(event.target.value), setViewport(null))}>
            {pages.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <span className="flex-1" />
        <button type="button" className="ev-button" onClick={onClose}>
          Done
        </button>
      </header>
      {error && (
        <p role="alert" className="ev-panel m-0 flex-none px-3 py-2 text-danger">
          {error}
        </p>
      )}
      {/* On a phone the list of changes goes under the canvases, which are stacked. */}
      <div className="flex min-h-0 flex-1 gap-1.5 max-md:flex-col">
        {mode === 'side' ? (
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-2 gap-1.5 max-md:grid-cols-1 max-md:grid-rows-2">
            <section aria-label={`Older: ${label(a)}`} className="ev-panel flex min-h-0 flex-col overflow-hidden">
              <p className="m-0 flex-none truncate border-b border-line px-3 py-1.5 text-dim">{label(a)}</p>
              {canvas(before, 'before', { className: 'flex-1 bg-bg' })}
            </section>
            <section aria-label={`Newer: ${label(b)}`} className="ev-panel flex min-h-0 flex-col overflow-hidden">
              <p className="m-0 flex-none truncate border-b border-line px-3 py-1.5 text-dim">{label(b)}</p>
              {canvas(after, 'after', { className: 'flex-1 bg-bg' })}
            </section>
          </div>
        ) : (
          <section aria-label="Overlay" className="ev-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex flex-none items-center gap-3 border-b border-line px-3 py-1.5">
              <span className="min-w-0 truncate text-dim">{label(a)}</span>
              <input type="range" aria-label="Show the newer side" min={0} max={100} value={mix} className="w-48 flex-none max-sm:w-24" onChange={(event) => setMix(Number(event.target.value))} />
              <span className="min-w-0 truncate text-dim">{label(b)}</span>
            </div>
            <div className="relative min-h-0 flex-1 bg-bg">
              <div className="absolute inset-0 flex">{canvas(before, 'before', { className: 'flex-1' })}</div>
              <div className="pointer-events-none absolute inset-0 flex">{canvas(after, 'after', { className: 'flex-1', opacity: mix / 100, passThrough: true })}</div>
            </div>
          </section>
        )}
        <aside aria-label="Changes" className="ev-panel flex w-72 flex-none flex-col overflow-hidden max-md:h-[34%] max-md:w-auto">
          <h3 className="ev-section-title flex-none border-b border-line px-3 py-2.5">Changes</h3>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {before && after ? <DiffListView diffs={diffs} focused={focused} onFocus={focus} empty="These two are the same." /> : <p className="m-0 px-3 py-2 text-dim">Reading…</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
