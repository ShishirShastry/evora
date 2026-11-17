# OPEN DESIGN — Document Schema

Current schema version: **24**. Version 1 was Phase 1. Phase 2 so far: version 2 added the `GROUP` layer type, version 3 `TEXT`, version 4 gradient paints, stroke caps / joins / dashes, per-corner radii, effects and blend modes, version 5 image paints with the document's asset table, version 6 constraints and layout grids, and version 7 ruler guides on pages. Phase 3: version 8 adds the `VECTOR` layer type, and version 9 arcs on ellipses and arrowheads on lines and vectors. Version 10 adds masks (a Phase 2 item finished later), version 11 boolean groups, version 12 adjustments on image paints version 13 justified text, lists and styles on parts of a text layer, and version 14 mirrored text and image fills and guides on frames (Phase 2 items finished later). Phase 4: version 15 adds Auto Layout (frames that lay out their children, and how each layer is sized and placed in one), version 16 the alignment that stretches children across a layout, and version 17 columns that wrap as rows do. Phase 5: version 18 adds components and instances, version 19 component sets, variants and component properties, version 20 styles and variables with modes, and version 21 libraries. Phase 6: version 22 adds prototyping (interactions, flows, scrolling and overlays). Phase 7: version 23 adds export settings and what developers are handed (status, notes, links, code mapping), and version 24 a stroke weight for each side of a box, links in prototypes and Auto Layout rows aligned on the baseline of their text (all needed to open Figma files faithfully). This file is the contract between the editor, the native file format, the storage layer and, later, the collaboration server. Any change to it requires a version bump and a migration (spec §32).

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
  // Version 20: the design system of the document (see §5.9)
  styles: Record<string, Style>;
  variables: Record<string, Variable>;
  variableCollections: Record<string, VariableCollection>;
  // Version 21: what this document has published as a library, or null (see §5.10)
  publication: Publication | null;
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
  variableModes: Record<string, string>;   // version 20: the mode chosen for this page, by collection ID
  library: { id: string; name: string; version: number } | null;   // version 21: set on a page that holds a library's components (§5.10)
  // Version 22: the prototype of the page (§5.11)
  flows: { id: string; name: string; startId: NodeId }[];   // its named starting frames
  prototypeDevice: 'NONE' | 'PHONE' | 'TABLET' | 'DESKTOP';   // the screen it is shown on
  exportSettings: ExportSetting[];   // version 23: the ways the page as a whole is exported (§5.12)
}

interface Guide {
  axis: 'X' | 'Y';           // 'X': a vertical line at x = position; 'Y': a horizontal line at y = position
  position: number;          // page space for a page's guide; the frame's own space for a frame's guide
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

  // Version 15: Auto Layout (see §5.7)
  layoutSizingHorizontal: 'FIXED' | 'HUG' | 'FILL';   // what decides the width
  layoutSizingVertical: 'FIXED' | 'HUG' | 'FILL';     // what decides the height
  layoutPositioning: 'AUTO' | 'ABSOLUTE';             // ABSOLUTE: not placed by the Auto Layout frame it is in
  minWidth: number | null;   // limits on the size Auto Layout gives the layer; null = none
  maxWidth: number | null;
  minHeight: number | null;
  maxHeight: number | null;

  // Version 18: components (see §5.8)
  sourceId: NodeId | null;   // inside an instance: the layer of the component that this one mirrors; otherwise null

  // Version 19: component properties (see §5.8)
  propRefs: { visible?: string; characters?: string; componentId?: string };   // in a component: the properties, by ID, that decide these

  // Version 20: styles and variables (see §5.9)
  styleRefs: { fills?: string; strokes?: string; text?: string; effects?: string; grids?: string };   // the styles this layer uses, by style ID
  boundVariables: Record<string, string>;   // a property ("width", "fills.0") to the ID of the variable it is bound to
  variableModes: Record<string, string>;    // the mode chosen on this layer, for it and what is in it, by collection ID

  // Version 22: prototyping (see §5.11)
  reactions: Reaction[];                     // the interactions on this layer
  scrollBehavior: 'SCROLLS' | 'FIXED' | 'STICKY';   // what it does when the frame it is in scrolls

  // Version 23: export and handoff (see §5.12)
  exportSettings: ExportSetting[];           // the ways this layer is exported
  devStatus: 'NONE' | 'READY' | 'COMPLETED'; // where it stands in being handed to developers
  annotations: { id: string; text: string }[];              // notes on it for developers
  devResources: { id: string; name: string; url: string }[];   // links that go with it
  codeConnect: { component: string; source: string; snippet: string } | null;   // how it is known in code (components and sets)

