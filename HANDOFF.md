# OPEN DESIGN — Handoff note

Last updated: 2026-11-15, after five slices of Phase 2 (groups and arranging; text; snapping; appearance; images).

## Where the project stands

| Phase | State |
|---|---|
| 0 — Planning | Partly done, then stopped at the owner's request. `PROJECT_ARCHITECTURE.md` and `DOCUMENT_SCHEMA.md` exist. The other four planning documents were **not written**. |
| 1 — Editor foundation | **Implemented and tested.** Acceptance criterion met (see below). |
| 2 — Design functionality | **In progress.** Done and tested: groups, align, distribute, flip, text layers, snapping to objects with smart guides, gradients, stroke caps / joins / dashes, per-corner radii, shadows, blurs, blend modes, images. **Not started:** clipping masks, rulers, draggable guides, layout grids, constraints. The Phase 2 acceptance criterion is **not** met. |
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
- **Text (Phase 2).** Text tool (T): click for text that grows with what you type, or drag out a box that wraps. Typed in place on the canvas with a real text field (caret, selection, clipboard, IME), at any zoom and rotation. Double-click or Enter edits existing text; Escape, Ctrl+Enter or clicking away finishes. Font family (from the fonts installed on the machine), weight, size, line height, letter spacing, horizontal and vertical alignment, auto width / auto height / fixed size, letter case, underline or strikethrough, italic, fill colour. The layer resizes itself to its text and is named after it. Leaving new text empty creates nothing.
- **Snapping (Phase 2).** While moving, resizing or drawing, edges and centre lines snap to the other layers in the same frame and to the frame's own edges and centre, within 6 screen pixels, and the lines snapped to are shown as guides. An axis locked with Shift is not snapped. "Snap to objects" in the View menu switches it off; the choice is remembered on this device.
- **Appearance (Phase 2).** Fills and strokes can be solid or a linear, radial, angular or diamond gradient with any number of colour stops (colour, position, opacity) and an angle. Strokes have flat / round / square ends, sharp / cut / round corners and dashes with a gap. Frames and rectangles can have a different radius on each corner. Effects: drop shadow and inner shadow (offset, blur, spread, colour, opacity), layer blur and background blur, stacked, each hideable. Sixteen blend modes. Opacity, blend mode, blur and shadow apply to a layer as a whole, children included.
- **Images (Phase 2).** Place PNG, JPEG, WebP, GIF or SVG files from File → Place image… (Ctrl+Shift+K), by dropping them on the canvas, or by pasting from the clipboard. An image becomes a rectangle with an image fill, at its natural size unless that would not fit in the view, inside the frame it lands on. Any shape's fill can be an image: Fill, Fit, Crop (choose the part shown) and Tile (choose the tile size), with opacity; the image can be replaced without touching the layer. Image bytes are stored once per device by content hash, and "Save a copy to disk" bundles them into the file, checked against their hashes when the file is imported.
- **Menus and shortcuts.** Main menu (File, Edit, View, Object, Help), context menus and a shortcut reference, all generated from one command table, so a menu item and its shortcut cannot disagree.

## What is tested

Run on 2026-11-15: TypeScript clean; **241 unit tests** and **13 browser acceptance tests** pass; production build succeeds.

- `src/core/core.test.ts`, `src/core/document/validate.test.ts` — document operations, transforms, ordering, hit testing, selection rules, history diff, validation and repair, file format and version handling.
- `src/state/editor.test.ts` — the real store and the real tools driven with pointer sequences: drawing, selecting, moving, nesting, resizing, rotating, pan and zoom, commands, pages, history.
- `src/persistence/persistence.test.ts` — IndexedDB storage, file operations, import/export, autosave including failure and recovery, session memory.
- `src/engine/render/render.test.ts` — culling, hidden layers, a 10,000-layer page.
- `src/architecture.test.ts` — module boundaries (the core imports nothing outside itself).
- `e2e/phase1.spec.ts` — the Phase 1 acceptance criterion end to end in Microsoft Edge with real mouse and keyboard, including a reload and reopening from the file browser.
- `src/core/ops/arrange.test.ts`, `src/state/arrange.test.ts` — groups (fit, nesting, scaling, removal when empty), align, distribute, flip, and opening a version 1 file in the version 2 format.
- `src/core/text/layout.test.ts`, `src/state/text.test.ts` — line breaking, alignment, auto-sizing with the anchored edge, the text tool, editing, resizing rules, validation of text properties, and opening a version 2 file in the version 3 format.
- `src/images.test.ts` — hashing and base64, where each fit mode puts an image, crop limits, validation and repair of image paints and the asset table, the image cache, importing and placing (size, position, nesting in a frame, undo), exported files that carry their images and refuse tampered ones, asset storage in IndexedDB, what the renderer draws for each fit mode, and opening a version 4 file in version 5.
- `e2e/images.spec.ts` — a generated PNG placed through the real file chooser, pixel checks for Fill / Fit / Crop / Tile, replacing the image, a reload; drop and paste; plain Ctrl+C / Ctrl+V of layers; refusing non-images and broken images.
- `src/appearance.test.ts` — gradient construction and conversion, validation and repair of paints, effects, dashes and corner radii, corner-radius fitting, culling bounds with effects, which layers the renderer composites as a whole, and opening a version 3 file in version 4.
- `e2e/appearance.spec.ts` — real pixels for all four gradient kinds, dashes, stroke position and caps, per-corner radii, drop shadow with spread and blur, inner shadow, layer blur, background blur, multiply / screen / difference, and group opacity.
- `src/state/snap.test.ts` — snap targets, snapping maths, snapping while moving, resizing and drawing, the on/off preference.
- `e2e/phase2.spec.ts` — snapping on and off in the browser with the preference surviving a reload; group, ungroup, align, distribute and flip; and text: typing in the real in-place editor, glyph pixels on the canvas, restyling, re-editing, undo, discarding empty text, reload.
- `e2e/rendering.spec.ts` — reads real pixels from the canvas: fills, clipping, ellipse shape, strokes, hidden layers, undo.

