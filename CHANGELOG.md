# Changelog

All notable changes to Evora are written down here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): the version in `package.json` is the
app's version, and each release is the git tag `vX.Y.Z`.

Phases 1 to 9 were built and tested before there was a release pipeline, so
they have no version of their own; the first release, 0.1.0, contains all of
them together with Phase 10.

## [Unreleased]

## [0.1.0] - 2026-11-18

The first release of Evora: a free, open-source design tool for interfaces,
products and ideas, with an infinite canvas, real-time teamwork and
interactive prototypes, now as a desktop app for Windows, macOS and Linux and
as a server you can host yourself.

**Downloads** (below, under Assets):

- **Windows** 10 and 11, 64-bit: `Evora-Setup-0.1.0.exe` (installer) or
  `Evora-0.1.0-portable.exe` (no install).
- **macOS**: `Evora-0.1.0-arm64.dmg` for Apple silicon, `Evora-0.1.0-x64.dmg`
  for Intel (or the `.zip` of each).
- **Linux**, 64-bit: the `.AppImage` (any distribution; make it executable
  first) or the `.deb` (Debian and Ubuntu).
- **Self-hosting**: `evora-server-0.1.0.tar.gz` (needs Node.js 24), or the
  container image `ghcr.io/shishirshastry/evora:0.1.0`. See the
  [self-hosting guide](https://github.com/ShishirShastry/evora/blob/main/docs/self-hosting.md).

**These builds are not code-signed.** Windows shows "Windows protected your
PC": choose *More info*, then *Run anyway*. macOS will not open the app at
first: right-click it and choose *Open*, or allow it under System Settings ->
Privacy & Security; if macOS says the app is damaged, run
`xattr -dr com.apple.quarantine /Applications/Evora.app` in Terminal. Automatic
updates work on Windows and with the Linux AppImage; on macOS, download new
versions by hand until the app is signed. The macOS and Linux builds have not
yet been tried on real machines; please report anything that goes wrong.

### Phase 10 - Desktop and production release

- **Desktop app** (Electron) for Windows, macOS and Linux: works fully offline,
  opens and saves `.evora`, `.fig` and SVG files on disk, recent files, a
  native menu, recovery of unsaved work after a crash, a save that asks where
  to save when the file's folder is gone, automatic updates from GitHub
  Releases, and hosting a team server from the app.
- **Self-hosting**: one process serves the app and the collaboration server;
  Docker and Docker Compose, systemd, nginx and Caddy examples, configuration
  by environment, `/api/health` and `/api/version`, graceful shutdown, a
  trusted-proxy setting and online backups (`npm run backup`).
- **Security review** with 17 fixes and a test that checks every one of the
  server's 98 routes; see [SECURITY.md](https://github.com/ShishirShastry/evora/blob/main/SECURITY.md).
- **Release pipeline** on GitHub Actions: checks on every push, and on a
  version tag installers for every platform, the self-hosting bundle and the
  container image.
- **Documentation**: a user guide with every keyboard shortcut, the API
  reference, the self-hosting guide and the desktop app's notes.
- "Save to version history" moved to Ctrl+Alt+Shift+S (Ctrl+Alt+S is
  Subtract).
- Known limitations are listed in
  [HANDOFF.md](https://github.com/ShishirShastry/evora/blob/main/HANDOFF.md).

## Before the first release

These phases were built between 2026-11-15 and 2026-11-17. Details, tests and
known limitations of each are in [HANDOFF.md](HANDOFF.md).

### Phase 9 - Ecosystem (2026-11-17)

- Version history: automatic and named versions for local and shared files,
  view, rename, restore (one undo step), and compare side by side or overlaid
  with a list of layer differences.
- Branches of shared files: update from main, merge with conflict review per
  layer, rollback; a merged branch is read-only.
- Plugins in a sandbox with permissions (read, write, export, ui, storage), a
  plugin manager, a development mode, developer documentation, four examples
  and a plugin directory on the server; widgets drawn by plugins (schema 26).
- The Community library: publish files, templates, UI kits and libraries,
  browse, search and duplicate.
- File management: projects, moving files, favourites, recents, search, and a
  trash that keeps deleted shared files for 30 days.

### Phase 8 - Collaboration (2026-11-17)

- A self-hostable collaboration server using only Node's built-ins: accounts,
  guests, workspaces with unlimited members, roles, invites and link sharing.
- Real-time editing that merges concurrent changes, live cursors and
  selections, following, offline edits merged on reconnect.
- Comments with replies, mentions and notifications.
- Continue with Google, off until the server is given its own OAuth client.
- Everything free and unlimited: no plans, seats or feature gates.

### The name and the interface (2026-11-17)

- The application is now Evora (files `.evora`; `.opendesign` files still open
  and are moved over), with the owner's logo and a new interface in the spirit
  of Figma's layout and Framer's dark theme.
- Gaps closed across feature areas (schema 25): mouse leave and mouse up
  triggers, key triggers with modifiers, paragraph spacing, inner shadows on
  text and groups, shadow spread on every shape, split at intersections,
  angular and diamond gradients in SVG and PDF export, code for a whole frame.

### Phase 7 - Export and production workflows (2026-11-16 and 17)

- Export as PNG, JPG, SVG and PDF with scales, suffixes and ZIP archives; copy
  as PNG, SVG and CSS; SVG files imported as editable layers.
- Developer Mode: inspection, measurements, CSS, SwiftUI and Compose code,
  assets, status, annotations and component code mapping.
- Figma `.fig` files: open one as an editable file, and save a copy as `.fig`,
  checked against a real Figma file (every layer, component, instance, style,
  variable, Auto Layout setting and interaction comes through). Not verified:
  that a file saved here opens in Figma.

### Phase 6 - Prototyping (2026-11-16)

- Connections, triggers, actions, transitions, Smart Animate, overlays, scroll
  behaviour, interactive components, variables, conditional logic and a
  presentation mode (schema 22).

### Phase 5 - Components and design systems (2026-11-16)

- Components and instances with overrides, reset, detach and swap; component
  sets, variants and component properties.
- Colour, text, effect and grid styles; variables with collections, modes,
  aliases and scopes (design tokens); libraries shared between files
  (schemas 18 to 21).

### Phase 4 - Auto Layout and responsive design (2026-11-16)

- Frames that lay out their children in rows or columns: padding, spacing,
  alignment, wrapping, hug contents, fill container, minimum and maximum
  sizes, absolute children, nested layouts (schemas 15 to 17).

### Phase 3 - Vector editing (2026-11-16)

- Vector networks, flatten to vector, the Pen and Pencil tools, point and
  handle editing, boolean operations and boolean groups, arcs, arrowheads and
  outline stroke (schemas 8 to 11).

### Phase 2 - Design functionality (2026-11-15 and 16)

- Groups, alignment, distribution and flips; text with styled parts, lists and
  justification, and the bundled Inter typeface; snapping, smart guides and
  distances; gradients, strokes, corner radii, effects and blend modes; images
  with crop and adjustments; constraints and layout grids; rulers and guides;
  masks; a colour picker; resizable panels and a light theme.

### Phase 1 - Editor foundation (2026-11-15)

- The infinite canvas with its own Canvas 2D renderer, the drawing tools,
  selection and transforms, frames, the layers panel, pages, the properties
  panel, undo and redo, menus and shortcuts, and files kept on this device
  with autosave.
