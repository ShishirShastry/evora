// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, type Document } from './core';
import { HistoryPanel, VersionViewer } from './ui/versions/HistoryPanel';
import { DiffListView } from './ui/versions/CompareView';
import { menuItems } from './ui/versions/menu';
import type { VersionEntry, VersionSource } from './ui/versions/source';
import { versionsActions, versionsUi } from './ui/versions/state';
import { createEditorStore } from './state/editorStore';

/**
 * The version history panel, rendered: the list (named versions on their
 * own, autosaves grouped and expandable), looking at a version, naming,
 * restoring and deleting one, what someone who may only view can do, the
 * viewing banner, the list of differences, and the menu entries.
 */

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  cleanup();
  versionsActions.reset();
});

const NOW = Date.parse('2026-11-17T12:00:00Z');

function fakeSource(canned: VersionEntry[]) {
  let versions = [...canned];
  const source: VersionSource & { calls: string[] } = {
    kind: 'shared',
    calls: [],
    list: async () => versions,
    content: async () => createDocument('Old'),
    create: async (name, description) => {
      const made: VersionEntry = { id: `v${versions.length + 1}`, kind: 'named', name, description, createdAt: new Date(NOW).toISOString(), author: null };
      versions = [made, ...versions];
      return made;
    },
    update: async (id, changes) => {
      source.calls.push(`update ${id} ${changes.name}/${changes.description}`);
      versions = versions.map((v) => (v.id === id ? { ...v, ...changes, kind: changes.name ? 'named' : v.kind } : v));
      return versions.find((v) => v.id === id) as VersionEntry;
    },
    remove: async (id) => {
      source.calls.push(`remove ${id}`);
      versions = versions.filter((v) => v.id !== id);
    },
    restore: async (entry) => {
      source.calls.push(`restore ${entry.id}`);
      return `Restored “${entry.name || 'Autosave'}” for everyone.`;
    },
  };
  return source;
}

const ana = { id: 'u1', name: 'Ana Lima', color: '#0d99ff' };
const history: VersionEntry[] = [
  { id: 'n2', kind: 'named', name: 'Final', description: 'Signed off', createdAt: '2026-11-17T11:30:00Z', author: ana },
  { id: 'a2', kind: 'auto', name: '', description: '', createdAt: '2026-11-17T11:00:00Z', author: null },
  { id: 'a1', kind: 'auto', name: '', description: '', createdAt: '2026-11-17T10:00:00Z', author: null },
  { id: 'n1', kind: 'named', name: 'Draft', description: '', createdAt: '2026-11-16T09:00:00Z', author: ana },
];

/** Renders the panel as the mount does, re-rendering when the list changes. */
function renderPanel(source: VersionSource, canEdit = true) {
  const onView = vi.fn();
  const view = () => (
    <HistoryPanel source={source} canEdit={canEdit} revision={versionsUi.getState().revision} viewingId={null} onView={onView} onClose={() => undefined} now={() => NOW} />
  );
  const result = render(view());
  const stop = versionsUi.subscribe(() => result.rerender(view()));
  stops.push(stop);
  return { onView, stop };
}

