<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="Evora logo" />
</p>

<h1 align="center">Evora</h1>

<p align="center">
  A free, open-source, local-first design and prototyping application.<br />
  The full design workflow, from vectors to real-time collaboration, with no paid plans, no seat limits and no AI generation.
</p>

---

Evora is a standalone design tool that aims at the traditional Figma Design workflow: design on an infinite canvas, build design systems with components and variables, lay out with Auto Layout, prototype interactions, hand off to developers, open and save Figma files, and work together in real time. Everything in it is free, including collaboration: there are no plans, no seats to buy and no locked features. It runs in the browser on your own machine, keeps your files on your own device, and can be self-hosted for a team with one command.

- **Specification:** [EVORA_MASTER_SPEC.md](EVORA_MASTER_SPEC.md), the product brief the project is built against.
- **Current state, limits and next steps:** [HANDOFF.md](HANDOFF.md).
- **Architecture:** [PROJECT_ARCHITECTURE.md](PROJECT_ARCHITECTURE.md). **File format:** [DOCUMENT_SCHEMA.md](DOCUMENT_SCHEMA.md) (schema version 25, with a migration and a test for every version).

## Status

| Phase | Area | State |
|---|---|---|
| 1 | Editor foundation | Built and tested |
| 2 | Design (appearance, text, layout aids) | Built and tested |
| 3 | Vector editing | Built and tested |
| 4 | Auto Layout and responsive design | Built and tested |
| 5 | Components and design systems | Built and tested |
| 6 | Prototyping | Built and tested |
| 7 | Export, developer handoff and Figma files | Built and tested |
| 8 | Collaboration (free, unlimited) | Built and tested |
| 9 | Ecosystem: plugins, version history, branching | Not started |
| 10 | Desktop apps and production release | Not started |

Every change is checked by about a thousand unit tests (Vitest) and more than seventy browser acceptance tests (Playwright, in Microsoft Edge), including tests in which several people edit the same file at once. What each feature does not do yet is listed honestly in [HANDOFF.md](HANDOFF.md) under "Known limitations".

## Features

### Files and the canvas
- Files kept on your device (IndexedDB), with autosave, validation and repair on open, and "Save a copy" as an `.evora` file.
- An infinite canvas drawn by Evora's own renderer, with pan, zoom, rulers, guides, layout grids, snapping (to layers, guides, grids, even spacing and pixels) and distance measurement.
- Pages, a layers panel that stays fast on very large files, groups, align and distribute, flip, masks, undo and redo for everything, menus and keyboard shortcuts generated from one command table, a dark and a light theme.

### Shapes, appearance and text
- Frames, rectangles, ellipses with arcs and rings, lines with arrowheads, polygons, stars and images (PNG, JPEG, WebP, GIF, SVG).
- Solid, linear, radial, angular and diamond gradient and image fills; strokes with ends, joins, dashes and a weight for each side; per-corner radii; drop and inner shadows with spread, layer and background blur; sixteen blend modes.
- Text with any installed font (Inter is bundled), styles on parts of a text, lists, paragraph spacing, justified text, auto-width, auto-height and fixed boxes.

### Vectors
- Pen and Pencil tools, point and handle editing, flatten to vector, outline stroke, split at intersections, and boolean groups (union, subtract, intersect, exclude) that stay editable.

### Layout
- Constraints, and Auto Layout: rows and columns that wrap, padding, spacing (fixed or automatic), alignment including text baseline, hug, fill and fixed sizing, minimum and maximum sizes, absolute positioning and nested layouts.

### Design systems
- Components and instances with overrides, reset, detach and swap; variants and component properties (boolean, text, instance swap).
- Colour, text, effect and grid styles; variables (colour, number, text, boolean) with collections, modes, aliases, scopes and bindings.
- Libraries: publish a file and use its components, styles and variables in another.

### Prototyping
- Connections and flows; triggers (click, hover, press, mouse leave, mouse up, delay, drag, keys with modifiers); actions (navigate, overlays, scroll to, back, change component state, set variable, conditions, type into a variable, open a link); transitions including Smart Animate; scrolling, fixed and sticky layers; presentation on phone, tablet and desktop frames.

### Export and handoff
- Export as PNG, JPG, SVG or PDF at any scale, in batches as a ZIP; copy as PNG, SVG or CSS; import SVG as editable layers.
- Developer mode: inspection, measurements, CSS, SwiftUI and Jetpack Compose code for a layer or a whole frame (HTML and CSS with flexbox), assets, ready-for-development status, notes, links and component code mapping.
- **Figma files:** open `.fig` files (every kind of layer, Auto Layout, constraints, components and the changes made in instances, variants, styles, variables, prototype interactions and flows; anything that cannot be converted is listed) and save a copy as `.fig`.