Not covered by automated tests: the native save/open file dialogs (`src/persistence/diskIO.ts`), drag-and-drop reordering in the layers panel, context menus, the colour picker's live preview, and any browser other than Edge. These were written to work but have not been exercised by a test.

## Known limitations and rough edges

- No rulers, draggable guides, layout grids, constraints or Auto Layout yet: those are the rest of Phase 2 and later.
- Images: crop is set with numbers, not by dragging on the canvas. No image adjustments (exposure, contrast and so on), no "use as mask", no PDF import. An animated GIF shows its first frame. SVG is placed as a picture, not converted into editable vector layers. Image fills are not drawn on strokes or text. Deleting a file does not yet remove images that no other file uses; they stay in the browser's storage.
- Gradients are edited in the properties panel only (type, angle, stops); there are no draggable gradient handles on the canvas, and no eyedropper. On text and strokes, radial and angular gradients are circular rather than stretched to the box, and diamond falls back to radial.
- Shadow spread works on rectangles, ellipses and frames only. Inner shadows are not drawn on text or groups. A drop shadow shows through a translucent fill. Background blur does not see through a group that is itself being composited (one with a blend mode, blur or partial opacity).
- There is one colour picker (the browser's), with HEX entry; no RGB / HSL fields, no colour styles.
- Snapping is to objects only: no snapping to a grid or to guides (there are none yet), no equal-spacing snapping, no distance read-outs, and nothing snaps inside a rotated frame. Whole-pixel snapping is always on and has no switch yet.
- Text has one style per layer: no bold word inside a sentence, no lists, no text on a path, no justified alignment. No fonts are bundled, so the font menu offers what the machine has (default Arial) and a file opened on a machine without a font shows a fallback. Text strokes are always centred on the outline.
- While text is being edited, the in-place editor ignores vertical alignment and may sit a fraction of a pixel off the painted text.
- Dragging a resize handle past the opposite edge flips the box but does not mirror its content. (The Flip commands do mirror correctly.)
- Flip is exact for today's shapes because they are all symmetric; text, images and vector paths will need a real flip property (noted in DOCUMENT_SCHEMA.md §6).
- Alt+D (align right) is also the browser's "focus address bar" shortcut and the browser may take it first; the button and the menu item always work.
- Resizing a multi-selection that contains rotated layers scales their boxes approximately; it cannot skew.
- Copying and pasting layers works inside the application only (within and between files in the same tab); layers are not put on the system clipboard. Images on the system clipboard can be pasted in.
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
2. ~~Snapping to objects and frame edges with smart guides.~~ Done. Still to do here: rulers, draggable guides and snapping to them, equal-spacing snapping, a switch for pixel snapping.
3. ~~Appearance: gradients, strokes with dash/cap/join, independent corner radii, shadows and blurs, blend modes.~~ Done. Still to do here: gradient handles on the canvas, eyedropper, RGB/HSL entry, arrowheads.
4. ~~Text layers with inline editing and font properties.~~ Done, with the limits listed above. Still to do for text: per-range styles, lists, bundled open-licence fonts, justified text.
5. ~~Images: import (file, drag-and-drop, paste), fill modes, crop, asset store.~~ Done. Still to do here: cropping by dragging, image adjustments, masks, removing unused assets, SVG import as editable vectors (needs Phase 3).
6. Constraints and layout grids.

Each schema addition needs a version bump and a migration with a fixture test (see `MIGRATIONS` in `src/core/document/serialize.ts`). The schema is currently at version 5.
