# OPEN DESIGN — Document Schema

Current schema version: **13**. Version 1 was Phase 1. Phase 2 so far: version 2 added the `GROUP` layer type, version 3 `TEXT`, version 4 gradient paints, stroke caps / joins / dashes, per-corner radii, effects and blend modes, version 5 image paints with the document's asset table, version 6 constraints and layout grids, and version 7 ruler guides on pages. Phase 3: version 8 adds the `VECTOR` layer type, and version 9 arcs on ellipses and arrowheads on lines and vectors. Version 10 adds masks (a Phase 2 item finished later), version 11 boolean groups, version 12 adjustments on image paints and version 13 justified text, lists and styles on parts of a text layer (Phase 2 items finished later). This file is the contract between the editor, the native file format, the storage layer and, later, the collaboration server. Any change to it requires a version bump and a migration (spec §32).

The TypeScript source of truth is `src/core/document/schema.ts`. If this document and the code disagree, that is a bug: fix both in the same commit.

---

## 1. Design goals

1. **Independent.** Nothing here depends on Figma's servers or file format (spec §4).
2. **Versioned.** Every stored file carries `schemaVersion`; loading always migrates forward.
3. **Collaboration-ready.** Flat node map, single-property moves, stable IDs, so that it maps one-to-one onto a CRDT.
4. **Deterministic.** The same document always produces the same tree and the same pixels.
5. **Strict.** Loaded data is validated and repaired; corruption is detected, not rendered.

---

## 2. File container

The native file extension is `.opendesign`. The content is UTF-8 JSON:

```jsonc
{
  "format": "open-design",       // constant; identifies the file type
  "schemaVersion": 1,            // integer; see Migrations
  "meta": {
    "createdAt": "2026-11-15T10:00:00.000Z",   // ISO 8601, UTC
    "updatedAt": "2026-11-15T10:42:10.123Z"
  },
  "document": { /* Document, below */ }
}
```

The same object is what IndexedDB stores for each local file, in a record that additionally indexes `id`, `name` and `updatedAt` for the file browser.

**Image assets (version 5).** The bytes of an image are never part of `document`. An image is identified by the SHA-256 of its bytes; the document records what it knows about each one in `document.assets` and image paints refer to it by that hash.

- On a device, the bytes are kept in asset storage (an IndexedDB object store keyed by hash), once however many files use them.
- A file exported to disk carries them in a top-level `assetData` object, `{ "<hash>": "<base64 of the bytes>" }`, holding exactly the assets the document's layers use, so the file is complete on its own. Local storage never writes `assetData`.
- On import each bundled image is hashed again and stored only if the hash matches its key. A mismatch is refused, because every file that uses that hash would otherwise show the wrong image.
- A document whose image bytes cannot be found still opens; the layers that use them show a placeholder.