### Collaboration (free and unlimited)
- Accounts with email and password, or **Continue with Google** once it is configured (see below); guests without an account through a link.
- Workspaces with unlimited members and roles (owner, editor, viewer, and viewers can comment); invites by email or by link; "Shared with me".
- Per-file sharing: people and roles, and link access (no one, anyone can view, anyone can edit).
- Real-time co-editing: every property of every layer is merged last-writer-wins with hybrid logical clocks, so everyone converges to the same document; edits made offline are kept and merged on reconnect; undo undoes only your own changes.
- Live cursors with names, other people's selections, avatars and following someone's view.
- Comments pinned to the canvas or to a layer, with replies, @mentions, notifications, resolve and reopen, and a Comments panel.

## Getting started

Evora needs Node.js 20.19 or newer (Node 24 for the collaboration server, which uses its built-in SQLite and runs its TypeScript directly).

```bash
npm install
```

### Design on your own device

```bash
npm run dev
```

Open http://localhost:5173. Files are kept in the browser on this device; nothing needs a server or an account.

### Work together

Run the collaboration server beside the app, in a second terminal:

```bash
npm run server
```

```bash
npm run dev
```

Sign up in the app, then share a file or invite people to a workspace. The server keeps its data in `.evora-server/` (SQLite and images).

### Self-host for a team

```bash
npm start
```

This builds the app and serves it from the collaboration server at http://localhost:8787, in one process. Options: `--port`, `--data <folder>`, `--host 0.0.0.0` to accept other machines, `--public-url https://your.domain`. The server has no TLS of its own: put it behind a reverse proxy with HTTPS for use over the internet.

### Continue with Google (optional)

1. In Google Cloud Console, configure the OAuth consent screen (scopes `openid`, `email`, `profile`; add test users while it is in Testing).
2. Create an OAuth client ID of type **Web application**, with the authorised redirect URI `<app address>/api/auth/google/callback`, for example `http://localhost:5173/api/auth/google/callback`.
3. Start the server with the environment variables `EVORA_GOOGLE_CLIENT_ID` and `EVORA_GOOGLE_CLIENT_SECRET` (and `EVORA_PUBLIC_URL` for an address other than localhost). The button appears in the sign-in and sign-up dialogs. Never commit these values.

## Checks

```bash
npm run typecheck   # TypeScript: the app, the tooling and the server
npm test            # unit tests (Vitest), the server's included
npm run e2e         # browser acceptance tests (Playwright, Microsoft Edge)
npm run build       # production build into dist/
```

## Project layout

| Folder | What it holds |
|---|---|
| `src/core` | The document model and every operation on it, the `.fig` reader and writer, layout, text layout, vectors, prototyping logic. Pure TypeScript: no React, no browser APIs. |
| `src/engine` | The canvas renderer, overlays, viewport maths, interaction tools, and SVG/PDF/PNG export. |
| `src/state` | The editor store (document, selection, per-person undo history) and the command table shared by menus and shortcuts. |
| `src/persistence` | Local storage (IndexedDB), autosave, file import and export. |
| `src/collab` | The collaboration contract (`protocol.ts`), the sync engine, the offline queue and the API client. |
| `src/ui` | The React interface: file browser, editor chrome, panels, dialogs, collaboration screens. |
| `server` | The collaboration server: HTTP API, WebSocket rooms, accounts, sharing, comments, Google sign-in. Node built-ins only. |
| `e2e` | Browser acceptance tests. |

## Roadmap

Phases 9 and 10 of the specification, and what an outside review of the project put first:

1. **Version history and visual comparison:** named versions, automatic checkpoints, restore, side-by-side and overlay comparison, layer-level differences.
2. **Branching and merging:** isolated branches, updating from main, merge review, conflict resolution and rollback.
3. **Plugins and widgets:** a stable SDK, a sandbox, APIs, documentation, installation and a community directory.
4. **Developer integrations:** a VS Code extension, component-to-code mapping, a public REST API, GitHub, Storybook and Jira.
5. **Desktop apps:** Windows, macOS and Linux builds, signed installers, automatic updates and crash recovery.
6. **Production hardening:** security review, performance benchmarks, large-document and multiplayer load tests, file migration testing.

Also open: sections as a layer type of their own, text on a path, variable-width strokes, video in prototypes, audio and cursor chat, shared team fonts, library analytics, finer permission policies, and character-level merging of text edited by two people at once.

## Licence

Evora is released under the [MIT License](LICENSE). The bundled Inter font is under the SIL Open Font License 1.1; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