  // Version 24
  strokeSides: { top: number; right: number; bottom: number; left: number } | null;   // frames and rectangles: a weight for each side, in place of strokeWeight; null for one weight all round
}
```

**Strokes with a weight for each side (version 24).** A frame or rectangle with `strokeSides` has its stroke drawn as four bands along its edges, each as thick as its side says (a side of 0 is not drawn), with the stroke's paints. Inside strokes stay within the box, and within its rounded corners; centred ones straddle the edge; outside ones lie beyond it. In SVG and PDF the bands are filled shapes. `strokeWeight` is kept, and is what the stroke goes back to when `strokeSides` is set to null. Other layer types ignore `strokeSides`. An instance may have its own (it is one of the properties an instance can override).

**Masks.** A layer with `isMask` is not painted. The layers above it in the same parent, up to the next mask (or the end of the parent), are shown only where the mask would have painted, and only as strongly: a half-transparent mask lets half through, and a mask with a gradient that fades out fades them out. A hidden mask masks nothing. A mask reaches no further than its parent, which is why "Use as mask" on several layers groups them first. On the canvas a masked layer can be clicked only where its mask lets it show, and a mask cannot be clicked at all (it is selected in the layers panel).

### 5.3 Concrete layers

```ts
interface FrameNode extends LayerBase {
  type: 'FRAME';
  clipsContent: boolean;     // children are clipped to the frame's box
  // Version 22: in a prototype (§5.11)
  overflow: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH';   // which way its content scrolls
  overlayPosition: 'CENTER' | 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_CENTER' | 'BOTTOM_RIGHT';   // where it sits when opened as an overlay
  overlayCloseOutside: boolean;              // whether a click outside it closes it
  overlayBackground: { color: RGB; opacity: number } | null;   // what covers the screen behind it
  cornerRadius: number;      // ≥ 0
  cornerRadii: [number, number, number, number] | null;   // version 4; see RectangleNode
  layoutGrids: LayoutGrid[]; // version 6
  guides: Guide[];           // version 14: guides of this frame, in its own space

  // Version 18: components (see §5.8)
  kind: 'FRAME' | 'COMPONENT' | 'COMPONENT_SET' | 'INSTANCE';   // an ordinary frame, a component, a set of variants (version 19), or an instance
  description: string;                         // a component's description
  componentId: NodeId | null;                  // an instance's component; null for anything else
  overrides: Record<NodeId, Record<string, unknown>>;   // an instance's overrides; {} for anything else
  // Version 19
  componentProps: { id: string; name: string; type: 'BOOLEAN' | 'TEXT' | 'INSTANCE_SWAP' }[];   // of a component, or of a set for all its variants
  variantProps: Record<string, string>;        // of a component in a set: its value for each of the set's variant properties
  propValues: Record<string, boolean | string>;   // an instance's values for its component's properties, by property ID

