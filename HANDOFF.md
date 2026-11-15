# OPEN DESIGN — Handoff note

Last updated: 2026-11-15, after the first slice of Phase 2 (groups and arranging).

## Where the project stands

| Phase | State |
|---|---|
| 0 — Planning | Partly done, then stopped at the owner's request. `PROJECT_ARCHITECTURE.md` and `DOCUMENT_SCHEMA.md` exist. The other four planning documents were **not written**. |
| 1 — Editor foundation | **Implemented and tested.** Acceptance criterion met (see below). |
| 2 — Design functionality | **Started.** Done and tested: groups, align, distribute, flip. Everything else in Phase 2 is **not started** (see "Next actions"). The Phase 2 acceptance criterion is **not** met. |
| 3 – 10 | **Not started.** Nothing from these phases exists, not even as UI. |

How to run and check the project: [README.md](README.md).

## What works (Phase 1)

All of this is wired to the real document model, is undoable, and is saved automatically.

- **Files.** File browser with create, open, rename, duplicate, delete (with confirmation) and import. Files are stored in the browser's IndexedDB on this device. "Save a copy to disk" writes a `.opendesign` file; importing reads one back. Files are validated and repaired on open; files from a newer format version are refused.
- **Autosave** about 0.4 s after each change, with an honest status in the toolbar (Saved / Unsaved changes / Saving… / Not saved). Reloading the page restores the file, the page you were on and the view.
- **Canvas.** Infinite canvas drawn by our own Canvas 2D renderer (no DOM elements per object), high-DPI, with culling of off-screen layers. Pan: wheel, Space + drag, middle button, hand tool. Zoom: Ctrl + wheel / pinch about the pointer, zoom in/out, fit, selection, 100 %, custom percentage.
- **Tools.** Move, Hand, Frame, Rectangle, Ellipse, Line, Polygon, Star. Drag to draw (Shift = square / 45° line, Alt = from centre) or click for a default size. Shapes drawn over a frame go inside it.
- **Selection.** Click, Shift-click, marquee, double-click to go deeper, Ctrl-click for the deepest layer, frame name labels, hover outline. Hidden and locked layers cannot be hit.
- **Transform.** Drag to move (Shift = one axis, Alt = duplicate, Escape = cancel); dropping on a frame nests the layer, dragging out un-nests it, keeping its place on the page. Eight resize handles (Shift = keep proportions, Alt = from centre), correct for rotated layers. Rotate by dragging outside a corner (Shift = 15° steps). Line endpoints. Multi-selection move, resize and rotate. Arrow-key nudge (Shift = 10).
- **Frames** with children in the frame's own coordinate space, optional clipping, corner radius.
- **Layers panel.** Tree of the current page; select, multi-select, rename, show/hide, lock/unlock, expand/collapse, drag to reorder and to nest, context menu.
- **Pages.** Add, switch, rename, duplicate, move up/down, delete.
- **Properties panel.** X, Y, W, H, rotation, corner radius, polygon points, star ratio, clip content, layer opacity, fills and strokes (colour, opacity, visibility, add/remove), stroke weight and position, page background. Multi-selection shows "Mixed".
- **Undo / redo** for every document change, one step per gesture, restoring selection and page.
- **Edit commands.** Cut, copy, paste, duplicate, delete, select all, bring to front / forward / backward / to back.
- **Groups (Phase 2).** Group (Ctrl+G) and ungroup (Ctrl+Shift+G, also dissolves frames). A group's box always fits its children; resizing a group scales its contents; an emptied group disappears. Click selects the group, double-click goes inside; a layer dragged about inside a group stays in it.
- **Arrange (Phase 2).** Align left / centre / right / top / middle / bottom (to the selection, or to the parent frame for a single layer), distribute horizontal and vertical spacing, flip horizontal and vertical. Available from the properties panel, the Arrange and Object menus and shortcuts.
- **Menus and shortcuts.** Main menu (File, Edit, View, Object, Help), context menus and a shortcut reference, all generated from one command table, so a menu item and its shortcut cannot disagree.

## What is tested

Run on 2026-11-15: TypeScript clean; **160 unit tests** and **5 browser acceptance tests** pass; production build succeeds.

