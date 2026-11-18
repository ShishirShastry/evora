# Self-hosting Evora

Evora runs on your own devices without any server. A server is only needed for
working together: shared files, live editing, comments, sharing links, version
history kept on the server, the plugin directory and the Community library. One
Evora server process does all of that **and** serves the app itself, so a team
needs one machine (or one container) and nothing else. Everything is free and
unlimited: there are no plans, seats or licence keys.

This guide covers running that server for a team: with Docker, or with plain
Node and systemd, behind HTTPS, with backups and monitoring.

- [Requirements](#requirements)
- [Quick start with Docker](#quick-start-with-docker)
- [Quick start with plain Node](#quick-start-with-plain-node)
- [Configuration](#configuration)
- [HTTPS and reverse proxies](#https-and-reverse-proxies)
- [Continue with Google](#continue-with-google)
- [Backups and restoring](#backups-and-restoring)
- [Upgrading](#upgrading)
- [Monitoring](#monitoring)
- [Stopping and restarting](#stopping-and-restarting)
- [Resource sizing](#resource-sizing)
- [Security notes](#security-notes)

## Requirements

- **Node.js 24** (the server uses Node's own `node:sqlite` and runs its
  TypeScript directly with Node's type stripping: there is nothing to compile
  and no npm package is needed at run time). Building the app needs `npm` and
  the project's development dependencies once.
- Or **Docker** (any recent version with BuildKit, the default since Docker 23),
  which needs neither Node nor npm on the machine.
- A Linux, macOS or Windows machine. For a team, a small Linux virtual machine
  is plenty (see [Resource sizing](#resource-sizing)).
- For HTTPS: a domain name pointing at the machine, and ports 80 and 443 open
  (Caddy or nginx in front, see below).

## Quick start with Docker

From the repository's root:

```sh
docker build -f deploy/Dockerfile -t evora .
docker run -d --name evora -p 127.0.0.1:8787:8787 -v evora-data:/data --stop-timeout 20 evora
```

Open http://localhost:8787. Accounts, files and images are kept in the
`evora-data` volume; the container itself holds nothing that matters.

Or with Compose, which does the same with a named volume and a second one for
backups, and has a Caddy service ready to uncomment for HTTPS:

```sh
docker compose -f deploy/docker-compose.yml up -d --build
```

What the image is (`deploy/Dockerfile`):

- a build stage on `node:24-slim` that runs `npm ci` and builds the app with
  Vite (the Electron and Playwright downloads are skipped: they are only for the
  desktop app and the browser tests);
- a final stage on `node:24-slim` with only `package.json`, `server/`, the two
  shared files of `src/` the server imports and the built app in `dist/`; no
  `node_modules`;
- it runs as the image's unprivileged `node` user, listens on `0.0.0.0:8787`
  inside the container, keeps its data in the `/data` volume and reports its
  health to Docker from `/api/health`.

## Quick start with plain Node

```sh
git clone <this repository> evora && cd evora
npm ci
npm run build                      # the app, into dist/
node server/main.ts --serve dist   # or: npm start (builds, then serves)
```

Open http://localhost:8787. The data is kept in `.evora-server/` next to where
you started it (change it with `--data`). By default the server listens only on
this computer (`127.0.0.1`); `--host 0.0.0.0` makes it reachable from the
network, which you want only behind a reverse proxy with HTTPS, or on a network
you trust.

To install it as a service on Linux, copy what the Docker image holds to
`/opt/evora` (`package.json`, `server/` without its `*.test.ts` files and
`testing.ts`, `src/collab/protocol.ts`, `src/plugins/manifest.ts` and `dist/`),
then use the unit in `deploy/evora.service`; its comments list every step. It
runs as a system user `evora`, may write only `/var/lib/evora`, reads its
settings from `/etc/evora/evora.env`, and stops gracefully on
`systemctl stop evora`.

## Configuration

Every setting can be given as a flag or as an environment variable; a flag wins
over the variable. A value that is not one stops the server before it starts,
with a message saying which setting was wrong (exit code 1).

| Flag | Variable | Default | What it does |
|---|---|---|---|
| `--port` | `EVORA_PORT` | `8787` | The port to listen on (0 to 65535; 0 picks a free one). |
| `--host` | `EVORA_HOST` | `127.0.0.1` | The address to listen on: `127.0.0.1` for this computer only, `0.0.0.0` (or `::`) for every network. The Docker image sets `0.0.0.0`. |
| `--data` | `EVORA_DATA` | `.evora-server` | The data folder: the database `evora.db` and the uploaded files (`assets/`, `community/`). Created if missing. The Docker image sets `/data`. |
| `--serve` | `EVORA_SERVE` | (API only) | A built app (`dist/`) to serve as well, so one process is the whole of Evora. Refused if the folder has no `index.html`. The Docker image sets `/app/dist`. |
| `--public-url` | `EVORA_PUBLIC_URL` | (none) | The app's public origin, e.g. `https://evora.example.com` (no path). Needed for Continue with Google anywhere other than localhost. |
| `--google-client-id` | `EVORA_GOOGLE_CLIENT_ID` | (off) | The Google OAuth client ID. With the secret below, Continue with Google is on. |
| (variable only) | `EVORA_GOOGLE_CLIENT_SECRET` | (off) | The Google OAuth client secret. Only ever read from the environment, so it does not show in the list of processes. Giving one of the ID and the secret without the other is refused. |
| `--max-upload-mb` | `EVORA_MAX_UPLOAD_MB` | `50` | The largest upload (an image, a file's content) and the largest live message, in MB (1 to 1024). Keep your proxy's limit above it. |
| `--max-json-mb` | `EVORA_MAX_JSON_MB` | `2` | The largest JSON body of other requests, in MB. |
| `--trust-proxy` | `EVORA_TRUST_PROXY` | off | Read the client's address from `X-Forwarded-For` (see [below](#trust-proxy)). Off by default. |
| `--shutdown-seconds` | `EVORA_SHUTDOWN_SECONDS` | `10` | On SIGTERM or SIGINT, how long requests under way may take to finish before they are dropped (0 to 600). |
| (variable only) | `EVORA_SMTP_URL` | (email off) | The mail relay that sends Evora's email, with its account: `smtps://user:password@smtp.example.com:465` or `smtp://user:password@smtp.example.com:587` (see [Sending email](#sending-email)). Only ever read from the environment, because it holds a password. |
| (variable only) | `EVORA_MAIL_FROM` | (email off) | The sender of that email: `noreply@example.com` or `Evora <noreply@example.com>`. Needed with `EVORA_SMTP_URL`, and both need `EVORA_PUBLIC_URL` for the links. |
| `--fresh` | (flag only) | off | Empty the data folder first: for tests. Refused unless the folder is empty or holds an `evora.db`, so it never deletes some other folder named by mistake. |

Examples:

```sh
EVORA_HOST=0.0.0.0 EVORA_DATA=/srv/evora node server/main.ts --serve dist
node server/main.ts --serve dist --port 9000 --trust-proxy loopback --public-url https://evora.example.com
```

## HTTPS and reverse proxies

Put a reverse proxy with HTTPS in front of Evora for anything reachable from the
internet. The app talks to the server on the same origin, under `/api` (HTTP)
and `/ws` (a WebSocket), so the proxy must pass WebSocket upgrades on `/ws`,
allow uploads as large as `EVORA_MAX_UPLOAD_MB`, and keep idle connections open
for a long time (the server pings each live connection every 15 seconds).

- **Caddy** (`deploy/Caddyfile`): automatic HTTPS from Let's Encrypt with no
  further setup; WebSockets need no extra lines. Set `EVORA_DOMAIN`, and
  `EVORA_UPSTREAM` when Evora is not on `127.0.0.1:8787` (Compose: `evora:8787`).
- **nginx** (`deploy/nginx.conf`): the `Upgrade`/`Connection` headers for
  `/ws`, `X-Forwarded-For`, `client_max_body_size`, long read timeouts, and a
  redirect from HTTP. Certificates from certbot or your own.
- **Docker Compose with Caddy**: uncomment the `caddy` service and its volumes
  in `deploy/docker-compose.yml`, set `EVORA_DOMAIN`, `EVORA_TRUST_PROXY=private`
  and `EVORA_PUBLIC_URL=https://<your domain>`, and remove Evora's own `ports`.

With a proxy in front, keep Evora listening on `127.0.0.1` (or only on the
container network), so that nobody can reach it around the proxy.

### Trust proxy

Evora limits repeated attempts per client address (wrong passwords, accounts and
guests made, Community copies and plugin installs counted once per person).
Behind a proxy every request comes from the proxy, so turn on
`EVORA_TRUST_PROXY`: the client's address is then taken from
`X-Forwarded-For`, from the right-most hop that is not a trusted proxy. Left
off, the header is ignored, which is right for a server reached directly:
anyone can write that header.

| Value | Meaning |
|---|---|
| `0`, `false`, `off`, `no` or nothing | Off (the default): the connection's own address. |
| `1` (or `true`, `yes`, `on`) | One proxy in front: the right-most address in `X-Forwarded-For`. |
| `2`, `3`, ... | That many proxies in a row (e.g. a CDN, then nginx). |
| `loopback` | Trust proxies on this machine (`127.0.0.0/8`, `::1`): nginx or Caddy on the same host. |
| `private` | Trust proxies on private networks (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`): Docker networks. |
| `10.0.0.5, 192.168.1.0/24, ::1` | A list of addresses and ranges (`linklocal` is a third name). |

A list is the safest: a request whose connection does not come from a listed
proxy is never believed. Both nginx (`$proxy_add_x_forwarded_for`) and Caddy
append the address they saw, as Evora expects.

## Continue with Google

Optional; accounts with an email and a password always work.

1. In Google Cloud Console, configure the OAuth consent screen (scopes `openid`,
   `email`, `profile`; add test users while it is in Testing).
2. Create an OAuth client ID of type **Web application**, with the authorised
   redirect URI `https://evora.example.com/api/auth/google/callback` (your
   public URL followed by `/api/auth/google/callback`).
3. Start the server with `EVORA_GOOGLE_CLIENT_ID`, `EVORA_GOOGLE_CLIENT_SECRET`
   and `EVORA_PUBLIC_URL=https://evora.example.com`. The server prints
   "Continue with Google: on", and the button appears in the sign-in and sign-up
   dialogs.

Keep the secret out of git and out of command lines: an environment file
readable only by root (`/etc/evora/evora.env`), Docker secrets or an `.env` file
next to `docker-compose.yml` that is not committed.

## Sending email

Optional. Without it Evora sends no email at all and behaves as it always has.
With it, Evora sends three kinds of short, plain messages (text and HTML, in
UTF-8), each with a link to the app at `EVORA_PUBLIC_URL`:

- **Confirm your email address**: to every new account made with a password,
  and to an account whose address changes. The link works once, for 24 hours,
  and only for the address it was sent to; only a hash of it is kept, and asking
  for a new one (the "Resend" button in the app, at most 5 times in 15 minutes)
  makes the older links stop working. An account made or linked through
  Continue with Google counts as confirmed, because Google has verified the
  address.
- **Invitations**: when someone invites an address to a workspace or a file
  (at most 50 such emails per account in 15 minutes; beyond that the
  invitation is still made, without an email).
- **Mentions**: when someone mentions a person in a comment, to their confirmed
  address. Each person can turn these off in the app (account menu ▸ Email
  settings…); the notification inside the app still comes.

**What changes for invitations.** With email off, an invitation by email goes to
whichever account has that address, or is made with it first: nothing proves the
address belongs to that person. With email on, an invitation is taken up only
by an account whose address is confirmed; an account that has not confirmed it
yet gets the invitation the moment it does. Someone who makes an account with
another person's address can therefore no longer receive their invitations.

To turn it on, give the server a mail relay (your provider's SMTP service, or a
relay such as Postfix on the same machine) and restart it:

```sh
EVORA_SMTP_URL='smtps://evora%40example.com:app-password@smtp.example.com:465' \
EVORA_MAIL_FROM='Evora <noreply@example.com>' \
EVORA_PUBLIC_URL=https://evora.example.com \
node server/main.ts --serve dist
```

The server prints `Email: on, through smtps://evora%40example.com@smtp.example.com:465 (TLS), from noreply@example.com`
(never the password), or `Email: off` when the two variables are not set.

- `smtps://` is TLS from the first byte (port 465 unless given). `smtp://` to
  another machine must switch to TLS with STARTTLS (port 587 unless given):
  if the relay does not offer it, nothing is sent. Unencrypted SMTP is used only
  for a relay on the same machine (`smtp://localhost:25`, `127.0.0.1`, `::1`).
  Certificates are always checked.
- The user name and password in the address are percent-encoded: an `@` is
  `%40`, a `:` is `%3A`. Signing in uses AUTH PLAIN, or AUTH LOGIN when the
  relay does not offer PLAIN; without a user name nothing is signed in.
- The sender's domain should allow your relay to send for it (SPF, DKIM), or
  messages may land in spam. Evora does not sign messages itself.
- Mail goes out in the background: no request waits for it. A message that fails
  for a passing reason (the relay busy, the connection dropped) is tried again
  after 10 seconds, 1 minute and 5 minutes; one the relay refuses (a 5xx answer,
  e.g. a wrong password) is not. Failures are written to the server's error
  output with the recipient's domain only, never the address or the password.
  The queue is in memory: messages not yet sent when the server stops are lost
  (the log says how many). Each step of talking to the relay may take at most
  30 seconds.
- An account's address can be changed with `PATCH /api/me/email` (with the
  account's password); the new address is confirmed again. There is no screen
  for it in the app yet.

## Backups and restoring

Everything the server keeps is in its data folder: the SQLite database
`evora.db` (with its `-wal` and `-shm` files while it runs) and the uploaded
files in `assets/` and `community/`. Copying that folder while the server runs
can catch the database in the middle of a change; use the backup tool instead,
which works while the server runs:

```sh
npm run backup -- --data .evora-server --out backups/evora-2026-11-18
# or, without npm:
node server/backup.ts --data /var/lib/evora --out /srv/backups/evora-$(date +%F)
# in Docker Compose:
docker compose -f deploy/docker-compose.yml exec evora node server/backup.ts --data /data --out /backups/evora-$(date +%F)
```

A backup is a folder: `evora.db`, a consistent copy of the database made with
SQLite's online backup (one snapshot, while the server keeps writing),
`files/` with the uploaded files, and `manifest.json` with the size and SHA-256
of every file, the Evora version and the database's schema version. The
database is copied first and the files after it, so every image the copy
refers to is in the backup. The output folder must be new or empty, and may not
be inside the data folder.

Check a backup (every file against its checksum, and SQLite's integrity check):

```sh
node server/backup.ts --verify backups/evora-2026-11-18
```

Restore into a new or empty data folder, then start the server on it:

```sh
node server/backup.ts --restore backups/evora-2026-11-18 --data /var/lib/evora-restored
node server/main.ts --serve dist --data /var/lib/evora-restored
```

A restore refuses a folder that is not empty (move the old one aside first) and
a backup whose files do not match its manifest, and puts nothing in place in
that case. Sessions made before the backup still work after a restore.

Schedule it with cron or a systemd timer, and copy the folders somewhere else
(another disk, object storage). Old backups are not removed by the tool.

## Upgrading

1. Make a backup (above).
2. Stop the server (`systemctl stop evora`, `docker compose stop`): it stops
   gracefully.
3. Replace the code: `git pull && npm ci && npm run build`, or rebuild the
   image (`docker compose -f deploy/docker-compose.yml up -d --build`).
4. Start it again. The database's tables are created and brought up to date
   when the server starts, keeping everything in them; there is no separate
   migration step.

Going back to an older version after an upgrade is not supported on the same
data folder: restore the backup you made in step 1 instead.

## Monitoring

- `GET /api/health` (no account needed) answers `200` with
  `{"ok":true,"version":"0.1.0","uptime":123,"db":"ok"}` when the server is up
  and can read its database, and `503` with `"ok":false` when the database
  cannot be read or while the server is stopping. `HEAD` works too. Use it for
  Docker's `HEALTHCHECK` (the image has one), a load balancer's check, or an
  uptime monitor.
- `GET /api/version` answers `{"version":"0.1.0","node":"24.22.3","database":2}`:
  the Evora version, the Node version it runs on, and the database's schema
  version.
- The server writes one line per start (address, data folder, whether the app is
  served, whether Google sign-in is on) and one per stop to standard output:
  `journalctl -u evora`, `docker logs evora`.

## Stopping and restarting

On SIGTERM (what `docker stop` and `systemctl stop` send) or SIGINT (Ctrl+C) the
server:

1. stops taking new connections and answers new requests on open ones with
   `503`;
2. closes every live connection with WebSocket close code `1012` ("The server
   is restarting"); the app shows the file as offline, keeps the changes made
   meanwhile, and reconnects by itself, sending them when the server is back;
3. lets requests under way finish, for up to `EVORA_SHUTDOWN_SECONDS` (10);
4. checkpoints the database's write-ahead log into `evora.db` and closes it.

A second signal stops it at once. Give the service manager more time than
`EVORA_SHUTDOWN_SECONDS` (`TimeoutStopSec=20` in the systemd unit,
`stop_grace_period: 20s` in Compose, `docker stop -t 20`).

## Resource sizing

Measured on 2026-11-18 on a Windows 11 PC with Node 24.22.3, running the same
files the Docker image holds (not in Docker: Docker was not available there),
serving the built app:

| | Memory (working set) | Data folder |
|---|---|---|
| Just started, empty | 74 MB | 0.8 MB |
| 5 accounts, 20 files of about 1,000 properties each, 40 images of 200 KB, written through the API | 85 MB | 13.9 MB (7.8 MB of it images) |
| A backup of that | | 10.4 MB |

The built app (`dist/`) is about 34 MB, most of it the Inter font in many
weights and scripts; the Docker image adds the `node:24-slim` base.

From that:

- **Memory**: 256 MB is enough for a small team; 512 MB leaves room for many
  open files and live connections.
- **CPU**: one core. Signing up and signing in use scrypt on purpose, which
  takes a moment of CPU each.
- **Disk**: images dominate. Plan for the images your team uploads, plus about
  the same again for each backup you keep, plus a few hundred MB for the
  database and its write-ahead log.

This was a small workspace and a short run; it was not a load test with many
people editing at once. `npm run bench` has the project's performance
benchmarks.

## Security notes

- Keep the server behind HTTPS for anything beyond one computer: passwords and
  session tokens travel in requests.
- Listen on `127.0.0.1` behind a proxy, and turn on `EVORA_TRUST_PROXY` only
  with a proxy in front, preferably with a list of its addresses.
- The data folder holds password hashes (scrypt), hashed session tokens and
  everyone's files: keep its permissions tight (the systemd unit and the image
  run as unprivileged users) and keep backups as private as the data.
- The server runs only Node's built-in modules: there are no third-party
  packages to keep patched on the server itself; keep Node 24 (or the image)
  up to date.
