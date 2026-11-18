import { afterEach, describe, expect, it } from 'vitest';
import {
  Mailer,
  MailSettingsError,
  SmtpError,
  buildMessage,
  describeSmtp,
  dotStuff,
  encodeHeaderText,
  isLocalHost,
  mailDate,
  parseSender,
  parseSmtpUrl,
  quotedPrintable,
  sendMail,
  type SmtpSettings,
} from './mail.ts';
import { ConfigError, readConfig, readMailConfig } from './config.ts';
import { decodeQuotedPrintable, fakeSmtp, header, plainText, type FakeSmtp } from './smtp-testing.ts';

const SENDER = parseSender('Evora <noreply@example.com>');

let relay: FakeSmtp | null = null;
afterEach(async () => {
  await relay?.close();
  relay = null;
});

function local(port: number, extra: Partial<SmtpSettings> = {}): SmtpSettings {
  return { security: 'plain', host: '127.0.0.1', port, user: 'relay-user', pass: 's3cret pass', ...extra };
}

describe('the relay address', () => {
  it('reads smtps:// as TLS on 465, smtp:// as STARTTLS on 587, and plain only for this computer', () => {
    expect(parseSmtpUrl('smtps://user:pass@smtp.example.com')).toEqual({ security: 'tls', host: 'smtp.example.com', port: 465, user: 'user', pass: 'pass' });
    expect(parseSmtpUrl('smtp://user:pass@smtp.example.com')).toEqual({ security: 'starttls', host: 'smtp.example.com', port: 587, user: 'user', pass: 'pass' });
    expect(parseSmtpUrl('smtp://smtp.example.com:2525')).toMatchObject({ security: 'starttls', port: 2525, user: null, pass: null });
    expect(parseSmtpUrl('smtp://localhost')).toMatchObject({ security: 'plain', host: 'localhost', port: 25 });
    expect(parseSmtpUrl('smtp://127.0.0.1:1025')).toMatchObject({ security: 'plain', port: 1025 });
    expect(parseSmtpUrl('smtp://[::1]:1025')).toMatchObject({ security: 'plain', host: '::1' });
    expect(parseSmtpUrl('smtps://alex%40example.com:p%40ss%3Aword@smtp.example.com:465')).toMatchObject({ user: 'alex@example.com', pass: 'p@ss:word' });
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('127.0.0.5')).toBe(true);
    expect(isLocalHost('192.168.1.10')).toBe(false);
    expect(isLocalHost('localhost.example.com')).toBe(false);
  });

  it('refuses what is not a relay address, without repeating the password', () => {
    for (const bad of ['http://smtp.example.com', 'not a url', 'smtp://user:hunter2@smtp.example.com/path', 'smtp://:hunter2@smtp.example.com']) {
      let error: unknown;
      try {
        parseSmtpUrl(bad);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(MailSettingsError);
      expect((error as Error).message).not.toContain('hunter2');
    }
  });

  it('is shown without its password', () => {
    const shown = describeSmtp(parseSmtpUrl('smtps://mailer:hunter2@smtp.example.com'));
    expect(shown).toBe('smtps://mailer@smtp.example.com:465 (TLS)');
    expect(shown).not.toContain('hunter2');
    expect(describeSmtp(parseSmtpUrl('smtp://evora%40example.com:hunter2@smtp.example.com'))).toBe('smtp://evora%40example.com@smtp.example.com:587 (STARTTLS)');
  });

  it('is part of the server settings: both variables or neither, with a public URL for the links', () => {
    expect(readConfig([], {}).mail).toBeNull();
    const on = readConfig([], { EVORA_SMTP_URL: 'smtps://u:hunter2@smtp.example.com', EVORA_MAIL_FROM: 'Evora <noreply@example.com>', EVORA_PUBLIC_URL: 'https://evora.example.com' });
    expect(on.mail).toEqual({ smtp: { security: 'tls', host: 'smtp.example.com', port: 465, user: 'u', pass: 'hunter2' }, from: { name: 'Evora', address: 'noreply@example.com' } });
    const refused = [
      { EVORA_SMTP_URL: 'smtps://u:hunter2@smtp.example.com', EVORA_PUBLIC_URL: 'https://evora.example.com' },
      { EVORA_MAIL_FROM: 'noreply@example.com', EVORA_PUBLIC_URL: 'https://evora.example.com' },
      { EVORA_SMTP_URL: 'smtps://u:hunter2@smtp.example.com', EVORA_MAIL_FROM: 'noreply@example.com' },
      { EVORA_SMTP_URL: 'ftp://u:hunter2@smtp.example.com', EVORA_MAIL_FROM: 'noreply@example.com', EVORA_PUBLIC_URL: 'https://evora.example.com' },
      { EVORA_SMTP_URL: 'smtps://u:hunter2@smtp.example.com', EVORA_MAIL_FROM: 'not an address', EVORA_PUBLIC_URL: 'https://evora.example.com' },
    ];
    for (const env of refused) {
      expect(() => readConfig([], env)).toThrow(ConfigError);
      try {
        readMailConfig(env, env.EVORA_PUBLIC_URL ?? null);
      } catch (error) {
        expect((error as Error).message).not.toContain('hunter2');
      }
    }
  });

  it('reads the sender with or without a name', () => {
    expect(parseSender('noreply@example.com')).toEqual({ name: null, address: 'noreply@example.com' });
    expect(parseSender('"Evora Team" <team@example.com>')).toEqual({ name: 'Evora Team', address: 'team@example.com' });
    expect(() => parseSender('Evora <no reply@example.com>')).toThrow(MailSettingsError);
  });
});

