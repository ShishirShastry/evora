<p align="center">
  <img src="public/favicon.svg" width="112" height="112" alt="Evora logo" />
</p>

<h1 align="center">Evora</h1>

<p align="center">
  <b>Design, prototype and build together. Free, open and yours.</b>
</p>

<p align="center">
  The all-in-one design tool for interfaces, products and ideas:<br />
  an infinite canvas, real-time teamwork and interactive prototypes, with nothing behind a paywall.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7c5cff" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/price-free%20forever-22c55e" alt="Free forever" />
  <img src="https://img.shields.io/badge/seats-unlimited-0ea5e9" alt="Unlimited seats" />
  <img src="https://img.shields.io/badge/runs%20on-web%20%7C%20Windows%20%7C%20macOS%20%7C%20Linux-f97316" alt="Web, Windows, macOS, Linux" />
</p>

---

Evora is where screens, flows and design systems come to life. Sketch an idea, shape it with real layout and components, click through it as a working prototype, and hand it to developers, alone or with your whole team on the same canvas at once.

It is **free for everyone, for good**: no plans, no seats to count, no "upgrade to unlock". Your files live on **your** device, work offline, and can be shared through a server **you** run. And because it is open source, you can see how it works, change it, and extend it with plugins.

## Why Evora

| | |
|---|---|
| **Everything included** | Vectors, layout, components, variables, prototyping, developer handoff, collaboration, version history and plugins. All of it, for everyone. |
| **Truly collaborative** | Edit together live with cursors, comments and @mentions. Invite as many people as you like; every seat is free. |
| **Yours to keep** | Local-first: files stay on your device and keep working offline. Host your own team server with one command. No lock-in. |
| **Fast on big files** | A canvas renderer built for the job, and a layers panel that stays quick with thousands of layers. |
| **Made to be extended** | Sandboxed plugins and live widgets with a documented API, plus a community library of templates and UI kits. |
| **Open source** | MIT licensed. Read the code, fork it, improve it. |

## What you can do

**🎨 Design anything.** Frames, shapes, pen and pencil, boolean shapes that stay editable, rich text with any font, gradients, image fills, shadows, blurs and blend modes, on an infinite canvas with smart guides, snapping and measurements.

**📐 Lay out like real code.** Responsive auto layout with wrapping rows and columns, padding, gaps, hug and fill sizing, constraints and nesting: designs that resize the way the finished product will.

**🧩 Build design systems.** Components and variants with overrides, component properties, colour, text and effect styles, and variables with modes for themes such as light and dark. Publish a library and reuse it across files.

**▶️ Prototype interactions.** Link screens with clicks, hovers, key presses and timers; open overlays, scroll, switch component states, set variables and branch on conditions; animate between screens with smart transitions; present on phone, tablet or desktop frames.

**👩‍💻 Hand off to developers.** Inspect any layer, copy CSS, SwiftUI or Jetpack Compose code, export assets as PNG, JPG, SVG or PDF, and mark what is ready to build.

**🤝 Work as a team.** Workspaces, roles and share links (guests welcome), live co-editing that merges even offline changes, cursors, following, and comments pinned to the canvas.

**🕓 Never lose work.** Automatic and named versions, side-by-side and overlay comparison, one-click restore, and branches you can merge back with every conflict laid out for you.

**🔌 Extend it.** Install plugins that run safely in a sandbox with only the permissions you grant, drop interactive widgets on the canvas, and browse the community library for templates, UI kits and icon sets.

**📂 Bring your work with you.** Open `.fig` and SVG files as fully editable layers, and save your work as an open `.evora` file.

## Get Evora

### 💻 Desktop app (Windows, macOS, Linux)

A native app that works fully offline, opens and saves files on disk, recovers your work after a crash, keeps itself up to date once releases are published, and can host a team server for your office.

> **No release has been published yet.** Until the first release, build the installer yourself with `npm run dist:desktop` (see below). Early builds are not code-signed, so Windows shows an "unknown publisher" notice (**More info → Run anyway**) and macOS asks you to allow the app in **Privacy & Security**. [More about the desktop app](electron/README.md).

### 🌐 In your browser