- `src/core/core.test.ts`, `src/core/document/validate.test.ts` — document operations, transforms, ordering, hit testing, selection rules, history diff, validation and repair, file format and version handling.
- `src/state/editor.test.ts` — the real store and the real tools driven with pointer sequences: drawing, selecting, moving, nesting, resizing, rotating, pan and zoom, commands, pages, history.
- `src/persistence/persistence.test.ts` — IndexedDB storage, file operations, import/export, autosave including failure and recovery, session memory.
- `src/engine/render/render.test.ts` — culling, hidden layers, a 10,000-layer page.
- `src/architecture.test.ts` — module boundaries (the core imports nothing outside itself).
- `e2e/phase1.spec.ts` — the Phase 1 acceptance criterion end to end in Microsoft Edge with real mouse and keyboard, including a reload and reopening from the file browser.
- `src/core/ops/arrange.test.ts`, `src/state/arrange.test.ts` — groups (fit, nesting, scaling, removal when empty), align, distribute, flip, and opening a version 1 file in the version 2 format.
- `e2e/phase2.spec.ts` — group, ungroup, align, distribute and flip in the browser, including a reload.
- `e2e/rendering.spec.ts` — reads real pixels from the canvas: fills, clipping, ellipse shape, strokes, hidden layers, undo.

Not covered by automated tests: the native save/open file dialogs (`src/persistence/diskIO.ts`), drag-and-drop reordering in the layers panel, context menus, the colour picker's live preview, and any browser other than Edge. These were written to work but have not been exercised by a test.

## Known limitations and rough edges

- No text, images, gradients, effects, snapping, guides, rulers, constraints or Auto Layout yet: those are the rest of Phase 2 and later.
- Dragging a resize handle past the opposite edge flips the box but does not mirror its content. (The Flip commands do mirror correctly.)
- Flip is exact for today's shapes because they are all symmetric; text, images and vector paths will need a real flip property (noted in DOCUMENT_SCHEMA.md §6).
- Alt+D (align right) is also the browser's "focus address bar" shortcut and the browser may take it first; the button and the menu item always work.
- Resizing a multi-selection that contains rotated layers scales their boxes approximately; it cannot skew.
- Copy and paste work inside the application only, not through the system clipboard.
- Clicking a rounded rectangle is tested against its square box, not its rounded outline.
- The layers panel renders every row (not virtualised); culling is a linear walk (no spatial index). Fine at thousands of layers, untested beyond that. There is no WebGL backend.
- Keyboard shortcuts match physical key positions, so letter shortcuts follow a QWERTY layout.
- Sidebars are fixed width. Only the dark theme exists.
- Files live in the browser profile that created them, per address (`localhost:5173`). Clearing site data deletes them; use "Save a copy to disk" for anything that matters.
- No licence has been chosen for the project yet. That is the owner's decision.

## Environment notes

- The project is on an exFAT external drive, which cannot hold symbolic links: keep it a single npm package (no workspaces).
- Node.js v24.22.3 was unpacked into `.tools/node` (git-ignored) after its SHA-256 was checked against nodejs.org. The npm cache is in `.tools/npm-cache`. Nothing was installed system-wide.
- `git config --global safe.directory "F:/Open Design"` was added; git refuses to work on exFAT without it.
- Playwright uses the installed Microsoft Edge (`channel: 'msedge'`); no browsers were downloaded.

## Next actions

Phase 2 (static design), suggested order, each to be finished with tests before the next:

1. ~~Groups, alignment and distribution, flip.~~ Done.
2. Snapping to pixels, objects and frame edges with smart guides; rulers and draggable guides.
3. Appearance: gradients, multiple strokes with dash/cap/join, independent corner radii, shadows and blurs, blend modes.
4. Text layers with inline editing and font properties.
5. Images: import (file, drag-and-drop, paste), fill modes, crop; this needs the asset store and schema version 2 (zip container).
6. Constraints and layout grids.

Each schema addition needs a version bump and a migration with a fixture test (see `MIGRATIONS` in `src/core/document/serialize.ts`). The schema is currently at version 2.
