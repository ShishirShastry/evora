# Security

Evora is a free, open-source, local-first design tool. This page says how to report a vulnerability, what is in scope, the threat model, and what has been tested.

## Reporting a vulnerability

Please report it privately through **GitHub's security advisories** for this repository: on the repository's page, open **Security ▸ Advisories ▸ Report a vulnerability**. Do not open a public issue for something that could be exploited before it is fixed.

Say what is affected (the app, the collaboration server, the desktop app, a file importer, the plugin sandbox), the version or commit, how to reproduce it, and what an attacker gains. A proof of concept helps. You will get an answer in the advisory; a fix is released with the advisory once it is ready, and you are credited unless you ask not to be.

There is no bug bounty: Evora is a volunteer project with no paid plans of any kind.

## Scope

In scope:

- The collaboration server (`server/`): the HTTP API under `/api`, the WebSocket at `/ws`, the static files it serves, its storage (`.evora-server/`), "Continue with Google".
- The web app (`src/`), including the sync engine, sharing, comments, the Community and plugin directory screens.
- The plugin sandbox (`src/plugins/`): a plugin getting past its permissions, out of its frame, onto the network, or wearing the app out.
- File importers: `.fig`, `.evora` (and `.opendesign`), SVG and images, and pasted layers.
- The desktop app and its installers and updates, once released.

Out of scope: someone with access to the server's machine, its data folder or its environment; denial of service by sheer volume against a server without a proxy in front; a plugin a person chose to install doing what its accepted permissions allow (a plugin with "write" can change the open file); the absence of email verification (see "Known limits"); social engineering.

## Threat model

**Who is trusted.** The person running a server trusts its machine, its data folder and its environment (including `EVORA_GOOGLE_CLIENT_SECRET`). Everyone else who reaches the server is not trusted: people with no account, guests, people with accounts in other workspaces, and members whose role is lower than what they try to do. Files from elsewhere (`.fig`, `.evora`, SVG, images), plugins and Community resources are not trusted.

**What is protected.**

