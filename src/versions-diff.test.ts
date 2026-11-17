import { describe, expect, it } from 'vitest';
import { addLayer, createDocument, createPage, getPages, patchNode, setNodes, type Document } from './core';
import { makeClock, type Register } from './collab/protocol';
import { registersFromDocument } from './collab/registers';
import {
  autoVersionsToDrop,
  createVersionsApi,
  diffCounts,
  diffList,
  documentFromVersion,
  groupConflicts,
  groupHistory,
  nodesIn,
  propertyLabel,
  resolutionsFor,
  versionLabel,
  versionTime,
} from './collab/versions';

/**
 * The pure helpers of version history and branching: the list of layer
 * differences between two documents, the history grouped as Figma shows
 * it, conflicts grouped by layer, and the client for the server's routes.
 */

function base(): { doc: Document; pageId: string; rect: string; text: string } {
  let doc = createDocument('Site');
  const pageId = getPages(doc)[0]!.id;
  const rect = addLayer(doc, 'RECTANGLE', pageId, { name: 'Card', x: 0, y: 0, width: 100, height: 100 });
  doc = rect.doc;
  const text = addLayer(doc, 'TEXT', pageId, { name: 'Title' });
  return { doc: text.doc, pageId, rect: rect.id, text: text.id };
}

describe('diffList', () => {
  it('lists added, removed and changed layers with what changed, readably', () => {
    const { doc, pageId, rect, text } = base();
    let after = patchNode(doc, rect, { x: 40, fills: [] });
    after = setNodes(after, { [text]: null });
    const added = addLayer(after, 'ELLIPSE', pageId, { name: 'Dot' });
    after = added.doc;

    const diffs = diffList(doc, after);
    expect(diffs.find((d) => d.id === rect)).toMatchObject({ kind: 'changed', name: 'Card', type: 'RECTANGLE', pageId, props: ['Position', 'Fill'] });
    expect(diffs.find((d) => d.id === text)).toMatchObject({ kind: 'removed', name: 'Title', pageId });
    expect(diffs.find((d) => d.id === added.id)).toMatchObject({ kind: 'added', name: 'Dot', pageId });
    expect(diffCounts(diffs)).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(diffList(doc, doc)).toEqual([]);
  });

  it('puts pages first and finds the page of nested layers', () => {
    const { doc, rect } = base();
    const frame = addLayer(doc, 'FRAME', getPages(doc)[0]!.id, { name: 'Frame' });
    const inner = addLayer(frame.doc, 'RECTANGLE', frame.id, { name: 'Inner' });
    const page = createPage('Second', 'b');
    const after = setNodes(patchNode(inner.doc, rect, { name: 'Card 2' }), { [page.id]: page });
    const diffs = diffList(frame.doc, after);
    expect(diffs[0]).toMatchObject({ kind: 'added', type: 'PAGE', pageId: page.id });
    expect(diffs.find((d) => d.id === inner.id)?.pageId).toBe(getPages(doc)[0]!.id);
    expect(diffs.find((d) => d.id === rect)?.props).toEqual(['Name']);
  });

  it('works on documents built from a shared version’s registers', () => {
    const { doc, rect } = base();
    const clock = { last: makeClock(0, 0, 'tester'), clientId: 'tester' };
    const registers: Register[] = registersFromDocument(patchNode(doc, rect, { opacity: 0.5 }), clock);
    const version = documentFromVersion(registers, { id: doc.id, name: doc.name });
    expect(diffList(doc, version).find((d) => d.id === rect)?.props).toEqual(['Opacity']);
  });

  it('names properties for people', () => {
    expect(propertyLabel('cornerRadius')).toBe('Corner radius');
    expect(propertyLabel('itemSpacing')).toBe('Item spacing');
  });
});

