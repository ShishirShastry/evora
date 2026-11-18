// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAccount, setAccountStorage, type KeyValueStore } from '../../collab/account';
import { createEmailApi, needsVerifying, type EmailStatus } from '../../collab/email';
import { parseRoute } from '../App';
import { EmailSettingsDialog, VerifyEmailNotice, VerifyEmailScreen } from './Email';

/**
 * Email in the app: the "Confirm your email address" notice shows only for an
 * account whose address is not confirmed on a server that sends email, and
 * sends the link again; the page a link opens confirms it once; the setting
 * for mention emails is saved on the server.
 */

class MemoryKeyValues implements KeyValueStore {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/** A stand-in server for the email routes. */
function server(start: Partial<EmailStatus> = {}) {
  const calls: string[] = [];
  let status: EmailStatus = { mail: true, email: 'alex@example.com', verified: false, mentionEmails: true, ...start };
  let used = false;
  const api = createEmailApi({
    auth: () => ({ token: 'session', guestToken: null }),
    fetch: async (url, init) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url === '/api/me/email' && method === 'GET') return Response.json(status);
      if (url === '/api/me/email' && method === 'PATCH') {
        status = { ...status, ...(JSON.parse(String(init.body)) as Partial<EmailStatus>) };
        return Response.json(status);
      }
      if (url === '/api/me/email/resend') return Response.json({ sent: true });
      if (url === '/api/auth/verify-email') {
        const { token } = JSON.parse(String(init.body)) as { token: string };
        if (token !== 'good-token-0123456789abcdef' || used) return Response.json({ error: 'This link is not valid, or was already used' }, { status: 400 });
        used = true;
        return Response.json({ email: 'alex@example.com', verified: true });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
  return { api, calls };
}

beforeEach(() => {
  setAccountStorage(new MemoryKeyValues());
  setAccount({ token: 'session', user: { id: 'u1', email: 'alex@example.com', name: 'Alex', color: '#0d99ff', createdAt: '2026-11-18T10:00:00.000Z' } });
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  setAccountStorage(null);
});

describe('the notice', () => {
  it('asks to confirm the address and sends the link again', async () => {
    const { api, calls } = server();
    render(<VerifyEmailNotice api={api} />);
    const notice = await screen.findByRole('region', { name: 'Confirm your email address' });
    expect(notice.textContent).toContain('alex@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Resend' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Sent/));
    expect(calls).toContain('POST /api/me/email/resend');
  });

  it('offers to send a link when none was sent, and names a new address waiting for its link', async () => {
    const { api } = server({ linkSent: false });
    render(<VerifyEmailNotice api={api} />);
    const notice = await screen.findByRole('region', { name: 'Confirm your email address' });
    expect(notice.textContent).toContain('Send a link to alex@example.com');
    expect(notice.textContent).not.toContain('We sent');
    fireEvent.click(screen.getByRole('button', { name: 'Send a link' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resend' })).toBeTruthy());
    cleanup();

    const moving = server({ verified: true, pendingEmail: 'alex.new@example.com', linkSent: true });
    render(<VerifyEmailNotice api={moving.api} />);
    expect((await screen.findByRole('region', { name: 'Confirm your email address' })).textContent).toContain('We sent a link to alex.new@example.com');
  });

  it('is not shown when the address is confirmed, or the server sends no email', async () => {
    for (const status of [{ verified: true }, { mail: false }]) {
      const { api, calls } = server(status);
      const { container } = render(<VerifyEmailNotice api={api} />);
      await waitFor(() => expect(calls).toContain('GET /api/me/email'));
      expect(container.textContent).toBe('');
      cleanup();
    }
    expect(needsVerifying(null)).toBe(false);
    expect(needsVerifying({ mail: true, email: 'a@example.com', verified: false, mentionEmails: true })).toBe(true);
  });
});

describe('the confirmation page', () => {
  it('has its own address', () => {
    expect(parseRoute('#/verify-email/good-token-0123456789abcdef')).toEqual({ screen: 'verify-email', token: 'good-token-0123456789abcdef' });
    expect(parseRoute('#/verify-email/')).toEqual({ screen: 'home', view: { kind: 'local' } });
  });

  it('confirms the address once, and takes the token out of the address bar', async () => {
    window.location.hash = '#/verify-email/good-token-0123456789abcdef';
    const { api, calls } = server();
    render(<VerifyEmailScreen token="good-token-0123456789abcdef" api={api} onHome={() => undefined} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/alex@example\.com is confirmed/));
    expect(calls.filter((call) => call === 'POST /api/auth/verify-email')).toHaveLength(1);
    expect(window.location.hash).toBe('#/');
  });

  it('says what went wrong with a link that does not work', async () => {
    const { api } = server();
    render(<VerifyEmailScreen token="wrong-token-0123456789abcdef" api={api} onHome={() => undefined} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/not valid/);
  });
});

describe('the email settings', () => {
  it('turns mention emails off', async () => {
    const { api, calls } = server({ verified: true });
    render(<EmailSettingsDialog api={api} onClose={() => undefined} />);
    const box = await screen.findByRole('checkbox', { name: 'Email me when someone mentions me in a comment' });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    expect(calls).toContain('PATCH /api/me/email');
  });

  it('says when the server sends no email', async () => {
    const { api } = server({ mail: false });
    render(<EmailSettingsDialog api={api} onClose={() => undefined} />);
    expect(await screen.findByText(/does not send email/)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });
});