You need [Node.js](https://nodejs.org) 24.

```bash
npm install
npm run dev
```

Open http://localhost:5173 and start designing. No account, no server: files are kept on your device.

### 👥 With your team

Start the collaboration server beside the app:

```bash
npm run server
```

```bash
npm run dev
```

Sign up, then invite your team to a workspace or share a file by link.

### 🏢 Self-host for everyone

One process serves both the app and the collaboration server:

```bash
npm start
```

It runs at http://localhost:8787. For Docker, systemd, HTTPS behind nginx or Caddy, backups and every setting, see the **[self-hosting guide](docs/self-hosting.md)**.

<details>
<summary><b>Sign in with Google (optional)</b></summary>

1. In Google Cloud Console, set up the OAuth consent screen (scopes `openid`, `email`, `profile`).
2. Create an OAuth client ID of type **Web application** with the redirect URI `<app address>/api/auth/google/callback`, for example `http://localhost:5173/api/auth/google/callback`.
3. Start the server with `EVORA_GOOGLE_CLIENT_ID` and `EVORA_GOOGLE_CLIENT_SECRET` (and `EVORA_PUBLIC_URL` for an address other than localhost). Never commit these values.

</details>

## Where Evora is today

Evora is young and moving fast. The editor, design systems, prototyping, handoff, collaboration, version history, plugins and community library are built, and more than eleven hundred automated tests and dozens of real-browser tests check them. The desktop app, self-hosting and release pipeline are new and being polished toward the **first public release**. Every known gap is listed openly in [HANDOFF.md](HANDOFF.md).

**Coming next:** the first release with installers for every platform, performance tuning for very large files, a VS Code extension and public REST API, and integrations with GitHub, Storybook and Jira. Also on the list: text on a path, variable-width strokes, video in prototypes, and audio and cursor chat.

## Build with us

Evora is open source and contributions are welcome: bug reports, ideas, plugins, and code.

- **Write a plugin:** [plugin guide](plugins/PLUGINS.md), with four examples in [plugins/examples](plugins/examples).
- **Report a security issue:** [SECURITY.md](SECURITY.md).
- **Ship a release:** [RELEASING.md](RELEASING.md) and [CHANGELOG.md](CHANGELOG.md).
- **Understand the code:** [architecture](PROJECT_ARCHITECTURE.md), [file format](DOCUMENT_SCHEMA.md), [product specification](EVORA_MASTER_SPEC.md) and the [handoff notes](HANDOFF.md).

<details>
<summary><b>Checks</b></summary>

```bash
npm run typecheck      # TypeScript: the app, the tooling, the server and the desktop app
npm test               # unit tests (Vitest), the server's included
npm run e2e            # browser tests (Playwright, Microsoft Edge)
npm run build          # production build into dist/
npm run desktop        # the desktop app in development
npm run dist:desktop   # desktop installers for this system, into release/
```

</details>

<details>
<summary><b>Project layout</b></summary>

| Folder | What it holds |
|---|---|
| `src/core` | The document model and every operation on it, file import and export, layout, text, vectors and prototyping logic. Pure TypeScript. |
| `src/engine` | The canvas renderer, overlays, viewport, interaction tools, and SVG, PDF and PNG export. |
| `src/state` | The editor store (document, selection, per-person undo) and the command table behind menus and shortcuts. |
| `src/persistence` | Local storage, autosave, file import and export, and the desktop bridge. |
| `src/collab` | The sync protocol, the sync engine, the offline queue and the API client. |
| `src/plugins` | The plugin runtime: manifests, the sandbox, the `evora.*` API and widgets. |
| `src/ui` | The interface: file browser, editor, panels, dialogs, collaboration, version history, plugins and community. |
| `server` | The collaboration server: API, live rooms, accounts, sharing, comments, versions, plugins and community. Node built-ins only. |
| `electron` | The desktop app: windows, menus, files on disk, updates. |
| `plugins` | The plugin guide and examples. |
| `deploy`, `docs` | Self-hosting files and guides. |
| `e2e` | Browser and desktop tests. |
| `.github` | Continuous integration and the release workflow. |

</details>

## Licence

Evora is released under the [MIT License](LICENSE). The bundled Inter font is under the SIL Open Font License 1.1; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<sub>Evora is an independent project, not affiliated with or endorsed by any other design tool's maker. Other product names and file formats mentioned belong to their owners.</sub>