describe('the version history panel', () => {
  it('lists named versions on their own and groups autosaves, expandable', async () => {
    const { stop } = renderPanel(fakeSource(history));
    const panel = screen.getByRole('complementary', { name: 'Version history' });
    expect(within(panel).getByRole('button', { name: /Current version/ })).toHaveProperty('ariaCurrent', 'true');
    await within(panel).findByRole('button', { name: /^Final/ });
    expect(within(panel).getByText('Signed off')).toBeTruthy();
    expect(within(panel).getByText('30 minutes ago · Ana Lima')).toBeTruthy();
    const group = within(panel).getByRole('button', { name: '2 autosave versions' });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(within(panel).queryByRole('button', { name: /^Autosave/ })).toBeNull();
    fireEvent.click(group);
    expect(within(panel).getAllByRole('button', { name: /^Autosave/ })).toHaveLength(2);
    // Newest first: Final, the autosaves, then Draft.
    const titles = within(panel)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => /^(Final|Autosave|Draft)/.test(t))
      .map((t) => t.replace(/(Today|Yesterday|\d).*/, ''));
    expect(titles).toEqual(['Final', 'Autosave', 'Autosave', 'Draft']);
    stop();
  });

  it('shows a version when it is clicked', async () => {
    const { onView, stop } = renderPanel(fakeSource(history));
    fireEvent.click(await screen.findByRole('button', { name: /^Draft/ }));
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }));
    stop();
  });

  it('names an autosave, restores and deletes versions from a version’s menu', async () => {
    const source = fakeSource(history);
    const { stop } = renderPanel(source);
    fireEvent.click(await screen.findByRole('button', { name: '2 autosave versions' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'More actions for Autosave' })[0]!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Name this version…' }));
    const dialog = screen.getByRole('dialog', { name: 'Name this version' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Before the review' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Colours agreed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(source.calls).toContain('update a2 Before the review/Colours agreed'));
    // Now a named version of its own.
    expect(await screen.findByRole('button', { name: /^Before the review/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Final' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore this version' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Restored “Final” for everyone.');
    expect(source.calls).toContain('restore n2');

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Draft' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete version' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete version' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Draft/ })).toBeNull());
    expect(source.calls).toContain('remove n1');
    stop();
  });

  it('lets someone who may only view look, but not change the history', async () => {
    const { stop } = renderPanel(fakeSource(history), false);
    expect(screen.getByRole('button', { name: 'Save to version history' })).toHaveProperty('disabled', true);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Final' }));
    expect(screen.getByRole('menuitem', { name: 'Restore this version' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Delete version' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Compare with current' }).getAttribute('aria-disabled')).not.toBe('true');
    stop();
  });

  it('says when there are no versions yet', async () => {
    const { stop } = renderPanel(fakeSource([]));
    expect(await screen.findByText(/No versions yet/)).toBeTruthy();
    stop();
  });
});

describe('looking at a version', () => {
  it('shows a banner to restore it or go back to the current file', () => {
    const onRestore = vi.fn();
    const onBack = vi.fn();
    const doc: Document = createDocument('Then');
    render(<VersionViewer entry={history[0]!} doc={doc} canEdit onRestore={onRestore} onBack={onBack} />);
    const viewer = screen.getByRole('dialog', { name: 'Viewing Final' });
    expect(within(viewer).getByRole('img', { name: /^Final, / })).toBeTruthy();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Restore this version' }));
    fireEvent.click(within(viewer).getByRole('button', { name: 'Back to current' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('the list of differences', () => {
  it('shows each layer with what changed, and goes to it when clicked', () => {
    const onFocus = vi.fn();
    const diffs = [
      { id: 'r', kind: 'changed' as const, name: 'Card', type: 'RECTANGLE', pageId: 'p', props: ['Position', 'Fill'] },
      { id: 't', kind: 'added' as const, name: 'Title', type: 'TEXT', pageId: 'p', props: [] },
    ];
    render(<DiffListView diffs={diffs} onFocus={onFocus} />);
    expect(screen.getByText('1 added · 0 removed · 1 changed')).toBeTruthy();
    expect(screen.getByText('Position, Fill')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Title/ }));
    expect(onFocus).toHaveBeenCalledWith(diffs[1]);
  });
});

describe('the menu', () => {
  const env = { store: createEditorStore(createDocument('File')), app: {} as never };

  it('offers version history for every file, and branches for shared ones', () => {
    const state = env.store.getState();
    expect(menuItems(env, state).map((item) => ('label' in item ? item.label : '-'))).toEqual(['Show version history', 'Save to version history…', 'Compare versions…']);
    versionsActions.setContext({ shared: true, docId: 'd1', signedIn: true });
    expect(menuItems(env, state).map((item) => ('label' in item ? item.label : '-'))).toEqual([
      'Show version history',
      'Save to version history…',
      'Compare versions…',
      '-',
      'Create branch…',
      'Show branches…',
    ]);
    versionsActions.setContext({
      branch: { id: 'd1', name: 'Idea', mainId: 'm', mainName: 'Main', status: 'open', baseSeq: 3, createdBy: ana, createdAt: '', mergedAt: null, mergedBy: null },
    });
    const labels = menuItems(env, state).map((item) => ('label' in item ? item.label : '-'));
    expect(labels).toContain('Update from main…');
    expect(labels).toContain('Merge into main…');

    const show = menuItems(env, state)[0]!;
    if ('onSelect' in show) show.onSelect();
    expect(versionsUi.getState().panelOpen).toBe(true);
  });
});
