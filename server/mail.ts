/**
 * Sending email, with Node's own `node:net` and `node:tls` only: a small SMTP
 * client (RFC 5321) and a queue in front of it.
 *
 * - Where to send is one address, EVORA_SMTP_URL (server/config.ts):
 *   `smtps://user:pass@smtp.example.com:465` is TLS from the first byte,
 *   `smtp://user:pass@smtp.example.com:587` starts plain and must switch to
 *   TLS with STARTTLS before anything else is said. Mail is sent unencrypted
 *   only to a relay on this computer (`smtp://localhost:25`), never across a
 *   network. Certificates are checked.
 * - Signing in to the relay is AUTH PLAIN, or AUTH LOGIN where PLAIN is not
 *   offered, and only over TLS (or to this computer).
 * - A message is UTF-8 text and HTML (multipart/alternative, quoted-printable),
 *   with Date and Message-ID; lines end in CRLF and a line that starts with a
 *   dot is sent with two (the "dot-stuffing" of RFC 5321 §4.5.2).
 * - Every step has a time limit, so a relay that stops answering does not hold
 *   anything up for long.
 * - The `Mailer` queue takes a message and returns at once: a request never
 *   waits for mail. A message that fails for a passing reason (a 4xx answer, a
 *   dropped connection) is tried again a few times, further apart each time;
 *   one the relay refuses outright (5xx) is not.
 *
 * The relay's password is never written to the log or put in an error message.
 */
import { randomBytes } from 'node:crypto';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';

// ------------------------------------------------------------------ settings

/** How the connection to the relay is protected. */
export type SmtpSecurity = 'tls' | 'starttls' | 'plain';

export interface SmtpSettings {
  security: SmtpSecurity;
  host: string;
  port: number;
  /** The relay account, or null to send without signing in. */
  user: string | null;
  pass: string | null;
}

/** A mail setting that is not one; its message never contains the password. */
export class MailSettingsError extends Error {}

/** Whether a host is this computer, the only place mail may be sent to without TLS. */
export function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || (isIP(bare) === 4 && bare.startsWith('127.'));
}

/**
 * Reads EVORA_SMTP_URL. `smtps://` is implicit TLS (port 465 unless given),
 * `smtp://` is STARTTLS (port 587 unless given), or plain to this computer
 * only (port 25 unless given). The user name and password may be
 * percent-encoded (an `@` in a user name is `%40`).
 */
export function parseSmtpUrl(text: string): SmtpSettings {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new MailSettingsError('EVORA_SMTP_URL is not an address (write it as smtps://user:password@smtp.example.com:465 or smtp://user:password@smtp.example.com:587)');
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') throw new MailSettingsError(`EVORA_SMTP_URL must start with smtps:// or smtp://, not ${url.protocol}//`);
  if (!url.hostname) throw new MailSettingsError('EVORA_SMTP_URL has no host');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new MailSettingsError('EVORA_SMTP_URL must not have a path or a query');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = isLocalHost(host);
  const security: SmtpSecurity = url.protocol === 'smtps:' ? 'tls' : local ? 'plain' : 'starttls';
  const port = url.port ? Number(url.port) : security === 'tls' ? 465 : security === 'starttls' ? 587 : 25;
  let user: string | null = null;
  let pass: string | null = null;
  try {
    user = url.username ? decodeURIComponent(url.username) : null;
    pass = url.password ? decodeURIComponent(url.password) : null;
  } catch {
    throw new MailSettingsError('EVORA_SMTP_URL: the user name or password is not percent-encoded properly');
  }
  if (pass !== null && user === null) throw new MailSettingsError('EVORA_SMTP_URL has a password without a user name');
  return { security, host, port, user, pass };
}

/** The relay as it may be shown in the log: no password. */
export function describeSmtp(settings: SmtpSettings): string {
  const scheme = settings.security === 'tls' ? 'smtps' : 'smtp';
  const how = settings.security === 'tls' ? 'TLS' : settings.security === 'starttls' ? 'STARTTLS' : 'unencrypted, this computer only';
  const host = settings.host.includes(':') ? `[${settings.host}]` : settings.host;
  return `${scheme}://${settings.user ? `${encodeURIComponent(settings.user)}@` : ''}${host}:${settings.port} (${how})`;
}