- *Who may do what.* Every route checks who is asking and their role, the strongest of their role in the document, in its workspace, and what its link gives. Viewers and guests may comment; only editors change a file; only owners delete or change roles. Someone with no access is told as little as possible (404 for a workspace they are not in; 401 or 403 for a document; 410 only to someone who could open a file before it went to the trash).
- *Sessions.* Tokens are 32 random bytes; only their SHA-256 is stored. A session ends after 90 days unused or a year after it started, on sign-out, on "sign out everywhere" (`POST /api/auth/logout-all`), when the password is changed (all other sessions), and when Google proves who owns the account's email (all sessions made before). The app sends tokens in an `Authorization` header (and guests in `X-Evora-Guest`), never in cookies or addresses, so another site cannot make a browser use them (no CSRF); the only cookie is Google's sign-in state (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS).
- *Passwords.* scrypt (N = 16384, r = 8, p = 1, a 16-byte salt per password), compared in constant time; an unknown email takes as long as a wrong password. At least 8 and at most 1024 characters. N is stored with each hash, so it can be raised later without breaking old ones.
- *Limits.* Wrong passwords per address and email, and per address across all emails; accounts and guests made per address; comments, invitations and uploads per person; counted routes per address; request bodies (2 MB of JSON, 50 MB uploads); JSON nested at most 64 deep; WebSocket messages (64 KB until the connection has said who it is, then 50 MB; at most 1024 pieces each; at most 20,000 messages per 10 s per connection).
- *The shared document.* Changes are registers merged by hybrid logical clocks. The server refuses keys with a `__proto__` part, values nested more than 64 deep, clocks more than a day ahead, and counters past the largest safe integer.
- *Uploads.* An image is named by the SHA-256 of its bytes and checked against it. Only image types are served as declared; anything else is served as `application/octet-stream`. Every upload is served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so an SVG's scripts never run and nothing uploaded acts as a page of the site. Community covers must be the picture their type says.
- *Headers.* Every answer has `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and a Content-Security-Policy with `frame-ancestors 'none'`; HSTS when the request came over HTTPS. The served app's policy allows only its own scripts, styles, images, fonts and its own server for network access, and frames only from itself (see "Known limits" for `'unsafe-inline'`).
- *Plugins.* A plugin runs in an iframe with `sandbox="allow-scripts"` (an opaque origin: no access to the app, its storage or cookies; no popups; cannot navigate the app) and a policy with no network, no `eval`, no frames and no forms. It reaches the file only through messages, each checked against the permissions the person accepted. A plugin that sends more than 20,000 messages in 10 s or keeps more than 2000 calls waiting is stopped, with the reason shown; console lines are cut at 10,000 characters; the app stops waiting for a widget's answer after 5 s.
- *Files.* Importers refuse rather than hang or exhaust memory: ZIP archives and deflate streams are read to at most 1 GiB, Zstandard data to at most 1 GiB, kiwi arrays cannot claim more elements than there are bytes, messages and structs nest at most 1000 deep, a node listed twice or inside itself is kept once, SVG files are read to at most 50,000 shapes with their repeats counted, and `.evora` files nest at most 200 deep. Numbers that are not finite are replaced.

## What was tested

Automated, in `server/security.test.ts`, `src/security-plugins.test.ts` and `src/security-import.test.ts` (run with `npm test`):

- **Every route** of the API, read from the API's own route table (the Phase 9 routes included), called by nobody, a guest, someone outside the workspace and a workspace viewer wherever they must be refused; a route added without a decision fails the test. The refusals change nothing, and their messages carry no stack traces or SQL.
- **IDs of others' things** mixed with one's own: versions, deleted files, projects, branches, notifications, favourites, search.
- **Bodies**: nesting 500,000 deep, `__proto__` and `constructor` keys, registers with `__proto__` keys, deep values, counters that become Infinity, clocks a day ahead; search with `%` and `_` and long queries.
- **Limits**: one password tried on many accounts, comments, invitations, uploads.
- **Sessions**: hashed tokens, sign out everywhere (live connections closed), the yearly end, scrypt parameters, password length.
- **Uploads**: an HTML file declared as `text/html`, an SVG with scripts, a cover that is not a picture.
- **Headers and static files**: headers on answers and errors, HSTS behind HTTPS, the app's policy, a Host header trying to inject into it, path traversal (`..`, `%2f`, `%5c`, `%00`).
- **WebSocket**: a large message before hello, a message in 1100 empty pieces, a flood of 20,100 messages, presence with huge IDs.
- **Google**: return addresses that are not the app's or this computer's (other sites, look-alike hosts, `javascript:`, paths, user names), and an account made with someone else's email being taken back when its owner signs in with Google (a stand-in Google, not the real one).
- **Plugins**: sandbox flags and policy, a plugin's script trying to end itself early, method names outside the API (`__proto__`, `constructor`, internal names), every method without its permission, floods of calls, calls kept waiting, a 200,000-character console line, a widget that never answers.
- **Files**: 300 mutated `.fig` files (archive, canvas, message and schema each mutated) with a fixed seed, 300 mutated `.evora` files (cycles of parents, enormous numbers, deep nesting, `__proto__`, wrong types), 400 mutated SVG files; each must open or be refused with the importer's own error within 5 s. ZIP and Zstandard bombs, arrays of billions of empty structs, a struct that holds itself, 50,000 layers side by side, a `<use>` bomb, SVG nested 100,000 deep.

Checked by hand in Microsoft Edge 157 (Phase 10): the served app runs under its policy (file browser and editor, a shape drawn) with no violations; a plugin's frame runs its scripts, and its attempts to fetch, load an image from another site, navigate the app, read the parent and navigate itself to another site were all blocked (nothing reached the other site).

`npm audit` (Phase 10): no known vulnerabilities in what the app and server ship (`npm audit --omit=dev`: 0). The development and build tools have advisories (picomatch ReDoS and minimatch through Vite, Vitest and electron-builder); they run only on a developer's machine on the project's own files.

## Known limits

- **Email addresses are not verified** (Evora sends no email). Whoever signs up first with an address gets the invitations waiting for it. Prefer invitation links for people who have no account yet. Signing in with Google takes an account back from someone who made it with another's address (their sessions end), but they still know the password they set.
- The served app's policy allows inline scripts (`'unsafe-inline'`), because a plugin's `srcdoc` frame inherits the app's policy and runs inline scripts. The app itself has no inline script and renders text only through React. Moving plugins to a page of their own would remove this.
- The development server (`npm run dev`) and the desktop app do not send the served app's policy, so there a plugin frame could navigate itself to another site (carrying data in the address). Use plugins you trust there, or the self-hosted server.
- A plugin's frame may run in the app's own thread: a plugin stuck in an endless loop can freeze the tab until it is closed.
- A client with editor access can send changes with clocks up to a day ahead; changes made by others during that day can then be refused until it passes. The fix belongs in the clock rules of `src/collab/protocol.ts`.
- One server process, no TLS of its own: put it behind a reverse proxy with HTTPS for the internet. There is no limit on the number of connections per address.