describe('the history list', () => {
  const v = (id: string, kind: 'auto' | 'named', createdAt: string, name = '') => ({ id, kind, name, createdAt });

  it('shows named versions on their own and groups the autosaves between them, newest first', () => {
    const items = groupHistory([
      v('a1', 'auto', '2026-11-17T09:00:00Z'),
      v('n1', 'named', '2026-11-17T10:00:00Z', 'Draft'),
      v('a2', 'auto', '2026-11-17T11:00:00Z'),
      v('a3', 'auto', '2026-11-17T12:00:00Z'),
      v('n2', 'named', '2026-11-17T13:00:00Z', 'Final'),
    ]);
    expect(items.map((item) => (item.type === 'named' ? item.version.id : item.versions.map((x) => x.id).join('+')))).toEqual(['n2', 'a3+a2', 'n1', 'a1']);
    expect(versionLabel(v('a1', 'auto', ''))).toBe('Autosave');
    expect(versionLabel(v('n', 'named', '', 'Final'))).toBe('Final');
  });

  it('says when, relative to now', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(versionTime('2026-11-17T11:59:30Z', now)).toBe('Just now');
    expect(versionTime('2026-11-17T11:55:00Z', now)).toBe('5 minutes ago');
    expect(versionTime('2026-11-01T09:30:00Z', now)).toMatch(/^1 Nov 2026 at \d\d:\d\d$/);
  });

  it('thins autosaves out by the same rule as the server', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const list = [v('new', 'auto', '2026-11-17T11:00:00Z'), v('d1', 'auto', '2026-11-12T20:00:00Z'), v('d2', 'auto', '2026-11-12T08:00:00Z'), v('n', 'named', '2026-11-12T07:00:00Z')];
    expect(autoVersionsToDrop(list, now)).toEqual(['d2']);
  });
});

describe('conflicts', () => {
  it('are grouped by layer, and a choice per layer becomes a choice per register', () => {
    const { doc, rect, text } = base();
    const conflicts = [
      { key: `n:${rect}:x`, base: 0, main: 1, branch: 2 },
      { key: `n:${rect}:fills`, base: [], main: [], branch: [] },
      { key: `n:${text}:@`, base: true, main: false, branch: true },
      { key: 't:styles:s1', base: null, main: { name: 'Brand' }, branch: { name: 'Brand 2' } },
    ];
    const groups = groupConflicts(conflicts, doc, doc);
    expect(groups.map((g) => [g.label, g.props])).toEqual([
      ['Card', ['Position', 'Fill']],
      ['Title', ['Deleted or kept']],
      ['Style', ['Definition']],
    ]);
    expect(resolutionsFor(groups, { [rect]: 'branch', [text]: 'main' })).toEqual({ [`n:${rect}:x`]: 'branch', [`n:${rect}:fills`]: 'branch', [`n:${text}:@`]: 'main' });
    expect([...nodesIn(conflicts.map((c) => c.key))]).toEqual([rect, text]);
  });
});

describe('the client', () => {
  it('calls the server’s routes with the session and reads its errors', async () => {
    const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
    const api = createVersionsApi({
      auth: () => ({ token: 'tok', guestToken: null }),
      fetch: async (url, init) => {
        const headers = init.headers as Record<string, string>;
        calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? null });
        if (url.endsWith('/merge') && init.method === 'POST') return Response.json({ error: '1 conflict needs a choice' }, { status: 409 });
        if (url.endsWith('/branch')) return Response.json({ branch: null });
        return Response.json({ id: 'v1', name: 'Draft' }, { status: 201 });
      },
    });
    await api.createVersion('d 1', 'Draft', 'Notes');
    expect(await api.branchInfo('d1')).toBeNull();
    await expect(api.merge('b1', { 'n:x:x': 'main' })).rejects.toMatchObject({ status: 409, message: '1 conflict needs a choice' });
    expect(calls).toEqual([
      { url: '/api/documents/d%201/versions', method: 'POST', body: { name: 'Draft', description: 'Notes' }, auth: 'Bearer tok' },
      { url: '/api/documents/d1/branch', method: 'GET', body: undefined, auth: 'Bearer tok' },
      { url: '/api/documents/b1/merge', method: 'POST', body: { resolutions: { 'n:x:x': 'main' } }, auth: 'Bearer tok' },
    ]);
  });
});
