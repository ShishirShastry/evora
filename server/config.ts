/**
 * The server's settings, from flags and environment variables. Every setting
 * can be given either way; a flag wins over the variable. A value that is not
 * one is refused with a message saying what was wrong, before anything starts.
 *
 * | Flag                    | Variable                    | Default          |
 * |-------------------------|-----------------------------|------------------|
 * | --port                  | EVORA_PORT                  | 8787             |
 * | --host                  | EVORA_HOST                  | 127.0.0.1        |
 * | --data                  | EVORA_DATA                  | .evora-server    |
 * | --serve                 | EVORA_SERVE                 | (API only)       |
 * | --public-url            | EVORA_PUBLIC_URL            | (none)           |
 * | --google-client-id      | EVORA_GOOGLE_CLIENT_ID      | (off)            |
 * | (variable only)         | EVORA_GOOGLE_CLIENT_SECRET  | (off)            |
 * | --max-upload-mb         | EVORA_MAX_UPLOAD_MB         | 50               |
 * | --max-json-mb           | EVORA_MAX_JSON_MB           | 2                |
 * | --trust-proxy           | EVORA_TRUST_PROXY           | off              |
 * | --shutdown-seconds      | EVORA_SHUTDOWN_SECONDS      | 10               |
 * | (variable only)         | EVORA_SMTP_URL              | (email off)      |
 * | (variable only)         | EVORA_MAIL_FROM             | (email off)      |
 * | (variable only)         | EVORA_MAIL_DAILY_LIMIT      | 100              |
 * | (variable only)         | EVORA_MAIL_HOURLY_LIMIT     | 30               |
 * | --fresh                 | (flag only)                 | off              |
 *
 * docs/self-hosting.md has the same table with what each one means.
 */
import { existsSync, readdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SERVER_PORT } from '../src/collab/protocol.ts';
import { asOrigin, googleFromEnv, type GoogleConfig } from './google.ts';
import { parseTrustProxy, type TrustProxy } from './proxy.ts';
import { DEFAULT_MAIL_LIMITS, MailSettingsError, parseSender, parseSmtpUrl, type Sender, type SmtpSettings } from './mail.ts';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  serveDir?: string;
  publicUrl: string | null;
  google: GoogleConfig | null;
  maxUploadBytes: number;
  maxJsonBytes: number;
  trustProxy: TrustProxy;
  /** How long a stop waits for requests under way before it drops them. */
  shutdownMs: number;
  fresh: boolean;
  /** Sending email (invitations, mentions, confirming addresses); null when it is off. */
  mail: MailConfig | null;
}

/** Where mail goes and whom it is from. */
export interface MailConfig {
  smtp: SmtpSettings;
  from: Sender;
  /** Emails a day and an hour at most, whatever they are (EVORA_MAIL_DAILY_LIMIT, EVORA_MAIL_HOURLY_LIMIT; default 100 and 30). */
  perDay: number;
  perHour: number;
}

function mailLimit(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new ConfigError(`email: ${name} must be a whole number from 1 to 100000`);
  return value;
}

/**
 * EVORA_SMTP_URL and EVORA_MAIL_FROM, read from the environment only (the
 * address may hold the relay's password, which must not be seen in the list
 * of processes). Both or neither; with them, EVORA_PUBLIC_URL is needed too,
 * for the links in the messages. A message never contains the password.
 */
export function readMailConfig(env: Record<string, string | undefined>, publicUrl: string | null): MailConfig | null {
  const url = (env.EVORA_SMTP_URL ?? '').trim();
  const from = (env.EVORA_MAIL_FROM ?? '').trim();
  if (!url && !from) return null;
  if (!url) throw new ConfigError('email: EVORA_MAIL_FROM was given without EVORA_SMTP_URL');
  if (!from) throw new ConfigError('email: EVORA_SMTP_URL was given without EVORA_MAIL_FROM (the address mail is sent from, e.g. Evora <noreply@example.com>)');
  if (!publicUrl) throw new ConfigError('email: EVORA_PUBLIC_URL is needed for the links in the messages (e.g. https://evora.example.com)');
  try {
    return { smtp: parseSmtpUrl(url), from: parseSender(from), perDay: mailLimit(env, 'EVORA_MAIL_DAILY_LIMIT', DEFAULT_MAIL_LIMITS.perDay), perHour: mailLimit(env, 'EVORA_MAIL_HOURLY_LIMIT', DEFAULT_MAIL_LIMITS.perHour) };
  } catch (error) {
    if (error instanceof MailSettingsError) throw new ConfigError(`email: ${error.message}`);
    throw error;
  }
}

/** A setting that is not one; its message is for the person starting the server. */
export class ConfigError extends Error {}