describe('the message', () => {
  it('is quoted-printable UTF-8 with lines of at most 76 characters', () => {
    const encoded = quotedPrintable(`Café = ${'x'.repeat(200)} \n.leading dot\nend `);
    for (const line of encoded.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(encoded).toContain('Caf=C3=A9 =3D ');
    expect(encoded).toContain('\r\n.leading dot\r\n');
    expect(encoded.endsWith('end=20')).toBe(true);
    expect(decodeQuotedPrintable(encoded)).toBe(`Café = ${'x'.repeat(200)} \r\n.leading dot\r\nend `);
  });

  it('dot-stuffs every line that starts with a dot, and ends lines in CRLF', () => {
    expect(dotStuff('.one\ntwo\r\n.three\n..four')).toBe('..one\r\ntwo\r\n..three\r\n...four');
  });

  it('encodes a header that is not ASCII, and lets nothing add a header of its own', () => {
    expect(encodeHeaderText('Hello')).toBe('Hello');
    expect(encodeHeaderText('Hi\r\nBcc: victim@example.com')).toBe('Hi Bcc: victim@example.com');
    const encoded = encodeHeaderText('Zoë mentioned you in “Plans”');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = encoded
      .split('\r\n ')
      .map((word) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(word)?.[1] ?? '', 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe('Zoë mentioned you in “Plans”');
  });

  it('has From, To, Subject, Date, Message-ID and both a text and an HTML part', () => {
    const data = buildMessage(
      SENDER,
      { to: 'alex@example.com', subject: 'Welcome\nBcc: x@example.com', text: 'Hello Alex\n.\nBye', html: '<p>Hello Alex</p>' },
      { date: new Date(Date.UTC(2026, 10, 18, 9, 5, 0)), messageId: '<id@example.com>' },
    );
    expect(header(data, 'From')).toBe('"Evora" <noreply@example.com>');
    expect(header(data, 'To')).toBe('alex@example.com');
    expect(header(data, 'Subject')).toBe('Welcome Bcc: x@example.com');
    expect(header(data, 'Bcc')).toBeNull();
    expect(header(data, 'Date')).toBe('Wed, 18 Nov 2026 09:05:00 +0000');
    expect(header(data, 'Message-ID')).toBe('<id@example.com>');
    expect(header(data, 'MIME-Version')).toBe('1.0');
    expect(header(data, 'Content-Type')).toMatch(/^multipart\/alternative; boundary="evora-[0-9a-f]+"$/);
    expect(data).toContain('Content-Type: text/html; charset=UTF-8');
    expect(plainText(data)).toBe('Hello Alex\r\n.\r\nBye');
    expect(data.split('\r\n').every((line) => line.length <= 998)).toBe(true);
    expect(data).not.toMatch(/[^\r]\n/);
    expect(mailDate(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('Thu, 1 Jan 2026 00:00:00 +0000');
    expect(() => buildMessage(SENDER, { to: 'a@example.com\r\nBcc: b@example.com', subject: 's', text: 't', html: 'h' })).toThrow();
  });
});

describe('talking to the relay', () => {
  it('says EHLO, signs in with AUTH PLAIN, sends MAIL FROM, RCPT TO and DATA with dot-stuffing, and quits', async () => {
    relay = await fakeSmtp({ user: 'relay-user', pass: 's3cret pass' });
    const data = buildMessage(SENDER, { to: 'alex@example.com', subject: 'Dots', text: 'first\n.hidden line\n.\nlast', html: '<p>.</p>' });
    await sendMail(local(relay.port), { from: 'noreply@example.com', to: 'alex@example.com' }, data, { clientName: 'evora.test' });
    // STARTTLS is not tried on this computer; the password never shows in the conversation.
    expect(relay.commands).toEqual(['EHLO evora.test', 'AUTH PLAIN (secret)', 'MAIL FROM:<noreply@example.com>', 'RCPT TO:<alex@example.com>', 'DATA', 'QUIT']);
    expect(relay.auth).toEqual([{ method: 'PLAIN', user: 'relay-user', pass: 's3cret pass' }]);
    expect(relay.messages).toHaveLength(1);
    const got = relay.messages[0]!;
    expect(got).toMatchObject({ from: 'noreply@example.com', to: ['alex@example.com'] });
    // On the wire the lines that start with a dot have two; taken off, the message is what was built.
    expect(got.wire).toContain('\r\n..hidden line\r\n..\r\n');
    expect(got.data).toBe(data.replace(/\r\n$/, ''));
    expect(plainText(got.data)).toBe('first\r\n.hidden line\r\n.\r\nlast');
  });

  it('uses AUTH LOGIN when the relay does not offer PLAIN', async () => {
    relay = await fakeSmtp({ user: 'relay-user', pass: 's3cret pass', features: ['AUTH LOGIN'] });
    await sendMail(local(relay.port), { from: 'noreply@example.com', to: 'alex@example.com' }, buildMessage(SENDER, { to: 'alex@example.com', subject: 's', text: 't', html: 'h' }));
    expect(relay.commands.slice(1, 4)).toEqual(['AUTH LOGIN', '(user name)', '(password)']);
    expect(relay.auth).toEqual([{ method: 'LOGIN', user: 'relay-user', pass: 's3cret pass' }]);
    expect(relay.messages).toHaveLength(1);
  });

  it('sends without signing in when no account is given', async () => {
    relay = await fakeSmtp();
    await sendMail(local(relay.port, { user: null, pass: null }), { from: 'noreply@example.com', to: 'alex@example.com' }, buildMessage(SENDER, { to: 'alex@example.com', subject: 's', text: 't', html: 'h' }));
    expect(relay.commands.some((command) => command.startsWith('AUTH'))).toBe(false);
    expect(relay.messages).toHaveLength(1);
  });

  it('fails for good on a wrong password or a refused recipient, and for now on a 4xx', async () => {
    relay = await fakeSmtp({ user: 'relay-user', pass: 'other' });
    const data = buildMessage(SENDER, { to: 'alex@example.com', subject: 's', text: 't', html: 'h' });
    const wrong = await sendMail(local(relay.port), { from: 'noreply@example.com', to: 'alex@example.com' }, data).catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(SmtpError);
    expect(wrong).toMatchObject({ code: 535, permanent: true });
    expect((wrong as Error).message).not.toContain('s3cret');
    relay.options.user = 'relay-user';
    relay.options.pass = 's3cret pass';
    relay.options.refuseRecipient = { reply: '450 4.2.1 Mailbox busy', times: 1 };
    expect(await sendMail(local(relay.port), { from: 'noreply@example.com', to: 'alex@example.com' }, data).catch((error: unknown) => error)).toMatchObject({ code: 450, permanent: false });
    relay.options.refuseRecipient = { reply: '550 5.1.1 No such user', times: 1 };
    expect(await sendMail(local(relay.port), { from: 'noreply@example.com', to: 'alex@example.com' }, data).catch((error: unknown) => error)).toMatchObject({ code: 550, permanent: true });
  });

  it('will not go on without TLS when STARTTLS is wanted and not offered', async () => {
    relay = await fakeSmtp({ features: ['AUTH PLAIN'] });
    const error = await sendMail(local(relay.port, { security: 'starttls' }), { from: 'noreply@example.com', to: 'alex@example.com' }, 'x').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ permanent: true });
    expect((error as Error).message).toMatch(/STARTTLS/);
    // Nothing was said after EHLO: no password, no message.
    expect(relay.commands).toEqual(['EHLO evora.localhost']);
  });

  it('never sends unencrypted to another computer', async () => {
    const error = await sendMail({ security: 'plain', host: 'smtp.example.com', port: 25, user: null, pass: null }, { from: 'a@example.com', to: 'b@example.com' }, 'x').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ permanent: true });
  });

  it('gives up on a relay that does not answer in time', async () => {
    relay = await fakeSmtp({ silent: true });
    const started = Date.now();
    const error = await sendMail(local(relay.port), { from: 'a@example.com', to: 'b@example.com' }, 'x', { timeoutMs: 200 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SmtpError);
    expect((error as Error).message).toMatch(/in time/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('the queue', () => {
  const message = { to: 'alex@example.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' };

  it('returns at once and sends in the background', async () => {
    relay = await fakeSmtp({ user: 'relay-user', pass: 's3cret pass' });
    const mailer = new Mailer({ smtp: local(relay.port), from: SENDER, log: () => undefined });
    expect(mailer.send(message)).toBe(true);
    expect(relay.messages).toHaveLength(0);
    await mailer.idle();
    expect(relay.messages).toHaveLength(1);
    expect(mailer.sent).toBe(1);
    mailer.close();
  });

  it('tries again after a passing failure, further apart each time, and gives up after the last try', async () => {
    const tries: number[] = [];
    const log: string[] = [];
    let failuresLeft = 2;
    const mailer = new Mailer({
      smtp: local(1),
      from: SENDER,
      retryDelaysMs: [20, 40],
      log: (line) => log.push(line),
      transport: async () => {
        tries.push(Date.now());
        if (failuresLeft-- > 0) throw new SmtpError('Busy', 421, false);
      },
    });
    mailer.send(message);
    await mailer.idle();
    expect(tries).toHaveLength(3);
    expect(mailer.sent).toBe(1);
    expect((tries[2] as number) - (tries[1] as number)).toBeGreaterThanOrEqual((tries[1] as number) - (tries[0] as number) - 5);
    expect(log.join('\n')).toMatch(/try 1 of 3.*trying again/);
    expect(log.join('\n')).not.toContain('alex@');

    failuresLeft = 10;
    tries.length = 0;
    mailer.send(message);
    await mailer.idle();
    expect(tries).toHaveLength(3);
    expect(mailer.failed).toBe(1);
    expect(log.at(-1)).toMatch(/try 3 of 3, given up/);
    mailer.close();
  });

  it('does not try again what the relay refused outright', async () => {
    let calls = 0;
    const mailer = new Mailer({
      smtp: local(1),
      from: SENDER,
      retryDelaysMs: [10, 10],
      log: () => undefined,
      transport: async () => {
        calls++;
        throw new SmtpError('No such user', 550, true);
      },
    });
    mailer.send(message);
    await mailer.idle();
    expect(calls).toBe(1);
    expect(mailer.failed).toBe(1);
    mailer.close();
  });

  it('keeps a limit on what waits, and drops what is left when it is closed', async () => {
    let release: () => void = () => undefined;
    const mailer = new Mailer({
      smtp: local(1),
      from: SENDER,
      maxQueued: 2,
      log: () => undefined,
      transport: () => new Promise<void>((resolve) => (release = resolve)),
    });
    expect(mailer.send(message)).toBe(true);
    expect(mailer.send(message)).toBe(true);
    expect(mailer.send(message)).toBe(false);
    expect(mailer.send({ ...message, to: 'not an address' })).toBe(false);
    mailer.close();
    release();
    await mailer.idle();
    expect(mailer.send(message)).toBe(false);
  });
});
