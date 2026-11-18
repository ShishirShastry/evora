# Evora server API

This is the reference for the Evora collaboration server: its HTTP API under
`/api` and its live connection, a WebSocket at `/ws`. Use it to build an
integration, write a script against your own server, or understand what your
self-hosted server does. To run a server, see [Self-hosting Evora](self-hosting.md).

Everything here is free and unlimited. There are no plans, seat limits or
feature gates anywhere in the API.

If you write TypeScript, the app's own typed clients are in the repository and
follow this document: `src/collab/api.ts` (accounts, workspaces, documents,
comments), `src/collab/files.ts` (projects, favourites, recents, search,
trash), `src/collab/versions.ts` (versions and branches),
`src/collab/community.ts` (Community and plugin directory) and
`src/collab/libraries.ts` (team libraries, the routes under
[Libraries](#libraries)). The wire contract both sides share is `src/collab/protocol.ts`.

- [The basics](#the-basics)
- [Authentication](#authentication)
- [Who may do what](#who-may-do-what)
- [Errors](#errors)
- [Rate limits](#rate-limits)
- [Size limits](#size-limits)
- [Headers, CORS and origins](#headers-cors-and-origins)
- [Data shapes](#data-shapes)
- [Routes](#routes)
  - [Health](#health)
  - [Accounts and sessions](#accounts-and-sessions)
  - [Google sign-in](#google-sign-in)
  - [Workspaces and members](#workspaces-and-members)
  - [Documents, sharing and links](#documents-sharing-and-links)
  - [Images](#images)
  - [Comments and notifications](#comments-and-notifications)
  - [Versions and branches](#versions-and-branches)
  - [Projects, files, favourites, recents, search and trash](#projects-files-favourites-recents-search-and-trash)
  - [Community](#community)
  - [Plugin directory](#plugin-directory)
  - [Libraries](#libraries)
- [The live connection (WebSocket)](#the-live-connection-websocket)
- [Known limits](#known-limits)

---

## The basics

- **Base address.** The API is under `/api` and the live connection at `/ws`,
  on the server's own origin, for example `http://127.0.0.1:8787/api` (8787 is
  the default port). When the server also serves the app, the app and the API
  share one origin.
- **JSON in, JSON out.** Request bodies are JSON objects; answers are JSON with
  `Content-Type: application/json; charset=utf-8`. An empty body counts as
  `{}`. Image uploads and downloads are the exceptions: they are raw bytes.
- **IDs** the server makes are short random strings of letters, digits, `-`
  and `_`. They never contain `:`. (Plugin IDs are chosen by their authors.)
- **Times** are ISO 8601 strings, for example `"2026-11-18T09:30:00.000Z"`.
- **Text fields are trimmed.** A required text field that is missing or blank
  is refused, and each one has a maximum length, given in the route tables.
- **Success status** is `200`, or `201` where a route says so (something new
  was made). Routes that only do something answer `{}`.

## Authentication

Send one of these headers with each request:

| Header | For | Where it comes from |
|---|---|---|
| `Authorization: Bearer <token>` | Someone with an account | `token` in the answer to sign-up, sign-in, or Google's redeem step |
| `X-Evora-Guest: <guestToken>` | Someone without an account (a guest) | `guestToken` in the answer to `POST /api/guests` |

When both are sent, the `Authorization` header is used and the guest header is
ignored.

**Session tokens.** A token is 32 random bytes in base64url. The server keeps
only its SHA-256 hash. A session ends when you sign out, when you sign out
everywhere, when it has not been used for 90 days, or one year after it
started, however often it is used. Changing your password ends every other
session of the account.

**A token that no longer works** (a session that ended, a guest pass that is
not valid) does not fail the request by itself. The request is handled as if
nobody in particular sent it, so public routes and signing in again still work.
Any route that needs to know who you are then answers `401` with
`"Your session has ended: sign in again"` (or
`"This guest pass is no longer valid"`). So does any route that opens a
document, even one whose link is open to anyone: drop the stale header to
read it without credentials.

**The live connection** does not read these headers. It takes the same token or
guest token inside its first message, `hello` (see
[the live connection](#the-live-connection-websocket)).

## Who may do what

**Roles.** A workspace or a document gives each person a role: `owner`,
`editor` or `viewer`. Owners and editors may change a document. Viewers may
view it and comment on it.

**Your role on a document** is the strongest of:

1. your role as a member of the document itself,
2. your role in the document's workspace,
3. what the document's link gives anyone: `linkAccess` `"view"` makes anyone a
   viewer, `"edit"` makes anyone an editor, `"none"` gives nothing.

Because of (3), when a document's link is on, anyone can read it over HTTP,
guests included, and even a request sent without any credentials. Posting a
comment still needs an account or a guest token, and the live connection
always needs one.

**Workspaces you are not in** are answered with `404 "There is no such
workspace"`, so nobody learns which workspace IDs exist. A **document** you
cannot open is answered with `401` when you sent no credentials and `403`
otherwise.

**Files in the trash** answer `410 "This file is in the trash"` to anyone who
could open them before they were deleted, and `401`/`403` to anyone else.

**Merged branches** can be viewed but not changed. Every route that would
change one answers `409` with `"This branch has been merged into <main>; it can
be viewed but not changed"`.

**Access words used in the route tables:**

| Word | Meaning |
|---|---|
| Public | No credentials needed. |
| Account | A session token (`Authorization: Bearer`). Guests are refused. |
| Account or guest | A session token or a guest token. |
| Can open | Anyone with a role on the document (see above). |
| Member | Any member of the workspace, whatever their role. |
| Editor | Owner or editor (of the workspace or document named). |
| Owner | Owner only. |

## Errors

Every error from the API is a JSON object with one field:

```json
{ "error": "Viewers cannot change the document" }
```

The message is written for people and is safe to show in your interface. It
never contains a stack trace or database details. (The one exception is the
health check: its `503` includes the database's error text. See
[Known limits](#known-limits).)

| Status | When |
|---|---|
| `400` | A body or query that is not valid: missing or too long text, a wrong type, JSON that is not an object or nested more than 64 levels deep, registers that are not valid. |
| `401` | No credentials, or credentials that no longer work, on a route that needs them; a wrong email or password; a Google ticket that expired. |
| `403` | Signed in, but your role does not allow this. |
| `404` | No such route, or no such thing (or a workspace you are not in). |
| `405` | The path exists but not with this method (`"Method not allowed"`). |
| `409` | A conflict: an email already has an account, a workspace would lose its last owner, a merged branch, conflicts left unresolved, a plugin version that is not higher. |
| `410` | A file in the trash, or a branch whose main file has been deleted. |
| `413` | The body is larger than allowed. The server closes the connection after this answer. |
| `429` | A rate limit was reached. Try again later. |
| `500` | Something went wrong on the server (`"Something went wrong on the server"`). |
| `503` | The server is stopping: `{"error": "The server is restarting"}` with `Retry-After: 5`. |

## Rate limits

Limits are counted in fixed windows of **15 minutes**, starting at the first
request counted. They are kept in memory, so restarting the server resets them.
In this version they are not set by flags or environment variables. Beyond a
limit the route answers `429`.

| Limit | Default | Counted per | Routes |
|---|---|---|---|
| Wrong passwords | 10 | Client address and email | `POST /api/auth/login` (a correct password resets it) |
| Wrong passwords from one address | 100 | Client address | `POST /api/auth/login`, whatever the email |
| New accounts | 100 | Client address | `POST /api/auth/signup`, and new accounts made by Google sign-in |
| New guests | 200 | Client address | `POST /api/guests` |
| Counted requests | 300 | Client address | `POST /api/plugins/directory/:id/install`, `POST /api/community/resources/:id/copies`, `POST /api/community/resources/:id/duplicate` |
| Comments | 600 | Person | New threads, replies and comment edits |
| Invitations | 300 | Account | `POST /api/workspaces/:id/members`, `POST /api/workspaces/:id/invites`, `POST /api/documents/:id/members` |
| Image uploads | 5000 | Person (or client address) | `PUT /api/documents/:id/assets/:hash` |
| New email links | 5 | Account | `POST /api/me/email/resend` |
| Invitation emails | 50 | Account | Invitations by email beyond this are still made, without an email |
| Wrong email links | 50 | Client address | `POST /api/auth/verify-email` with a token that is wrong, used or expired |
| Wrong passwords for a new address | 10 | Account | `PATCH /api/me/email` with `email` |

Once an address is limited on sign-in, even a correct password is refused until
the window ends.

**The client address** is the connection's own address. Behind a reverse
proxy, turn on the trust-proxy setting so the address is read from
`X-Forwarded-For` instead; otherwise every caller shares the proxy's address
and its limits (see [Trust proxy](self-hosting.md#trust-proxy)).

The live connection has its own limit: **20,000 messages in 10 seconds** per
connection (see [Limits of the live connection](#limits-of-the-live-connection)).

## Size limits

| What | Limit | Setting |
|---|---|---|
| A JSON body (most routes) | 2 MB | `EVORA_MAX_JSON_MB` / `--max-json-mb` (0.0625 to 256) |
| The body of `POST /api/documents` and `POST /api/community/resources` (they carry a whole file) | 50 MB | `EVORA_MAX_UPLOAD_MB` / `--max-upload-mb` (1 to 1024) |
| An image upload (document or Community) | 50 MB | `EVORA_MAX_UPLOAD_MB` |
| A message on the live connection, after `hello` | 50 MB | `EVORA_MAX_UPLOAD_MB` |
| A message on the live connection, before `hello` | 64 KB | fixed |
| A plugin bundle (`POST /api/plugins/directory`) | 8 MB | fixed |
| A Community cover | 5 MB, PNG, JPEG or WebP | fixed |
| JSON nesting (a body, or a register's value) | 64 levels | fixed |
| A register key | 1024 characters | fixed |
| A comment | 20,000 characters | fixed |
| A password | 8 to 1024 characters | fixed |

A body over its limit is answered `413 "The request is larger than N MB"`.
Keep your reverse proxy's own body limit above `EVORA_MAX_UPLOAD_MB`.

## Headers, CORS and origins

**Security headers.** Every answer of the API (except `/api/health` and
`/api/version`, which are answered before it) carries
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin`. JSON
answers also carry `Cache-Control: no-store` and
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`.
When the request came over HTTPS (TLS, or a proxy that sends
`X-Forwarded-Proto: https`), answers carry
`Strict-Transport-Security: max-age=31536000; includeSubDomains`.

**Uploaded files** are served with `Content-Security-Policy: default-src 'none'; sandbox`
and `nosniff`, so nothing uploaded ever runs as a page on your server. An upload
keeps its declared type only when it is one of `image/png`, `image/jpeg`,
`image/gif`, `image/webp`, `image/avif`, `image/svg+xml`, `image/bmp` or
`image/x-icon`. Anything else is stored and served as
`application/octet-stream`.

**CORS.** The server sends no CORS headers and does not answer preflight
(`OPTIONS`) requests. The app always talks to the server on its own origin
(the desktop app passes its requests on itself). So:

- a web page on **another origin** cannot call the API from a browser. Serve
  your integration from the same origin, for example under the same reverse
  proxy;
- **scripts and servers** (curl, Node, Python) are not affected by CORS and can
  call the API directly.

**WebSocket origin.** The server does not check the `Origin` header of the
WebSocket handshake. Access is decided only by the token in `hello`.

**Origins for Google sign-in.** `GET /api/auth/google/start` sends people back
only to the app's public URL (`EVORA_PUBLIC_URL`) or to `localhost` /
`127.0.0.1`.

---

## Data shapes

These are the JSON shapes the routes answer with, written as TypeScript. A `?`
marks a field that may be missing. They come from `src/collab/protocol.ts` and
the server's own types.

### People

```ts
interface User {            // you, as an account
  id: string;
  email: string;
  name: string;
  color: string;            // "#rrggbb", for cursors and avatars
  createdAt: string;
}

interface Guest { id: string; name: string; color: string }

interface UserRef {         // someone mentioned in another object
  id: string;
  name: string;
  color: string;
  guest?: boolean;          // true for a guest without an account
}

interface AuthResult { token: string; user: User }
interface GuestResult { guestToken: string; guest: Guest }

type Role = 'owner' | 'editor' | 'viewer';
type LinkAccess = 'none' | 'view' | 'edit';
```

### Workspaces and documents

```ts
interface Workspace {
  id: string;
  name: string;
  role: Role;               // your role there
  memberCount: number;
  createdAt: string;
}

interface Member { user: UserRef & { email: string }; role: Role }
interface PendingInvite { email: string; role: Role; createdAt: string }
interface Members { members: Member[]; pending: PendingInvite[] }

interface DocInfo {
  id: string;
  name: string;
  workspaceId: string;
  role: Role | null;        // your role, or null
  linkAccess: LinkAccess;
  owner: UserRef;
  createdAt: string;
  updatedAt: string;
}

// File lists leave branches out and list them under their main file.
interface BranchFields {
  mainId: string | null;    // for a branch: its main file's ID
  branches: FileBranch[];   // a main file's open branches you can open, newest first
}
interface FileBranch { id: string; name: string; updatedAt: string; createdBy: UserRef; role: Role }

type ListedDoc = DocInfo & BranchFields;

interface FileInfo extends DocInfo, BranchFields {
  projectId: string | null;
  projectName: string | null;
  workspaceName: string | null;   // when you are a member of its workspace
  favorite: boolean;
  openedAt: string | null;        // when you last opened it, as the app reported
}

interface Project { id: string; workspaceId: string; name: string; createdAt: string; fileCount: number }

interface TrashedFile {
  id: string;
  name: string;
  workspaceId: string;
  owner: UserRef;
  trashedBy: UserRef;
  trashedAt: string;
  purgeAt: string;          // when it is deleted for good (30 days later)
  canDelete: boolean;       // whether you may delete it for good
}
```

### Registers (the content of a document)

```ts
interface Register { k: string; v: unknown; c: string }        // key, JSON value, clock
interface StoredRegister extends Register { s: number }         // plus the server's sequence number
```

See [registers and their keys](#registers-and-their-keys).

### Comments and notifications

```ts
interface Comment {
  id: string;
  threadId: string;
  author: UserRef;
  body: string;             // mentions are written @[Name](userId)
  mentions: string[];       // the user IDs mentioned
  createdAt: string;
  editedAt: string | null;
}

interface Thread {
  id: string;
  docId: string;
  pageId: string;
  x: number;                // page coordinates, or relative to the layer when nodeId is set
  y: number;
  nodeId: string | null;    // the layer the pin follows
  resolved: boolean;
  createdAt: string;
  comments: Comment[];
}

interface Notification {
  id: string;
  kind: 'mention' | 'reply' | 'invite' | 'shared';
  docId: string | null;
  threadId: string | null;
  workspaceId: string | null;
  from: UserRef;
  text: string;             // a short text to show
  createdAt: string;
  read: boolean;
}
```

### Versions and branches

```ts
interface VersionInfo {
  id: string;
  docId: string;
  kind: 'auto' | 'named';
  name: string;             // empty for an automatic version
  description: string;
  seq: number;              // the document's sequence number the version holds
  author: UserRef | null;   // null for the server's own versions
  createdAt: string;
}

interface BranchInfo {
  id: string;               // the branch's own document ID
  name: string;
  mainId: string;
  mainName: string;
  status: 'open' | 'merged';
  baseSeq: number;          // main's sequence number at the branch point or last update
  createdBy: UserRef;
  createdAt: string;
  mergedAt: string | null;
  mergedBy: UserRef | null;
}

interface Change { key: string; base: unknown; value: unknown }
interface Conflict { key: string; base: unknown; main: unknown; branch: unknown }
type Resolution = 'main' | 'branch';
```

### Team libraries

```ts
interface LibrarySummary {
  id: string;                    // the library's document ID
  name: string;
  workspaceId: string | null;    // null when you are not in its workspace (it was shared with you as a document)
  workspaceName: string | null;
  version: number;               // counts up with every publishing
  publishedAt: string;
  components: number;            // nodes of kind COMPONENT in the publication (each variant counts)
  styles: number;
  variables: number;
}
```

### Community and plugins

```ts
type ResourceKind = 'file' | 'template' | 'ui-kit' | 'components' | 'icons';

interface ResourceSummary {
  id: string;
  kind: ResourceKind;
  title: string;
  description: string;
  tags: string[];
  author: UserRef;
  coverAt: string | null;   // null when there is no cover
  version: number;          // the latest version's number
  duplicates: number;       // how many people took a copy
  createdAt: string;
  updatedAt: string;
  sourceKey?: string;       // only for its author: "doc:<id>" or "local:<id>"
}

interface ResourceDetail extends ResourceSummary {
  versions: { number: number; name: string; notes: string; createdAt: string; assetCount: number }[];
}

interface VersionContent {
  resourceId: string;
  number: number;
  name: string;
  registers: Register[];
  assets: { hash: string; contentType: string }[];   // the images this version uses
}

interface DirectoryEntry {
  id: string;
  name: string;
  description: string;
  version: string;          // the latest version
  kind: 'plugin' | 'widget';
  author: { id: string; name: string };
  installs: number;
  updatedAt: string;
}
```

---

## Routes

Each table lists the method and path, who may call it, what to send, and what
comes back. Path parameters are written `:name`. Notes after a table give the
status codes worth knowing about beyond the general ones in [Errors](#errors).

### Health

These two are answered before everything else, so they work whatever state the
rest of the server is in. They accept `GET` and `HEAD`.

| Route | Access | Answer |
|---|---|---|
| `GET /api/health` | Public | `200 {ok: true, version, uptime, db: "ok"}` |
| `GET /api/version` | Public | `200 {version, node, database}` |

- `uptime` is in seconds. `database` is the database's schema version.
- `/api/health` answers `503 {ok: false, version, uptime, db: "error", error}`
  when the database cannot be read, and
  `503 {ok: false, version, uptime, db, stopping: true}` while the server is
  stopping. Use it for Docker or load-balancer health checks.
- Other methods on `/api/version` answer `405` with `Allow: GET, HEAD`.

### Accounts and sessions

| Route | Access | Body | Answer |
|---|---|---|---|
| `POST /api/auth/signup` | Public | `{email, name, password}` | `201 AuthResult` |
| `POST /api/auth/login` | Public | `{email, password}` | `AuthResult` |
| `POST /api/auth/logout` | Public | — | `{}` |
| `POST /api/auth/logout-all` | Account | — | `{}` |
| `POST /api/guests` | Public | `{name}` | `GuestResult` |
| `GET /api/me` | Account | — | `{user: User, workspaces: Workspace[]}` |
| `PATCH /api/me` | Account | `{name?, color?, password?}` | `User` |

- **Sign up.** `email` up to 254 characters, `name` up to 100, `password` 8 to
  1024 characters. A new account gets its own workspace (`"<name>'s
  workspace"`), and any invitations waiting for that email are taken up at
  once. `409` when the email already has an account; `429` for too many new
  accounts from one address. With email off the address is not verified; with
  email on, a link to confirm it is sent, and invitations wait until it is
  confirmed (see [Email](#email)).
- **Sign in.** `401 "Wrong email or password"` for a wrong password or an
  unknown email (both take the same time). An account made with Google has no
  password until one is set with `PATCH /api/me`, so signing in with a password
  fails the same way. `429` after too many wrong attempts.
- **Sign out** ends the session the request was sent with and closes the live
  connections made with it. Without a session it does nothing and still
  answers `{}`.
- **Sign out everywhere** (`logout-all`) ends every session of the account,
  this one included, and closes all their live connections.
- **Guests** are for opening documents by their link without an account.
  `name` up to 100 characters.
- **`PATCH /api/me`**: `name` up to 100 characters, `color` as `#rrggbb`,
  `password` 8 to 1024 characters. A new password ends every other session of
  the account. A new name or colour is shown at once to others in open
  documents.

### Google sign-in

"Continue with Google" works only when the server has a Google OAuth client
(see [Continue with Google](self-hosting.md#continue-with-google)). It is a
browser flow: the server does the OAuth code exchange with PKCE, and the
session token is never put in an address.

| Route | Access | Body / query | Answer |
|---|---|---|---|
| `GET /api/auth/providers` | Public | — | `{google: boolean}` |
| `GET /api/auth/google/start` | Public | `?origin=<app origin>&mode=login\|signup&invite=<invite token>&desktop=1&nonce=<nonce>&code_challenge=<challenge>&code_challenge_method=S256` | `302` to Google |
| `GET /api/auth/google/callback` | Public (Google sends the browser here) | `?code&state` | `302` back to the app; for a desktop sign-in, `200` with a page that goes on to `evora://auth` |
| `POST /api/auth/google/redeem` | Public | `{ticket, verifier?}` (`verifier`: only for a desktop ticket) | `AuthResult` |

1. Send the browser to `/api/auth/google/start`. `origin` must be the app's
   public URL or a `localhost` / `127.0.0.1` origin (`400` otherwise). Without
   `origin`, the public URL (`EVORA_PUBLIC_URL`) is used, and `400` when there
   is none. `mode` defaults to `login`. `invite` is optional: a workspace
   invite token, joined at once after signing in. The server sets a cookie,
   `evora_google_state` (`HttpOnly`, `SameSite=Lax`, 10 minutes), so that the
   sign-in finishes only in the browser that started it. `404` when Google
   sign-in is not set up.
2. Google sends the browser to `/api/auth/google/callback`, which redirects to
   `<origin>/#/auth/google?ticket=<ticket>`, or to
   `<origin>/#/auth/google?error=<message>` when something went wrong (it was
   cancelled, took more than 10 minutes, was already used, came back in another
   browser, or Google has not verified the email).
3. Post the ticket to `/api/auth/google/redeem`. A ticket works once, for two
   minutes; after that `401`.

An account with the same verified email is linked to the Google account. When
that happens, every session the account had before ends, since accounts are
made without checking the email.

**From the desktop app.** The desktop app (whose pages are at `app://evora/`)
opens `/api/auth/google/start` in the system's browser with `origin` set to
the server's own origin (so it must be the public URL or a localhost one, as
above), `desktop=1`, `nonce` (22 to 128 letters, digits, `-` or `_` that the
app made) and `code_challenge`: the base64url SHA-256 of a random PKCE
verifier the app keeps to itself (43 letters, digits, `-` or `_`), with
`code_challenge_method=S256` (the default; any other method is refused). `400`
when `desktop` is given without a good nonce and challenge, or with a value
other than `1`. Everything else is the same, the cookie included, until the
callback: instead of the `302` to the app, it answers `200` with a small HTML
page (no scripts, `Cache-Control: no-store`) that says "Click Open Evora to
finish", with an "Open Evora" link (and a meta refresh, as a best effort) to
`evora://auth?ticket=<ticket>&nonce=<nonce>`, or
`evora://auth?error=<message>&nonce=<nonce>`. The system hands that address to
the desktop app, which accepts it only with its own nonce, within 10 minutes,
once, and then posts `{ticket, verifier}` to `/api/auth/google/redeem`.

A desktop ticket is bound to the challenge it was started with: it is redeemed
only with the verifier whose SHA-256 is that challenge (compared in constant
time). Posted without a verifier, or with another one, it is refused (`401`)
and burned, so a program that caught the `evora://` address cannot use it. Web
tickets need no verifier (one given is ignored). The server keeps the nonce and
challenge of each desktop sign-in in memory (at most 10,000, each until its
state expires): a server restarted during a desktop sign-in finishes it in the
web app at `origin` instead. A ticket, once made, is stored with its challenge,
so a restart does not unbind it.

### Email

Email is on only when the server has a mail relay (`EVORA_SMTP_URL` and
`EVORA_MAIL_FROM`, see [Sending email](self-hosting.md#sending-email)). These
routes exist either way; `mail` in the answer says which.

| Route | Access | Body | Answer |
|---|---|---|---|
| `GET /api/me/email` | Account | — | `{mail: boolean, email, verified: boolean, mentionEmails: boolean, pendingEmail: string | null, linkSent: boolean}` (`pendingEmail`: a new address asked for and not yet confirmed; the account keeps its address until it is) |
| `PATCH /api/me/email` | Account | `{mentionEmails?: boolean, email?, password?}` | the same as `GET`; a new `email` is `409` with email off, needs the password (or, for an account without one, a Google sign-in in the last 10 minutes, else `403`), and is `429` beyond the limits |
| `POST /api/me/email/resend` | Account | — | `{sent: true}` |
| `POST /api/auth/verify-email` | Public | `{token}` | `{email, verified: true}` |

- **Confirming an address.** With email on, signing up with a password (and
  changing the address) sends a link, `<EVORA_PUBLIC_URL>/#/verify-email/<token>`.
  The app posts the token to `POST /api/auth/verify-email`, which needs no
  session, so the link works on any device. A token works once, for 24 hours,
  for the address it was sent to; only its SHA-256 is stored. `400` for a token
  that is wrong, used, expired, or for an address the account no longer has;
  `429` after too many such tries from one client address. Confirming takes up
  the invitations waiting for the address. An account made through Google, or
  linked to Google by its verified address, is confirmed already (and linking
  takes up its waiting invitations too).
- **`resend`** makes a new link and sends it; older links stop working. `409`
  when email is off or the address is confirmed already; `429` beyond 5 in 15
  minutes.
- **`PATCH`**: `mentionEmails` turns the emails about mentions off or on (the
  notification in the app is not affected). `email` changes the account's
  address (up to 254 characters, lower-cased); it needs the account's current
  `password` when it has one (`403` otherwise, `429` after 10 wrong ones), and
  `409` when another account has it. The new address is not confirmed: with
  email on a link is sent to it, and invitations to it wait until it is
  confirmed. With email off, changing the address takes up no invitations.
- **What is sent.** Invitations to a workspace or a file by email (to the
  address, whether or not it has an account), mentions in comments (to the
  mentioned person's confirmed address, unless `mentionEmails` is false), and
  the links above. Sending happens in the background and never delays an
  answer.

### Workspaces and members

| Route | Access | Body | Answer |
|---|---|---|---|
| `GET /api/workspaces` | Account | — | `Workspace[]` |
| `POST /api/workspaces` | Account | `{name}` | `201 Workspace` |
| `PATCH /api/workspaces/:id` | Owner | `{name}` | `Workspace` |
| `DELETE /api/workspaces/:id` | Owner | — | `{}` |
| `GET /api/workspaces/:id/members` | Member | — | `Members` |
| `POST /api/workspaces/:id/members` | Editor | `{email, role}` | `Members` |
| `PATCH /api/workspaces/:id/members/:userId` | Owner | `{role}` | `Members` |
| `DELETE /api/workspaces/:id/members/:userId` | Owner, or yourself to leave | — | `{}` |
| `POST /api/workspaces/:id/invites` | Editor | `{role}` | `{token}` |
| `GET /api/invites/:token` | Public | — | `{workspace: {id, name}, role, from: UserRef}` |
| `POST /api/invites/:token/accept` | Account | — | `Workspace` |

- Names are up to 100 characters. You become the owner of a workspace you make.
- **Deleting a workspace** deletes it with all its documents and everything in
  them, for good. Anyone who has one of them open is disconnected.
- **Adding a member** by email: if the email has an account, the person is
  added at once (or their role is raised; it is never lowered here), and gets
  an `invite` notification when newly added. If not, a pending invitation is kept and taken up when
  someone signs up with that email. With email off no email is sent. With email
  on ([Email](#email)) the address is sent the invitation, and an account whose
  address is not confirmed yet gets it only once it is: until then it is
  pending (listed in `pending`). Only owners can make
  owners (`403`). Counts towards the invitation limit (`429`).
- **`:userId` can be an email** in `PATCH` and `DELETE` of members: that
  changes or removes a pending invitation. Removing a pending invitation needs
  an editor; changing one needs an owner. `404` when there is no such member or
  invitation.
- A workspace keeps at least one owner: `409 "A workspace needs at least one
  owner"`.
- **Invite links.** `POST .../invites` makes a link token. The app's link is
  `<app address>#/invite/<token>`. Only owners can make owner links. Anyone can
  read what a token is for (`GET /api/invites/:token`); accepting it adds you
  to the workspace, or raises your role there. `404 "This invite link is not
  valid"` for an unknown token. This version has no route to withdraw an
  invite link.

### Documents, sharing and links

| Route | Access | Body | Answer |
|---|---|---|---|
| `GET /api/workspaces/:id/documents` | Member | — | `ListedDoc[]` |
| `GET /api/shared` | Account | — | `ListedDoc[]` |
| `POST /api/documents` | Account; editor of the workspace | `{workspaceId, name, registers?}` | `201 DocInfo` |
| `GET /api/documents/:id` | Can open | — | `DocInfo` |
| `PATCH /api/documents/:id` | Editor | `{name?, linkAccess?}` | `DocInfo` |
| `DELETE /api/documents/:id` | Account; owner of the file | — | `{}` |
| `POST /api/documents/:id/trash` | Account; owner of the file | — | `{}` |
| `GET /api/documents/:id/members` | Can open, with an account | — | `Members` |
| `POST /api/documents/:id/members` | Editor, with an account | `{email, role}` | `Members` |
| `PATCH /api/documents/:id/members/:userId` | Owner, with an account | `{role}` | `Members` |
| `DELETE /api/documents/:id/members/:userId` | Owner, or yourself to leave (with an account) | — | `{}` |
| `GET /api/documents/:id/registers` | Can open | — | `{seq, registers: StoredRegister[]}` |

- **Lists** (`documents`, `shared`) are newest first and leave branches out;
  each main file carries its open branches in `branches`. `GET /api/shared`
  lists files shared with you directly that you do not own.
- **Making a document.** `name` up to 200 characters. `registers` is the
  starting content (for example a file from your device); it is checked like
  changes on the live connection (`400` with the reason when one is not
  valid). This body may be as large as the upload limit.
- **`PATCH`**: `name` up to 200 characters; renaming reaches everyone who has
  the file open. `linkAccess` is `"none"`, `"view"` or `"edit"`, and changing
  it needs an account (`403 "Sign in to change who has access"` for a guest
  editor). Renaming a merged branch answers `409`.
- **Deleting a document** moves it to its workspace's trash. `DELETE` and
  `POST .../trash` do the same thing. Only an owner of the file may (`403`
  otherwise). Its members, invitations and link access are set aside, nobody
  can open it, and anyone who has it open is disconnected. It is deleted for
  good after 30 days, or with `DELETE /api/trash/:docId`.
- **Document members** work like workspace members: an existing account is
  added (or raised) and gets a `shared` notification; another email becomes a
  pending invitation; `:userId` can be an email for a pending invitation
  (removing one needs an editor). Only owners can make owners. Guests cannot
  see or change who has access (`403`). Adding counts towards the invitation
  limit.
- **Registers** gives the whole document as it is now, with the server's
  latest sequence number `seq`. This is a snapshot; to follow changes live, use
  the WebSocket.

### Images

Images are stored per document and named by the SHA-256 of their bytes,
written as 64 lowercase hex characters.

| Route | Access | Body | Answer |
|---|---|---|---|
| `PUT /api/documents/:id/assets/:hash` | Editor | The image's bytes, with its `Content-Type` | `{}` |
| `GET /api/documents/:id/assets/:hash` | Can open | — | The bytes |

- **Upload**: `400` when `:hash` is not a SHA-256 in lowercase hex, or the
  bytes do not match it. `409` on a merged branch. `413` over the upload limit.
  `429` over the upload limit per person. Uploading the same image again
  replaces it.
- **Download**: served with the stored type (see
  [Headers](#headers-cors-and-origins)), `Cache-Control: private,
  max-age=31536000, immutable`, and a sandboxing content security policy.
  `404` when the document has no such image.
- A document refers to its images through `a:<hash>` registers (see
  [registers](#registers-and-their-keys)). Upload the bytes so that others can
  download them.

### Comments and notifications

| Route | Access | Body | Answer |
|---|---|---|---|
| `GET /api/documents/:id/threads` | Can open | — | `Thread[]` |
| `POST /api/documents/:id/threads` | Account or guest who can open it | `{pageId, x, y, nodeId?, body}` | `201 Thread` |
| `POST /api/threads/:id/comments` | Account or guest who can open it | `{body}` | `Thread` |
| `PATCH /api/threads/:id` | Account or guest who can open it | `{resolved?, x?, y?}` | `Thread` |
| `DELETE /api/threads/:id` | The thread's author, or an editor | — | `{}` |
| `PATCH /api/comments/:id` | The comment's author | `{body}` | `Thread` |
| `DELETE /api/comments/:id` | The comment's author | — | `Thread`, or `{}` |
| `GET /api/notifications` | Account or guest | — | `Notification[]` |
| `POST /api/notifications/read` | Account or guest | `{ids: string[]}` | `{}` |

- **Viewers and guests may comment.** A thread is a pin on a page: `pageId`
  (up to 200 characters), `x` and `y` (numbers), optionally `nodeId` (the layer
  it follows, up to 200 characters, or `null`), and the first comment's
  `body`.
- **Comment text** is 1 to 20,000 characters. Write a mention as
  `@[Name](userId)`: the person mentioned gets a `mention` notification. When a
  comment is edited, only people mentioned for the first time are told.
  Replies send `reply` notifications. New threads, replies and edits count
  towards the comment limit (`429`).
- **`PATCH /api/threads/:id`**: anyone who can comment may resolve or reopen a
  thread (`resolved`, `true` or `false`). Moving it (`x`, `y`) needs an editor
  or the thread's author (`403`).
- **Deleting the last comment** of a thread deletes the thread and answers
  `{}`; otherwise the answer is the thread as it is now.
- Every change to a thread is also sent to everyone who has the document open,
  as a `comment` message on the live connection.
- **Notifications** are yours only, newest first, up to 200. Marking IDs that
  are not yours as read does nothing.

### Versions and branches

Versions are saved copies of a shared document. The server also makes
automatic ones: before a change that arrives 10 minutes or more after the last
version, or 1000 changes after it. Automatic versions are thinned out as they
age (all of the last day, one a day for 30 days, then one a week); named ones
are kept. A document's versions stay after the document is deleted, as a
backup.

| Route | Access | Body | Answer |
|---|---|---|---|
| `GET /api/documents/:id/versions` | Can open | — | `VersionInfo[]` (newest first) |
| `POST /api/documents/:id/versions` | Editor | `{name, description?}` | `201 VersionInfo` |
| `GET /api/documents/:id/versions/:versionId` | Can open | — | `{version: VersionInfo, registers: Register[]}` |
| `PATCH /api/documents/:id/versions/:versionId` | Editor | `{name?, description?}` | `VersionInfo` |
| `DELETE /api/documents/:id/versions/:versionId` | Editor | — | `{}` |
| `POST /api/documents/:id/versions/:versionId/restore` | Editor | — | `{seq, changed, before: VersionInfo}` |
| `GET /api/workspaces/:id/deleted-documents` | Editor of the workspace | — | `{docId, name, versions, latestAt}[]` |
| `POST /api/workspaces/:id/deleted-documents/:docId/recover` | Editor of the workspace | — | `201 DocInfo` |
| `DELETE /api/workspaces/:id/deleted-documents/:docId` | Owner of the workspace | — | `{}` |
| `POST /api/documents/:id/branches` | Account; editor | `{name}` | `201 BranchInfo` |
| `GET /api/documents/:id/branches` | Can open | — | `(BranchInfo & {role})[]` |
| `GET /api/documents/:id/branch` | Can open | — | `{branch: BranchInfo \| null}` |
| `GET /api/documents/:id/update-from-main` | Can open the branch | — | `{mainSeq, baseSeq, changes: Change[], conflicts: Conflict[]}` |
| `POST /api/documents/:id/update-from-main` | Editor of the branch | `{resolutions?}` | `{seq, applied, baseSeq}` |
| `GET /api/documents/:id/merge` | Can open the branch | — | `{mainId, mainSeq, baseSeq, status, canMerge, changes, conflicts}` |
| `POST /api/documents/:id/merge` | Account; editor of the main file | `{resolutions?}` | `{mainSeq, applied, before, after, branch: BranchInfo}` |

**Versions**

- `name` up to 200 characters, `description` up to 5000.
- A version's `registers` hold its values, not their original clocks: every
  register is given the same placeholder clock.
- Giving an automatic version a name makes it a named version, which is kept.
  `400 "A named version needs a name"` when that would leave it without one.
- **Restoring** first saves a named version `"Before restoring …"` (returned as
  `before`), then changes the document back to the version with ordinary
  changes, which reach everyone who has it open. `changed` is the number of
  registers changed. The document's name is left as it is, and so is what it
  publishes as a library (`d:publication`): a library's version only counts
  up, and a restore never brings back an older publication or unpublishes it.
  `409` on a merged branch.
- **Deleted documents**: files deleted for good whose versions are still kept.
  Recovering makes a new document from the latest version (`409` when the file
  was not deleted, `404` when there is no backup). Deleting purges those
  versions.

**Branches**

- A branch is a document of its own: a copy of its main file with the same
  document members, link access and images. Its `:id` is the branch's own
  document ID. A branch cannot have branches (`400`).
- `GET .../branches` lists a main file's branches that you can open, merged
  ones included, each with your role on it. `GET .../branch` says whether a
  document is a branch, and of what.
- **Update from main** and **merge** first show what would happen with `GET`:
  the changes since the branch's base, and the **conflicts** (a register
  changed on both sides to different values). `canMerge` says whether you may
  merge. Neither carries the document's name or its publication
  (`d:publication`): each side keeps its own.
- To apply, send `resolutions`: an object mapping each conflicting register key
  to `"main"` or `"branch"`. `409 "N conflicts need a choice"` while any is
  left unresolved. `applied` is the number of registers changed.
- **Merging** saves `"Before merging <branch>"` and `"Merged <branch>"`
  versions on main (`before` and `after`); restoring the first undoes the
  merge. The branch is then merged: viewable, never changed again. Merging an
  already merged branch answers `409`. Only editors of the main file may merge.
- `404 "This file is not a branch"` on a document that is not one;
  `410` when the branch's main file has been deleted.

### Projects, files, favourites, recents, search and trash

Projects are folders inside a workspace. A file is in at most one project, or
at the workspace's root. Favourites and recents belong to each person.

| Route | Access | Body / query | Answer |
|---|---|---|---|
| `GET /api/workspaces/:id/projects` | Member | — | `Project[]` |
| `POST /api/workspaces/:id/projects` | Editor | `{name}` | `201 Project` |
| `PATCH /api/projects/:id` | Editor of its workspace | `{name}` | `Project` |
| `DELETE /api/projects/:id` | Editor of its workspace | — | `{}` |
| `GET /api/workspaces/:id/files` | Member | — | `FileInfo[]` |
| `POST /api/documents/:id/move` | Account; editor of the file and of the target workspace | `{workspaceId?, projectId?}` | `FileInfo` |
| `POST /api/documents/:id/duplicate` | Account who can open it; editor of the target workspace | `{workspaceId?, projectId?, name?}` | `201 FileInfo` |
| `GET /api/workspaces/:id/trash` | Member | — | `TrashedFile[]` |
| `POST /api/trash/:docId/restore` | Editor of its workspace | — | `FileInfo` |
| `DELETE /api/trash/:docId` | A member of its workspace who is a workspace owner, whoever deleted it, or the file's owner | — | `{}` |
| `GET /api/favorites` | Account | — | `FileInfo[]` |
| `PUT /api/favorites/:docId` | Account who can open it | — | `{}` |
| `DELETE /api/favorites/:docId` | Account | — | `{}` |
| `GET /api/recents` | Account | — | `FileInfo[]` |
| `POST /api/recents/:docId` | Account who can open it | — | `{}` |
| `GET /api/files/search` | Account | `?q=<text>` | `FileInfo[]` |

- Project names are up to 100 characters. **Deleting a project** keeps its
  files: they move to the workspace's root.
- **Moving** a file: `workspaceId` defaults to its own workspace; `projectId`
  is a project in the target workspace, or `null` for the root (`400` for a
  project of another workspace). Taking a file out of its workspace needs an
  editor of that workspace or an owner of the file. Moving changes who can open it,
  and anyone who may no longer do so is disconnected.
- **Duplicating** copies the file as it is now, with its images. `name`
  (up to 200 characters) defaults to `"<name> copy"`; in the same workspace the
  copy goes into the same project unless `projectId` says otherwise.
- **Trash**: files stay 30 days, then are deleted for good (the server checks
  every hour and when the trash is listed). Restoring brings back the file's
  members, invitations and link access. Deleting from the trash is permanent.
  `404 "That file is not in the trash"`.
- **Favourites**: removing one that is not there still answers `{}`.
- **Recents**: `POST /api/recents/:docId` records that you opened a file; the
  server keeps your last 50 and lists up to 30 you can still open. (The app
  records files opened from its file browser, not from a direct link.)
- **Search** matches file names containing `q` (up to 200 characters), in your
  workspaces and among files shared with you directly, newest first, up to 100.
  An empty `q` answers `[]`.
- File lists leave out branches and files in the trash; branches are listed
  under their main file in `branches`.

### Community

The Community library holds design files, templates, UI kits, component
libraries and icon libraries that people publish. Browsing, reading and taking
a copy need no account; publishing and duplicating into a workspace need one.

| Route | Access | Body / query | Answer |
|---|---|---|---|
| `GET /api/community/resources` | Public | `?q=&kind=&tag=&sort=newest\|popular&limit=&offset=` | `{items: ResourceSummary[], total}` |
| `GET /api/community/tags` | Public | — | `{tag, count}[]` |
| `GET /api/community/mine` | Account | — | `ResourceSummary[]` (with `sourceKey`) |
| `POST /api/community/resources` | Account; editor of the file when `docId` is given | `{docId}` or `{registers, sourceId}`, plus `{kind, title, description?, tags?, notes?}` | `{resource: ResourceDetail, version, created}` (`201` when new) |
| `GET /api/community/resources/:id` | Public | — | `ResourceDetail` |
| `PATCH /api/community/resources/:id` | Its author | `{kind?, title?, description?, tags?}` | `ResourceDetail` |
| `DELETE /api/community/resources/:id` | Its author | — | `{}` |
| `PUT /api/community/resources/:id/cover` | Its author | PNG, JPEG or WebP bytes | `{}` |
| `GET /api/community/resources/:id/cover` | Public | — | The picture |
| `PUT /api/community/resources/:id/assets/:hash` | Its author | The image's bytes | `{}` |
| `GET /api/community/resources/:id/assets/:hash` | Public | — | The bytes |
| `GET /api/community/resources/:id/versions/:number` | Public | — | `VersionContent` |
| `POST /api/community/resources/:id/copies` | Public | `{version?}` | `VersionContent` |
| `POST /api/community/resources/:id/duplicate` | Account; editor of the workspace | `{workspaceId, version?, projectId?}` | `201 FileInfo` |

- **Browsing.** `q` is up to five words; each must appear in the title,
  description, a tag or the author's name. `kind` is one of `file`,
  `template`, `ui-kit`, `components`, `icons`. `sort` is `newest` (the
  default) or `popular`. `limit` is 1 to 100 (default 48). `tags` lists the 30
  most used tags.
- **Publishing.** Publish a shared file by its `docId` (you must be able to
  edit it), or a file from your device by its `registers` and a `sourceId` you
  choose (up to 200 characters). Publishing again from the same file makes a
  new version of the same resource (`200`, `created: false`). For a new
  resource `kind` and `title` (up to 100 characters) are required.
  `description` is up to 2000 characters, `notes` (about this version) up to
  1000, and `tags` a list of up to 10 tags of up to 30 characters each, stored
  in lowercase with spaces turned into `-`. The body may be as large as the
  upload limit. A version is a snapshot: later edits to the file do not change
  it.
- **Images.** For a shared file, the images it uses are copied when it is
  published. For a file from your device, upload each image the latest version
  uses with `PUT .../assets/:hash` (`400` for an image the version does not
  use, or bytes that do not match the hash).
- **Cover.** `Content-Type` must be `image/png`, `image/jpeg` or `image/webp`,
  up to 5 MB, and the bytes must really be that kind of picture (`400`). Covers
  are served with `Cache-Control: public, max-age=300`; `404` when there is
  none.
- **Taking a copy.** `copies` answers a version's content (the latest unless
  `version`, a number, is given) for keeping on your device. `duplicate` makes
  it a new file in one of your workspaces, with its images, optionally in a
  project there. Both count you once in `duplicates`, however often you take
  it, and both count towards the per-address limit for counted requests
  (`429`).
- **Unpublishing** (`DELETE`) removes the resource, its versions and its files.
  `404 "There is no such resource: it may have been unpublished"`.

### Plugin directory

Anyone with an account can publish a plugin or widget. A plugin's ID belongs to
whoever published it first, and only they can publish new versions. Browsing
and downloading need no account. Bundles are checked with the same rules the
app uses to install them; how to write a plugin is in `plugins/PLUGINS.md`.

| Route | Access | Body / query | Answer |
|---|---|---|---|
| `GET /api/plugins/directory` | Public | `?q=&kind=plugin\|widget` | `DirectoryEntry[]` |
| `POST /api/plugins/directory` | Account; the publisher for a new version | `{bundle, description?, notes?}` | `DirectoryEntry` (`201` when new, `200` for a new version) |
| `GET /api/plugins/directory/:id` | Public | — | `DirectoryEntry & {permissions, commands, widgets, versions}` |
| `GET /api/plugins/directory/:id/versions/:version` | Public | — | `{bundle}` |
| `POST /api/plugins/directory/:id/install` | Public | `{version?}` | `{bundle, installs}` |
| `DELETE /api/plugins/directory/:id` | The publisher | — | `{}` |

- **Listing** matches `q` (up to 100 characters) in the name, description, ID
  or publisher's name, most installed first, up to 200.
- **Publishing**: the body may be up to 8 MB. `description` up to 1000
  characters (otherwise the manifest's), `notes` up to 2000. `400` for a bundle
  that is not valid, `403` when the ID was published by someone else, `409`
  when the kind differs from what was published or the version is not higher
  than the latest.
- **Details**: `permissions`, `commands` and `widgets` come from the latest
  version's manifest; `versions` is `{version, notes, publishedAt}[]`, newest
  first.
- **Installing** answers the bundle (the latest unless `version` is given, up
  to 20 characters) and counts you once, however often you install. It counts
  towards the per-address limit for counted requests (`429`).

### Libraries

A shared document is published as a team library by setting its
`d:publication` register (see [registers](#registers-and-their-keys)) over the
live connection, which only editors may do; unpublishing sets it to `null`.
There is no publish route. These two routes read what is published.

| Route | Access | Body / query | Answer |
|---|---|---|---|
| `GET /api/libraries` | Account or guest | `?workspace=<id>` (optional) | `{libraries: LibrarySummary[], truncated?: true}` |
| `GET /api/documents/:id/library` | Can open | — | `{id, name, publication}` |

- **The list** holds every document with a publication (its register is not
  `null`) that you can open as a member of the document or of its workspace,
  whatever your role: not files in the trash, not documents of deleted
  workspaces, and not branches (a branch carries a copy of its main file's
  publication). It is sorted by workspace name, then name, ignoring case;
  libraries shared with you as a document, outside your workspaces, come last
  with `workspaceId` and `workspaceName` `null`.
- **At most 500**: the first 500 of that order (every library you can view is
  sorted before the list is cut). A list that was cut says `truncated: true`
  (the field is left out otherwise); it is also set past a safety cap of
  20,000 documents read for one list. The app then asks for the libraries a
  file uses that are missing with `GET /api/documents/:id/library`, one by
  one.
- **Reading the list never reads a publication**: the server finds published
  documents through an index of their `d:publication` registers that holds
  only their sequence numbers, and works out each row's counts once per change
  of the register (kept in memory).
- **Documents reached only through their link are not listed**, for accounts or
  guests: a link is shared by handing it over, and a guest pass is free, so
  listing them would show every link-shared library to anyone. A guest's list
  is therefore always empty. Whoever has a library's ID (a file that uses it
  keeps it) reads it with `GET /api/documents/:id/library`, link access
  included.
- `?workspace=<id>` lists one workspace: `404` when you are not in it, `401`
  for a guest.
- **One library**: `publication` is the register's value as the app wrote it
  (`{version, publishedAt, roots, nodes, styles, variables,
  variableCollections, assets}`, `Publication` in
  `src/core/document/schema.ts`). `404 "This file is not published as a
  library"` when it is not published; otherwise the statuses of
  `GET /api/documents/:id` (`401`, `403`, `404`, and `410` for a file in the
  trash to whoever could open it before).
- **Images** a publication uses are downloaded from the library document with
  `GET /api/documents/:id/assets/:hash` (see [Images](#images)), with the same
  access. The app fetches only those its components and styles use (IMAGE
  paints in their fills and strokes, and in paint styles), not every image in
  `assets`, which may list images the library's file no longer shows. A
  missing image (`404`, its upload perhaps still under way) is asked for again
  over about eight seconds.
- **Versions and dates**: `version` counts up with every publishing, but
  starts again from 1 when a library is unpublished and published again. The
  app also dates every version after the one before it, so a file that uses a
  library compares `publishedAt` (when it has one) to find a newer version,
  and the version otherwise. Restoring a version of the library's file and
  merging a branch into it leave `d:publication` as it is.

---

## The live connection (WebSocket)

Open documents stay in sync through one WebSocket per open document. Messages
are JSON text, one object per WebSocket message, each with a type in `t`.

### Connecting

- Connect to **`/ws`** on the server's origin: `ws://host:port/ws`, or
  `wss://` behind HTTPS. Any other path is refused with `404`. A query string
  is ignored.
- It is a standard WebSocket (RFC 6455, version 13), with no subprotocols and
  no extensions, so messages are never compressed.
- The handshake carries **no credentials**. Send them in your first message,
  `hello`, within 30 seconds.
- While the server is stopping, a new connection is answered
  `503` with `Retry-After: 5`.

```js
const socket = new WebSocket('wss://evora.example.com/ws');
socket.onopen = () =>
  socket.send(JSON.stringify({ t: 'hello', docId: 'DOC_ID', since: 0, clientId: 'k2x9a7c1qz', token: 'SESSION_TOKEN' }));
socket.onmessage = (event) => console.log(JSON.parse(event.data));
```

### Messages you send

| Type | Fields | What it does |
|---|---|---|
| `hello` | `docId`, `since`, `clientId`, `token?`, `guestToken?` | Opens a document. Must come first (only `ping` may come before it). |
| `ops` | `id`, `ops: Register[]` | Sends changes. `id` is yours; the answer carries it back. |
| `presence` | `presence: Presence` | Shares your page, pointer, selection and view. |
| `ping` | — | Answered with `pong`. |

- **`hello`**: `docId` is the document to open. `since` is the last sequence
  number you already hold (`0` for none). `clientId` is 1 to 64 letters,
  digits, `_` or `-`, unique to this copy of the app (the app uses 10 random
  letters and digits); it is also the last part of your clocks. Give `token`
  (a session) or `guestToken`. When both are given, only `token` is used.
- **`ops`**: valid only for owners and editors. See
  [registers](#registers-and-their-keys) and
  [the merge rule](#clocks-and-the-merge-rule).
- **`presence`**:

  ```ts
  interface Presence {
    pageId: string | null;                         // the page in view
    cursor: { x: number; y: number } | null;       // page coordinates; null off the canvas
    selection: string[];                           // selected layer IDs
    viewport: { x: number; y: number; zoom: number; width: number; height: number } | null;
  }
  ```

  Presence is passed on to the others, never stored. `pageId` is cut to 200
  characters, layer IDs longer than 200 characters are left out, and at most
  10,000 are kept. Numbers must be finite. Viewers and guests send presence
  too.

### Messages the server sends

| Type | Fields | When |
|---|---|---|
| `welcome` | `seq`, `full`, `registers: StoredRegister[]`, `you: Peer`, `peers: Peer[]`, `doc: DocInfo` | The answer to `hello`. |
| `ops` | `seq`, `ops: StoredRegister[]`, `from` | Someone else's changes, already applied on the server. |
| `ack` | `id`, `seq` | Your `ops` with this `id` were taken, up to this sequence number. |
| `rejected` | `id`, `reason` | Your `ops` with this `id` were not kept. |
| `presence` | `peer: Peer` | Someone joined, moved, changed selection, or their role or name changed. |
| `leave` | `clientId` | Someone left. |
| `comment` | `event` | A thread was made, changed or deleted: `{kind: "thread", thread: Thread}` or `{kind: "deleted", threadId}`. |
| `access` | `role`, `linkAccess` | What you may do changed. `role: null` means you may no longer open it, and the connection closes. |
| `error` | `code`, `message` | Something was wrong. `code` is `unauthorized`, `forbidden`, `not-found` or `bad-request`. |
| `pong` | — | The answer to `ping`. |

```ts
interface Peer {
  clientId: string;
  user: UserRef;
  role: Role;
  presence: Presence | null;
}
```

- **`welcome`**: `registers` are the changes after `since`, in sequence order.
  When `since` is `0` or less, or larger than the document ever reached, you
  get everything and `full` is `true`. `seq` is the document's latest sequence
  number. `you` is your own peer, with your role. `peers` are the others
  already there.
- **`ops`**: `from` is the sender's `clientId`, or `"server"` for a change the
  server made itself (a rename over HTTP, a version restored, a branch updated
  or merged). You do not get your own changes back; you get an `ack`.
- **`ack`** comes even when none of your changes won (all of them lost to later
  clocks). Keep your changes until they are acknowledged, and send them again
  after a reconnect.
- **`rejected`** means none of the changes in that message were kept. The
  whole message is refused when any one change in it is not valid. Reasons
  include `"You can view and comment on this document, not change it"`, the
  merged-branch message, and the validation reasons below.
- An `error` without a close (a binary message, JSON that is not valid, an
  unknown type, presence that is not valid, a second `hello`) leaves the
  connection open.

### Registers and their keys

A shared document is a set of **registers**: each a key, a JSON value (`null`
for removed) and the clock of the change that set it. The server gives each
change it keeps the next **sequence number** of the document (`s` in a
`StoredRegister`), so a client can ask for everything after the last one it
holds.

| Key | Value |
|---|---|
| `n:<nodeId>:@` | Whether the layer (node) exists: `true`, or `false` once deleted. |
| `n:<nodeId>:<prop>` | One property of a layer. Its parent and its place among its siblings are properties too. |
| `t:styles:<id>` | A whole style; `null` once removed. |
| `t:variables:<id>` | A whole variable; `null` once removed. |
| `t:variableCollections:<id>` | A whole variable collection; `null` once removed. |
| `d:name` | The document's name. Setting it renames the document (trimmed, up to 200 characters). |
| `d:publication` | What the document publishes as a library. |
| `a:<hash>` | The description of an image; its bytes are uploaded separately (see [Images](#images)). |

IDs never contain `:`, so a key splits on its first two colons. Property and
table values follow the document model in
[DOCUMENT_SCHEMA.md](../DOCUMENT_SCHEMA.md); `src/collab/registers.ts` turns a
document into registers and back.

**What the server refuses** (with `rejected` on the live connection, `400` over
HTTP):

- a list that is not a list, or a change that is not an object;
- a key that is empty, longer than 1024 characters, or has a part named
  `__proto__`;
- a change without a `v` field;
- a clock that does not have the clock format, whose counter is larger than
  the largest safe integer, or that is more than 24 hours ahead of the
  server's clock;
- a value nested more than 64 levels deep.

### Clocks and the merge rule

Each change carries a **hybrid logical clock**, written as a string that sorts
the same way the clocks compare:

```
0lp3k9z2a.0003.k2x9a7c1qz
└──┬────┘ └┬─┘ └───┬────┘
   │       │       └ the client's ID (1 to 64 characters, no spaces)
   │       └ a counter: base 36, at least 4 digits (up to 11 accepted)
   └ milliseconds since 1970: 9 base-36 digits
```

**Making a clock.** For each change, take the later of now and the highest
clock you have made or seen. If now is later, use now with counter `0`;
otherwise keep that clock's milliseconds and add one to its counter. Every
clock you receive (in `welcome` and `ops`) counts as seen. The functions
`tick` and `observe` in `src/collab/protocol.ts` do exactly this.

**The merge rule** is last writer wins, per register: an incoming change
replaces what is held only when its clock is **greater, compared as a
string**. A change with an earlier or equal clock is ignored. So every copy
that has seen the same changes holds the same document, whatever order they
arrived in, and changes made offline merge when they are sent. The server
applies the same rule, and also observes every clock it receives, so the
clocks of its own changes (renames, restores, merges) are later than any it
has seen.

Text is one register per text layer: two people editing the same text at once
keep one whole value, not a merge of characters.

### Access changes

When members, roles or link access change, or a file is deleted, moved or a
branch merged, everyone connected to that document is checked again:

- someone whose role or link access changed gets an `access` message, and the
  others get a `presence` message with their new role;
- someone who may no longer open the document gets `access` with
  `role: null`, and the connection closes with `4403`;
- on a merged branch everyone becomes a viewer, and changes are rejected with
  the reason.

Signing out (one session, everywhere, or by a password change or a Google
link) sends `error` `unauthorized` "Signed out" and closes with `4401`.

### Close codes

| Code | Meaning | Reconnect? |
|---|---|---|
| `1012` | The server is restarting (a graceful stop). | Yes, with a short delay. |
| `1001` | The server is stopping. | Yes. |
| `1002` | A WebSocket protocol error (for example frames that are not masked). | Fix the client. |
| `1007` | Text that is not valid UTF-8. | Fix the client. |
| `1008` | Too many messages (more than 20,000 in 10 seconds). | Later, more slowly. |
| `1009` | A message too large, or in more than 1024 pieces. | Fix the client. |
| `4400` | Bad request: no `hello` within 30 seconds, a message other than `ping` before `hello`, a `hello` without a valid `docId` and `clientId`, or a `clientId` already used in this document by someone else. | Not until fixed. |
| `4401` | Unauthorized: no valid token in `hello`, or the session was signed out. | After signing in again. |
| `4403` | Forbidden: no access to the document, or access was removed. | After being given access. |
| `4404` | Not found: no such document, or `"This file is in the trash"`. | No. |
| `4409` | Replaced: the same person connected again with the same `clientId`; the older connection is closed. | No (the newer one is open). |

Each `44xx` close except `4409` follows an `error` message with the reason,
or, for `4403` after an access change, an `access` message with `role: null`.
A `4409` close comes with no message before it; its close reason is
`"Connected again"`.

A connection that sends nothing (not even an answer to the server's pings) for
30 seconds is dropped without a close frame, which a browser reports as
`1006`. Reconnect then.

### Limits of the live connection

| Limit | Value |
|---|---|
| Time to send `hello` | 30 seconds |
| A message before `hello` is accepted | 64 KB |
| A message after `hello` | the upload limit, 50 MB by default (`EVORA_MAX_UPLOAD_MB`) |
| Pieces (fragments) per message | 1024 |
| Messages per connection | 20,000 in 10 seconds |
| Heartbeat | the server pings every 15 seconds and drops a connection silent for 30 |
| Unread data the server holds for a slow connection | 256 MB, then it is dropped |

---

## Known limits

These are known and listed in the project's handoff notes:

- A client with edit access can still send clocks up to 24 hours ahead, which
  can make its changes win over others' until then.
- With email off (the default), email invitations go to whoever signs up first
  with that address, since addresses are not verified, and no email is sent.
  With email on, only a confirmed address takes up an invitation; but an
  account made with someone else's address still holds that address (it cannot
  be signed up for again) until its owner links it with Continue with Google.
  An account keeps its confirmed address until a new one is confirmed, and an
  account without a password must have signed in with Google in the last 10
  minutes to ask for a new one, so an account linked to Google cannot take
  someone else's address from its owner.
- There is no limit on the number of connections per address.
- `/api/health` and `/api/version` do not carry the security headers, and the
  health check's `503` includes the database's error text.
- HSTS is sent whenever `X-Forwarded-Proto: https` is present, even without the
  trust-proxy setting.
- Behind a reverse proxy without the trust-proxy setting, every caller without
  an account shares the proxy's address and its rate limits.
- The server has no TLS of its own: put it behind a reverse proxy for the
  internet. It runs as one process, and registers are never compacted.

This reference covers every route the API registers (98, plus the 4 email routes and the 2 library routes: 104, the same table the
security tests walk), plus `GET /api/version` and the WebSocket at `/ws`.