const MB = 1024 * 1024;

function number(name: string, text: string, min: number, max: number, integer: boolean): number {
  const value = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new ConfigError(`${name}: "${text}" is not ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  }
  return value;
}

/** A host name or address to listen on. */
function host(text: string): string {
  const value = text.trim();
  if (isIP(value) || /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value)) return value;
  throw new ConfigError(`host: "${text}" is not an address or a host name (127.0.0.1 for this computer only, 0.0.0.0 for every network)`);
}

/** Reads the settings from the command line's arguments and the environment. */
export function readConfig(args: string[], env: Record<string, string | undefined>): ServerConfig {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        data: { type: 'string' },
        serve: { type: 'string' },
        'public-url': { type: 'string' },
        'google-client-id': { type: 'string' },
        'max-upload-mb': { type: 'string' },
        'max-json-mb': { type: 'string' },
        'trust-proxy': { type: 'string' },
        'shutdown-seconds': { type: 'string' },
        fresh: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
  const pick = (flag: string, variable: string): string | undefined => {
    const fromFlag = values[flag];
    if (typeof fromFlag === 'string') return fromFlag;
    const fromEnv = env[variable];
    return fromEnv === undefined || fromEnv.trim() === '' ? undefined : fromEnv;
  };

  const portText = pick('port', 'EVORA_PORT');
  const port = portText === undefined ? DEFAULT_SERVER_PORT : number('port', portText, 0, 65535, true);
  const hostText = pick('host', 'EVORA_HOST');
  const listenHost = hostText === undefined ? '127.0.0.1' : host(hostText);
  const dataDir = resolve(pick('data', 'EVORA_DATA') ?? '.evora-server');

  const serveText = pick('serve', 'EVORA_SERVE');
  const serveDir = serveText ? resolve(serveText) : undefined;
  if (serveDir && !existsSync(join(serveDir, 'index.html'))) {
    throw new ConfigError(`serve: ${serveDir} has no index.html (run "npm run build" first)`);
  }

  const publicText = pick('public-url', 'EVORA_PUBLIC_URL');
  const publicUrl = publicText === undefined ? null : asOrigin(publicText.trim());
  if (publicText !== undefined && !publicUrl) {
    throw new ConfigError(`public URL: "${publicText}" is not an origin (write it as https://host or http://host:port, without a path)`);
  }

  const clientIdFlag = typeof values['google-client-id'] === 'string' ? values['google-client-id'] : undefined;
  const clientId = (clientIdFlag ?? env.EVORA_GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (env.EVORA_GOOGLE_CLIENT_SECRET ?? '').trim();
  if (clientId && !clientSecret) throw new ConfigError('Google sign-in: a client ID was given without EVORA_GOOGLE_CLIENT_SECRET (the secret is read only from the environment)');
  if (!clientId && clientSecret) throw new ConfigError('Google sign-in: EVORA_GOOGLE_CLIENT_SECRET was given without a client ID (EVORA_GOOGLE_CLIENT_ID or --google-client-id)');
  const google = googleFromEnv(env, clientIdFlag);

  const uploadText = pick('max-upload-mb', 'EVORA_MAX_UPLOAD_MB');
  const maxUploadBytes = Math.round((uploadText === undefined ? 50 : number('max upload MB', uploadText, 1, 1024, false)) * MB);
  const jsonText = pick('max-json-mb', 'EVORA_MAX_JSON_MB');
  const maxJsonBytes = Math.round((jsonText === undefined ? 2 : number('max JSON MB', jsonText, 0.0625, 256, false)) * MB);

  let trustProxy: TrustProxy;
  try {
    trustProxy = parseTrustProxy(pick('trust-proxy', 'EVORA_TRUST_PROXY'));
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }

  const shutdownText = pick('shutdown-seconds', 'EVORA_SHUTDOWN_SECONDS');
  const shutdownMs = (shutdownText === undefined ? 10 : number('shutdown seconds', shutdownText, 0, 600, false)) * 1000;

  const fresh = values.fresh === true;
  if (fresh && existsSync(dataDir)) {
    // Only a folder this server made (or an empty one) is emptied, never some other folder named by mistake.
    const entries = readdirSync(dataDir);
    if (entries.length > 0 && !entries.includes('evora.db')) {
      throw new ConfigError(`--fresh would delete ${dataDir}, which does not look like an Evora server's data folder; nothing was deleted`);
    }
  }

  const mail = readMailConfig(env, publicUrl);

  return { port, host: listenHost, dataDir, serveDir, publicUrl, google, maxUploadBytes, maxJsonBytes, trustProxy, shutdownMs, fresh, mail };
}
