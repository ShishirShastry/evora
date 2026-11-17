# Changelog

All notable changes to Evora are written down here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): the version in `package.json` is the
app's version, and each release is the git tag `vX.Y.Z`.

No version has been released yet. Phases 1 to 9 were built and tested before
there was a release pipeline, so they have no version of their own; the first
release (planned as 0.1.0) will contain all of them together with Phase 10.
When a version is released, the "Unreleased" heading becomes `## [X.Y.Z] - date`
(see [RELEASING.md](RELEASING.md)).

## [Unreleased]

### Phase 10 - Desktop and production release (in progress)

- A release pipeline on GitHub Actions: checks on every push and pull request
  (type-check, unit tests, build and the browser tests in Microsoft Edge on
  Windows, the collaboration server's tests on Linux), and on a version tag,
  desktop installers for Windows, macOS (Apple silicon and Intel) and Linux and
  a self-hosting bundle, put on a draft GitHub Release with the files automatic
  updates read.
- Installers are not code-signed yet. Signing is wired to turn on when the
  certificates are added as repository secrets.
- Still to be listed here as they land: the desktop application, local-first
  workflows, self-hosted deployment, documentation, security and performance
  testing.

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
