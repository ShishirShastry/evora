/**
 * A stand-in mail relay for the tests, with `node:net`: it speaks enough
 * SMTP to take messages, writes down every command it is sent (with AUTH's
 * secret kept apart), and keeps each message as it arrived after DATA, before
 * and after undoing the dot-stuffing. It never does TLS, so it stands for a
 * relay on this computer.
 */
import { createServer, type Server, type Socket } from 'node:net';

export interface ReceivedMail {
  from: string;
  to: string[];
  /** The DATA lines as they came over the wire, dot-stuffed, joined with CRLF. */
  wire: string;
  /** The message with the dot-stuffing undone. */
  data: string;
}

export interface FakeSmtpOptions {
  /** What EHLO offers besides the greeting line (default AUTH PLAIN LOGIN and 8BITMIME). */
  features?: string[];
  /** The account and password AUTH must give; any is refused when unset and AUTH is tried. */
  user?: string;
  pass?: string;
  /** Answers RCPT TO with this (e.g. "450 try later" or "550 no such user") for the next N messages. */
  refuseRecipient?: { reply: string; times: number };
  /** Says nothing at all after the connection is made (for time limits). */
  silent?: boolean;
}

export interface FakeSmtp {
  port: number;
  /** Every command received, in order, across connections; AUTH's secrets are replaced by what they decoded to. */
  commands: string[];
  /** Whether a client signed in, and how. */
  auth: { method: string; user: string; pass: string }[];
  messages: ReceivedMail[];
  options: FakeSmtpOptions;
  close(): Promise<void>;
}

export async function fakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const fake: FakeSmtp = { port: 0, commands: [], auth: [], messages: [], options, close: async () => undefined };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    if (fake.options.silent) return;
    const say = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    let buffer = '';
    let mode: 'command' | 'data' | 'login-user' | 'login-pass' = 'command';
    let loginUser = '';
    let envelope: { from: string; to: string[] } = { from: '', to: [] };
    let lines: string[] = [];
    const checkAuth = (method: string, user: string, pass: string): void => {
      fake.auth.push({ method, user, pass });
      say(user === fake.options.user && pass === fake.options.pass ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid');
    };
    say('220 fake.localhost ESMTP ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (mode === 'data') {
          if (line === '.') {
            const wire = lines.join('\r\n');
            fake.messages.push({ from: envelope.from, to: envelope.to, wire, data: lines.map((l) => (l.startsWith('.') ? l.slice(1) : l)).join('\r\n') });
            lines = [];
            mode = 'command';
            say('250 2.0.0 Queued');
          } else lines.push(line);
          continue;
        }
        if (mode === 'login-user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          fake.commands.push('(user name)');
          mode = 'login-pass';
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        if (mode === 'login-pass') {
          fake.commands.push('(password)');
          mode = 'command';
          checkAuth('LOGIN', loginUser, Buffer.from(line, 'base64').toString('utf8'));
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('AUTH PLAIN ')) {
          fake.commands.push('AUTH PLAIN (secret)');
          const [, user = '', pass = ''] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          checkAuth('PLAIN', user, pass);
          continue;
        }
        fake.commands.push(line);
        if (upper.startsWith('EHLO ')) {
          const features = fake.options.features ?? ['AUTH PLAIN LOGIN', '8BITMIME'];
          if (features.length === 0) say('250 fake.localhost');
          else {
            say('250-fake.localhost');
            features.forEach((feature, i) => say(`250${i === features.length - 1 ? ' ' : '-'}${feature}`));
          }
        } else if (upper.startsWith('HELO ')) say('250 fake.localhost');
        else if (upper === 'AUTH LOGIN') {
          mode = 'login-user';
          say('334 VXNlcm5hbWU6');
        } else if (upper.startsWith('MAIL FROM:')) {
          envelope = { from: /<(.*)>/.exec(line)?.[1] ?? '', to: [] };
          say('250 2.1.0 Ok');
        } else if (upper.startsWith('RCPT TO:')) {
          const refuse = fake.options.refuseRecipient;
          if (refuse && refuse.times > 0) {
            refuse.times--;
            say(refuse.reply);
          } else {
            envelope.to.push(/<(.*)>/.exec(line)?.[1] ?? '');
            say('250 2.1.5 Ok');
          }
        } else if (upper === 'DATA') {
          mode = 'data';
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'QUIT') {
          say('221 2.0.0 Bye');
          socket.end();
        } else if (upper === 'RSET' || upper === 'NOOP') say('250 2.0.0 Ok');
        else say('502 5.5.2 Command not recognised');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  fake.port = typeof address === 'object' && address ? address.port : 0;
  fake.close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  return fake;
}

/** Undoes quoted-printable (soft line breaks and =XX), as UTF-8. */
export function decodeQuotedPrintable(text: string): string {
  const joined = text.replace(/=\r\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const char = joined[i] as string;
    if (char === '=' && /^[0-9A-F]{2}$/i.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(char, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The text/plain part of a message built by server/mail.ts, decoded. */
export function plainText(data: string): string {
  const part = /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n([\s\S]*?)\r\n--evora-/.exec(data);
  return part ? decodeQuotedPrintable(part[1] as string) : '';
}

/** A header's value from a message (the first of that name). */
export function header(data: string, name: string): string | null {
  const head = data.split('\r\n\r\n')[0] ?? '';
  const found = new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, 'im').exec(head);
  return found ? (found[1] as string).replace(/\r\n[ \t]/g, ' ') : null;
}
