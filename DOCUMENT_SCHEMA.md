# OPEN DESIGN — Document Schema

Current schema version: **3**. Version 1 was Phase 1; version 2 added the `GROUP` layer type and version 3 adds `TEXT` (both Phase 2). This file is the contract between the editor, the native file format, the storage layer and, later, the collaboration server. Any change to it requires a version bump and a migration (spec §32).

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

Binary assets (Phase 2) will not be inlined in `document`. They are stored content-addressed (SHA-256) beside it and bundled with the JSON into a zip container when a file is exported. That change will be schema version 2 and will keep reading version 1 files.

---

## 3. Document

```ts
interface Document {
  id: string;                          // stable document ID
  name: string;                        // file name shown in the UI
  nodes: Record<NodeId, DesignNode>;   // every page and every layer, flat
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
type NodeType = 'PAGE' | 'FRAME' | 'GROUP' | 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'POLYGON' | 'STAR' | 'TEXT';
```

`GROUP` exists from version 2 and `TEXT` from version 3; everything else from version 1.

### 5.1 Page

```ts
interface PageNode extends NodeBase {
  type: 'PAGE';
  parentId: null;
  backgroundColor: RGB;      // canvas colour behind the page content
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
}
```

### 5.3 Concrete layers

```ts
interface FrameNode extends LayerBase {
  type: 'FRAME';
  clipsContent: boolean;     // children are clipped to the frame's box
  cornerRadius: number;      // ≥ 0
}

interface GroupNode extends LayerBase {
  type: 'GROUP';             // version 2. No appearance of its own: fills and strokes are empty.
}

interface RectangleNode extends LayerBase {
  type: 'RECTANGLE';
  cornerRadius: number;      // ≥ 0, clamped at paint time to half the shorter side
}

interface EllipseNode extends LayerBase {
  type: 'ELLIPSE';
}

interface LineNode extends LayerBase {
  type: 'LINE';              // drawn from (0, height/2) to (width, height/2); height is 0
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
  textAlign: 'LEFT' | 'CENTER' | 'RIGHT';
  verticalAlign: 'TOP' | 'MIDDLE' | 'BOTTOM';
  textAutoResize: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
}
```

**Text.** One style applies to the whole layer; styling a range of characters differently is not part of version 3. `textAutoResize` says which dimensions follow the content: both (auto width, never wraps), the height only (wraps at the layer's width), or neither (fixed box). The editor refits those dimensions after every edit (`fitTextLayers`), keeping the edge the text is aligned to in place, so the stored `width` and `height` are always the laid-out size as measured on the machine that last edited the text. A machine without the font falls back to another and may lay the text out differently until it is next edited.

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

type Paint = SolidPaint;     // gradients and images are added in Phase 2
```

---

## 6. Coordinate system and transforms

- The page is an unbounded plane. X grows to the right, Y grows downwards. Units are CSS pixels at 100% zoom.
- A layer's `x, y, width, height` describe its **unrotated** box in its parent's coordinate space. For a child of a page that is page space; for a child of a frame the origin is the frame's own top-left corner.
- `rotation` turns the box about its **centre**. Rotating a layer in place therefore changes only `rotation`.
- Local matrix: `M = T(x + w/2, y + h/2) · R(rotation) · T(−w/2, −h/2)`.
- World matrix: `W = W(parent) · M`; a page's world matrix is the identity.
- A child's coordinates are in its parent's local, unrotated space, so children rotate with their parent.

This is the convention CSS uses (`left/top/width/height` plus `transform: rotate()` about the centre), which keeps Developer Mode output direct (ADR-005).

Skew is not representable. There is no flip flag either: every shape that exists so far is symmetric about its own vertical axis, so "Flip horizontal / vertical" is implemented as an exact geometric operation (mirror the position, negate the rotation, add a half turn for a vertical flip of polygons and stars, and recurse into containers). A `flipX` / `flipY` property becomes necessary, and will be added, with the first asymmetric content (text, images, vector paths).

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

Repair never silently discards user content except under rule 7, and every repair is surfaced to the user when a file is opened.

---

## 8. Migrations

```ts
const CURRENT_SCHEMA_VERSION = 2;
const MIGRATIONS: Record<number, (file) => file> = {
  // 1 -> 2: adds the GROUP type. A version 1 file has no groups, so only the version number changes.
  1: (file) => ({ ...file, schemaVersion: 2 }),
  // 2 -> 3: adds the TEXT type. Older files have no text layers.
  2: (file) => ({ ...file, schemaVersion: 3 }),
};
```

| From | To | What changed | Fixture test |
|---|---|---|---|
| 1 | 2 | `GROUP` layer type added | `src/core/ops/arrange.test.ts` ("schema migration") |
| 2 | 3 | `TEXT` layer type added | `src/core/text/layout.test.ts` ("text in the file format") |

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
| 2 | Per-range text styles, `IMAGE` fills, gradient paints, multiple strokes with dash/cap/join, independent corner radii, `effects[]`, `blendMode`, `flipX/flipY`, `constraints`, `layoutGrids[]`, page `guides[]`, asset table. (`GROUP` is done in version 2 and `TEXT` in version 3.) |
| 3 | `VECTOR` (vector network: vertices, segments with Bézier handles, regions), `BOOLEAN_OPERATION`, arc data on ellipses. |
| 4 | Auto Layout properties on frames (`layoutMode`, padding, `itemSpacing`, alignment, wrap) and on children (`layoutSizingHorizontal/Vertical`, `layoutPositioning`, min/max sizes). |
| 5 | `COMPONENT`, `COMPONENT_SET`, `INSTANCE` with `overrides`; document-level `styles`, `variableCollections`, `variables`; property bindings. |
| 6 | `interactions[]` on nodes, `flows[]` on pages, scroll behaviour, fixed/sticky children. |
| 7 | `exportSettings[]`, annotations, development status. |
| 8 | Comments are stored outside the document body, keyed by document and node ID. |
