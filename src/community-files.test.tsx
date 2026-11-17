// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesApi, localFavorites, noteLocalOpened, setLocalFavorite, type FileInfo, type TrashedFile } from './collab/files';
import type { Workspace } from './collab/protocol';
import { createFile } from './persistence/files';
import { MemoryStorage } from './persistence/storage';
import { QuickPage, TrashPage } from './ui/files/FilePages';

/**
 * The file browser's pages for file management, rendered against a fake
 * server: a workspace's trash restores and deletes for good, and Recents and
 * Favorites put the files on this device and shared files together.
 */

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const person = { id: 'u1', name: 'Ana Lima', color: '#0d99ff' };
const workspace: Workspace = { id: 'w1', name: 'Studio', role: 'owner', memberCount: 2, createdAt: '2026-11-01T00:00:00.000Z' };

function shared(id: string, name: string, extra: Partial<FileInfo> = {}): FileInfo {
  return {
    id,
    name,
    workspaceId: 'w1',
    role: 'owner',
    linkAccess: 'none',
    owner: person,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    projectId: null,
    projectName: null,
    workspaceName: 'Studio',
    favorite: false,
    openedAt: null,
    ...extra,
  };
}

describe('the trash page', () => {
  it('lists deleted files, restores one and deletes another for good after asking', async () => {
    let trash: TrashedFile[] = [
      { id: 'd1', name: 'Old landing', workspaceId: 'w1', owner: person, trashedBy: person, trashedAt: new Date().toISOString(), purgeAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), canDelete: true },
      { id: 'd2', name: 'Scratch', workspaceId: 'w1', owner: person, trashedBy: person, trashedAt: new Date().toISOString(), purgeAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), canDelete: true },
    ];
    const asked: string[] = [];
    const files = createFilesApi({
      auth: () => ({ token: 't', guestToken: null }),
      fetch: async (url, init) => {
        const method = init.method ?? 'GET';
        asked.push(`${method} ${url}`);
        if (url === '/api/workspaces/w1/trash') return Response.json(trash);
        if (url === '/api/trash/d1/restore') {
          trash = trash.filter((item) => item.id !== 'd1');
          return Response.json(shared('d1', 'Old landing'));
        }
        if (url === '/api/trash/d2' && method === 'DELETE') {
          trash = trash.filter((item) => item.id !== 'd2');
          return Response.json({});
        }
        return Response.json({ error: 'Not found' }, { status: 404 });
      },
    });
    let restored = 0;
    render(<TrashPage files={files} workspace={workspace} onChanged={() => restored++} />);
    const list = await screen.findByRole('list', { name: 'Deleted files' });
    expect(list.textContent).toContain('Old landing');
    expect(list.textContent).toContain('gone for good in 10 days');

    fireEvent.click(within(list).getByRole('button', { name: 'Restore Old landing' }));
    await waitFor(() => expect(screen.queryByText('Old landing')).toBeNull());
    expect(restored).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Scratch forever' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete forever' });
    expect(dialog.textContent).toContain('This cannot be undone.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete forever' }));
    expect(await screen.findByText('The trash is empty.')).toBeTruthy();
    expect(asked).toContain('DELETE /api/trash/d2');
  });
});

describe('recents and favorites', () => {
  it('shows the files on this device and shared files together, the latest opened first', async () => {
    const storage = new MemoryStorage();
    const local = await createFile(storage, 'Wireframes');
    noteLocalOpened(local.id, localStorage, new Date('2026-11-12T00:00:00.000Z'));
    const files = createFilesApi({
      auth: () => ({ token: 't', guestToken: null }),
      fetch: async (url) => {
        if (url === '/api/recents') return Response.json([shared('d1', 'Brand board', { openedAt: '2026-11-15T00:00:00.000Z' }), shared('d2', 'Old deck', { openedAt: '2026-11-01T00:00:00.000Z' })]);
        return Response.json([]);
      },
    });
    const opened: string[] = [];
    render(<QuickPage kind="recents" storage={storage} files={files} signedIn onOpenLocal={(id) => opened.push(`local:${id}`)} onOpenDoc={(doc) => opened.push(`doc:${doc.id}`)} />);
    const list = await screen.findByRole('list', { name: 'Recents' });
    const names = within(list)
      .getAllByRole('button', { name: /^Open / })
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Open Brand board', 'Open Wireframes', 'Open Old deck']);
    fireEvent.click(within(list).getByRole('button', { name: 'Open Wireframes' }));
    expect(opened).toEqual([`local:${local.id}`]);
  });

  it('lists the favorites of this device without an account, and takes one off from its menu', async () => {
    const storage = new MemoryStorage();
    const kept = await createFile(storage, 'Logo ideas');
    await createFile(storage, 'Not a favorite');
    setLocalFavorite(kept.id, true);
    const files = createFilesApi({ fetch: async () => Response.json({ error: 'Sign in first' }, { status: 401 }), auth: () => ({ token: null, guestToken: null }) });
    render(<QuickPage kind="favorites" storage={storage} files={files} signedIn={false} onOpenLocal={() => undefined} onOpenDoc={() => undefined} />);
    const list = await screen.findByRole('list', { name: 'Favorites' });
    expect(within(list).getAllByRole('button', { name: /^Open / })).toHaveLength(1);
    fireEvent.click(within(list).getByRole('button', { name: 'More actions for Logo ideas' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from favorites' }));
    expect(localFavorites()).toEqual([]);
    expect(await screen.findByText('Add files to your favorites from their menu, and they appear here.')).toBeTruthy();
  });
});