// ------------------------------------------------------------------ addresses

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$|^[^\s@<>()",;:\\[\]]+@localhost$/i;

/** Whether text is a bare address that can go in MAIL FROM, RCPT TO and a header as it is. */
export function isMailAddress(text: string): boolean {
  return text.length <= 254 && ADDRESS.test(text);
}

/** A sender as EVORA_MAIL_FROM gives it: `noreply@example.com` or `Evora <noreply@example.com>`. */
export interface Sender {
  name: string | null;
  address: string;
}

export function parseSender(text: string): Sender {
  const trimmed = text.trim();
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  const name = named ? (named[1] as string).replace(/^"(.*)"$/, '$1').trim() : null;
  const address = named ? (named[2] as string).trim() : trimmed;
  if (!isMailAddress(address)) throw new MailSettingsError(`EVORA_MAIL_FROM: "${text}" is not an address (write it as noreply@example.com or Evora <noreply@example.com>)`);
  if (name !== null && /[\r\n"\\]/.test(name)) throw new MailSettingsError('EVORA_MAIL_FROM: the name may not contain quotes, backslashes or line breaks');
  return { name: name || null, address };
}

// ------------------------------------------------------------------ the message

export interface MailMessage {
  /** One recipient's bare address. */
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Takes line breaks and other control characters out of what goes in a header, so nothing can add headers of its own. */
function headerSafe(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/**
 * A header value as RFC 2047 encoded words where it is not plain ASCII,
 * in pieces short enough for a header line, split between characters.
 */
export function encodeHeaderText(text: string): string {
  const safe = headerSafe(text);
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  const words: string[] = [];
  let piece = '';
  for (const char of safe) {
    if (Buffer.byteLength(piece + char) > 45) {
      words.push(piece);
      piece = '';
    }
    piece += char;
  }
  if (piece) words.push(piece);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
}

function formatSender(sender: Sender): string {
  if (!sender.name) return sender.address;
  const name = /^[\x20-\x7e]*$/.test(sender.name) ? `"${sender.name}"` : encodeHeaderText(sender.name);
  return `${name} <${sender.address}>`;
}

/**
 * Text as quoted-printable (RFC 2045 §6.7): UTF-8, lines of at most 76
 * characters, line breaks kept as CRLF. A line may start with a dot; the
 * SMTP layer stuffs it.
 */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bytes = Buffer.from(line, 'utf8');
    let current = '';
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i] as number;
      const last = i === bytes.length - 1;
      const literal = (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
      const piece = literal ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      if (current.length + piece.length > 75) {
        out.push(`${current}=`);
        current = '';
      }
      current += piece;
    }
    out.push(current);
  }
  return out.join('\r\n');
}

/** A date as RFC 5322 writes it, in UTC: `Wed, 18 Nov 2026 09:05:00 +0000`. */
export function mailDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`;
}

/** A new Message-ID at the sender's domain. */
export function newMessageId(sender: Sender): string {
  const domain = sender.address.split('@')[1] ?? 'localhost';
  return `<${Date.now().toString(36)}.${randomBytes(12).toString('hex')}@${domain}>`;
}

/** The whole message as it goes after DATA (before dot-stuffing), with CRLF line ends. */
export function buildMessage(sender: Sender, message: MailMessage, options: { date?: Date; messageId?: string } = {}): string {
  if (!isMailAddress(message.to)) throw new Error('Not an email address');
  const boundary = `evora-${randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${formatSender(sender)}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderText(message.subject)}`,
    `Date: ${mailDate(options.date ?? new Date())}`,
    `Message-ID: ${options.messageId ?? newMessageId(sender)}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string): string =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(body)].join('\r\n');
  return [...headers, '', part('text/plain', message.text), part('text/html', message.html), `--${boundary}--`, ''].join('\r\n');
}

/** CRLF line ends, and a dot doubled at the start of any line, so that no line of the message ends DATA early. */
export function dotStuff(data: string): string {
  return data.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
}

// ------------------------------------------------------------------ the SMTP conversation

/** A failure to send; `permanent` when the relay refused it (5xx), so trying again will not help. */
export class SmtpError extends Error {
  readonly code: number;
  readonly permanent: boolean;
  constructor(message: string, code = 0, permanent = false) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.permanent = permanent;
  }
}

interface Reply {
  code: number;
  lines: string[];
}

/** Reads the relay's replies off a socket, one complete (possibly multi-line) reply at a time. */
class ReplyReader {
  private buffer = '';
  private lines: string[] = [];
  private replies: Reply[] = [];
  private waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  private socket: Socket | TLSSocket | null = null;
  private readonly onData = (chunk: Buffer): void => this.take(chunk.toString('latin1'));

  attach(socket: Socket | TLSSocket): void {
    this.socket?.off('data', this.onData);
    this.socket = socket;
    socket.on('data', this.onData);
  }

  detach(): void {
    this.socket?.off('data', this.onData);
    this.socket = null;
  }

