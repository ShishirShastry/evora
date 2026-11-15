# OPEN DESIGN — Project Architecture

Status: living document. Created in Phase 0 (2026-11-15). Update it whenever a module boundary or data flow changes.

> This document was written while planning, before any code existed, and describes the target architecture. Phase 1 was built to it, but later phases are plans, not facts. For what actually exists and is tested today, [HANDOFF.md](HANDOFF.md) is the authority. The planned ENGINEERING_DECISIONS, IMPLEMENTATION_ROADMAP, PRODUCT_REQUIREMENTS and FEATURE_TRACKER documents were not written, at the owner's request.

Companion documents: [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [DOCUMENT_SCHEMA.md](DOCUMENT_SCHEMA.md), [ENGINEERING_DECISIONS.md](ENGINEERING_DECISIONS.md), [FEATURE_TRACKER.md](FEATURE_TRACKER.md). The source specification is [OPEN_DESIGN_MASTER_SPEC.md](OPEN_DESIGN_MASTER_SPEC.md).

---

## 1. Phase 0 audit result

The specification (§31, §35) asks for an audit of the existing repository before any code is written. The audit was carried out on 2026-11-15 and found:

| Question | Finding |
|---|---|
| Existing repository | None. `F:\Open Design` did not exist and was created empty for this project. |
| Existing framework, components, backend, rendering libraries | None. Nothing to preserve, nothing to rewrite. |
| Reusable code | None. |
| Package dependencies | None installed. |
| Architecture limitations inherited | None from code. Two from the environment, below. |

Environment facts that shape the architecture:

1. **The project lives on an exFAT external hard disk** (`F:`, label "SHISHIR 3"). exFAT has no symbolic links, junctions or file ownership. Consequences: no npm/pnpm workspaces (they need links), so the repository is a single npm package; git needs a `safe.directory` entry; installs and cold starts are slower than on an SSD.
2. **The system drive has little free space** (about 9 GB). Consequences: do not download bundled browsers for Playwright (use the installed Microsoft Edge), and keep caches inside the project folder where practical.
3. **Node.js was not installed** when the project started. The toolchain location is recorded in ENGINEERING_DECISIONS.md (ADR-013).

Because there is no prior implementation, "map the current architecture against the specification" reduces to the target architecture described here, and the first safe milestone is Phase 1, milestone M1.1 (see the roadmap).

---

## 2. Architectural principles

1. **The document model is the single source of truth.** Every panel, tool, menu item and exporter reads and writes the same document through the same command path. There is no parallel UI copy of design data.
2. **The core is framework-agnostic.** Everything under `src/core` is pure TypeScript with no React and no DOM. It runs unchanged in the browser, in Node (tests, server, export workers) and in a Web Worker.
3. **Four kinds of state are kept apart** (spec §32):
   - *Document state*: the design itself. Persisted, undoable, synchronised.
   - *Editor state*: current page, selection, active tool, viewport, panel layout. Per user, not part of the document, not synchronised (except as presence).
   - *Transient interaction state*: a drag in progress, a marquee rectangle, a shape being drawn. Lives inside the active tool; never persisted.
   - *Collaborative state*: presence, remote cursors and selections, connection status. Lives in the collaboration engine.
4. **All document changes are pure functions** `(document, arguments) → document`. They are composed by the store, which records history, schedules autosave and (later) emits CRDT updates. Nothing else may mutate the document.
5. **Rendering is custom and canvas-based.** Design objects are never DOM elements. The DOM is used only for application chrome (panels, menus, inputs).
6. **Features are complete or absent.** A control is added to the interface only when the engine behind it works, is undoable, persists and is tested (spec §32 rules 1–3, 11).

---

## 3. System overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Application shell (React)                                                │
│   Home / file browser · Top toolbar · Menus · Left sidebar · Right       │
│   sidebar · Canvas host · Dialogs · Command search                       │
└───────────────┬──────────────────────────────────────────┬───────────────┘
                │ reads selectors / calls actions          │ pointer + key events
                ▼                                          ▼
┌───────────────────────────────┐          ┌───────────────────────────────┐
│ Editor store (Zustand)        │◄─────────│ Input and interaction engine  │
│  document · selection · tool  │ commands │  tools (state machines),      │
│  viewport · history · status  │          │  shortcuts, gestures          │
└───────┬───────────┬───────────┘          └───────────────┬───────────────┘
        │           │                                      │ hit tests, snapping
        │           ▼                                      ▼
        │   ┌──────────────────────────────────────────────────────────────┐
        │   │ Core (pure TypeScript, no DOM)                               │
        │   │  document schema · scene graph · geometry · operations ·     │
        │   │  history · validation · migrations · layout · components ·   │
        │   │  variables · vector · prototype model                        │
        │   └──────────────────────────────────────────────────────────────┘
        │
        ├──► Canvas rendering engine   (scene canvas + overlay canvas)
        ├──► Persistence engine        (IndexedDB, autosave, file import/export)
        ├──► Export engine             (PNG, JPG, SVG, PDF)            [Phase 7]
        ├──► Collaboration engine      (Yjs provider, presence)        [Phase 8]
        └──► Plugin engine             (sandboxed iframe + API bridge) [Phase 9]

                         ┌─────────────────────────────────────┐
                         │ Server (Node.js, TypeScript)        │ [Phase 8]
                         │  REST · WebSocket (Yjs) · PostgreSQL│
                         │  auth · permissions · asset storage │
                         └─────────────────────────────────────┘
```

Data flow for one edit:

```
pointer event → active tool → pure operation(s) on the document
             → store.apply / store.gesture  ─┬─► history entry (property-level diff)
                                             ├─► subscribers: renderer marks dirty, React selectors update
                                             ├─► autosave scheduler (debounced write to IndexedDB)
                                             └─► collaboration engine (diff → Yjs transaction)   [Phase 8]
```

---

## 4. Repository layout

A single npm package (see ADR-001). Later server and desktop code live in sibling folders with their own `package.json` and import the shared core by relative path, never through workspace links.

```
Open Design/
├── OPEN_DESIGN_MASTER_SPEC.md      the specification (verbatim copy)
├── PROJECT_ARCHITECTURE.md  …      the six Phase 0 documents
├── HANDOFF.md                      current state for the next session (spec §35)
├── package.json, tsconfig*.json, vite.config.ts, playwright.config.ts
├── index.html
├── src/
│   ├── core/                       pure TypeScript, no DOM, no React
│   │   ├── ids.ts                  stable ID generation
│   │   ├── order.ts                fractional ordering keys
│   │   ├── math/                   matrices, rectangles, angles
│   │   ├── document/               schema, factories, validation, migrations, serialisation
│   │   ├── scene/                  tree queries, world transforms, bounds, hit testing
│   │   ├── ops/                    pure document operations (create, move, resize, reorder …)
│   │   ├── history/                diff, patches, undo/redo stacks
│   │   ├── layout/                 constraints, Auto Layout                    [Phase 2, 4]
│   │   ├── vector/                 paths, Bézier maths, booleans                [Phase 3]
│   │   ├── text/                   text model and layout                        [Phase 2]
│   │   ├── components/             components, instances, overrides             [Phase 5]
│   │   ├── variables/              variables, modes, styles                     [Phase 5]
│   │   └── prototype/              interactions, flows                          [Phase 6]
│   ├── engine/                     browser-side engines
│   │   ├── render/                 Canvas 2D renderer, overlay renderer
│   │   ├── input/                  tools, shortcut map, interaction controller
│   │   └── viewport.ts             pan / zoom maths
│   ├── persistence/                storage interface, IndexedDB, autosave, file I/O
│   ├── state/                      Zustand stores (editor store, file list store)
│   ├── export/                     PNG / JPG / SVG / PDF                        [Phase 7]
│   ├── collab/                     Yjs binding, presence                        [Phase 8]
│   ├── plugins/                    sandbox host, plugin API                     [Phase 9]
│   └── ui/                         React application shell
│       ├── app/                    routing, home screen
│       ├── editor/                 editor shell, toolbar, menus, canvas host
│       ├── panels/                 pages, layers, design, prototype, inspect
│       └── components/             shared controls (number input, colour input, menu …)
├── e2e/                            Playwright acceptance tests
├── server/                         Node.js backend                              [Phase 8]
└── desktop/                        Tauri shell                                  [Phase 10]
```

Import rule, enforced by `src/architecture.test.ts`, which reads every file's imports: `core` imports nothing outside `core` and no browser globals; `engine` and `persistence` may import `core` and the editor store's types from `state`, and never React; `state` may import `core`, `engine` and `persistence`; `ui` may import everything; nothing imports `ui`.

---

## 5. The twenty engines

Spec §2 lists twenty engines. This table fixes where each lives, what it owns and when it is built.

| # | Engine | Location | Responsibility | Phase |
|---|---|---|---|---|
| 1 | Application shell | `src/ui` | Routing, layout, panels, menus, dialogs, theming. Holds no design data. | 1 |
| 2 | Canvas rendering engine | `src/engine/render` | Draws the visible part of the current page and the interaction overlay. Culling, high-DPI, later WebGL backend. | 1 → 7 |
| 3 | Document and scene graph engine | `src/core/document`, `src/core/scene`, `src/core/ops` | Schema, node tree, ordering, world transforms, bounds, pure operations. | 1 |
| 4 | Input and interaction engine | `src/engine/input` | Tools as state machines, pointer and keyboard routing, shortcuts, snapping. | 1 → 3 |
| 5 | Vector geometry engine | `src/core/vector`, `src/core/math` | Paths, Bézier maths, vector networks, booleans, flattening. | 3 |
| 6 | Typography engine | `src/core/text`, `src/engine/render/text` | Text model, shaping and line breaking, measurement, inline editing. | 2 |
| 7 | Layout engine | `src/core/layout/constraints.ts` | Constraints, min/max, layout grids. | 2 |
| 8 | Auto Layout engine | `src/core/layout/autoLayout.ts` | Flex-like measure and arrange passes, hug/fill, wrapping, nesting. | 4 |
| 9 | Component engine | `src/core/components` | Main components, instances, overrides, variants, propagation. | 5 |
| 10 | Variable and design-system engine | `src/core/variables` | Styles, variables, collections, modes, aliases, bindings. | 5 |
| 11 | Image and asset engine | `src/core/assets`, `src/engine/render/images` | Content-addressed assets, decoding, caching, fill modes, crop. | 2 |
| 12 | Prototype engine | `src/core/prototype`, `src/ui/player` | Interactions, flows, overlay stack, variable state, player. | 6 |
| 13 | Animation engine | `src/core/prototype/animate.ts` | Transitions, easing, Smart Animate matching and interpolation. | 6 |
| 14 | Export and import engine | `src/export`, `src/persistence/fileIO.ts` | Native file, PNG/JPG/SVG/PDF export, SVG/image import. | 1 (native) → 7 |
| 15 | Collaboration engine | `src/collab`, `server/collab` | Yjs document binding, WebSocket provider, presence, offline queue. | 8 |
| 16 | Plugin engine | `src/plugins` | Sandboxed execution, permissioned API bridge, plugin registry. | 9 |
| 17 | File management engine | `src/persistence`, `src/state/files.ts`, `server/files` | Local file list, projects, folders, recents, thumbnails. | 1 → 9 |
| 18 | Developer inspection engine | `src/core/inspect`, `src/ui/panels/inspect` | Measurements and code generation from the real document. | 7 |
| 19 | Persistence and versioning engine | `src/persistence`, `src/core/history`, `server/versions` | Autosave, recovery, snapshots, version history, branches. | 1 → 9 |
| 20 | Authentication and permission engine | `server/auth`, `src/collab/session.ts` | Accounts, sessions, workspace and document permissions. | 8 |

Each engine exposes a small typed interface (an `index.ts`) and is tested in isolation.

---

## 6. Document and scene graph

Full schema: [DOCUMENT_SCHEMA.md](DOCUMENT_SCHEMA.md). The essentials:

- A document is `{ id, name, nodes }` where `nodes` is a flat map from node ID to an immutable node object.
- The tree is expressed by two fields on each child: `parentId` and `order` (a fractional index string). There are no `children` arrays. Reordering or reparenting changes one node, which is what makes concurrent editing mergeable (ADR-002).
- Pages are nodes of type `PAGE` with `parentId: null`.
- Geometry is `x, y, width, height, rotation` relative to the parent, with rotation about the box centre (ADR-005).
- Derived data (children lists, world matrices, world bounds) is computed lazily and cached per `nodes` object identity in `src/core/scene`. It is never stored.

Operations in `src/core/ops` are pure. Example signatures:

```ts
createNode(doc, node): Document
updateNodes(doc, updates: Record<NodeId, Partial<Node>>): Document
deleteNodes(doc, ids): Document
moveNodesBy(doc, ids, dx, dy): Document            // world-space delta
resizeNode(doc, id, box): Document
reparentNodes(doc, ids, parentId, before?): Document   // keeps world position
reorderNodes(doc, ids, 'front' | 'back' | 'forward' | 'backward'): Document
duplicateNodes(doc, ids): { doc, newIds }
```

---

## 7. Editor store and history

`src/state/editorStore.ts` is a Zustand store created per open document. It owns the current document snapshot, the editor state, and the history stacks.

- `apply(label, fn)` runs a pure operation and records one history entry.
- `beginGesture()` / `updateGesture(fn)` / `commitGesture(label)` / `cancelGesture()` wrap continuous interactions (drag, resize, rotate) so that one gesture is one undo step and can be cancelled with Escape.
- A history entry is a **property-level diff** between the document before and after, plus the selection and page before and after. Undo applies the inverse patch; redo re-applies the forward patch. Because patches name properties, not whole nodes, undo composes correctly with remote edits to other properties (ADR-003).
- History is bounded (500 entries) and is per session; it is not persisted.

React reads the store through selectors. The renderer subscribes directly and redraws on the next animation frame.

---

## 8. Canvas rendering engine

- Two stacked `<canvas>` elements: the **scene canvas** (the design) and the **overlay canvas** (selection outlines, handles, hover, marquee, guides, frame labels). The overlay can repaint without re-rasterising the scene.
- A redraw is requested by marking the renderer dirty; drawing happens at most once per animation frame.
- Coordinates: `screen = (world − viewport.origin) × zoom`, scaled by `devicePixelRatio` for high-DPI output.
- Each frame: compute the visible world rectangle, walk the page tree in paint order, skip invisible nodes, cull subtrees whose render bounds do not intersect the viewport, set the transform to `viewport × worldMatrix`, and paint.
- The renderer talks to a `RenderBackend` interface. Phase 1 ships the Canvas 2D backend. A WebGL backend, tile caching, dirty-region repaint and OffscreenCanvas workers are planned behind the same interface (roadmap Phase 7 performance milestone); they are not present until the tracker says so.
- The same paint code, pointed at an offscreen canvas with an identity viewport, is the PNG/JPG exporter. Export is real rendering, never a screenshot of the editor (spec §32 rule 10).

Hit testing (`src/core/scene/hitTest.ts`) is geometric, not pixel-based: the point is transformed into each candidate node's local space and tested against that node's shape. Candidates are currently found by walking the tree; a spatial index to speed this up on very large pages is planned and not yet built.

---

## 9. Input and interaction engine

- `InteractionController` receives pointer, wheel and keyboard events from the canvas host and routes them to the active **tool**.
- A tool is a small state machine with `onPointerDown / Move / Up`, `onKeyDown / Up`, `cancel()` and `getCursor()`. It keeps its transient state privately and publishes overlay data (for example a marquee rectangle) for the overlay renderer.
- Tools call store actions; they never touch the DOM or React.
- Shortcuts are data: a table of `{ id, keys, when, run }` in `src/engine/input/shortcuts.ts`. The same table drives the menus and the shortcut reference, which is how menu labels and real bindings stay in agreement. User-configurable bindings (spec §25) layer over this table.

---

## 10. Persistence

- **Local-first.** Documents are stored in IndexedDB through a `DocumentStorage` interface (`list`, `load`, `save`, `delete`, `duplicate`). No account and no server are needed (deployment Mode A).
- **Autosave** is a debounced write after every committed change, flushed on page hide. The toolbar shows the true status: saved, saving, unsaved or error.
- **Native file format** `.opendesign`: versioned JSON (see DOCUMENT_SCHEMA.md). "Save as" and "Open" use the File System Access API when the browser has it and fall back to download and file-picker upload.
- **Loading** always goes through `migrate → validate → repair`. A file from a newer schema version is refused with a clear message rather than opened lossily.
- Later: binary assets are stored content-addressed beside documents (Phase 2), snapshots feed version history (Phase 9), and the server implements the same `DocumentStorage` interface over PostgreSQL and S3-compatible storage (Phase 8).

---

## 11. Collaboration (Phase 8, design fixed now)

The document model was chosen so that it maps directly onto Yjs:

- `nodes` becomes a `Y.Map<nodeId, Y.Map<property, value>>`. Property-level last-writer-wins gives sensible merges; `parentId` + `order` make moves and reorders single-property writes.
- Local history diffs are translated into one Yjs transaction each. Remote transactions are applied to the store as external changes that do not enter the local undo stack. Undo therefore only reverts the local user's own property changes.
- Concurrent reparenting can create a cycle; the receiving side detects it during integration and deterministically reattaches the node with the lower ID to its previous parent.
- Presence (cursor, selection, viewport, name, colour) uses the Yjs awareness protocol and never touches the document.
- Offline edits accumulate in the local Yjs document (persisted in IndexedDB) and merge on reconnect.

The server (`server/`) is a Node.js process offering REST for accounts, workspaces, files and permissions, and a WebSocket endpoint speaking the Yjs sync protocol with per-document permission checks. PostgreSQL stores metadata and document updates; assets go to S3-compatible storage; Redis is added only if multi-process fan-out is needed.

---

## 12. Desktop and deployment (Phase 10)

- Desktop shell: Tauri (small binaries, native file dialogs, native menus). The web application is the UI; a thin adapter implements `DocumentStorage` and file dialogs over native file access.
- Self-hosting: a Docker Compose file with the server, PostgreSQL and MinIO.
- The browser build is a static site and works fully offline in Mode A.

---

## 13. Testing strategy

| Layer | Tool | What is verified |
|---|---|---|
| Core | Vitest (Node) | Operations, history, geometry, hit testing, validation, migrations, layout engines. Pure functions, exact assertions. |
| Engines | Vitest + jsdom | Tools driven with synthetic pointer sequences against a real store; persistence against `fake-indexeddb`; renderer against a recording canvas context. |
| UI | React Testing Library | Panels reading and writing the real store. |
| Acceptance | Playwright (installed Edge) | Each phase's acceptance criterion in a real browser: real pointer and keyboard input on the canvas, results asserted through the layers panel, the properties panel and a page reload. |
| Rendering regression | Playwright screenshots / pixel probes | Added with Phase 2 once output is rich enough to regress. |

Rules: tests exercise real behaviour (spec §33); there are no test-only code paths in the application; a feature is "Tested" in the tracker only when a test would fail if the feature broke.

---

## 14. Performance plan

Targets from spec §5 and §27: usable with thousands of objects.

- Now (Phase 1): immutable snapshots with structural sharing, lazy cached world transforms, viewport culling, redraw coalescing, overlay on a separate canvas.
- Next: spatial index for hit tests and marquee, virtualised layers list (Phase 2), image decode cache (Phase 2), text layout cache (Phase 2).
- Later (Phase 7 performance milestone): tile cache for static content, dirty-region repaint, WebGL backend for fills/images/compositing, workers for booleans, export and thumbnailing.

Performance is tracked with a scripted stress document (10,000 nodes) and recorded frame times; numbers are written to the tracker when measured, not before.
