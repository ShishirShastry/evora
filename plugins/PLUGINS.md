# Writing plugins and widgets for Evora

Evora can be extended with **plugins** (commands in the Plugins menu, with or without a window of their own) and **widgets** (interactive objects placed on the canvas, such as a counter or a vote). Both are free to make, install and publish.

This page describes the format, the API and how to develop one. The examples in [`examples/`](examples/) are complete, working plugins to start from:

| Example | Kind | Shows |
|---|---|---|
| [`rename-layers`](examples/rename-layers/) | plugin | a window (`ui.html`) that talks to the plugin; batch changes; events |
| [`tidy-up`](examples/tidy-up/) | plugin | two commands, no window; closing with a message |
| [`lorem-ipsum`](examples/lorem-ipsum/) | plugin | creating text; the plugin's own storage |
| [`vote-counter`](examples/vote-counter/) | widget | two widgets, state and click handlers |

Each `examples/<name>.evora-plugin` is the installable file made from the folder of the same name.

## 1. What a plugin is

A plugin is a folder with:

- `manifest.json` — what it is and what it may do;
- `main.js` — its code (the file named by `"main"`);
- `ui.html` — only if it has a window (the file named by `"ui"`).

For installing, the three are bundled into **one JSON file** with the extension `.evora-plugin`:

```json
{
  "format": "evora-plugin",
  "formatVersion": 1,
  "manifest": { "...": "the manifest" },
  "code": "the text of main.js",
  "ui": "the text of ui.html, or null"
}
```

`node plugins/build-examples.mjs` bundles every folder in `plugins/examples/`; the function `bundleFolder(dir)` in that script, or `makeBundle(manifest, code, ui)` from `src/plugins/manifest.ts`, does the same for a plugin of your own. During development you do not need to bundle at all (see §6).

### The manifest

```json
{
  "id": "com.example.rename-layers",
  "name": "Rename layers",
  "version": "1.0.0",
  "description": "Renames the selected layers in one go.",
  "author": "Your name",
  "kind": "plugin",
  "api": 1,
  "permissions": ["read", "write", "ui"],
  "commands": [{ "id": "rename", "name": "Rename selected layers…" }],
  "main": "main.js",
  "ui": "ui.html"
}
```

| Field | |
|---|---|
| `id` | Unique, lowercase, in reverse-domain style: parts of letters and digits joined by `.` or `-` (`com.example.my-plugin`). In the directory, an ID belongs to whoever published it first. |
| `name` | Up to 60 characters; shown in the Plugins menu. |
| `version` | `major.minor.patch`. A new version in the directory must be higher than the last. |
| `description`, `author` | Shown in the plugin manager and the directory. |
| `kind` | `"plugin"` or `"widget"`. |
| `api` | The plugin API version it was written for: `1`. |
| `permissions` | What it may do; see below. May be empty. |
| `commands` | Plugins: its menu commands, each `{ "id", "name" }`. Without any, it has one command named after it (ID `run`). |
| `widgets` | Widget plugins: its widgets, each `{ "id", "name" }` (at least one). |
| `main` | The code's file name (default `main.js`). |
| `ui` | The window's HTML file name, if it has a window. Needs the `ui` permission. |

### Permissions

A plugin can do only what its permissions allow. They are shown, in words, before it is installed, and every call is checked against them: a call without its permission is refused with an error that names the permission.

| Permission | Allows |
|---|---|
| `read` | Reading the current file: pages, layers, the selection, components, styles, variables; the `selectionchange`, `documentchange` and `currentpagechange` events; setting the selection and the page shown. |
| `write` | Changing the current file: creating, editing, grouping and deleting layers; creating and changing styles and variables. |
| `export` | `evora.exportAsync`: layers as PNG, JPG, SVG or PDF. |
| `ui` | A window (`evora.showUI`) and messages with it. |
| `storage` | `evora.clientStorage`: data of its own, kept on this device. |

Every plugin may show notifications (`evora.notify`) and close itself.

## 2. Where plugins run

A plugin's code runs in a **sandbox**: an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, so it has an opaque origin and no access to Evora, its storage, cookies or other files; and a Content-Security-Policy that allows inline scripts and styles and nothing else: **no network** (`fetch`, `XMLHttpRequest`, WebSockets, images from addresses), no `eval`, no other frames, no forms. The only way out is the `evora` API, which sends each call to Evora as a message and gets the answer back as a promise.