  /** Whether anything has come that no reply has been read for yet (a relay talking out of turn). */
  get pending(): boolean {
    return this.buffer.length > 0 || this.lines.length > 0 || this.replies.length > 0;
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.waiting?.reject(error);
    this.waiting = null;
  }

  next(): Promise<Reply> {
    const ready = this.replies.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }

  private take(text: string): void {
    this.buffer += text;
    if (this.buffer.length > 64 * 1024) return this.fail(new SmtpError('The mail relay sent a reply that is too long'));
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      const found = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!found) return this.fail(new SmtpError('The mail relay sent something that is not an SMTP reply'));
      this.lines.push(found[3] as string);
      if (found[2] !== '-') {
        const reply = { code: Number(found[1]), lines: this.lines };
        this.lines = [];
        if (this.waiting) {
          this.waiting.resolve(reply);
          this.waiting = null;
        } else this.replies.push(reply);
      }
    }
  }
}

export interface SendOptions {
  /** How long any one step may take (default 30 s). */
  timeoutMs?: number;
  /** The name this server gives itself in EHLO (default "evora.localhost"). */
  clientName?: string;
  /** More TLS options (the tests give their own certificate authority); certificates are always checked. */
  tls?: ConnectionOptions;
}

/** Sends one message to one recipient through the relay, from greeting to QUIT. */
export async function sendMail(settings: SmtpSettings, envelope: { from: string; to: string }, data: string, options: SendOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const clientName = options.clientName ?? 'evora.localhost';
  if (settings.security === 'plain' && !isLocalHost(settings.host)) throw new SmtpError('Mail is sent unencrypted only to this computer: use smtps:// or STARTTLS', 0, true);
  const reader = new ReplyReader();
  let socket: Socket | TLSSocket;
  const servername = isIP(settings.host) ? undefined : settings.host;

  const connected = new Promise<Socket | TLSSocket>((resolve, reject) => {
    const made =
      settings.security === 'tls'
        ? tlsConnect({ ...options.tls, host: settings.host, port: settings.port, servername, rejectUnauthorized: true }, () => resolve(made))
        : netConnect({ host: settings.host, port: settings.port }, () => resolve(made));
    made.once('error', (error) => reject(new SmtpError(`Could not reach the mail relay: ${error.message}`)));
    made.setTimeout(timeoutMs, () => made.destroy(new Error('it did not answer in time')));
    socket = made;
  });
  socket = await connected;
  const watch = (target: Socket | TLSSocket): void => {
    target.on('error', (error) => reader.fail(new SmtpError(`The connection to the mail relay failed: ${error.message}`)));
    target.on('close', () => reader.fail(new SmtpError('The mail relay closed the connection')));
    target.setTimeout(timeoutMs, () => {
      reader.fail(new SmtpError('The mail relay did not answer in time'));
      target.destroy();
    });
  };
  watch(socket);
  reader.attach(socket);

  const write = (line: string): void => {
    socket.write(`${line}\r\n`);
  };
  /** Waits for the next reply and checks it is one of the codes wanted; `what` names the step in an error, never what was sent. */
  const expect = async (what: string, ...codes: number[]): Promise<Reply> => {
    const reply = await reader.next();
    if (!codes.includes(reply.code)) {
      const said = reply.lines.join(' ').slice(0, 200);
      throw new SmtpError(`The mail relay refused ${what}: ${reply.code} ${said}`, reply.code, reply.code >= 500);
    }
    return reply;
  };
  const hello = async (): Promise<Set<string>> => {
    write(`EHLO ${clientName}`);
    const reply = await reader.next();
    if (reply.code !== 250) {
      write(`HELO ${clientName}`);
      await expect('HELO', 250);
      return new Set();
    }
    return new Set(reply.lines.slice(1).map((line) => line.toUpperCase()));
  };

  try {
    await expect('the connection', 220);
    let features = await hello();

    if (settings.security === 'starttls') {
      if (!features.has('STARTTLS')) throw new SmtpError('The mail relay does not offer STARTTLS, and mail is not sent unencrypted across a network', 0, true);
      write('STARTTLS');
      await expect('STARTTLS', 220);
      if (reader.pending) throw new SmtpError('The mail relay sent something before TLS started');
      reader.detach();
      const plain = socket;
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const secure = tlsConnect({ ...options.tls, socket: plain, servername, rejectUnauthorized: true }, () => resolve(secure));
        secure.once('error', (error) => reject(new SmtpError(`TLS with the mail relay failed: ${error.message}`)));
      });
      watch(socket);
      reader.attach(socket);
      features = await hello();
    }

    if (settings.user !== null) {
      if (settings.security === 'plain' && !isLocalHost(settings.host)) throw new SmtpError('Not signing in to the mail relay without TLS', 0, true);
      const auth = [...features].find((line) => line.startsWith('AUTH ') || line.startsWith('AUTH='));
      const methods = new Set((auth ?? '').slice(5).split(/\s+/));
      const pass = settings.pass ?? '';
      if (methods.has('PLAIN')) {
        write(`AUTH PLAIN ${Buffer.from(`\u0000${settings.user}\u0000${pass}`, 'utf8').toString('base64')}`);
        await expect('the user name or password', 235);
      } else if (methods.has('LOGIN')) {
        write('AUTH LOGIN');
        await expect('AUTH LOGIN', 334);
        write(Buffer.from(settings.user, 'utf8').toString('base64'));
        await expect('the user name', 334);
        write(Buffer.from(pass, 'utf8').toString('base64'));
        await expect('the user name or password', 235);
      } else {
        throw new SmtpError('The mail relay offers no way of signing in that Evora knows (PLAIN or LOGIN)', 0, true);
      }
    }

    const utf8 = /[^\x00-\x7f]/.test(envelope.from + envelope.to);
    if (utf8 && !features.has('SMTPUTF8')) throw new SmtpError('The address has letters outside ASCII and the mail relay does not accept them (SMTPUTF8)', 0, true);
    write(`MAIL FROM:<${envelope.from}>${utf8 ? ' SMTPUTF8' : ''}`);
    await expect('the sender', 250);
    write(`RCPT TO:<${envelope.to}>`);
    await expect('the recipient', 250, 251);
    write('DATA');
    await expect('DATA', 354);
    const body = dotStuff(data);
    socket.write(`${body}${body.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
    await expect('the message', 250);
    write('QUIT');
    await reader.next().catch(() => undefined);
  } finally {
    reader.detach();
    socket.end();
    socket.destroy();
  }
}

// ------------------------------------------------------------------ the queue

/** Sends one message's data; the default is `sendMail` to the relay. */
export type Transport = (envelope: { from: string; to: string }, data: string) => Promise<void>;

export interface MailerOptions {
  smtp: SmtpSettings;
  from: Sender;
  /** How messages leave; `sendMail` to `smtp` by default. */
  transport?: Transport;
  /** The waits before each further try (default 10 s, 1 min, 5 min: four tries in all). */
  retryDelaysMs?: number[];
  /** Messages waiting at most; more are dropped and said to be (default 200). */
  maxQueued?: number;
  /**
   * Caps on what is sent, so that a relay billed by the message can never run up
   * a bill: messages accepted in any 24 hours (default 100) and in any hour
   * (default 30), and to any one address in 24 hours (default 5). Beyond them a
   * message is dropped and the log says which limit was reached; nothing else
   * changes (invitations and mentions are still made and shown in the app).
   */
  limits?: Partial<MailLimits>;
  /** The clock, for tests. */
  now?: () => number;
  send?: SendOptions;
  /** Where to say what failed (default the console's error stream). */
  log?: (line: string) => void;
}

export interface MailLimits {
  perDay: number;
  perHour: number;
  perAddressPerDay: number;
}

export const DEFAULT_MAIL_LIMITS: MailLimits = { perDay: 100, perHour: 30, perAddressPerDay: 5 };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Job {
  message: MailMessage;
  attempt: number;
}

/** An address as the log shows it: its domain only. */
function forLog(address: string): string {
  return `someone at ${address.split('@')[1] ?? 'an unknown domain'}`;
}

/** An error for the log, with any address in it (a relay's reply may quote one) cut down to its domain. */
function errorForLog(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/<?[^\s<>@]+@([A-Za-z0-9.-]*[A-Za-z0-9])>?/g, (_all, domain: string) => `someone at ${domain}`);
}

/**
 * Sends mail in the background, one message at a time, never holding up the
 * request that asked for it. A message that fails for a passing reason is
 * tried again after each of `retryDelaysMs`; one refused outright is not.
 */
export class Mailer {
  readonly from: Sender;
  readonly smtp: SmtpSettings;
  private readonly transport: Transport;
  private readonly delays: number[];
  private readonly maxQueued: number;
  private readonly limits: MailLimits;
  private readonly now: () => number;
  /** When each message accepted in the last 24 hours was accepted, in all and by address. */
  private accepted: number[] = [];
  private acceptedTo = new Map<string, number[]>();
  private readonly log: (line: string) => void;
  private queue: Job[] = [];
  private timers = new Set<NodeJS.Timeout>();
  private running = false;
  private closed = false;
  private idleWaiters: (() => void)[] = [];
  /** Messages sent, and given up on, since the server started. */
  sent = 0;
  failed = 0;

  constructor(options: MailerOptions) {
    this.from = options.from;
    this.smtp = options.smtp;
    this.transport = options.transport ?? ((envelope, data) => sendMail(options.smtp, envelope, data, options.send));
    this.delays = options.retryDelaysMs ?? [10_000, 60_000, 300_000];
    this.maxQueued = options.maxQueued ?? 200;
    this.limits = { ...DEFAULT_MAIL_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.error(line));
  }

  /** Queues a message and returns at once; false when it was not queued (the queue is full, or the mailer is closed). */
  send(message: MailMessage): boolean {
    if (this.closed) return false;
    if (!isMailAddress(message.to)) {
      this.log('Email not sent: the recipient is not an address');
      return false;
    }
    if (this.queue.length + this.timers.size >= this.maxQueued) {
      this.failed++;
      this.log(`Email to ${forLog(message.to)} not sent: ${this.maxQueued} messages are already waiting`);
      return false;
    }
    const limited = this.overLimit(message.to);
    if (limited) {
      this.failed++;
      this.log(`Email to ${forLog(message.to)} not sent: ${limited}`);
      return false;
    }
    this.queue.push({ message, attempt: 1 });
    queueMicrotask(() => void this.pump());
    return true;
  }

  /** Which cap a message to this address would go over, or null; when none, counts the message. */
  private overLimit(to: string): string | null {
    const now = this.now();
    this.accepted = this.accepted.filter((at) => now - at < DAY_MS);
    const key = to.toLowerCase();
    const toThis = (this.acceptedTo.get(key) ?? []).filter((at) => now - at < DAY_MS);
    if (this.acceptedTo.size > 10_000) for (const [address, times] of this.acceptedTo) if (!times.some((at) => now - at < DAY_MS)) this.acceptedTo.delete(address);
    if (this.accepted.length >= this.limits.perDay) return `the limit of ${this.limits.perDay} emails a day was reached (EVORA_MAIL_DAILY_LIMIT)`;
    if (this.accepted.filter((at) => now - at < HOUR_MS).length >= this.limits.perHour) return `the limit of ${this.limits.perHour} emails an hour was reached (EVORA_MAIL_HOURLY_LIMIT)`;
    if (toThis.length >= this.limits.perAddressPerDay) return `the limit of ${this.limits.perAddressPerDay} emails a day to one address was reached`;
    this.accepted.push(now);
    toThis.push(now);
    this.acceptedTo.set(key, toThis);
    return null;
  }

  /** Resolves once nothing is waiting, being sent, or waiting to be tried again. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stops: messages not yet sent are dropped (said in the log), nothing more is tried. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const dropped = this.queue.length + this.timers.size;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.queue = [];
    if (dropped > 0) this.log(`Email: ${dropped} message${dropped === 1 ? '' : 's'} not sent because the server stopped`);
    this.wakeIdle();
  }

  private isIdle(): boolean {
    return !this.running && this.queue.length === 0 && this.timers.size === 0;
  }

  private wakeIdle(): void {
    if (!this.isIdle() && !this.closed) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let job: Job | undefined;
      while (!this.closed && (job = this.queue.shift())) await this.attempt(job);
    } finally {
      this.running = false;
      this.wakeIdle();
    }
  }

  private async attempt(job: Job): Promise<void> {
    let data: string;
    try {
      data = buildMessage(this.from, job.message);
    } catch (error) {
      this.failed++;
      this.log(`Email to ${forLog(job.message.to)} not sent: ${errorForLog(error)}`);
      return;
    }
    try {
      await this.transport({ from: this.from.address, to: job.message.to }, data);
      this.sent++;
    } catch (error) {
      const permanent = error instanceof SmtpError && error.permanent;
      const tries = this.delays.length + 1;
      const delay = this.delays[job.attempt - 1];
      if (permanent || delay === undefined || this.closed) {
        this.failed++;
        this.log(`Email to ${forLog(job.message.to)} not sent (try ${job.attempt} of ${tries}, given up): ${errorForLog(error)}`);
        return;
      }
      this.log(`Email to ${forLog(job.message.to)} not sent yet (try ${job.attempt} of ${tries}, trying again in ${Math.round(delay / 1000)} s): ${errorForLog(error)}`);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.closed) return;
        this.queue.push({ message: job.message, attempt: job.attempt + 1 });
        void this.pump();
      }, delay);
      timer.unref();
      this.timers.add(timer);
    }
  }
}

/** For tests. */
export { errorForLog };
