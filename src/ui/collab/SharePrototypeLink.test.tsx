// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from '../../collab/api';
import type { DocInfo, LinkAccess } from '../../collab/protocol';
import { audienceOf } from '../prototype/links';
import { DocumentShareDialog } from './ShareDialog';

/**
 * "Copy prototype link" in the Share dialog of a shared file: the link that
 * opens it in presentation is copied, with who it opens for, or shown to be
 * copied by hand when the browser refuses.
 */

const info: DocInfo = {
  id: 'd1',
  name: 'Landing page',
  workspaceId: 'w1',
  role: 'owner',
  linkAccess: 'view',
  owner: { id: 'u1', name: 'Alex', color: '#0d99ff' },
  createdAt: '2026-11-17T10:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
};

const api = createApi({
  auth: () => ({ token: 'session', guestToken: null }),
  fetch: async (url) => {
    if (url === '/api/documents/d1/members') return Response.json({ members: [{ user: { id: 'u1', name: 'Alex', email: 'alex@example.com', color: '#0d99ff' }, role: 'owner' }], pending: [] });
    if (url === '/api/workspaces') return Response.json({ workspaces: [] });
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
});

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { value: writeText ? { writeText } : undefined, configurable: true });
}

afterEach(() => {
  cleanup();
  setClipboard(undefined);
});

function show(linkAccess: LinkAccess, prototypeStartId?: string | null) {
  render(
    <DocumentShareDialog api={api} info={{ ...info, linkAccess }} role="owner" meId="u1" origin="https://evora.example/" prototypeStartId={prototypeStartId} onInfo={() => undefined} onClose={() => undefined} />,
  );
}

describe('Copy prototype link in Share', () => {
  it('copies the link that presents the file, from its first flow, and says who it opens for', async () => {
    const written: string[] = [];
    setClipboard(async (text) => {
      written.push(text);
    });
    show('view');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prototype link' }));
    const status = await screen.findByRole('status', { name: 'Prototype link' });
    expect(written).toEqual(['https://evora.example/#/doc/d1/present']);
    expect(status.textContent).toContain('Prototype link copied.');
    expect(status.textContent).toContain(audienceOf('view'));
    await screen.findByText('Alex');
  });

  it('starts from the frame it is given', async () => {
    const written: string[] = [];
    setClipboard(async (text) => {
      written.push(text);
    });
    show('none', 'F2');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prototype link' }));
    const status = await screen.findByRole('status', { name: 'Prototype link' });
    expect(written).toEqual(['https://evora.example/#/doc/d1/present/F2']);
    expect(status.textContent).toContain(audienceOf('none'));
    await screen.findByText('Alex');
  });

  it('shows the link to copy by hand when the browser refuses', async () => {
    setClipboard(async () => {
      throw new Error('denied');
    });
    show('none');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prototype link' }));
    const status = await screen.findByRole('status', { name: 'Prototype link' });
    expect(status.textContent).toContain('did not allow copying');
    expect(screen.getByRole('textbox', { name: 'Prototype link to copy' })).toHaveProperty('value', 'https://evora.example/#/doc/d1/present');
    await screen.findByText('Alex');
  });
});