A plugin's window is a second sandbox of the same kind, shown in a floating window that can be dragged by its title bar. It reaches the plugin only through messages (§4).

What follows from this:

- Everything in the API is **asynchronous**: `await` it.
- What you get back is **plain data** (JSON objects, and bytes for exports), a snapshot at the time of the call. Change a layer with `evora.setProperties`, not by changing the object you were given.
- Your code runs as the body of an `async` function, so `await` and `return` work at its top level.
- `console.log`, `console.warn` and `console.error` go to the plugin's **console** in the plugin manager, with the errors you do not catch.

## 3. The API

The object is `evora`.

```js
evora.apiVersion   // 1
evora.pluginId     // your manifest's id
evora.command      // the ID of the menu command it was run with
```

### Running and closing

| Call | |
|---|---|
| `evora.closePlugin(message?)` | Ends the plugin. A message is shown as a notification. A plugin keeps running until it closes (or the person stops it), so close it when its work is done. |
| `evora.notify(message, { error?, timeout? })` | A short notification at the foot of the canvas. `timeout` in ms (500–60000, 3000 by default). |

Running a plugin again while it runs restarts it. "Run last plugin" (Ctrl+Alt+P) runs the last plugin and command again.

### Reading (`read`)

| Call | Answer |
|---|---|
| `getDocument()` | `{ id, name, currentPageId, pages: [{ id, name }] }` |
| `getPages()`, `getCurrentPage()` | page nodes |
| `setCurrentPage(pageId)` | shows another page |
| `getSelection()` | the selected layers, as nodes |
| `setSelection(ids)` | selects layers of the page shown; answers with what is selected |
| `getNode(id)` | a node, or `null` |
| `getChildren(id)` | the nodes inside a page, frame or group, bottom to top |
| `findAll({ name?, nameContains?, type?, within? })` | every layer under `within` (the page shown by default) that matches; `type` is one type or a list (`"TEXT"`, `["RECTANGLE", "ELLIPSE"]`), `name` an exact name, `nameContains` part of a name, case aside |
| `findOne(query)` | the first such layer, or `null` |
| `getComponents()` | the file's components |
| `getStyles(type?)` | styles, all or of one type (`PAINT`, `TEXT`, `EFFECT`, `GRID`) |
| `getVariableCollections()`, `getVariables(collectionId?)` | variables and their collections |

A **node** is:

```js
{
  id, type,            // "FRAME", "GROUP", "RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR", "TEXT", "VECTOR", "BOOLEAN_OPERATION" or "PAGE"
  name, parentId, pageId, visible, locked,
  x, y, width, height, rotation, opacity,   // x and y within the parent
  fills, strokes, strokeWeight,             // paints, as in Evora's file format (colours from 0 to 1)
  children,                                 // the IDs of what is inside it, bottom to top
  cornerRadius,                             // frames and rectangles
  characters, fontFamily, fontSize, fontWeight, textAlign,   // text
  layoutMode, itemSpacing, padding,         // frames: Auto Layout
  component: { kind, componentId, description },             // components and instances
  widget: { pluginId, widgetId },           // widgets
}
```

A solid paint is `{ "type": "SOLID", "color": { "r": 1, "g": 0.5, "b": 0 }, "opacity": 1, "visible": true }`.

### Changing (`write`)

| Call | |
|---|---|
| `createRectangle(props)`, `createEllipse(props)`, `createFrame(props)`, `createText(props)` | a new layer, answered as a node. `props.parentId` puts it in a frame or group (the page shown by default), `props.index` at a place in its stack (on top by default). |
| `createInstance(componentId, props)` | an instance of a component |
| `setProperties(id, props)` | changes a layer; answers with the node as it now is |
| `remove(ids)` | deletes layers and what is in them |
| `group(ids, { name? })` | groups layers of one parent; answers with the group |
| `createStyle({ type: "PAINT" \| "EFFECT", name, paints \| effects, description? })` | a new style |
| `updateStyle(id, { name?, description?, paints?, effects? })` | changes a style of this file |
| `createVariableCollection(name)` | a collection, with one mode |
| `createVariable({ collectionId, type, name, value? })` | `type` is `COLOR`, `FLOAT`, `STRING` or `BOOLEAN`; `value` is given to every mode |
| `setVariableValue(id, modeId, value)` | a value in one mode, of the variable's type, or `{ alias: otherVariableId }` |

