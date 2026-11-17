// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesApi, type FileInfo } from './collab/files';
import { MemoryStorage } from './persistence/storage';
import { QuickPage } from './ui/files/FilePages';
import { FileTable } from './ui/files/parts';

/**
 * Branches in the file browser: the server lists a branch with its main file
 * (`branches`), not on its own; the lists show them under the main file,
 * behind a disclosure, each opening the branch.
 */

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const person = { id: 'u1', name: 'Ana Lima', color: '#0d99ff' };

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
    favorite: true,
    openedAt: null,
    ...extra,
  };
}

const twoBranches = {
  mainId: null,
  branches: [
    { id: 'b2', name: 'Dark mode', updatedAt: '2026-11-12T00:00:00.000Z', createdBy: person, role: 'owner' as const },
    { id: 'b1', name: 'Bigger buttons', updatedAt: '2026-11-11T00:00:00.000Z', createdBy: person, role: 'editor' as const },
  ],
};

describe('branches under their main file', () => {
  it('shows a main file’s branches in the grid behind a disclosure, and opens one', async () => {
    const files = createFilesApi({
      auth: () => ({ token: 't', guestToken: null }),
      fetch: async (url) => (url === '/api/favorites' ? Response.json([shared('d1', 'Checkout', twoBranches), shared('d2', 'Pricing', { mainId: null, branches: [] }), shared('d3', 'Logo')]) : Response.json([])),
    });
    const opened: string[] = [];
    render(<QuickPage kind="favorites" storage={new MemoryStorage()} files={files} signedIn onOpenLocal={() => undefined} onOpenDoc={(doc) => opened.push(doc.id)} />);
    const list = await screen.findByRole('list', { name: 'Favorites' });
    // Only the main files are files; only Checkout has branches, and they are hidden at first.
    expect(within(list).getAllByRole('button', { name: /^Open / }).map((button) => button.getAttribute('aria-label'))).toEqual(['Open Checkout', 'Open Pricing', 'Open Logo']);
    expect(within(list).queryByRole('list', { name: 'Branches of Checkout' })).toBeNull();
    expect(within(list).queryByRole('button', { name: /branch(es)? of (Pricing|Logo)$/ })).toBeNull();

    const toggle = within(list).getByRole('button', { name: 'Show 2 branches of Checkout' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide 2 branches of Checkout');
    const branches = within(list).getByRole('list', { name: 'Branches of Checkout' });
    expect(toggle.getAttribute('aria-controls')).toBe(branches.id);
    expect(within(branches).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Open branch Dark mode', 'Open branch Bigger buttons']);
    fireEvent.click(within(branches).getByRole('button', { name: 'Open branch Bigger buttons' }));
    expect(opened).toEqual(['b1']);
    // Opening a branch does not open its main file as well.
    fireEvent.click(toggle);
    expect(within(list).queryByRole('list', { name: 'Branches of Checkout' })).toBeNull();
  });

  it('shows them under the row in the list view', () => {
    const opened: string[] = [];
    render(
      <FileTable
        label="Shared files"
        rows={[
          {
            id: 'd1',
            name: 'Checkout',
            location: 'Studio',
            updatedAt: '2026-11-10T00:00:00.000Z',
            createdAt: '2026-11-10T00:00:00.000Z',
            favorite: false,
            shared: true,
            onOpen: () => opened.push('d1'),
            menu: () => [],
            branches: [{ id: 'b1', name: 'One', updatedAt: '2026-11-11T00:00:00.000Z', onOpen: () => opened.push('b1') }],
          },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Shared files' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(within(table).getByRole('button', { name: 'Show 1 branch of Checkout' }));
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    fireEvent.click(within(table).getByRole('button', { name: 'Open branch One' }));
    expect(opened).toEqual(['b1']);
  });
});