  // Version 15: Auto Layout (see §5.7)
  layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL';     // NONE: children stay where they are put
  layoutWrap: 'NO_WRAP' | 'WRAP';                      // the layout carries on in new lines: rows under a row, columns beside a column (columns from version 17)
  primaryAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';   // along the direction
  counterAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'BASELINE';   // across it; STRETCH from version 16, BASELINE from 24
  counterAxisAlignContent: 'AUTO' | 'SPACE_BETWEEN';   // the lines of a layout that wraps
  itemSpacing: number;       // between neighbouring children; may be negative
  counterAxisSpacing: number;// between the lines of a layout that wraps
  paddingLeft: number;       // ≥ 0, like the other three
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  itemsReversed: boolean;    // lay out from the top of the stack down instead of from the bottom up
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
  flipX: boolean;            // version 14: the glyphs are drawn mirrored left to right inside the box
  flipY: boolean;            // version 14: ... top to bottom
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
  flipX: boolean;            // version 14: the picture is drawn mirrored left to right inside the box
  flipY: boolean;            // version 14: ... top to bottom
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

### 5.7 Auto Layout (version 15)

A frame whose `layoutMode` is `HORIZONTAL` or `VERTICAL` places its children itself, in a row or in a column. Like constraints and group boxes, the result is **stored**: the `x`, `y`, `width` and `height` of the layers are what the layout gave them, so a file can be drawn, hit-tested and exported without doing any layout. The editor works the layout out again after every change (`applyAutoLayout`, run by `restoreLayout` together with the fitting of text, vectors and groups, repeated until nothing changes), in the same undo step as the change.

**The flow.** The children a frame places are those that are visible and have `layoutPositioning: 'AUTO'`, taken in stack order from the bottom up (from the top down when `itemsReversed`). The place of a layer in the layout is therefore its place in the stack; there is no separate order. A hidden child, and one with `ABSOLUTE`, is left where it is and takes up no room; an `ABSOLUTE` child follows its constraints (§5.6) when the frame changes size, and the children in the flow never do.

**Placing.** Inside the padding, the children follow one another along the direction with `itemSpacing` between them. `primaryAxisAlignItems` packs them at the start, in the middle or at the end, or with `SPACE_BETWEEN` puts the first at the start and the last at the end with equal gaps between (this is automatic spacing: it is not a property of its own but this alignment seen from the gap, which is how the editor shows it, as "Auto" in the gap field. While it is on, `itemSpacing` is not used and keeps the fixed gap the frame goes back to. It needs two children and room to spare, and otherwise they follow one another from the start). Across the direction each child sits at the start, middle or end of the room, by `counterAxisAlignItems`. With `STRETCH` (version 16) every child in the flow that can be given a size across the layout is as big there as the room between the padding (in a layout that wraps, as its line), within its own limits, whatever its own sizing across says; that sizing is kept, unused, and is the child's again when the alignment changes. A rotated child, a line's height and a text that fits itself to its content that way are not stretched, and sit at the start. A rotated child takes the room of the box round it and turns about the middle of that room. With `BASELINE` (version 24) the children of a row are moved down until the baselines of their first lines of text are level: a text's first line, a frame's or group's first text (where it sits in it), and for anything without text its bottom edge, as in Figma; a row that hugs is as tall as from the highest baseline's top to the lowest bottom. A column has no baseline to line up, and treats `BASELINE` as `MIN`.

**Sizing.** Each layer has a sizing for each axis:

- `FIXED`: the size it was given.
- `HUG`: as big as what is in it. For a frame with a layout that is its flow, the spacing and its padding (a frame with nothing in its flow keeps the size it has). A frame cannot hug where its own size is what decides something about its children; it is `FIXED` there. That is: across its layout while its alignment there is `STRETCH` (its children would be as big as the frame and the frame as big as they are), along its layout while its spacing is automatic (`primaryAxisAlignItems: 'SPACE_BETWEEN'`: the gaps are what the frame's size leaves over), and across it while the lines of a wrapping layout are spread out (`counterAxisAlignContent: 'SPACE_BETWEEN'`). For text it says the same as `textAutoResize`, which decides: `WIDTH_AND_HEIGHT` hugs both ways, `HEIGHT` hugs the height, `NONE` neither.
- `FILL`: the room the frame it is in has left. Along the direction, what remains after the other children, the spacing and the padding is shared equally between the children that fill, and one that fills is never less than a pixel. Across the direction a child that fills takes the whole room between the padding (in a layout that wraps, the size of its line).

A sizing that cannot apply where a layer is, is stored as `FIXED`, which is how the layer then behaves (`settleSizing`, part of the layout pass): `HUG` on anything but a frame with a layout or a text; `FILL` on a layer that no layout places, that is rotated, that has nothing to stretch along that axis (a line's height), or whose frame hugs that axis (a frame cannot be as big as its children and be filled by them); and `ABSOLUTE` outside a frame with a layout becomes `AUTO`. The operation that sets a sizing does what goes with it: it sets a text's `textAutoResize`, and makes a frame that hugged keep its size when a child is told to fill it.

**Limits.** `minWidth`, `maxWidth`, `minHeight` and `maxHeight` bound the size the layout gives a frame with a layout and the layers in a flow, whatever their sizing; where a minimum and a maximum disagree the minimum wins. When a child that fills reaches a limit, the others that fill share the difference. They are not applied to rotated layers, nor anywhere outside a layout.

**Wrapping.** With `layoutWrap: 'WRAP'` a layout carries on in further lines when it runs out of room: a row in rows one under another, a column (from version 17) in columns side by side. The children are taken in order and a child starts a new line when it no longer fits between the padding (a child that fills along the layout counts for its minimum, then takes what is left of its own line). Each line is as big across the layout as its biggest child (a row as tall as its tallest, a column as wide as its widest), with `counterAxisSpacing` between lines. The lines are packed where `counterAxisAlignItems` puts a single line, or with `counterAxisAlignContent: 'SPACE_BETWEEN'` spread from one side to the other (automatic spacing between the lines: `counterAxisSpacing` is then not used, and `AUTO` here is the name of the packed setting, with its fixed gap); if the frame has room to spare across the layout and a child fills its line there, the spare room is shared equally between the lines. A frame that hugs along its layout has all its children in one line, unless a maximum size stops it, in which case it wraps at that.

A wrapping column needs its height before its width, since its height says where a new column starts, and that is the other way round from everything else in a layout. Where its height is fixed, or hugs, it is known beforehand. Where the frame it is in gives it (the column fills, or is stretched), the layout takes the height it has, makes the columns, and runs again with the height it then turns out to have, four runs at most. A child that fills across a wrapping column, and whose height depends on its width (text that wraps), is put into columns by the height it has at the frame's whole inner width, as CSS does; it is then as wide as its column, and its height is what that width gives.

**Nesting.** A frame with a layout that is in the flow of another is laid out with it: the outer frame gives it its size where it fills, and takes its size where it hugs or is fixed. Widths are settled first, from the outside in, and heights after, because how tall a wrapped text or a wrapping row is depends on its width (a wrapping column is the exception described above). A frame with a layout that is not in a flow (on a page, in an ordinary frame or a group, rotated, hidden or `ABSOLUTE`) is laid out on its own, innermost first, and whatever contains it then sees it at its new size.

### 5.8 Components and instances (version 18)

A component and an instance are frames (`type: 'FRAME'`) whose `kind` says so, which is why everything that works on a frame (painting, clipping, constraints, Auto Layout) works on them unchanged. A **component** (`kind: 'COMPONENT'`) is the original: what is in it is made and arranged by the designer like the contents of any frame. An **instance** (`kind: 'INSTANCE'`) shows the component named by its `componentId` somewhere else.

**What is in an instance is stored**, like the result of a layout: for every layer of the component the instance holds a layer that mirrors it, with the same properties, in the same place in the tree, and with `sourceId` naming the layer it mirrors. The ID of a mirror is worked out from the ID of the instance and the ID of the layer it mirrors (`mirrorId`), so it is the same however often the instance is rebuilt. The editor brings every instance into step with its component after every change (`syncInstances`, the first thing `restoreLayout` does), in the same undo step:

- A layer added to the component appears in every instance, a removed one goes, and their order is the component's. A mirror that is deleted or moved out of its instance is put back.
- Every property of a mirror is the component's, except `id`, `parentId`, `order` and `sourceId`, and except its **overrides** (below). Its place and size (`x`, `y`, `width`, `height`, `rotation`) are taken from the component only when the component's change: in between they belong to the instance's own layout, so that an instance that is resized, or whose text is longer, is laid out for itself by constraints and Auto Layout.
- The instance itself takes its look (fills, strokes, effects, corner radii, clipping) and its Auto Layout settings from the component. Its position, rotation, constraints and sizing are its own. Its size is the component's until it is given another, and follows the component's while it is.
- An instance whose component no longer exists becomes an ordinary frame, and its mirrors ordinary layers.

**Overrides.** `overrides` holds what differs in this instance: for a layer of the component, by its ID, the properties that have another value here (the component's own ID stands for the instance's own look). The properties that can be overridden are what a layer shows, not where it is: visibility, opacity, fills, strokes and their settings, effects, blend mode, corner radii, clipping, and for text its characters and all its type settings. When a designer changes such a property on a mirror, the editor records it as an override in the same step; a change to the component then reaches the instance for every property that has no override, and takes none away. "Reset" empties `overrides`.

**Components inside components.** A component may hold instances of other components, never of itself, however indirectly. In an instance of the outer component, the inner instance is mirrored as an instance (its `kind`, `componentId` and `overrides` are mirrored like any property) and then given its own mirrors of the inner component. What is changed inside it is recorded on the outer instance, as an override of the inner one's `overrides` holding only what goes beyond the inner one's own; showing another component in it is an override of its `componentId`. So a change at any level reaches every instance, and each level keeps what was changed at it.

**Component sets and variants (version 19).** A component set (`kind: 'COMPONENT_SET'`) is a frame whose direct children are components: its variants. Each variant says which one it is in `variantProps`, a value for each variant property of the set ("Type": "Primary", "State": "Hover"); the properties a set has, and the values each can take, are read off its variants and stored nowhere else. A variant's name is made from its values. An instance of a variant shows another variant by getting that one's `componentId`, which is a swap like any other (below): the variant chosen is the one with the new value that agrees with the old variant's other values in the most places.

**Component properties (version 19).** `componentProps` on a component, or on a set for all its variants, defines properties an instance can set without reaching into its layers: `BOOLEAN`, `TEXT` or `INSTANCE_SWAP`. A layer of the component is bound to a property in its `propRefs`: a boolean property decides its `visible`, a text property a text's `characters`, an instance-swap property the `componentId` of an instance inside the component. A property has no default of its own: until an instance sets it, a bound layer is as the component has it. An instance's values are in `propValues`, by property ID; where it has one, the mirrors of the bound layers get it, over any override. A designer's change to a bound property of a mirror is recorded as the instance's value for the property, not as an override. For an instance inside an instance, `propValues` is overridden from the outer one like `overrides`, as a whole. Removing a property removes every binding to it and every value for it. "Reset" empties `propValues` as well as `overrides`.

**Swapping.** Giving an instance another `componentId` keeps each override whose layer has a counterpart of the same type and name at the same place in the new component, and drops the rest.

---

### 5.9 Styles and variables (version 20)

```ts
interface Style {
  id: string;
  name: string;
  description: string;
  type: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
  paints: Paint[];            // PAINT: used for fills or for strokes
  text: { fontFamily; fontSize; fontWeight; italic; lineHeight; letterSpacing; textDecoration; textCase };   // TEXT
  effects: Effect[];          // EFFECT
  grids: LayoutGrid[];        // GRID
}

interface VariableCollection {
  id: string;
  name: string;
  modes: { id: string; name: string }[];   // at least one; the first applies where none is chosen
}

interface Variable {
  id: string;
  name: string;
  description: string;
  collectionId: string;
  type: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';
  scopes: string[];           // the kinds of property it is offered for (FILL, STROKE, SIZE, GAP, RADIUS, OPACITY, TEXT, VISIBILITY); [] for all
  valuesByMode: Record<string, RGB | number | string | boolean | { alias: string }>;   // one for each mode of its collection
}
```

**Stored results, as everywhere else.** A layer that uses a style or is bound to a variable still has the resulting value in its ordinary properties (`fills`, `width`, `fontSize`…), so painting, export, layout and every reader of the file need to know nothing about tokens. `applyTokens` (`src/core/tokens/tokens.ts`), which the editor runs as part of `restoreLayout` after every change, writes the value of each style and variable into the layers that use it; that is why changing a token changes everything bound to it in the same undo step.

**Styles.** `styleRefs` names the style a layer takes its fills, its strokes, its type settings (text layers), its effects or its layout grids (frames) from. Only the part of a `Style` that goes with its type is used. Changing a styled property of a layer by hand removes the reference (the layer is detached from the style and keeps its new value). Removing a style leaves every layer with the look it gave.

**Variables.** A key of `boundVariables` is a property name, or `fills.N` / `strokes.N` for the colour of the Nth paint when it is solid. Colour variables bind to those; number variables to `width`, `height`, `opacity` (in percent), `strokeWeight`, `cornerRadius`, `itemSpacing`, the four paddings, `fontSize`, `lineHeight` and `letterSpacing`; string variables to `characters` and `fontFamily`; boolean variables to `visible`. A bound width or height applies while the layer's sizing on that axis is `FIXED` (binding sets it). Where a style and a variable both decide a property, the style does. Changing a bound property by hand removes the binding.

**Modes.** The mode of a collection that applies to a layer is the one named in `variableModes` on the layer or on its nearest ancestor that names one (up to its page), or else the collection's first mode. A variable's value for a layer is its value in that mode.

**Aliases (semantic tokens).** A value `{ alias: id }` makes a variable stand for another of the same type, in that mode; the other is resolved for the same layer, with the mode of its own collection, and may itself be an alias. A variable never stands for itself, however indirectly (the operation refuses it). An alias to a variable that is gone has no value: what is bound keeps what it last had.

**In instances.** `styleRefs`, `boundVariables` and `variableModes` are overridable like any other look of a layer in an instance. What a style or variable writes into a layer of an instance is not an override: it is resolved where the instance is, so an instance under a dark mode is dark while its component is light. The instance itself takes the component's style references and bindings for its look (fills, strokes, effects, radius, spacing, padding) and keeps its own for everything else. Where an instance overrides a property, the component's style or variable for that property does not apply to it.

### 5.10 Libraries (version 21)

```ts
interface Publication {
  version: number;                    // counts up with every publishing
  publishedAt: string;                // ISO time
  roots: NodeId[];                    // the components and component sets published
  nodes: Record<NodeId, LayerNode>;   // those and every layer in them, without the layers instances hold as mirrors; a root's parentId is ''
  styles: Record<string, Style>;
  variables: Record<string, Variable>;
  variableCollections: Record<string, VariableCollection>;
  assets: Record<Hash, AssetInfo>;
}
```

Since version 21 a `Style`, a `Variable` and a `VariableCollection` each have `remote: string | null`: the ID of the library document they were imported from, or null for the document's own.

**Publishing.** `Document.publication` is a snapshot of what the document offers other documents: its own components and sets, the components those use (wherever they came from, so that what is published is complete), and all its styles and variables. It is taken when the designer publishes and does not change until they publish again, so other documents never see half-finished work. Unpublishing sets it to null.

**Using a library.** A document that adds a library holds a copy of what was published, so that the file stays complete on its own: the components on a page with `library` set, and the styles and variables in its tables with `remote` set. A library page is not one of the document's pages: `getPages` leaves it out, it is never shown, listed or exported, and a document needs at least one ordinary page beside it. Everything imported gets the ID `mirrorId(libraryDocumentId, idInLibrary)`, the same every time, and every reference inside the imported content is rewritten to match; so instances, style references and bindings in the document keep pointing at the same thing when a newer version is imported, and a copy of the library file (which has the same layer IDs) can still add the original. Imported content is read-only: the operations that change styles and variables refuse entries with `remote`, and nothing on a library page can be selected.

**Updating and removing.** Importing a newer `Publication` replaces the copy. Instances follow as they follow a local component, keeping their overrides; what the library no longer has goes: instances of a removed component become ordinary frames with the layers they had, and layers keep the look a removed style or variable gave them. Removing a library does the same for everything from it.

**Where libraries come from.** The document says only which library it has and at which version. Finding libraries and their newer versions is the storage layer's job (`src/persistence/libraries.ts`): today the published files in the same local storage; a server can provide the same later.

### 5.11 Prototyping (version 22)

```ts
interface Reaction {
  id: string;
  trigger: { type: 'ON_CLICK' | 'ON_DRAG' | 'MOUSE_ENTER' | 'ON_PRESS' | 'AFTER_DELAY' | 'ON_KEY'; delay: number /* ms */; key: string };
  actions: Action[];           // run in order
}

interface Action {             // every action has every field; its type says which count
  type: 'NAVIGATE' | 'OPEN_OVERLAY' | 'SWAP_OVERLAY' | 'CLOSE_OVERLAY' | 'SCROLL_TO' | 'BACK' | 'CHANGE_TO' | 'SET_VARIABLE' | 'CONDITIONAL' | 'INPUT'
      | 'OPEN_LINK';             // version 24
  destinationId: NodeId | null;   // a frame to go to or open, a layer to scroll to, a variant to change to
  transition: Transition;
  variableId: string | null;      // SET_VARIABLE: the variable set; INPUT: the string variable that typing goes into
  expression: string;             // SET_VARIABLE: its new value; CONDITIONAL: the condition; OPEN_LINK: the web address
  then: Action[];                 // CONDITIONAL: when the condition holds
  otherwise: Action[];            // CONDITIONAL: when it does not
}

interface Transition {
  type: 'INSTANT' | 'DISSOLVE' | 'SMART_ANIMATE' | 'MOVE_IN' | 'MOVE_OUT' | 'PUSH' | 'SLIDE_IN' | 'SLIDE_OUT';
  direction: 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM';   // the way things move
  duration: number;               // ms
  delay: number;                  // ms
  easing: 'LINEAR' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT' | 'CUSTOM';
  bezier: [number, number, number, number];   // CUSTOM: a cubic Bézier timing curve, as in CSS
}
```

**What is stored and what is not.** The document holds the design of the prototype: interactions on layers, flows and the device on pages, how frames scroll and open as overlays. Nothing about a prototype being played is stored: the player (`src/core/prototype/player.ts`) works on a copy of the document, in which "Set variable" and "Change to" make their changes, and that copy is dropped when the prototype is closed or started again.

**Triggers.** `MOUSE_ENTER` ("while hovering") and `ON_PRESS` ("while pressing") last only while the pointer is over the layer or held down on it: what they did is undone after, unless something else happened in between, which is then kept. `ON_KEY` names a key as the keyboard does (`Enter`, `ArrowRight`, `a`), compared without regard to case; a gamepad button is the key `Gamepad0`, `Gamepad1`… An event on a layer with no interaction for it goes to the layers it is in, innermost first.

**Actions.** `NAVIGATE` shows a frame as the screen and closes any overlays. `OPEN_OVERLAY` shows a frame over the screen, placed by that frame's `overlayPosition`, with its `overlayBackground` behind it; `SWAP_OVERLAY` replaces the top overlay; `CLOSE_OVERLAY` closes it. `BACK` closes the top overlay or, without one, returns to the screen before, with the transition that led here run the other way. `SCROLL_TO` scrolls the nearest scrolling frame round a layer until the layer is at its top-left. `CHANGE_TO` makes the nearest instance round the layer (or the layer itself) that shows a variant of the destination's set show the destination instead: this is how interactive components work, and the interactions on a component apply to every instance of it. `SET_VARIABLE` gives a variable the value of an expression, in every mode. `CONDITIONAL` runs `then` or `otherwise`. `INPUT` makes what is typed go into a string variable until Enter. `OPEN_LINK` (version 24) hands its address to whatever shows the prototype; the viewer opens only `http:`, `https:` and `mailto:` addresses, in a new tab with no access back to the application, and the prototype stays where it is.

**Expressions** (`src/core/prototype/expression.ts`): numbers, strings in quotes, `true` / `false`, colours as `#RRGGBB`, variables by name in braces (`{count}`, or `{Collection/name}`), `+ - * / %`, comparisons, `and` / `or` / `not` (also `&& || !`), parentheses. `+` joins when either side is a string. An expression that cannot be worked out changes nothing.

**Scrolling.** A frame with `overflow` scrolls its content that way as far as the content reaches. A frame shown as the screen on a device smaller than it scrolls under the device whatever its `overflow`. A child with `scrollBehavior: 'FIXED'` stays where it is on the screen; one with `'STICKY'` goes with the content until it reaches the top and stops there.

**Smart Animate** matches layers of the two screens (or of the two states of a component) by name and type at the same place in the tree, and moves, sizes, turns and colours each between the two; a layer on one side only fades.

**Dangling references.** A destination or variable that no longer exists is kept as it is; the action then does nothing when played, and the editor shows it as missing. A flow whose frame is gone is not listed.

### 5.12 Export settings and handoff (version 23)

```ts
interface ExportSetting {       // every setting has every field; the format says which count
  format: 'PNG' | 'JPG' | 'SVG' | 'PDF';
  constraint: { type: 'SCALE' | 'WIDTH' | 'HEIGHT'; value: number };   // a scale (0.01 to 64), or a side in pixels the other follows
  suffix: string;               // added to the layer's name to make the file's name
  background: boolean;          // on the page's colour; otherwise transparent (a JPG is on white)
  quality: number;              // JPG: 0.1 to 1
  svgIds: boolean;              // SVG: an id on each layer's element, from its name
  pdfContent: 'VECTOR' | 'PICTURE';   // PDF: shapes as vectors, or one picture
  pdfText: 'TEXT' | 'PICTURE';        // vector PDF: text in a standard font, or pictures of the text
}
```

**What is exported.** A layer is exported as everything it paints (its box, and what reaches out of it: strokes, shadows, and for a frame that does not clip, what is in it), where it is on the page, without what it is in. A page is exported as everything on it; as a PDF it is one page for each frame laid out on it when it has any. The file name is the layer's name, the suffix, and the format's extension, with characters no file system takes replaced; names that would be the same get a number.

**Not stored.** The files are not kept: an export is made from the document as it is when it is asked for, by `src/engine/export` (PNG and JPG with the editor's own renderer; SVG and PDF from one vector scene built by the renderer's rules, so the two agree with each other and with the canvas).

**Handoff.** `devStatus`, `annotations`, `devResources` and `codeConnect` belong to the layer they are put on. They are not taken into the instances of a component (a note on a component is not a note on each of its instances). A link's address is `http`, `https` or `mailto` and nothing else. `codeConnect` is for a component or a component set; its `snippet` may name variant and component properties in braces (`{Type}`), which stand for the value an instance has. What the Inspect panel says about a layer, and the CSS, SwiftUI and Compose code it shows, are not stored: they are written from the layer when it is looked at (`src/core/dev`).

## 6. Coordinate system and transforms

- The page is an unbounded plane. X grows to the right, Y grows downwards. Units are CSS pixels at 100% zoom.
- A layer's `x, y, width, height` describe its **unrotated** box in its parent's coordinate space. For a child of a page that is page space; for a child of a frame the origin is the frame's own top-left corner.
- `rotation` turns the box about its **centre**. Rotating a layer in place therefore changes only `rotation`.
- Local matrix: `M = T(x + w/2, y + h/2) · R(rotation) · T(−w/2, −h/2)`.
- World matrix: `W = W(parent) · M`; a page's world matrix is the identity.
- A child's coordinates are in its parent's local, unrotated space, so children rotate with their parent.

This is the convention CSS uses (`left/top/width/height` plus `transform: rotate()` about the centre), which keeps Developer Mode output direct (ADR-005).

Skew is not representable. There is no flip flag either: the basic shapes are symmetric about their own vertical axis, so "Flip horizontal / vertical" is implemented as an exact geometric operation (mirror the position, negate the rotation, add a half turn for a vertical flip of polygons and stars, and recurse into containers), and a vector's curves are mirrored themselves. What else of a layer's look is not the same on both sides is mirrored with it: the handles of gradient paints, per-corner radii, the slice of an ellipse (`arcStart`), the arrowheads of a line (which change ends on a horizontal flip) and the offsets of shadows. The glyphs of text and the picture of an image fill cannot be mirrored by moving anything, so they carry flags (`flipX`, `flipY`, version 14) that a flip toggles: the renderer turns the layer's box over about its own middle before drawing the text, or the picture, into it. Mirrored text is turned over as a whole, so its paints are left alone by a flip. A flip also moves a frame's guides to the other side. The same mirroring, about the layer's own axis and without moving its box, is applied when a resize is dragged past the edge that stays fixed (`mirrorInPlace`).

**Guides of a frame (version 14).** A frame's `guides` are positions in the frame's own space: they move with the frame, are drawn across the frame only, and are snapped to by the layers in it. A guide dragged out of a ruler belongs to the frame it is let go over when that frame is not turned (nor inside anything turned), and otherwise to the page. A guide outside its frame's box, and the guides of a turned or hidden frame, are kept but not shown.

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

| 12 | A text layer's layout sizing is `HUG` exactly where its `textAutoResize` fits it to its content. Padding is ≥ 0; a size limit is ≥ 0 or null. | Set the sizing from `textAutoResize`; clamp. |
| 14 | Only an instance has a `componentId`, `overrides` and `propValues`. Property definitions have an ID, a known type and a name; `propRefs` and `variantProps` hold strings. | Set to null and {}; drop what is malformed. |
| 14a | A style has a known type; a collection has at least one mode; a variable is in a collection that exists and has a value of its own type (or an alias) for each of that collection's modes and no others. | Drop the entry; give a missing or wrong value the type's blank value. A reference from a layer to a style or variable that is gone is dropped by `applyTokens` at the next change. |
| 14b | The document has at least one page that does not hold a library. A page's `library` has the library's ID. `publication` is null or has a numeric version. | Add an empty page; set `library` or `publication` to null. What a publication holds is checked like a document when it is imported, not when the publishing file is opened. |
| 14c | An interaction has an ID (unique on its layer) and a known trigger; an action a known type; a transition a known kind, direction and easing, times that are not negative and four numbers for a curve; conditions nest at most four deep. A flow has an ID and a starting frame. | Drop the interaction, action or flow; reset the value. |
| 14d | An export setting has a known format, a scale from 0.01 to 64 or a side from 1 to 32768 pixels, and a quality from 0.1 to 1. A note and a link have an ID, unique on their layer. | Drop the setting, note or link; clamp the number. |
| 15 | Every instance is in step with its component (§5.8): it holds exactly one mirror of each of the component's layers, with the component's properties and its own overrides, and no layer has a `sourceId` outside an instance. | Not by `repairDocument`: the editor restores it with `restoreLayout` after the first change, as it does after every change. |
| 13 | Layout sizing and positioning are ones that can apply where the layer is (§5.7), and every frame with a layout is laid out: the boxes of the layers in its flow, and its own where it hugs, are what the layout gives. | Not by `repairDocument`, which cannot measure text: the editor restores it with `restoreLayout` after the first change, as it does after every change. |

Repair never silently discards user content except under rule 7, and every repair is surfaced to the user when a file is opened.

---

## 8. Migrations

```ts
const CURRENT_SCHEMA_VERSION = 24;
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
  // 13 -> 14: every text layer and every image paint gets flipX false and flipY false
  // (in a paint, after saturation); every frame gets guides [].
  13: addFlipsAndFrameGuides,
  // 14 -> 15: every layer gets layoutSizingHorizontal and layoutSizingVertical 'FIXED' (text: 'HUG' where its
  // textAutoResize fits it to its content), layoutPositioning 'AUTO' and the four size limits null; every frame
  // gets layoutMode 'NONE', layoutWrap 'NO_WRAP', alignments 'MIN' / 'MIN' / 'AUTO', spacings and padding 0
  // and itemsReversed false.
  14: addAutoLayout,
  // 15 -> 16: adds STRETCH to counterAxisAlignItems. No older frame has it, so only the version number changes.
  15: (file) => ({ ...file, schemaVersion: 16 }),
  // 16 -> 17: a frame with layoutMode 'VERTICAL' may have layoutWrap 'WRAP'. Older files have it on rows only
  // (it was removed from columns when a file was opened), so only the version number changes.
  16: (file) => ({ ...file, schemaVersion: 17 }),
  // 17 -> 18: every layer gets sourceId null; every frame gets kind 'FRAME', description '', componentId null
  // and overrides {}.
  17: addComponents,
  // 18 -> 19: every layer gets propRefs {}; every frame gets componentProps [], variantProps {} and propValues {}.
  18: addComponentProperties,
  // 19 -> 20: the document gets styles {}, variables {} and variableCollections {}; every layer styleRefs {},
  // boundVariables {} and variableModes {}; every page variableModes {}.
  19: addStylesAndVariables,
  // 20 -> 21: the document gets publication null; every page library null; every style, variable and collection remote null.
  20: addLibraries,
  // 21 -> 22: every layer gets reactions [] and scrollBehavior 'SCROLLS'; every frame overflow 'NONE', overlayPosition
  // 'CENTER', overlayCloseOutside true and overlayBackground null; every page flows [] and prototypeDevice 'NONE'.
  21: addPrototyping,
  // 22 -> 23: every layer gets exportSettings [], devStatus 'NONE', annotations [], devResources [] and codeConnect null;
  // every page exportSettings [].
  22: addExportAndHandoff,
  // 23 -> 24: every layer gets strokeSides null. OPEN_LINK actions and BASELINE alignment are new; no older file has either.
  23: addStrokeSides,
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
| 13 | 14 | `flipX` / `flipY` on text layers and image paints; `guides` on frames | `src/mirror.test.ts` ("opens a version 13 file") |
| 14 | 15 | Auto Layout: layout sizing, positioning and size limits on every layer; direction, wrap, alignment, spacing, padding and order on frames | `src/autolayout.test.ts` ("opens a version 14 file") |
| 15 | 16 | `STRETCH` among the alignments across a layout | `src/autolayout.test.ts` ("opens a version 15 file, where no frame stretches") |
| 16 | 17 | `layoutWrap: 'WRAP'` on columns as well as rows | `src/autolayout.test.ts` ("opens a version 16 file, where only rows wrap") |
| 17 | 18 | Components and instances: `sourceId` on every layer; `kind`, `description`, `componentId` and `overrides` on frames | `src/components.test.ts` ("opens a version 17 file, where nothing is a component") |
| 18 | 19 | Component sets (`kind: 'COMPONENT_SET'`), `variantProps`, `componentProps`, `propValues` on frames; `propRefs` on every layer | `src/variants.test.ts` ("opens a version 18 file") |
| 19 | 20 | Document tables `styles`, `variables`, `variableCollections`; `styleRefs`, `boundVariables` and `variableModes` on every layer; `variableModes` on pages | `src/tokens.test.ts` ("opens a version 19 file, which has none") |
| 20 | 21 | `publication` on the document; `library` on pages; `remote` on styles, variables and collections | `src/libraries.test.ts` ("opens a version 20 file, where nothing is published or from a library") |
| 21 | 22 | `reactions` and `scrollBehavior` on every layer; `overflow` and the three overlay settings on frames; `flows` and `prototypeDevice` on pages | `src/prototype.test.ts` ("opens a version 21 file, which has no prototype") |
| 22 | 23 | `exportSettings`, `devStatus`, `annotations`, `devResources` and `codeConnect` on every layer; `exportSettings` on pages | `src/export.test.ts` ("opens a version 22 file, which has no export settings") |
| 23 | 24 | `strokeSides` on every layer; the `OPEN_LINK` action; `BASELINE` among the alignments across a layout | `src/export.test.ts` ("opens a version 23 file, which has none") |

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
| 2 | (Done: mirrored text and image fills and guides on frames in version 14; per-range text styles, lists and justified text in version 13; `GROUP` in version 2, `TEXT` in version 3, gradients, stroke options, corner radii, effects and blend modes in version 4, image paints and assets in version 5, constraints and layout grids in version 6, ruler guides in version 7, masks in version 10, image adjustments in version 12.) |
| 3 | (Done: `VECTOR` in version 8, arcs and arrowheads in version 9, `BOOLEAN_OPERATION` in version 11.) |
| 4 | (Done in version 15: Auto Layout properties on frames and on every layer, §5.7; the stretch alignment in version 16; wrapping columns in version 17.) |
| 5 | (Done in version 18: components and instances with overrides, as kinds of frame, §5.8.) Done in version 19: component sets, variants and component properties. Done in version 20: document-level `styles`, `variableCollections`, `variables`, property bindings and modes (§5.9). Done in version 21: libraries (§5.10). |
| 6 | Done in version 22 (§5.11): `reactions[]` on layers, `flows[]` on pages, scroll behaviour, fixed and sticky children, overlays. |
| 7 | `exportSettings[]`, annotations, development status. |
| 8 | Comments are stored outside the document body, keyed by document and node ID. |