The properties a plugin can set: `name`, `visible`, `locked`, `x`, `y`, `width`, `height`, `rotation`, `opacity`, `fills`, `strokes`, `effects`, `strokeWeight`, `strokeAlign`, `blendMode`, `cornerRadius`, `clipsContent`, `constraints`, `description`; text: `characters`, `fontFamily`, `fontSize`, `fontWeight`, `italic`, `textAlign`, `verticalAlign`, `textAutoResize`, `letterSpacing`, `lineHeight`; Auto Layout: `layoutMode`, `itemSpacing`, `paddingLeft`, `paddingRight`, `paddingTop`, `paddingBottom`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `layoutSizingHorizontal`, `layoutSizingVertical`. Any other property is refused, as is a value of the wrong type or a name a property cannot have; numbers out of range are brought into range, as when a file is opened.

**Undo.** Each call that changes the file is **one undo step**, named after your plugin. To make many changes one step, put them in a batch:

```js
await evora.batch(async () => {
  for (const layer of await evora.getSelection()) {
    await evora.setProperties(layer.id, { name: layer.name.toUpperCase() });
  }
});
```

Inside a batch, what you read includes what the batch has changed so far; Evora shows it, as one step, when the batch ends. (Sizes that Auto Layout and text fitting work out are worked out when the batch ends.)

**Shared files.** Changes are made like the person's own: on a shared file they reach everyone at once. On a file the person may only view, every change is refused with the error "This file can only be viewed here, so plugins cannot change it."

### Exporting (`export`)

```js
const bytes = await evora.exportAsync(nodeId, { format: 'PNG', scale: 2 }); // Uint8Array; format PNG, JPG, SVG or PDF; scale 0.01–16
```

### Events

```js
evora.on('selectionchange', ({ selection }) => { … });        // read
evora.on('documentchange', ({ changes }) => { … });           // read; changes: [{ id, type: 'CREATE' | 'DELETE' | 'PROPERTY_CHANGE', properties }]
evora.on('currentpagechange', ({ pageId }) => { … });         // read
evora.on('message', (message) => { … });                      // ui: a message from the plugin's window
evora.on('close', () => { … });                               // the plugin is closing
evora.off(event, handler);  evora.once(event, handler);
```

### Storage (`storage`)

```js
await evora.clientStorage.setAsync('settings', { size: 12 });  // any JSON value, up to 1 MB
await evora.clientStorage.getAsync('settings');                // the value, or null
await evora.clientStorage.deleteAsync('settings');
await evora.clientStorage.keysAsync();
```

