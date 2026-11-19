# Changelog

All notable changes to Evora are written down here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): the version in `package.json` is the
app's version, and each release is the git tag `vX.Y.Z`.

Phases 1 to 9 were built and tested before there was a release pipeline, so
they have no version of their own; the first release, 0.1.0, contains all of
them together with Phase 10.

## [Unreleased]

### Added

- **Design with your AI agent.** Evora's MCP server lets Claude Code, Cursor, Claude Desktop, VS Code and other AI agents create and edit `.evora` designs: frames with auto layout, shapes, text, colours, shadows and pages, with an SVG drawing to check the result. It is one file, `evora-mcp.mjs`, attached to each release; see docs/mcp.md.

### Changed

- **Website design.** Larger section labels and headings, a roomier download card, a bigger footer logo, and a GSAP opening sequence with the screenshot tilting flat as you scroll. Visitors who prefer less motion get the page without it.
- **macOS and Linux downloads.** The website and README now offer the macOS (Apple silicon and Intel) and Linux (AppImage and .deb) apps beside the Windows one, and the website's download button picks the visitor's system.
- **macOS builds open with "Open Anyway".** Without a signing certificate the Mac app is now signed ad hoc, so its signature covers the whole app. Before, macOS called a downloaded copy "damaged" and it could only be opened from Terminal.
- **Release workflow.** It can now add one platform's builds to a release that exists already (Actions -> Release -> Run workflow with a tag); see RELEASING.md. 0.2.0's macOS files were added this way.

## [0.2.0] - 2026-11-18

Evora 0.2.0 brings design libraries your whole team can share, prototype links you can send, email from your own team server, and Continue with Google in the desktop app.

**Downloads** (below, under Assets): **Windows** 10 and 11, 64-bit: `Evora-Setup-0.2.0.exe` (installer) or `Evora-0.2.0-portable.exe` (no install). macOS (`Evora-0.2.0-arm64.dmg`, `Evora-0.2.0-x64.dmg`) and Linux (`.AppImage`, `.deb`) builds are attached too, not yet tried on real machines. Self-hosting: `evora-server-0.2.0.tar.gz` or `ghcr.io/shishirshastry/evora:0.2.0`. Installed 0.1.0 apps on Windows should offer this update by themselves (the first real test of automatic updates).

**These builds are not code-signed.** Windows shows "Windows protected your PC": choose *More info*, then *Run anyway*.

### Added

- **Team libraries.** A shared file published as a library can be used by everyone who can view it: the Libraries dialog lists your team's libraries by workspace beside the files on this device; adding one copies its components, styles, variables and images into your file (so it still opens offline); files that use it are told when a newer version is published and can take it as one undo step.
- **Prototype links.** Shared files can be presented, and "Copy prototype link" (presentation bar, Prototype panel, each flow, View menu, Share dialog) opens the presentation at the chosen frame for anyone who can open the file, guests through the file's link included. People without access are told how to get it.
- **Email from your team server** (optional, off by default): with `EVORA_SMTP_URL` and `EVORA_MAIL_FROM`, the server sends invitations, mention emails (each person can turn them off) and links to confirm an address; an email invitation then goes only to someone who has confirmed that address. Capped at 100 emails a day, 30 an hour and 5 a day to one address (`EVORA_MAIL_DAILY_LIMIT`, `EVORA_MAIL_HOURLY_LIMIT`), so a relay never costs money.
- **Continue with Google in the desktop app**, through your browser and back to Evora, without leaving the design you have open; the sign-in is bound to the app (PKCE).

### Changed

- File format version 27: a page that holds a library also records when its version was published. Version 26 files open unchanged.
- Restoring or merging a version no longer brings back an old library publication.

### Fixed

- On a computer several people use, a shared file's offline copy is shown only to the person who kept it.
- Changing an account's email address is rate-limited, keeps the confirmed address until the new one is confirmed, and needs a recent sign-in for accounts without a password.
- The server's log no longer shows whole email addresses from a relay's errors.

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
