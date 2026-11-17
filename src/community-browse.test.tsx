// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from './collab/api';
import { createCommunityApi, type ResourceDetail } from './collab/community';
import { createFilesApi } from './collab/files';
import { makeClock, newClientId } from './collab/protocol';
import { registersFromDocument } from './collab/registers';
import { createDocument } from './core';
import { MemoryStorage } from './persistence/storage';
import { CommunityScreen } from './ui/community/CommunityScreen';

/**
 * The Community page, rendered against a fake server: browsing lists what
 * the server answers, searching, choosing a type and sorting ask the server
 * again, a card leads to its page, the plugins tab copes with a server that
 * has no directory, and a resource's page keeps a copy on this device without
 * an account.
 */

afterEach(cleanup);

const author = { id: 'u1', name: 'Ana Lima', color: '#0d99ff' };
const base = { description: '', tags: ['mobile'], author, coverAt: null, duplicates: 3, createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:00:00.000Z' };
const kit = { ...base, id: 'r1', kind: 'ui-kit' as const, title: 'Mobile kit', version: 2 };
const icons = { ...base, id: 'r2', kind: 'icons' as const, title: 'Line icons', version: 1, duplicates: 0 };

function server(options: { directory?: 'missing' | 'empty' | 'some' } = {}) {
  const asked: string[] = [];
  const source = createDocument('Mobile kit');
  const registers = registersFromDocument(source, { last: makeClock(0, 0, ''), clientId: newClientId() });
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    asked.push(`${method} ${url}`);
    if (url.startsWith('/api/community/resources?') || url === '/api/community/resources') {
      const query = new URL(url, 'http://x').searchParams;
      let items = [kit, icons];
      if (query.get('kind')) items = items.filter((item) => item.kind === query.get('kind'));
      if (query.get('q')) items = items.filter((item) => item.title.toLowerCase().includes((query.get('q') ?? '').toLowerCase()));
      return Response.json({ items, total: items.length });
    }
    if (url === '/api/community/tags') return Response.json([{ tag: 'mobile', count: 2 }]);
    if (url.startsWith('/api/plugins/directory')) {
      if (options.directory === 'missing' || !options.directory) return Response.json({ error: 'Not found' }, { status: 404 });
      if (options.directory === 'empty') return Response.json([]);
      return Response.json([{ id: 'p1', name: 'Lorem filler', description: 'Fills text layers', version: '1.2.0', kind: 'plugin', author: { id: 'u1', name: 'Ana Lima' }, installs: 12, updatedAt: base.updatedAt }]);
    }
    if (url === '/api/community/resources/r1') {
      const detail: ResourceDetail = {
        ...kit,
        description: 'Buttons, cards and lists.',
        versions: [
          { number: 2, name: 'Mobile kit', notes: 'Dark mode', createdAt: base.createdAt, assetCount: 0 },
          { number: 1, name: 'Mobile kit', notes: '', createdAt: base.createdAt, assetCount: 0 },
        ],
      };
      return Response.json(detail);
    }
    if (url === '/api/community/resources/r1/copies' && method === 'POST') return Response.json({ resourceId: 'r1', number: 2, name: 'Mobile kit', registers, assets: [] });
    return Response.json({ error: 'Not found' }, { status: 404 });
  };
  const auth = () => ({ token: null, guestToken: null });
  return { asked, community: createCommunityApi({ fetch, auth }), api: createApi({ fetch, auth }), files: createFilesApi({ fetch, auth }) };
}

function renderScreen(fake: ReturnType<typeof server>, resourceId: string | null = null) {
  const went: string[] = [];
  const storage = new MemoryStorage();
  render(<CommunityScreen storage={storage} resourceId={resourceId} onNavigate={(hash) => went.push(hash)} api={fake.api} community={fake.community} files={fake.files} />);
  return { went, storage };
}

describe('the Community page', () => {
  it('lists what was published, with who made it and how often it was duplicated', async () => {
    const fake = server();
    renderScreen(fake);
    const list = await screen.findByRole('list', { name: 'Resources' });
    expect(within(list).getByRole('button', { name: 'Open Mobile kit' })).toBeTruthy();
    expect(within(list).getByRole('button', { name: 'Open Line icons' })).toBeTruthy();
    expect(list.textContent).toContain('Ana Lima');
    expect(list.textContent).toContain('3 duplicates');
    expect(screen.getByRole('status').textContent).toBe('2 resources');
    // Browsing needs no account: nothing asks for one, and "Your resources" is not offered.
    expect(screen.queryByRole('tab', { name: 'Your resources' })).toBeNull();
  });

  it('searches, filters by type and tag, and sorts, asking the server each time', async () => {
    const fake = server();
    renderScreen(fake);
    await screen.findByRole('list', { name: 'Resources' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the Community' }), { target: { value: 'line' } });
    await waitFor(() => expect(fake.asked).toContain('GET /api/community/resources?q=line&limit=24'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Mobile kit' })).toBeNull());
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the Community' }), { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Mobile kit' })).toBeTruthy());

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'UI kit' }));
    await waitFor(() => expect(fake.asked).toContain('GET /api/community/resources?kind=ui-kit&limit=24'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Line icons' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '#mobile' }));
    await waitFor(() => expect(fake.asked).toContain('GET /api/community/resources?kind=ui-kit&tag=mobile&limit=24'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), { target: { value: 'popular' } });
    await waitFor(() => expect(fake.asked).toContain('GET /api/community/resources?kind=ui-kit&tag=mobile&sort=popular&limit=24'));
  });

  it('opens a resource’s page from its card', async () => {
    const fake = server();
    const { went } = renderScreen(fake);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Mobile kit' }));
    expect(went).toEqual(['#/community/r1']);
  });

  it('says so when the server has no plugin directory, or nothing in it, and lists what it has', async () => {
    renderScreen(server({ directory: 'missing' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins & widgets' }));
    expect(await screen.findByText('This server has no plugin directory yet.')).toBeTruthy();
    cleanup();

    renderScreen(server({ directory: 'empty' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins & widgets' }));
    expect(await screen.findByText('No plugins or widgets have been published yet.')).toBeTruthy();
    cleanup();

    const fake = server({ directory: 'some' });
    renderScreen(fake);
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins & widgets' }));
    const plugins = await screen.findByRole('list', { name: 'Plugins' });
    expect(plugins.textContent).toContain('Lorem filler');
    expect(plugins.textContent).toContain('12 installs');
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'widget' } });
    await waitFor(() => expect(fake.asked).toContain('GET /api/plugins/directory?kind=widget'));
  });

  it('shows a resource’s page with its versions, and keeps a copy on this device without an account', async () => {
    const fake = server();
    const { went, storage } = renderScreen(fake, 'r1');
    const page = await screen.findByRole('article', { name: 'Mobile kit' });
    expect(page.textContent).toContain('Buttons, cards and lists.');
    expect(within(page).getByRole('region', { name: 'Versions' }).textContent).toContain('Dark mode');
    expect(within(page).getByRole('combobox', { name: 'Version' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open a copy on this device' }));
    await waitFor(() => expect(went).toHaveLength(1));
    const id = /^#\/file\/([0-9A-Za-z]+)$/.exec(went[0] ?? '')?.[1] ?? '';
    const saved = await storage.load(id);
    expect(saved?.document.name).toBe('Mobile kit');
    expect(fake.asked).toContain('POST /api/community/resources/r1/copies');

    // Duplicating into a workspace asks for an account first.
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByRole('dialog', { name: 'Create an account' })).toBeTruthy();
  });
});