The data belongs to the plugin, on this device, in every file. The plugin manager shows it (the plugin's settings) and can reset it; uninstalling removes it.

## 4. A window (`ui`)

```js
evora.showUI({ width: 300, height: 240, title: 'Rename layers' });
evora.ui.postMessage({ type: 'selection', count: 3 });   // to the window
evora.on('message', (message) => { … });                  // from the window
evora.ui.resize(320, 280);
evora.ui.close();                                         // the window goes; the plugin keeps running
```

The window's HTML (`ui.html`) is shown in a floating Evora window with your title and a close button (closing it closes the plugin). It talks to the plugin the same way as in Figma:

```html
<script>
  // To the plugin:
  parent.postMessage({ pluginMessage: { type: 'rename', pattern: 'Card $n' } }, '*');
  // From the plugin:
  window.onmessage = (event) => {
    const message = event.data.pluginMessage;
  };
</script>
```

Evora's colours are there as CSS variables, so a window can look at home in the dark and the light theme: `--evora-bg`, `--evora-panel`, `--evora-field`, `--evora-line`, `--evora-text`, `--evora-dim`, `--evora-accent`, `--evora-danger`. The window has the same policy as the plugin's code: inline scripts and styles, pictures from `data:` addresses, no network. Forms work (their `submit` event reaches your script; call `event.preventDefault()`), but cannot be sent anywhere.

## 5. Widgets

A widget is an object on the canvas that its plugin draws from the widget's **state**, and that changes its state when a part of it is clicked (with the Move tool). Everyone on a shared file sees the same state. Make a plugin with `"kind": "widget"` that lists its widgets, and register each in its code:

```js
evora.widget.register('counter', {
  initialState: { count: 0 },                 // or a function that returns it
  render(state) {
    return {
      type: 'frame', direction: 'horizontal', padding: 8, spacing: 8, align: 'center',
      fill: '#ffffff', cornerRadius: 12,
      children: [
        { type: 'text', text: String(state.count), fontSize: 20, fontWeight: 600 },
        { type: 'frame', width: 32, height: 32, cornerRadius: 16, fill: '#0d99ff',
          align: 'center', justify: 'center', onClick: 'increment',
          children: [{ type: 'text', text: '+', fill: '#ffffff' }] },
      ],
    };
  },
  handlers: {
    increment: (state) => ({ ...state, count: state.count + 1 }),
  },
});
```

`render(state)` returns a tree of **nodes**; the top one must be a frame:

| Property | Nodes | |
|---|---|---|
| `type` | all | `frame`, `rectangle`, `ellipse` or `text` |
| `name` | all | the layer's name |
| `width`, `height` | all | pixels, `"hug"` (fit the contents; frames with a direction and text) or `"fill"` (fill the frame it is in). Frames with a direction hug by default. |
| `fill`, `stroke` | all | `"#rgb"`, `"#rrggbb"` or `"#rrggbbaa"`, or `null` for none |
| `strokeWidth`, `opacity` | all | |
| `cornerRadius` | frame, rectangle | |
| `direction` | frame | `"horizontal"` (the default) or `"vertical"`: Auto Layout; `"none"` places children by their `x` and `y` |
| `padding` | frame | a number, or `{ top, right, bottom, left }`, or `{ vertical, horizontal }` |
| `spacing` | frame | the space between children |
| `align` | frame | across the layout: `"start"`, `"center"`, `"end"` |
| `justify` | frame | along the layout: `"start"`, `"center"`, `"end"`, `"space-between"` |
| `children` | frame | nodes |
| `text`, `fontSize`, `fontWeight`, `textAlign` | text | `textAlign`: `"left"`, `"center"`, `"right"`; a text with a width wraps |
| `onClick` | all | the name of a handler |

Evora turns the tree into **real layers** inside the widget's frame, so a widget is painted, exported and shared like any other layers. It is selected and moved as one object; a click on a part with `onClick` (or inside one) runs that handler with the current state and `{ path }`; what the handler returns (or the promise it returns resolves to) is the new state, which is drawn again. The new state and what is drawn from it are **one undo step**. A widget may draw up to 500 layers, 16 deep; its state is JSON, up to 100 000 characters.

Widgets are placed from **Plugins › Widgets**. A widget whose plugin is not installed is still shown (its layers are in the file) but cannot be clicked.

## 6. Developing

1. Make a folder with `manifest.json` and `main.js` (and `ui.html`).
2. In Evora: **Plugins › Development…**, then **Load from files…**, and choose the folder's files together.
3. Run it from the Plugins menu (or the **Run** button beside it). Its console is under it in the same tab: `console.log` output and errors.
4. After changing a file, choose **Reload**. In browsers that allow it (Edge, Chrome), Evora reads the files again from the disk; elsewhere it asks for them again.

When it works, bundle it (§1) to share it as a `.evora-plugin` file, which anyone can install from **Plugins › Manage plugins… › Install from file…**, or publish it.

## 7. The directory

With a collaboration server (`npm run server`), Evora has a directory of plugins and widgets: **Plugins › Browse plugins and widgets…** searches it and installs from it (showing the permissions first, as for a file). Anyone signed in can publish: open the plugin in **Manage plugins**, then **Publish to directory**. Only the first publisher of an ID can publish its new versions, each higher than the last. Browsing, searching and installing need no account. The server's routes:

| Route | | Who |
|---|---|---|
| `GET /api/plugins/directory?q=&kind=` | `[{ id, name, description, version, kind, author: { id, name }, installs, updatedAt }]`, most installed first | anyone |
| `GET /api/plugins/directory/:id` | the same, with `permissions`, `commands`, `widgets` and `versions` | anyone |
| `GET /api/plugins/directory/:id/versions/:version` | `{ bundle }` | anyone |
| `POST /api/plugins/directory/:id/install` `{ version? }` | `{ bundle, installs }`; counted once per person (or address) | anyone |
| `POST /api/plugins/directory` `{ bundle, description?, notes? }` | the entry (201 when new) | an account; new versions by the publisher |
| `DELETE /api/plugins/directory/:id` | `{}` | the publisher |

Everything is free and unlimited.
