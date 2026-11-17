// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from '../../collab/api';
import type { DocInfo, Role } from '../../collab/protocol';
import { DocumentShareDialog } from './ShareDialog';

/**
 * The Share dialog of a shared document, rendered: choosing who can open the
 * link sends the change to the server and shows what the server kept, a
 * refusal puts the choice back and says why, and someone who may only view
 * cannot change it.
 */

afterEach(cleanup);

const info: DocInfo = {
  id: 'd1',
  name: 'Landing page',
  workspaceId: 'w1',
  role: 'owner',
  linkAccess: 'none',
  owner: { id: 'u1', name: 'Ana Lima', color: '#0d99ff' },
  createdAt: '2026-11-17T10:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
};

const members = {
  members: [
    { user: { id: 'u1', name: 'Ana Lima', email: 'ana@example.com', color: '#0d99ff' }, role: 'owner' },
    { user: { id: 'u2', name: 'Bob Stone', email: 'bob@example.com', color: '#14ae5c' }, role: 'viewer' },
  ],
  pending: [{ email: 'cleo@example.com', role: 'editor', createdAt: '2026-11-17T10:00:00.000Z' }],
};

/** A server that keeps the document's link access, or refuses to change it. */
function server(refuse = false) {
  const patches: unknown[] = [];
  let linkAccess = info.linkAccess;
  const api = createApi({
    auth: () => ({ token: 'session', guestToken: null }),
    fetch: async (url, init) => {
      const method = init.method ?? 'GET';
      if (url === '/api/documents/d1/members') return Response.json(members);
      if (url === '/api/workspaces/w1/members') return Response.json({ members: members.members, pending: [] });
      if (url === '/api/documents/d1' && method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { linkAccess: DocInfo['linkAccess'] };
        patches.push(body);
        if (refuse) return Response.json({ error: 'Only owners and editors can change who can open the link.' }, { status: 403 });
        linkAccess = body.linkAccess;
        return Response.json({ ...info, linkAccess });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
  return { api, patches };
}

function show(role: Role, refuse = false) {
  const { api, patches } = server(refuse);
  const changed: DocInfo[] = [];
  render(<DocumentShareDialog api={api} info={info} role={role} meId="u1" origin="https://evora.example/" onInfo={(next) => changed.push(next)} onClose={() => undefined} />);
  return { patches, changed };
}

describe('the Share dialog’s link access', () => {
  it('shows the three choices with the document’s own checked', async () => {
    show('owner');
    const group = screen.getByRole('radiogroup', { name: 'Link access' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual([
      expect.stringContaining('No one'),
      expect.stringContaining('Anyone with the link can view'),
      expect.stringContaining('Anyone with the link can edit'),
    ]);
    expect(within(group).getByRole('radio', { name: /No one/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Link to this file' })).toHaveProperty('value', 'https://evora.example/#/doc/d1');
    // The people with access are read from the server, invitations not yet taken up among them.
    expect(await screen.findByText('Bob Stone')).toBeTruthy();
    expect(screen.getByText('cleo@example.com')).toBeTruthy();
  });

  it('sends the choice to the server and keeps what the server answers', async () => {
    const { patches, changed } = show('owner');
    fireEvent.click(screen.getByRole('radio', { name: /Anyone with the link can edit/ }));
    expect(screen.getByRole('radio', { name: /Anyone with the link can edit/ }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(changed).toHaveLength(1));
    expect(patches).toEqual([{ linkAccess: 'edit' }]);
    expect(changed[0]?.linkAccess).toBe('edit');
    expect(screen.getByRole('radio', { name: /No one/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('puts the choice back and says why when the server refuses it', async () => {
    const { patches, changed } = show('editor', true);
    fireEvent.click(screen.getByRole('radio', { name: /Anyone with the link can view/ }));
    expect(await screen.findByText('Only owners and editors can change who can open the link.')).toBeTruthy();
    expect(patches).toEqual([{ linkAccess: 'view' }]);
    expect(changed).toEqual([]);
    expect(screen.getByRole('radio', { name: /No one/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Anyone with the link can view/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('cannot be changed by someone who may only view, who cannot invite either', async () => {
    const { patches } = show('viewer');
    const edit = screen.getByRole('radio', { name: /Anyone with the link can edit/ });
    expect(edit).toHaveProperty('disabled', true);
    fireEvent.click(edit);
    expect(patches).toEqual([]);
    expect(screen.queryByRole('form', { name: 'Invite people' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Email address to invite' })).toBeNull();
    await screen.findByText('Bob Stone');
  });

  it('says that sharing is free for any number of people', () => {
    show('owner');
    expect(screen.getByText(/Free · unlimited people/)).toBeTruthy();
  });
});