A zip container (to avoid base64's one-third size overhead) remains an option for a later version; it would keep reading these files.

---

## 3. Document

```ts
interface Document {
  id: string;                          // stable document ID
  name: string;                        // file name shown in the UI
  nodes: Record<NodeId, DesignNode>;   // every page and every layer, flat
  assets: Record<Hash, AssetInfo>;     // version 5: image assets used by the document
}

interface AssetInfo {
  mimeType: string;                    // image/png, image/jpeg, image/webp, image/gif or image/svg+xml
  width: number;                       // natural size in pixels
  height: number;
  name: string;                        // the file it was imported from, for display
}
```

Timestamps are deliberately outside `Document` (in `meta`) so that they never appear in undo history or in collaborative merges.

---

## 4. Identity and tree structure

### 4.1 IDs

`NodeId` is a 16-character random string over `[0-9A-Za-z]` generated from a cryptographic random source (about 95 bits). IDs are unique across documents and users, never reused and never change for the lifetime of a node. Duplicating or pasting creates new IDs.

### 4.2 Parent pointer and order key

The tree is stored on the child, not on the parent:

```ts
interface NodeBase {
  id: NodeId;
  type: NodeType;
  name: string;
  parentId: NodeId | null;   // null only for PAGE nodes
  order: string;             // fractional index among siblings
}
```

- Siblings are sorted by `order` ascending using plain code-unit comparison; ties are broken by `id`. For layers, ascending order is **bottom to top** (the first sibling is painted first). For pages, ascending order is first to last.
- `order` keys are fractional indices: between any two keys a new key can always be generated, so inserting or moving a node writes exactly one node and never renumbers its siblings.
- There are no `children` arrays anywhere in stored data. Children lists are derived and cached at runtime.

Why: with children arrays, two users reordering the same parent overwrite each other's whole array. With `parentId` + `order`, a move is one small write that merges cleanly (ADR-002).

### 4.3 Containers

A node may be a parent only if its type is a container type. The container types are `PAGE`, `FRAME` and, from version 2, `GROUP`. Later versions add `SECTION`, `COMPONENT`, `COMPONENT_SET`, `INSTANCE` and `BOOLEAN_OPERATION`.

---

## 5. Node types

```ts
type NodeType = 'PAGE' | 'FRAME' | 'GROUP' | 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'POLYGON' | 'STAR' | 'TEXT' | 'VECTOR' | 'BOOLEAN_OPERATION';
```

`GROUP` exists from version 2 and `TEXT` from version 3; everything else from version 1.

### 5.1 Page

```ts
interface PageNode extends NodeBase {
  type: 'PAGE';
  parentId: null;
  backgroundColor: RGB;      // canvas colour behind the page content
  guides: Guide[];           // version 7: ruler guides
}

interface Guide {
  axis: 'X' | 'Y';           // 'X': a vertical line at x = position; 'Y': a horizontal line at y = position
  position: number;          // page space
}
```

### 5.2 Properties shared by all layers

```ts
interface LayerBase extends NodeBase {
  parentId: NodeId;
  visible: boolean;
  locked: boolean;

  // Geometry, in the parent's coordinate space (see §6)
  x: number;
  y: number;
  width: number;             // ≥ 0
  height: number;            // ≥ 0
  rotation: number;          // degrees, clockwise on screen, normalised to (-180, 180]

  // Appearance
  opacity: number;           // 0..1, applies to the node and its descendants
  fills: Paint[];            // painted in array order, first at the bottom
  strokes: Paint[];
  strokeWeight: number;      // ≥ 0
  strokeAlign: 'INSIDE' | 'CENTER' | 'OUTSIDE';

  // Version 4
  strokeCap: 'NONE' | 'ROUND' | 'SQUARE';   // ends of open strokes and of dashes
  strokeJoin: 'MITER' | 'BEVEL' | 'ROUND';
  dashPattern: number[];     // alternating dash and gap lengths; [] is a solid stroke
  effects: Effect[];         // applied in order, first at the bottom
  blendMode: BlendMode;      // how the layer and everything in it mixes with what is beneath

  // Version 6
  constraints: { horizontal: ConstraintType; vertical: ConstraintType };

  // Version 10
  isMask: boolean;           // the layer masks the layers above it in its parent instead of being painted
}
```

**Masks.** A layer with `isMask` is not painted. The layers above it in the same parent, up to the next mask (or the end of the parent), are shown only where the mask would have painted, and only as strongly: a half-transparent mask lets half through, and a mask with a gradient that fades out fades them out. A hidden mask masks nothing. A mask reaches no further than its parent, which is why "Use as mask" on several layers groups them first. On the canvas a masked layer can be clicked only where its mask lets it show, and a mask cannot be clicked at all (it is selected in the layers panel).

### 5.3 Concrete layers

```ts
interface FrameNode extends LayerBase {
  type: 'FRAME';
  clipsContent: boolean;     // children are clipped to the frame's box
  cornerRadius: number;      // ≥ 0
  cornerRadii: [number, number, number, number] | null;   // version 4; see RectangleNode
  layoutGrids: LayoutGrid[]; // version 6
}

interface GroupNode extends LayerBase {
  type: 'GROUP';             // version 2. No appearance of its own: fills and strokes are empty.
}

interface RectangleNode extends LayerBase {
  type: 'RECTANGLE';
  cornerRadius: number;      // ≥ 0
  // Version 4. One radius per corner in the order top-left, top-right,
  // bottom-right, bottom-left. When null, cornerRadius applies to all four.
  cornerRadii: [number, number, number, number] | null;
}

interface EllipseNode extends LayerBase {
  type: 'ELLIPSE';
  arcStart: number;          // version 9. Degrees, clockwise on screen from three o'clock; -360..360
  arcSweep: number;          // version 9. Degrees, 1..360; 360 is the whole ellipse
  arcRatio: number;          // version 9. Inner radius as a fraction of the outer, 0..0.99
}

type ArrowType = 'NONE' | 'LINE' | 'TRIANGLE' | 'CIRCLE' | 'DIAMOND';

interface LineNode extends LayerBase {
  type: 'LINE';              // drawn from (0, height/2) to (width, height/2); height is 0
  startArrow: ArrowType;     // version 9. At (0, height/2)
  endArrow: ArrowType;       // version 9. At (width, height/2)
}

interface PolygonNode extends LayerBase {
  type: 'POLYGON';
  pointCount: number;        // integer ≥ 3; first vertex at top centre
}

interface StarNode extends LayerBase {
  type: 'STAR';
  pointCount: number;        // integer ≥ 3
  innerRadius: number;       // 0..1, inner radius as a fraction of the outer radius
}
```

```ts
interface TextNode extends LayerBase {
  type: 'TEXT';              // version 3. Fills colour the glyphs; strokes outline them.
  characters: string;        // "\n" separates paragraphs
  fontFamily: string;
  fontSize: number;          // pixels, 1..2000
  fontWeight: number;        // 100..900 in steps of 100
  italic: boolean;
  lineHeight: number | null; // pixels; null = automatic (1.2 × fontSize, rounded)
  letterSpacing: number;     // pixels added after each character
  textAlign: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';   // JUSTIFIED: version 13
  verticalAlign: 'TOP' | 'MIDDLE' | 'BOTTOM';
  textAutoResize: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  listType: 'NONE' | 'BULLETED' | 'NUMBERED';   // version 13
  styleRanges: TextStyleRange[];                // version 13
}

// Version 13. A stretch of the characters, from start up to but not including end (string indices,
// that is UTF-16 code units), with what it has that differs from the layer. An absent key means
// "as the layer has it".
interface TextStyleRange {
  start: number;
  end: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
  letterSpacing?: number;
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  color?: RGB;               // a solid colour for these glyphs, in place of the layer's fills
}
```

**Styled ranges.** The layer's own font properties are the style of all of its text; `styleRanges` lists the parts that differ. The list is always in one form: in order, not overlapping, not empty, inside the text, each range changing at least one thing, no two neighbours alike, and keys in the order shown above. Every operation that changes `characters` moves the ranges with their characters (`replaceText`, `setTextCharacters`); characters typed in take the style of the one before them. Giving the whole layer a value for a property (`setTextStyle`) removes that property from every range, and new fills remove the ranges' colours. A line is as tall as its tallest run unless `lineHeight` is set, and runs of different sizes share a baseline.

**Lists.** With `listType` other than `NONE` every paragraph is an item: a bullet or the paragraph's number is drawn in front of its first line and all of its lines are set in by the same amount (one and a half times the font size, or more if the widest number needs it). A marker is drawn in the style of the first character of its item. The list is a property of the whole layer; there are no nested levels.

**Justified text.** `JUSTIFIED` spreads the words of every line that was cut short by wrapping across the layer's width, by widening the gaps between words. The last line of each paragraph, and text that sets its own width, are left as they are.

**Text.** A layer has one style of its own, with ranges for the parts that differ (see above). `textAutoResize` says which dimensions follow the content: both (auto width, never wraps), the height only (wraps at the layer's width), or neither (fixed box). The editor refits those dimensions after every edit (`fitTextLayers`), keeping the edge the text is aligned to in place, so the stored `width` and `height` are always the laid-out size as measured on the machine that last edited the text. A machine without the font falls back to another and may lay the text out differently until it is next edited.

```ts
interface VectorNode extends LayerBase {
  type: 'VECTOR';            // version 8
  network: VectorNetwork;
  windingRule: 'NONZERO' | 'EVENODD';
  startArrow: ArrowType;     // version 9
  endArrow: ArrowType;       // version 9
}

interface VectorNetwork {
  vertices: { x: number; y: number }[];   // in the layer's own space: (0, 0) is the top-left corner of its box
  segments: VectorSegment[];
}

interface VectorSegment {
  start: number;             // index into vertices
  end: number;               // index into vertices
  tangentStart: { x: number; y: number };  // Bézier control handle, relative to the start point
  tangentEnd: { x: number; y: number };    // Bézier control handle, relative to the end point
}
```

**Vectors.** A vector layer holds a *vector network*: points, and segments between them. A segment whose two tangents are zero is a straight line; otherwise it is a cubic Bézier curve. Unlike a path, a point may have any number of segments, so shapes can branch and share edges. What is derived from a network is not stored:

- *Strokes* follow every segment. Runs of segments through points that have exactly two segments are stroked as one line, so they get proper joins; a run ends at a loose end or at a branch.
- *Fills* cover closed regions. A plain path (no branches) is filled as it is, an open one as if a straight line closed it. The parts of a network that branch are filled region by region; the regions are found by walking round each point in order, which assumes segments do not cross each other. `windingRule` decides what happens where outlines overlap or nest: `NONZERO` fills everything enclosed, `EVENODD` makes a shape inside a shape a hole.
- A stroke can be inside or outside only when every run is closed; otherwise it is centred whatever `strokeAlign` says.
- Whether a point is smooth is read from its handles (two handles in a straight line through the point); no flag is stored.

A vector's box is always the bounding box of its curves (the curves themselves, not their handles), in the layer's own, possibly rotated, frame of reference. The editor restores this after every edit (`fitVectors`) without moving anything on the page, and removes a vector that has no points left. Resizing a vector scales its points and handles; a vector that is flat in one direction (a straight line) cannot be resized in that direction. "Flatten to vector" turns rectangles, ellipses, lines, polygons and stars into vectors (text cannot be converted: the application has no access to glyph outlines).

```ts
interface BooleanOperationNode extends LayerBase {
  type: 'BOOLEAN_OPERATION'; // version 11. A container: the shapes it combines are its children
  operation: 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE';
  network: VectorNetwork;    // derived: the result of the operation, in the group's own space
}
```

**Boolean groups.** A boolean group holds shapes (rectangles, ellipses, lines, polygons, stars, vectors, groups of those, other boolean groups) and shows the result of combining them: `UNION` everything any of them covers, `SUBTRACT` the bottom-most with the others taken out, `INTERSECT` what all of them share, `EXCLUDE` what an odd number of them cover. The children are not painted; the group is, as one shape, with its own fills, strokes and effects. A group inside counts as the union of what is in it; hidden children, frames and text count for nothing. `network` and the group's box (the bounding box of the result, or of the children when nothing is left) are **derived data**: the editor recomputes them whenever a child changes (`refreshBoolean`, run with `normalizeGroups`) and nothing edits them directly. They are stored so that a file can be drawn, hit-tested and exported without redoing the geometry. A boolean group with no children is removed, like an empty group. Resizing one scales its children; ungrouping releases them; flattening replaces it with a `VECTOR` of its result.

**Arcs.** An ellipse with `arcSweep` below 360 is a slice (the arc and two straight sides to the centre); with `arcRatio` above 0 the middle is cut out, which makes a ring, or with a sweep a piece of a ring. The layer's box is always that of the whole ellipse, whatever part of it is shown. Hit testing, flattening and boolean operations use the real outline.

**Arrowheads.** `startArrow` and `endArrow` say what is drawn at the loose ends of a stroke: nothing, an open arrow, a filled triangle, a dot or a diamond, sized from the stroke weight and painted with the stroke's paints. On a vector they apply to every open run of segments: `startArrow` to the end the run begins at (the lower-numbered point), `endArrow` to the other, and only at ends that are not branch points; a closed path shows none. Under a triangle the stroke is drawn slightly shorter so that it does not show through the tip. Arrowheads are not part of a layer's box.

**Groups.** A group's box is always the bounding box of its children, in the group's own (possibly rotated) frame of reference. This is an invariant the editor restores after every edit (`normalizeGroups`): the box is refitted when children move or resize, and a group whose last child is removed is deleted. Resizing a group scales its children; resizing a frame does not. A group is never hit directly on the canvas, only through its children.

### 5.4 Paint

```ts
interface RGB { r: number; g: number; b: number }   // each 0..1

interface SolidPaint {
  type: 'SOLID';
  color: RGB;
  opacity: number;           // 0..1
  visible: boolean;
}

// Version 4
interface GradientStop { position: number; color: RGB; opacity: number }   // position 0..1
interface GradientPaint {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  stops: GradientStop[];     // at least two, sorted by position
  from: { x: number; y: number };   // the two handles, in the layer's unit square:
  to: { x: number; y: number };     // (0,0) is its top-left corner, (1,1) its bottom-right
  opacity: number;
  visible: boolean;
}

// Version 5
interface ImagePaint {
  type: 'IMAGE';
  imageHash: string;         // 64 lowercase hex characters; a key of Document.assets
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  crop: { x: number; y: number; width: number; height: number };   // CROP: the part shown, in the image's unit square
  tileScale: number;         // TILE: tile size relative to the image's natural size
  exposure: number;          // version 12. -1..1, 0 = as it is: -1 is black, 1 twice as bright
  contrast: number;          // version 12. -1..1, 0 = as it is: -1 is flat grey, 1 twice the contrast
  saturation: number;        // version 12. -1..1, 0 = as it is: -1 is grey, 1 twice as colourful
  opacity: number;
  visible: boolean;
}

type Paint = SolidPaint | GradientPaint | ImagePaint;
```

An image paint fills a shape: FILL covers the box keeping the image's proportions, FIT shows the whole image inside it, CROP stretches the chosen part over it, TILE repeats it. Image paints are not drawn on strokes or on text. The three adjustments change how the image is drawn, never the stored image: the renderer applies them as the canvas filter `brightness(1 + exposure) contrast(1 + contrast) saturate(1 + saturation)`, and applies none when all three are 0.

A linear gradient runs from `from` to `to`, with its bands at right angles to that line in pixel space. For the other kinds `from` is the centre and `to` gives the radius and the direction of the first stop; they are laid out in the layer's unit square, so they stretch with the box (a radial gradient in a wide rectangle is an ellipse). On text and on strokes, which cannot be stretched that way, the round kinds are circular and a diamond falls back to radial.

When the radii of neighbouring corners do not fit along a side, all four are scaled down by the same factor at paint time (the CSS rule), so stored radii are never changed by resizing.

### 5.5 Effects and blend modes (version 4)

```ts
interface ShadowEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: RGB;
  opacity: number;
  offsetX: number;           // in the layer's own axes: a rotated layer casts a rotated shadow
  offsetY: number;
  blur: number;              // ≥ 0, as a CSS shadow blur radius
  spread: number;            // grows (+) or shrinks (−) the shadow's shape before blurring
  visible: boolean;
}

interface BlurEffect {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number;            // ≥ 0, as a CSS blur() radius
  visible: boolean;
}

type Effect = ShadowEffect | BlurEffect;

type BlendMode = 'NORMAL' | 'DARKEN' | 'MULTIPLY' | 'COLOR_BURN' | 'LIGHTEN' | 'SCREEN' | 'COLOR_DODGE'
  | 'OVERLAY' | 'SOFT_LIGHT' | 'HARD_LIGHT' | 'DIFFERENCE' | 'EXCLUSION' | 'HUE' | 'SATURATION' | 'COLOR' | 'LUMINOSITY';
```

### 5.6 Constraints and layout grids (version 6)

```ts
type ConstraintType = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE';

interface LayoutGrid {
  pattern: 'GRID' | 'COLUMNS' | 'ROWS';
  size: number;              // GRID: the size of each square cell
  count: number;             // COLUMNS / ROWS: how many
  gutter: number;            // COLUMNS / ROWS: the space between them
  offset: number;            // margin at both ends (STRETCH) or offset from the aligned edge (MIN, MAX)
  alignment: 'MIN' | 'CENTER' | 'MAX' | 'STRETCH';
  sectionSize: number;       // width of a column or height of a row when not stretched
  color: RGB;
  opacity: number;
  visible: boolean;
}
```

**Constraints** say what a layer does, on each axis, when the frame it is *directly* inside changes size: keep its distance to the near edge (`MIN`: left or top — the default, and what layers did before version 6), to the far edge (`MAX`), or to the centre; keep both distances by stretching (`STRETCH`); or keep its position and size as a proportion of the frame (`SCALE`). They are applied when the frame is resized, as part of the same edit, so the stored geometry is always the result and nothing is computed at paint time. They use the layer's unrotated box. A layer whose size changes this way passes the change on: a nested frame applies its own children's constraints, and a group scales its contents. Constraints have no effect on a layer in a group or directly on a page.

**Layout grids** are guides drawn over a frame while designing and offered as snap lines. They are not part of the design: they are never painted into it and never exported.

Opacity, blend mode, layer blur and drop shadows apply to a layer as a whole, children included. Spread is honoured on rectangles, ellipses and frames; other shapes cast a shadow of their exact outline. Inner shadows apply to shapes and frames, not to text or groups.

---

## 6. Coordinate system and transforms

- The page is an unbounded plane. X grows to the right, Y grows downwards. Units are CSS pixels at 100% zoom.
- A layer's `x, y, width, height` describe its **unrotated** box in its parent's coordinate space. For a child of a page that is page space; for a child of a frame the origin is the frame's own top-left corner.
- `rotation` turns the box about its **centre**. Rotating a layer in place therefore changes only `rotation`.
- Local matrix: `M = T(x + w/2, y + h/2) · R(rotation) · T(−w/2, −h/2)`.
- World matrix: `W = W(parent) · M`; a page's world matrix is the identity.
- A child's coordinates are in its parent's local, unrotated space, so children rotate with their parent.

This is the convention CSS uses (`left/top/width/height` plus `transform: rotate()` about the centre), which keeps Developer Mode output direct (ADR-005).

Skew is not representable. There is no flip flag either: the basic shapes are symmetric about their own vertical axis, so "Flip horizontal / vertical" is implemented as an exact geometric operation (mirror the position, negate the rotation, add a half turn for a vertical flip of polygons and stars, and recurse into containers), and a vector's curves are mirrored themselves. What else of a layer's look is not the same on both sides is mirrored with it: the handles of gradient paints, per-corner radii, the slice of an ellipse (`arcStart`), the arrowheads of a line (which change ends on a horizontal flip) and the offsets of shadows. The glyphs of text and the picture of an image fill are not mirrored; they would need a `flipX` / `flipY` property.

---

## 7. Invariants

A valid document satisfies all of the following. `validateDocument()` reports violations; `repairDocument()` fixes what can be fixed safely and reports what it changed.

| # | Invariant | Repair |
|---|---|---|
| 1 | There is at least one `PAGE`. | Add an empty page. |
| 2 | Each key in `nodes` equals that node's `id`. | Re-key. |
| 3 | `PAGE` nodes have `parentId: null`; all other nodes have a `parentId` naming an existing container node. | Reattach orphans to the first page. |
| 4 | Following `parentId` from any node reaches a page without visiting a node twice (no cycles). | Break the cycle by reattaching to the first page. |
| 5 | `order` is a non-empty string; siblings do not share an `order`. | Regenerate keys, preserving current sort. |
| 6 | Numbers are finite. `width`, `height`, `strokeWeight`, `cornerRadius` ≥ 0. `opacity` values are within 0..1. Colour channels are within 0..1. | Clamp, or reset non-finite values to defaults. |
| 7 | `type` is a known node type for this schema version. | Drop the node and its subtree, and report it. |
| 8 | `pointCount` is an integer ≥ 3; `innerRadius` is within 0..1. | Clamp. |
| 9 | Every segment of a vector network starts and ends at an existing point of that network; coordinates and tangents are finite. | Drop segments that point nowhere; reset bad numbers to 0. |
| 10 | A vector layer's box is the bounding box of its curves. | Refit the box, without moving the curves on the page. |
| 11 | A text layer's `styleRanges` are in order, do not overlap, are not empty, lie inside `characters`, each change something, and no two neighbours are alike; their values are within the limits of the layer's own font properties. | Drop bad values (that part of the text falls back to the layer's style), then cut, clamp, order and join the ranges. |

Repair never silently discards user content except under rule 7, and every repair is surfaced to the user when a file is opened.

---

## 8. Migrations

```ts
const CURRENT_SCHEMA_VERSION = 11;
const MIGRATIONS: Record<number, (file) => file> = {
  // 1 -> 2: adds the GROUP type. A version 1 file has no groups, so only the version number changes.
  1: (file) => ({ ...file, schemaVersion: 2 }),
  // 2 -> 3: adds the TEXT type. Older files have no text layers.
  2: (file) => ({ ...file, schemaVersion: 3 }),
  // 3 -> 4: every layer gets strokeCap 'NONE', strokeJoin 'MITER', dashPattern [],
  // effects [] and blendMode 'NORMAL'; frames and rectangles get cornerRadii null.
  // These are the values that paint exactly what the layer painted before.
  3: addVersion4Defaults,
  // 4 -> 5: adds image paints and Document.assets. Older documents use no images: assets is {}.
  4: (file) => ({ ...file, schemaVersion: 5, document: { ...file.document, assets: {} } }),
  // 5 -> 6: every layer gets constraints { horizontal: 'MIN', vertical: 'MIN' }; frames get layoutGrids [].
  5: addVersion6Defaults,
  // 6 -> 7: pages get guides [].
  6: addEmptyGuides,
  // 7 -> 8: adds the VECTOR type. Older files have no vector layers.
  7: (file) => ({ ...file, schemaVersion: 8 }),
  // 8 -> 9: ellipses get arcStart 0, arcSweep 360, arcRatio 0; lines and vectors get startArrow and endArrow 'NONE'.
  8: addVersion9Defaults,
  // 9 -> 10: every layer gets isMask false.
  9: addIsMask,
  // 10 -> 11: adds the BOOLEAN_OPERATION type. Older files have no boolean groups.
  10: (file) => ({ ...file, schemaVersion: 11 }),
  // 11 -> 12: every image paint (in fills and strokes) gets exposure 0, contrast 0 and saturation 0,
  // placed after tileScale, where a version 12 file has them.
  11: addImageAdjustments,
  // 12 -> 13: every text layer gets listType 'NONE' and styleRanges [].
  12: addTextListAndRanges,
};
```

| From | To | What changed | Fixture test |
|---|---|---|---|
| 1 | 2 | `GROUP` layer type added | `src/core/ops/arrange.test.ts` ("schema migration") |
| 2 | 3 | `TEXT` layer type added | `src/core/text/layout.test.ts` ("text in the file format") |
| 3 | 4 | Gradient paints; stroke cap, join and dashes; per-corner radii; effects; blend modes | `src/appearance.test.ts` ("version 3 files") |
| 4 | 5 | Image paints; `Document.assets`; `assetData` in exported files | `src/images.test.ts` ("opens a version 4 file") |
| 5 | 6 | Constraints on every layer; layout grids on frames | `src/layout.test.ts` ("version 5 files") |
| 6 | 7 | Ruler guides on pages | `src/guides.test.ts` ("opens a version 6 file") |
| 7 | 8 | `VECTOR` layer type added | `src/vector.test.ts` ("opens a version 7 file") |
| 8 | 9 | Arcs on ellipses; arrowheads on lines and vectors | `src/arcs.test.ts` ("opens a version 8 file") |
| 9 | 10 | Masks (`isMask` on every layer) | `src/masks.test.ts` ("survives flattening, validation and older files") |
| 10 | 11 | `BOOLEAN_OPERATION` layer type added | `src/boolean.test.ts` ("opens a version 10 file") |
| 11 | 12 | Image adjustments (`exposure`, `contrast`, `saturation` on image paints) | `src/imageedit.test.ts` ("are kept in range in a file, and are zero in a file from before they existed") |
| 12 | 13 | Text: `JUSTIFIED` alignment, `listType`, `styleRanges` | `src/richtext.test.ts` ("opens a version 12 file") |

- `migrateFile(raw)` reads `schemaVersion`, applies `migrations[v]` repeatedly until the current version, then hands the result to validation.
- A file whose `schemaVersion` is **greater** than the current version is refused with a message telling the user to update the application. It is never opened in a degraded mode, because saving it would destroy data the older build does not understand.
- A file with a missing or non-integer `schemaVersion`, or a `format` other than `open-design`, is refused as not an OPEN DESIGN file.
- Every migration has a unit test with a stored fixture of the older version.
- Migrations are pure and idempotent on already-migrated data.

---

## 9. What is not in the document

| Data | Where it lives | Why |
|---|---|---|
| Selection, current page, tool, viewport, expanded layers | Editor state (per user, per session; viewport and page are remembered locally per file) | Not design data; differs per collaborator. |
| Undo history | Editor store, memory only | Per user and per session. |
| A drag or draw in progress | The active tool | Transient. |
| Cursors and presence | Collaboration awareness channel | Ephemeral. |
| Children lists, world matrices, bounds | Runtime caches | Derived. |
| Timestamps | File `meta` | Must not create undo steps or merge conflicts. |

---

## 10. Planned extensions

These are reserved so that later versions extend the schema without restructuring it. None of them exists in version 1.

| Phase | Addition |
|---|---|
| 2 | `flipX/flipY`. (Done: per-range text styles, lists and justified text in version 13; `GROUP` in version 2, `TEXT` in version 3, gradients, stroke options, corner radii, effects and blend modes in version 4, image paints and assets in version 5, constraints and layout grids in version 6, ruler guides in version 7, masks in version 10, image adjustments in version 12.) |
| 3 | (Done: `VECTOR` in version 8, arcs and arrowheads in version 9, `BOOLEAN_OPERATION` in version 11.) |
| 4 | Auto Layout properties on frames (`layoutMode`, padding, `itemSpacing`, alignment, wrap) and on children (`layoutSizingHorizontal/Vertical`, `layoutPositioning`, min/max sizes). |
| 5 | `COMPONENT`, `COMPONENT_SET`, `INSTANCE` with `overrides`; document-level `styles`, `variableCollections`, `variables`; property bindings. |
| 6 | `interactions[]` on nodes, `flows[]` on pages, scroll behaviour, fixed/sticky children. |
| 7 | `exportSettings[]`, annotations, development status. |
| 8 | Comments are stored outside the document body, keyed by document and node ID. |
