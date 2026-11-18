/**
 * Starts the Evora collaboration server:
 *
 *   node server/main.ts [--port 8787] [--host 127.0.0.1] [--data .evora-server] [--serve dist] [--fresh] ...
 *
 * Every setting can also be given as an environment variable (EVORA_PORT,
 * EVORA_HOST, EVORA_DATA, EVORA_SERVE, EVORA_PUBLIC_URL, EVORA_GOOGLE_CLIENT_ID,
 * EVORA_GOOGLE_CLIENT_SECRET, EVORA_MAX_UPLOAD_MB, EVORA_MAX_JSON_MB,
 * EVORA_TRUST_PROXY, EVORA_SHUTDOWN_SECONDS; EVORA_SMTP_URL and EVORA_MAIL_FROM
 * for email, from the environment only); a flag wins over the variable.
 * server/config.ts and docs/self-hosting.md list them with what they mean.
 * The Google client secret is read only from the environment, never a flag,
 * so that it is not seen in the list of processes.
 *
 * --fresh starts from nothing: the data folder is emptied first (the browser
 * tests use this), and only when it is one this server made.
 *
 * On SIGINT or SIGTERM the server stops gracefully: no new connections, live
 * connections told the server is restarting (the app reconnects), requests
 * under way given time to finish, the database checkpointed and closed. A
 * second signal stops it at once.
 *
 * Runs with plain Node 24, which strips the types: nothing to build or install.
 */
import { rmSync } from 'node:fs';
import { startServer } from './app.ts';
import { ConfigError, readConfig } from './config.ts';
import { Mailer, describeSmtp } from './mail.ts';

let config;
try {
  config = readConfig(process.argv.slice(2), process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Evora: ${error.message}`);
  process.exit(1);
}

if (config.fresh) rmSync(config.dataDir, { recursive: true, force: true });

const server = await startServer({
  port: config.port,
  host: config.host,
  dataDir: config.dataDir,
  serveDir: config.serveDir,
  google: config.google,
  publicUrl: config.publicUrl,
  maxMessageBytes: config.maxUploadBytes,
  maxJsonBytes: config.maxJsonBytes,
  trustProxy: config.trustProxy,
  shutdownMs: config.shutdownMs,
  mailer: config.mail ? new Mailer({ smtp: config.mail.smtp, from: config.mail.from }) : null,
});
console.log(`Evora collaboration server on http://localhost:${server.port}${config.host === '127.0.0.1' ? '' : ` (listening on ${config.host})`}`);
console.log(`Data folder: ${config.dataDir}`);
if (config.serveDir) console.log(`Serving the app from ${config.serveDir}`);
console.log(config.google ? 'Continue with Google: on' : 'Continue with Google: off (set EVORA_GOOGLE_CLIENT_ID and EVORA_GOOGLE_CLIENT_SECRET to turn it on)');
// The relay is shown without its password.
console.log(config.mail ? `Email: on, through ${describeSmtp(config.mail.smtp)}, from ${config.mail.from.address}` : 'Email: off (set EVORA_SMTP_URL and EVORA_MAIL_FROM to turn it on)');
if (config.trustProxy.kind !== 'off') console.log('Trust proxy: on (client addresses are read from X-Forwarded-For)');

let stopping = false;
function stop(signal: string): void {
  if (stopping) {
    console.log(`${signal} again: stopping at once`);
    process.exit(1);
  }
  stopping = true;
  console.log(`${signal}: stopping (live connections are told the server is restarting)`);
  server.close().then(
    () => {
      console.log('Stopped');
      process.exit(0);
    },
    (error: unknown) => {
      console.error('Stopping failed:', error);
      process.exit(1);
    },
  );
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
