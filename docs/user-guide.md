# Evora user guide

Evora is a free, open-source design tool. You can design screens, build components and design systems, make clickable prototypes, hand designs to developers and work on them with other people. Everything is free, with no plans and no seat limits.

Evora is **local-first**: your files live on your own device and keep working offline. A server is only needed when you want to work with other people.

This guide walks through the app as it is today. Where a feature stops short of what you might expect, it says so.

**A note on keys.** This guide writes shortcuts with **Ctrl**. On a Mac, **Cmd** works too. **Alt** is the **Option** key on a Mac. Letter shortcuts follow the physical key positions of a QWERTY keyboard, so on another layout they sit on the same keys, not the same letters.

## Contents

- [Getting started](#getting-started)
- [Files](#files)
- [Drawing and editing](#drawing-and-editing)
- [Layout](#layout)
- [Design systems](#design-systems)
- [Prototyping](#prototyping)
- [Handoff](#handoff)
- [Working together](#working-together)
- [Plugins and widgets](#plugins-and-widgets)
- [Community](#community)
- [Projects, favourites, recents, search and trash](#projects-favourites-recents-search-and-trash)
- [Desktop app specifics](#desktop-app-specifics)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)

---

## Getting started

### The desktop app

The desktop app is made for Windows, macOS and Linux. It works fully offline, opens and saves files on your disk, and can recover your work after a crash.

No release has been published yet. Until then, the installer has to be built from the source code (`npm run dist:desktop`, see [electron/README.md](../electron/README.md)). So far only the Windows installer has been built and tried.

The Windows build comes in two forms:

- **`Evora-Setup-<version>.exe`**, an installer. It asks whether to install for you only (the default, which needs no administrator rights) or for everyone, and lets you choose the folder.
- **`Evora-<version>-portable.exe`**, which runs without installing.

On macOS there will be a `.dmg` and a `.zip` (Intel and Apple silicon). On Linux there will be an AppImage and a `.deb`.

The installers are not code-signed yet, so your system will warn you the first time. See [Unsigned installer warnings](#unsigned-installer-warnings).

### In your browser

You need [Node.js](https://nodejs.org) 24. In the project folder, run:

```bash
npm install
npm run dev
```

Then open http://localhost:5173. You do not need an account or a server. Your files are kept in the browser on this device.

If your team runs an Evora server, open its address instead (for example `https://evora.example.com`). The [self-hosting guide](self-hosting.md) explains how to run one.

> The editor is made for a desktop-sized window. At phone and tablet widths its side panels and menus do not fit yet.

### Your first file

1. On the file browser, choose **New design file** (or **Create your first file** when you have none).
2. The editor opens. Your file is saved automatically, moments after each change.
3. Press **F** and drag on the canvas to draw a frame. This is your screen.
4. Press **R** and drag inside the frame to draw a rectangle. Press **T** and click to add text.
5. Choose the Evora logo at the top left (the **Main menu**) and pick **File ▸ Back to files** to return to the file browser.

### A tour of the interface

**The file browser** is the first screen. It lists the files on this device as cards (or as a list). From here you can create, open, rename, duplicate, favourite, publish and delete files, and import files. When you are signed in to a server, a rail on the left adds your workspaces, files shared with you and the Community.

**The editor** has four parts:

- **The left sidebar.** At the top is the file header: the **Main menu** (the logo), the file's name (click it to rename the file) and its save status. The clock button beside it opens **Version history**. Below that are **Pages**, the **Components** list and the **Layers** panel.
- **The canvas** in the middle. It is infinite. Pan with the scroll wheel, by holding **Space** and dragging, with the middle mouse button, or with the Hand tool (**H**). Zoom with **Ctrl** and the wheel, or pinch.
- **The tool dock**, floating at the bottom of the canvas. It holds Move, Hand, Frame, the shapes (Rectangle, Ellipse, Line, Polygon, Star), Pen, Pencil, Text and Comment.
- **The right sidebar.** At the top: the people in the file, **Share**, **Present**, Undo and Redo, and the zoom. Below that, a switch with three tabs and a comment button:
  - **Design**: the properties of what is selected, or of the page when nothing is.
  - **Prototype** (**Shift+E**): interactions, flows and prototype settings.
  - **Inspect** (**Shift+D**): developer handoff. Measurements, code and assets.
  - **Comments**: the comment threads of a shared file.

You can drag the inner edge of either side panel to make it wider or narrower (180 to 480 pixels). Double-click the edge to reset it. **Main menu ▸ View ▸ Light theme** switches between the dark and light themes. Both choices are remembered on this device.

**The Main menu** holds File, Edit, View, Object, Arrange, Version history, Plugins and Help. Right-click a layer for its context menu, or the empty canvas for a shorter one. **Help ▸ Keyboard shortcuts** (**Ctrl+/**) lists every shortcut.

---

## Files

### The library on this device

Every file you work on is kept in Evora's library on this device. In a browser, the library is the browser's own storage for that address. In the desktop app it is the app's own storage.

Some things to know:

- Files live in the browser profile that made them, and only at that address. A file made at `localhost:5173` does not appear at another address or in another browser.
- **Clearing your browser's site data deletes your files.** For anything that matters, keep a copy on disk with **File ▸ Save a copy to disk…** (**Ctrl+Shift+S**).
- Deleting a file from the file browser removes it from this device for good. There is no trash for files on this device. (Shared files go to a trash first; see [Trash](#trash).)
- When a file is opened, it is checked and repaired if needed. If something was repaired, a message lists it. A file saved by a newer version of Evora is refused, with a message asking you to update.

### Autosave

Changes are saved automatically about 0.4 seconds after you make them. The file header shows the state:

| Status | Meaning |
|---|---|
| **Saved** | Everything is stored on this device. |
| **Unsaved changes** | A save is about to happen. |
| **Saving…** | A save is under way. |
| **Not saved** | The save failed. Hover over the status to see why. |

**File ▸ Save now** (**Ctrl+S**) saves at once. Reloading the page brings back the file, the page you were on and your view.

Shared files are not saved on this device; they are sent to the server. See [Live editing](#live-editing).

### Files on disk (desktop app)

In the desktop app, **Ctrl+S** saves to a file on your disk and **Ctrl+O** opens one. See [Open and save](#open-and-save).

### Importing

**From the file browser:** choose **Import file…**. It takes:

- **Evora files** (`.evora`, and `.opendesign` files from before the rename).
- **Figma files** (`.fig`). The file becomes a new file on this device with its layers, components, instances, styles, variables, Auto Layout, constraints and prototype interactions. If anything in it could not be brought over, a **Figma file opened** dialog lists it before the file opens. Large files can take a few seconds.

**Into an open file:** choose **File ▸ Place image…** (**Ctrl+Shift+K**), drop files on the canvas, or paste from the clipboard. Evora takes PNG, JPEG, WebP, GIF and SVG.

- A picture becomes a rectangle with an image fill, at its natural size unless that would not fit in the view. It lands inside the frame under it.
- An SVG file comes in as a frame of editable layers (rectangles, ellipses, vectors, groups, text and gradients). A notice lists anything it left out. If the SVG cannot be read that way, it is placed as a picture.
- A GIF is placed as its first frame.

Limits: PDF files cannot be imported. From SVG files, clipping paths (other than a plain rectangle around a group), masks, filters, patterns and embedded pictures are left out.

### Saving a copy and exporting

**File ▸ Save a copy to disk…** (**Ctrl+Shift+S**) asks which format to use:

- **Evora** (`.evora`): the whole file, with its images bundled in. Import it again with **Import file…**.
- **Figma** (`.fig`): the dialog says what a `.fig` file cannot hold. Whether files saved this way open in Figma has not been verified yet.

To export pictures, SVG or PDF, see [Export settings](#export-settings).

### Version history

Evora keeps versions of your files so you can look back, compare and restore.

Open the history with the clock button in the file header, or **Main menu ▸ Version history ▸ Show version history**.

**Automatic versions.** For files on this device, Evora saves a version when you open a file that changed since its last version, and every 10 minutes while it changes. For shared files, the server saves a version when changes arrive 10 minutes or 1,000 changes after the last one. Older automatic versions are thinned out: all of the last day are kept, then one a day for 30 days, then one a week.

**Named versions.** Choose **Version history ▸ Save to version history…** (**Ctrl+Alt+Shift+S**) and give the version a title and a description. Named versions are always kept.

In the history panel, open a version's menu to:

- **Name this version…** or **Edit version info…**
- **Compare with current**
- **Restore this version**
- **Delete version**

Click a version to view it, read-only.

**Restoring.** On this device, a restore is one undo step, and Evora first keeps a "Before restoring…" version. On a shared file, the restore happens on the server and everyone in the file sees it.

**Comparing.** **Version history ▸ Compare versions…** compares two versions, or a version with the file as it is now. Choose **Side by side** (the two views pan together) or **Overlay** (with a slider for the newer side). A list shows the layers that were added, removed and changed, and what changed. Click one to go to it.

### Branches

Branches are for shared files (they live on the server). A branch is a copy of the main file where you can try changes without touching the main file.

From **Main menu ▸ Version history**:

- **Create branch…** makes a branch and asks for its name. You need to be signed in and able to edit the file.
- **Show branches…** lists the file's branches.

Inside a branch, the same menu has:

- **Update from main…** brings in the main file's changes since the branch was made or last updated.
- **Merge into main…** shows the branch's changes and every **conflict**: a property of a layer that changed in both the branch and main. For each conflict choose **Keep main** or **Take branch**, then merge. Only editors of the main file can merge.
- **Show branches of main…**

Merging records "Before merging…" and "Merged…" versions on the main file. To undo a merge, restore the "Before merging…" version.

After a merge, the branch is kept, archived and view-only. It shows "This branch has been merged into *main*; it can be viewed but not changed".

In file lists, branches do not appear as files of their own. A file with open branches shows "*N* branches" under it.

---

## Drawing and editing

### Tools

| Tool | Key | What it does |
|---|---|---|
| Move | V | Select, move and resize. |
| Hand | H | Pan the canvas. |
| Frame | F | Draw a frame: a screen, a card, a container. |
| Rectangle | R | Draw a rectangle. |
| Ellipse | O | Draw an ellipse. |
| Line | L | Draw a line. |
| Polygon | (none) | Draw a polygon. |
| Star | (none) | Draw a star. |
| Pen | P | Draw paths point by point. |
| Pencil | Shift+P | Draw freehand. |
| Text | T | Add text. |
| Comment | C | Pin a comment (shared files only). |

Drag to draw, or click for a default size. Hold **Shift** for a square, a circle or a 45° line. Hold **Alt** to draw from the centre. Shapes drawn over a frame go inside it.

### Selecting and moving

- Click to select. **Shift**-click adds to the selection. Drag on empty canvas to select with a box.
- Double-click to go inside a group or frame. **Ctrl**-click picks the deepest layer under the pointer.
- Drag to move. **Shift** keeps to one axis, **Alt** drags a copy, **Escape** cancels.
- Dropping a layer on a frame puts it inside; dragging it out takes it out.
- Use the eight handles to resize (**Shift** keeps proportions, **Alt** resizes from the centre).
- Drag just outside a corner to rotate (**Shift** for 15° steps).
- The arrow keys nudge by 1 pixel, **Shift** and an arrow by 10.

Hidden and locked layers cannot be clicked on the canvas.

### Layers and pages

The **Layers** panel shows the current page as a tree. You can select, rename, show or hide, lock or unlock, expand or collapse layers, and drag them to reorder or nest them. Right-click for the context menu. It stays quick with thousands of layers.

The **Pages** section lists the file's pages. Use **Add page**, or right-click a page to **Rename**, **Duplicate**, **Move up**, **Move down** or **Delete** it.

**Group selection** (**Ctrl+G**) and **Ungroup** (**Ctrl+Shift+G**) are in the Object menu. A group always fits its contents, and resizing a group scales what is in it.

### Shapes

Select a shape to see its properties in the **Design** tab:

- **Position and size**: X, Y, width, height, rotation and corner radius. Choose **Separate corner radii** to set each corner.
- **Polygons and stars**: the point count, and for stars the inner radius.
- **Ellipses**: **Arc start**, **Arc sweep** and **Arc ratio** turn a circle into a slice, a ring or a piece of a ring. A selected ellipse also has handles on the canvas for this (when it is at least 48 pixels across on screen).
- **Frames**: **Clip content** hides what spills over the edge.

### The Pen, vectors and points

**Pen (P).** Click to place points joined by straight lines. Drag as you place a point to curve the path. Click the first point to close the path. **Shift** keeps to 45° steps. **Escape** ends the current path; press it again to put the pen down. **Enter** finishes.

**Pencil (Shift+P).** Drag to draw freehand. When you let go, the stroke is smoothed into a few curves. A stroke that ends near where it began becomes a closed shape.

**Flatten to vector** (**Ctrl+E**) turns rectangles, ellipses, lines, polygons and stars into a vector you can reshape.

**Editing points.** Double-click a vector, or select it and press **Enter** (or choose **Object ▸ Edit points**).

- Click, **Shift**-click or drag a box to select points. **Ctrl+A** selects all of them.
- Drag points or segments to move them. The arrow keys nudge the selected points.
- Drag a point's handles to reshape its curves. **Alt** moves one handle alone.
- **Ctrl**-click switches a point between corner and smooth.
- Double-click a segment to add a point.
- **Delete** removes the selected points. **Ctrl+J** joins two selected points.
- The Object menu also has **Cut path at points**, **Split at intersections**, **Smooth points** and **Corner points**.
- **Escape** clears the point selection, then leaves point editing.

**Arrowheads.** The Stroke section of a line or a vector has **Start arrow** and **End arrow**: no arrow, line arrow, triangle, circle or diamond. On a vector, the heads go on the loose ends of its open paths.

**Outline stroke** (**Ctrl+Shift+O**) turns a stroke into a filled shape.

Limits: strokes always have one width along their length. Text cannot be flattened or outlined.

### Boolean shapes

Select two or more shapes and choose one of these from the Object menu, the context menu, or the buttons in the Design tab:

| Operation | Shortcut | Result |
|---|---|---|
| Union selection | Ctrl+Alt+U | Everything any shape covers. |
| Subtract selection | Ctrl+Alt+S | The bottom shape, with the others cut out. |
| Intersect selection | Ctrl+Alt+I | Only what all the shapes share. |
| Exclude selection | Ctrl+Alt+X | What an odd number of shapes cover. |

The result is a **boolean group**. The shapes stay inside it and stay editable: move, resize or restyle one and the result follows. You can change the operation in the **Boolean group** section. **Ungroup** releases the shapes; **Flatten to vector** makes the result an ordinary vector.


### Text

Press **T**. Click to add text that grows as you type, or drag a box for text that wraps. Double-click text, or select it and press **Enter**, to edit it. **Escape**, **Ctrl+Enter** or clicking away finishes. New text left empty is not kept.

The **Text** section sets the font family, weight, size, line height, letter spacing, paragraph spacing, alignment, text box sizing (auto width, auto height or fixed), letter case, underline or strikethrough, and lists (bulleted or numbered).

**Styling part of a text.** While editing, select some characters. The section becomes **Text (selected part)** and changes only that part: font, weight, size, letter spacing, decoration, italic and its own colour. **Ctrl+B**, **Ctrl+I** and **Ctrl+U** switch bold, italic and underline.

**Fonts.** The Inter typeface ships with Evora, so it looks the same everywhere. You can also use the fonts installed on your computer, but someone without that font will see a fallback.

Limits: no text on a path. A list applies to the whole text layer. Typing with an input method (for Chinese, Japanese, Korean and similar) is built but untested.

### Fills, strokes and effects

**Fill** and **Stroke** can each hold several paints. A paint can be a solid colour, a linear, radial, angular or diamond gradient, or an image.

- Click a colour swatch to open the colour picker. It has a saturation square, a hue strip, HEX, RGB and HSL fields, and (in Chrome and Edge) a dropper.
- A gradient has a button that shows its handles on the canvas. Drag them to turn or stretch it. Colour stops are edited in the panel.
- Strokes have a weight, a position (inside, centre or outside), ends, corners and dashes.

**Effects** (the **+** of the Effects section): drop shadow, inner shadow, layer blur and background blur. They stack, and each can be hidden.

The **Layer** section has opacity, sixteen blend modes and **Mask the layers above** (also **Object ▸ Use as mask**, **Ctrl+Alt+M**).

### Images

Any shape's fill can be an image, set to **Fill**, **Fit**, **Crop** or **Tile**. With **Crop**, choose **Drag the image to position it**, then drag on the layer to move the image inside it. Every image also has **Exposure**, **Contrast** and **Saturation**, which change how it is drawn, never the stored image. **Replace image** swaps the picture and keeps the layer.

### Alignment and arranging

With layers selected, use the **Arrange** menu or the buttons in the Design tab:

- Align left, horizontal centres, right, top, vertical centres or bottom. A single layer aligns to its parent frame.
- Distribute horizontal or vertical spacing (three or more layers).
- **Object ▸ Flip horizontal** (**Shift+H**) and **Flip vertical** (**Shift+V**).
- **Object ▸ Bring to front**, **Bring forward**, **Send backward**, **Send to back**.

> **Alt+D** (align right) is also a browser shortcut, and the browser may take it first. The menu item always works.

### Guides, snapping and measuring

**Snapping.** While you move, resize or draw, edges and centres snap to nearby layers, the frame's edges and centre, layout grids and guides. A moving layer also snaps to even spacing with its neighbours, and the equal gaps are shown. Turn snapping off with **View ▸ Snap to objects** (**Ctrl+Shift+'**). **View ▸ Snap to pixel grid** (**Ctrl+Alt+'**) controls whole-pixel snapping.

**Measuring.** Select a layer and hold **Alt**. Point at another layer to see the distances between them. Point at nothing to see the distance to the frame's edges.

**Rulers and guides.** **View ▸ Rulers and guides** (**Shift+R**) shows rulers. Drag out of a ruler to make a guide. Drag a guide to move it, or back onto its ruler to remove it. A guide let go over a frame belongs to that frame and moves with it.

**Layout grids.** A frame can have column, row and grid layouts (the **Layout grid** section). They are guides only, never part of the design. **View ▸ Show layout grids** (**Shift+G**) shows or hides them.

Limits: a guide cannot be typed in as a number or locked. Nothing snaps inside a rotated frame.

---

## Layout

### Constraints

A layer directly inside a frame has **Constraints**: horizontally **Left**, **Right**, **Center**, **Left and right** or **Scale**, and the same vertically with **Top** and **Bottom**. When the frame is resized, its children move and resize to keep their constraints.

Limits: minimum and maximum sizes apply only in Auto Layout, not with constraints.

### Auto Layout

Auto Layout lays out a frame's children in a row or a column, like a flexbox in code.

- **Add:** **Object ▸ Add Auto Layout** (**Shift+A**), or the **+** of the **Auto layout** section. A selected frame keeps everything where it is and reads its settings from the current spacing. Any other selection is wrapped in a new frame.
- **Remove:** **Object ▸ Remove Auto Layout** (**Alt+Shift+A**), or the **−** of the section. Everything stays where it was.

The **Auto layout** section sets:

- **Layout direction** (horizontal or vertical) and **Wrap**.
- **Spacing between items**: a number, or **Auto** to spread items from edge to edge.
- Padding, as one value per axis or (with **Separate padding**) per side.
- **Alignment along the layout** and **Alignment across the layout**, including **Stretch** and, for rows, **Text baseline**.
- For a wrapping layout: **Spacing between lines** and **Line distribution**.
- **Reverse order**.

The **Resizing** section sets each child's width and height to **Fixed**, **Hug contents** or **Fill container**, with minimum and maximum widths and heights. **Ignore auto layout** takes a child out of the flow.

On the canvas, drag a child to change its place in the layout, or use the arrow keys.

Limits: there is no "space around". Padding and spacing are not shown or dragged on the canvas. A dragged child jumps to its new place instead of following the pointer. Strokes take up no room in a layout.

---

## Design systems

### Components and instances

- **Create a component:** select a frame (or anything) and choose **Object ▸ Create component** (**Ctrl+Alt+K**).
- **Place an instance:** **Object ▸ Create instance**, or the **+** beside a component in the **Components** list in the left sidebar.

Changes to the component reach every instance. In an instance, double-click a layer inside it to change what it shows (fill, stroke, effects, text, visibility). These **overrides** are kept even when the component changes later.

The Object menu also has **Go to component**, **Reset instance**, and **Detach instance** (**Ctrl+Alt+B**). In an instance's properties you can swap it for another component.

The **Components** list shows the file's components. A slash in a name files it under a heading. Search by name or description, and click one to go to it.

Limits: you cannot move, resize the layout of, or add layers to the inside of an instance. There is no way yet to push an instance's overrides back to its component.

### Variants

Select components and choose **Object ▸ Combine as variants**. They become a set. On the set, add, rename and remove **variant properties**, and use **Add variant**. An instance of a variant has a menu for each variant property.

Limits: a set does not lay its variants out for you.

### Component properties

A component (or a set) can have **Boolean** (whether a layer shows), **Text** (what a text says) and **Instance swap** (which component an inner instance shows) properties. Bind a layer to a property in its **Component properties** section. Each instance then gets a switch, a text field or a menu.

### Styles

With a layer selected, the **Styles** section has a menu for each kind of style that fits: fill, stroke, text, effect and grid. Choose a style, **None** to detach, **New style from this layer**, or update a style to match the layer.

With nothing selected, **Local styles** lists the file's styles. You can rename, describe and delete them, and edit solid colours and a text style's font, size and weight there.

Changing a style changes every layer that uses it. Changing a styled property by hand detaches it.

### Variables and modes

Variables can be colours, numbers, strings or booleans, grouped in collections.

- With nothing selected, the **Local variables** section has **Edit variables**. It opens a dialog with collections, modes (for example Light and Dark) and a row per variable, with its value in each mode. A variable can also stand for another variable.
- With a layer selected, the **Variables** section binds a property to a variable (**Bind a property…**, then the variable). On a frame, it also chooses the mode of each collection that has more than one.
- The page's mode is chosen under **Local variables**.

Limits: variables bind to solid colours, not to gradient stops or effects. Styles and variables do not travel when you copy layers into another file. There is no token (JSON) import or export yet.

### Libraries

**File ▸ Libraries…** shares components, styles and variables between files.

- **This file**: **Publish**, **Publish changes** or **Unpublish**. In a shared file, publishing needs edit access, and the new version is offered to every file that uses the library.
- **Used in this file**: the libraries this file has, with their version. **Update** takes a newer version when there is one; **Remove** takes the library out (instances become ordinary frames, and layers keep the look its styles and variables gave them).
- **On this device**: the other published files on this computer, in this browser. **Add to this file** to use one.
- **Team libraries**: the shared files published in your workspaces (and shared files others gave you access to), grouped by workspace, with what each holds and its version. **Add to this file** to use one. This needs an account: when you are not signed in the section says **Sign in to use your team's libraries**, and when the server cannot be reached it says you are offline, with **Try again**.

A library's components appear in the Components list under its name. Its items cannot be changed in the file that uses them.

What a file has from a library is a copy, kept in the file with the images it uses. A file therefore opens and draws without the library, the server or a connection, and a file on your device can use team libraries just as a shared file can.

**Updates.** When a file is opened, when **Libraries…** is opened, and every five minutes while the file stays open and you are online, Evora looks for newer versions of the libraries the file uses. When there are some, a quiet **Library updates available** bar above the canvas (and in the Libraries dialog) lists them, for example `Kit: version 1 → 2`. **Update** (or **Update all**) takes them all as one step, which a single undo takes back. **Not now** hides the bar until a newer version still is published. Someone who may only view a shared file is not offered updates.

Limits: an update takes the whole new version; there is no choosing item by item and no list of what changed inside it. A guest (someone without an account who opened a link) is asked to sign in with an account to see team libraries, and a library a file reaches only through a link is not checked for updates. An image of a team library that cannot be downloaded when it is added shows as missing.

---

## Prototyping

Switch to the **Prototype** tab (**Shift+E**).

### Connections

Select a layer. A round handle appears beside its right edge. Drag it onto a frame to make an "on click, navigate to" connection. Or build interactions in the panel under **Interactions**. Connections show on the canvas as arrows.

On a frame, **Start a flow here** marks where a flow begins and names it.

### Triggers

On click or tap, On drag, While hovering, While pressing, After delay, Key press, Mouse leave, Mouse up.

For **Key press**, type the key, or choose **Record** and press it. It can include modifiers, such as `Ctrl+K` or `Shift+Enter`.

### Actions

Navigate to, Open overlay, Swap overlay, Close overlay, Scroll to, Back, Change to (another variant of an interactive component), Set variable, Conditional (with "if it holds" and "otherwise" lists), Type into variable, and Open link.

### Transitions

Instant, Dissolve, Smart Animate, Move in, Move out, Push, Slide in and Slide out. Set the direction, the duration, the easing (Linear, Ease in, Ease out, Ease in and out, or a custom curve) and a delay.

**Smart Animate** matches layers by name and type, and animates position, size, rotation, opacity, corner radius, stroke weight, font size and solid colours.

### Scrolling and overlays

- **Scrolling**: whether a frame scrolls (No scrolling, Horizontal, Vertical, Both directions), and whether a layer scrolls with it, stays fixed, or is sticky at the top.
- **As an overlay**: where an overlay sits (centre, or one of six edges and corners), whether a click outside closes it, and its background.

With nothing selected, the panel sets the device: None, Phone (390 × 844), Tablet (820 × 1180) or Desktop (1440 × 900).

### Presenting

Choose **Present** (**Ctrl+Alt+Enter**). The viewer has:

- **Back to the editor**
- The flow, the device and the scale (**Fit to window**, **Fit width**, **Actual size**)
- **Back** and **Restart** (or press **R**)
- **Copy prototype link** and **Full screen**

**Prototype links.** Share the file first (see [Sharing and links](#sharing-and-links)); then **Copy prototype link** (in the presentation bar, the Prototype panel, beside each flow, the View menu or the Share dialog) gives a link that opens straight into the presentation, at the chosen frame or flow. Anyone who can open the file can open its prototype: teammates, and anyone with the link when the file's link lets anyone view (they give a name first). Someone without access is told how to get it. For a file kept only on this device, the button offers to share it first.

Limits: a presentation shows the file as it was when it was opened; reload to see later changes. There is no separate permission for prototypes only. There is no video or sound, scrolling has no momentum, and sticky layers stick to the top only.

---

## Handoff

### Inspect

Open the **Inspect** tab (**Shift+D**). While it is open, a click selects the deepest layer under the pointer, nothing can be moved by accident, and hovering measures from the selection to the layer under the pointer.

With a layer selected, Inspect shows:

- Its **status**: Not marked, **Ready for development** or **Completed**.
- What it is, in sections: layout, spacing, Auto Layout, typography, colours, borders, effects, component, variables and styles.
- Its code (see below), and PNG and SVG assets.
- Annotations and links.

With nothing selected, it lists what is marked for development in the file, and the page's annotations.

### Code

Inspect writes code as **CSS**, **iOS (SwiftUI)** or **Android (Compose)**, with **Copy**. Under **Code for**, choose **This layer** or **Whole frame**. For a whole frame, CSS comes out as HTML and CSS with Auto Layout as flexbox.

You can also use **Edit ▸ Copy as CSS**, **Copy as SVG** and **Copy as PNG** (**Ctrl+Shift+C**).

Code is a starting point, not a finished screen. Hidden layers are left out, and some alignment is approximated.

### Export settings

At the end of the **Design** tab, the **Export** section exports the selected layers, or the page when nothing is selected.

1. Choose **+** (**Add a way to export**) to add a way to export: a size (`2x`, `512w`, `300h`), a suffix and a format (**PNG**, **JPG**, **SVG** or **PDF**).
2. Open the arrow for options: on the page's colour, JPG quality, ids in SVG, PDF vectors or **As a picture (keeps shadows and blurs)**, and PDF text **As text, in a standard font (selectable)** or **As pictures (exact look)**.
3. Choose **Export *name***.

**File ▸ Export…** (**Ctrl+Shift+E**) lists everything in the file that has export settings, to export together. More than one file is saved as one ZIP archive.

Limits: a picture is at most 16,384 pixels on a side. PDF text uses Helvetica, Times or Courier in place of your font unless you export text as pictures. SVG and PDF have no background blur. **Copy as PNG** copies the first selected layer.

---

## Working together

Working together needs an Evora **collaboration server**. Anyone can run one, for free. In the browser, it is the server the app is served from. In the desktop app, you choose it under **File ▸ Collaboration…** (see [Collaboration settings](#collaboration-settings)).

### Accounts

On the file browser, choose **Sign in**. The dialog has two tabs, **Sign in** and **Create account**. An account has a name, an email and a password of at least 8 characters. Once you are signed in, your avatar opens the account menu, with **Change name…** and **Sign out**. (A guest's menu has **Sign in…** and **Create an account…**.)

**Continue with Google** appears in these dialogs when the server's owner has set it up (see the [self-hosting guide](self-hosting.md#continue-with-google)). In the desktop app it opens your browser to sign in with Google, then brings you back to Evora; your browser may ask whether to open Evora. It needs the team server at its public https address.

### Workspaces and roles

When you are signed in, the file browser has a rail with **Recents**, **Favorites**, **Files on this device**, **Shared with me**, **Community** and your **Workspaces**. Choose **New workspace** to make one.

A workspace holds shared files and projects. Invite people by email, or with an **Invite link** ("Anyone who opens it and signs in joins the workspace with this role"). Every seat is free.

| Role | What they can do |
|---|---|
| **Owner** | Everything, including managing people and deleting files. |
| **Can edit** | Change the design, and invite people (but not make owners). |
| **Can view** | Look and comment, but not change the design. |

**Email.** When the server's owner has given it a mail server (see the [self-hosting guide](self-hosting.md#sending-email)), Evora emails invitations and @mentions, and asks each person to confirm their address with a link (a notice with **Resend** shows until it is confirmed). An email invitation is then taken up only by an account that has confirmed that address. You can turn mention emails off from the account menu. Without a mail server, no email is sent: an email invitation waits until someone signs up with that address, and addresses are not confirmed, so it goes to whoever signs up with it first. Invite links work at once either way.

### Sharing and links

Choose **Share** at the top of the right sidebar.

- **A file on this device:** choose a workspace (or **A new workspace for it**) and **Share this file**. It becomes a shared file.
- **A shared file:** see **People with access** and change their roles. Under **Who can open the link**, choose:
  - **No one**: only the people invited can open it.
  - **Anyone with the link can view**: they can look and comment, also without an account.
  - **Anyone with the link can edit**: they can change the design, also without an account.

Choose **Copy link** to copy it. Someone without an account who opens the link is asked for a name to show on their cursor and comments.

People who may only view see a **View only** badge in the file header, and only the Move and Hand tools.

### Live editing

Shared files open at an address like `#/doc/<id>`. Everyone's changes reach everyone else as they are made.

- The avatars at the top of the right sidebar show who is in the file. Click one to **follow** that person's view. **Stop following**, or press **Escape**, to stop.
- You see other people's cursors and selections on the canvas.
- Undo and redo undo only your own changes.

The file header shows the connection: **Synced**, **Saving…**, **Connecting…**, **Offline** (with the number of changes waiting) or **No access**.

Limits: when two people edit the same text at the same time, one whole version of that text wins. There is no merging letter by letter.

### Comments

Comments belong to shared files. Press **C** (or the comment button in the tool dock) and click the canvas to pin a comment. Type **@** to mention someone. Others can reply. **Resolve** closes a thread and **Reopen** opens it again. The **Comments** tab lists threads, **Open** or **Resolved**.

The bell on the file browser shows your **Notifications**: mentions, replies and invitations.

### Offline

Files on this device always work offline. A shared file you have opened before also opens offline from what this device last held. Changes you make offline wait (the header says "Offline — *N* changes waiting") and are sent and merged when the connection is back.

---

## Plugins and widgets

Plugins add commands to Evora. Widgets are live, clickable objects on the canvas. Both are installed on this device and are available in every file on it.

### Installing safely

Open **Main menu ▸ Plugins ▸ Manage plugins…**. The **Installed** tab has **Install from file…**, which takes a `.evora-plugin` file. The **Browse** tab lists the plugin directory on your collaboration server.

Before anything is installed, a dialog shows what the plugin asks to do. Install only what you trust, and only with permissions that make sense for it.

### Permissions

| Permission | What it allows |
|---|---|
| `read` | Read the current file: its pages, layers, selection, components, styles and variables |
| `write` | Change the current file: create, edit and delete layers, styles and variables |
| `export` | Export layers as pictures, SVG or PDF |
| `ui` | Show a window of its own |
| `storage` | Keep its own data on this device |

Plugins run apart from Evora and your other files, with no access to the network. They can do only what their permissions allow. A plugin without `write` cannot change your file, and no plugin can change a file you may only view.

### Running plugins

Installed, enabled plugins appear in **Main menu ▸ Plugins**. **Run last plugin** (**Ctrl+Alt+P**) runs the last one again. Each change a plugin makes is one undo step (a plugin can group several changes into one step), and on a shared file everyone sees the result.

### Widgets

Insert a widget from **Main menu ▸ Plugins ▸ Widgets**. Clicking a widget runs its action. The new state is one undo step, and everyone in a shared file sees it.

### The plugin manager

In **Manage plugins…**, each installed plugin has:

- **Run**, and a switch to enable or disable it.
- Its permissions, its **Stored data** (if it uses `storage`) and its **Console**, where its messages and errors appear.
- **Uninstall**, and **Publish to directory** when you are signed in.

The **Development** tab loads a plugin from its files (`manifest.json`, its code and its window's HTML) and reloads it after each change. The [plugin guide](../plugins/PLUGINS.md) explains how to write one.

Limits: a plugin stuck in an endless loop can freeze its tab. A plugin's errors appear only in its console.

---

## Community

The Community is a library of free files, templates, UI kits, component libraries, icon libraries, plugins and widgets, kept on your collaboration server. Open it from the file browser (**Community**).

### Publishing

From a file's menu in the file browser, choose **Publish to Community…**. Publishing needs a free account. Fill in:

- **Title**, **Type** (Design file, Template, UI kit, Component library or Icon library), **Description** and **Tags**.
- A cover is drawn from the file's first page.

A copy of the file as it is now is published. Later edits change nothing until you publish again. Publishing again from the same file adds a new version, with **What changed in this version**.

### Finding

The **Files & templates** tab has search, a **Type** filter, tags, and sorting by **Newest** or **Most duplicated**. The **Plugins & widgets** tab shows the plugin directory. Plugins are installed from the editor, under **Plugins**.

### Duplicating

On a resource's page:

- **Duplicate** copies it into a workspace (you need an account).
- **Open a copy on this device** works without an account.

**Your resources** lists what you have published, with **Unpublish…**. Copies people already made stay theirs.

Limits: a copy keeps the source file's name, not the resource's title.

---

## Projects, favourites, recents, search and trash

### Projects

Inside a workspace, choose **New project…** to group files. A project's menu has **Rename project…** and **Delete project…** (its files move to the workspace itself). A shared file's menu has **Move to…**, to move it to another project or workspace.

### Favourites and recents

Choose **Add to favorites** in a file's menu. A star then marks the file, and **Favorites** lists it. **Recents** lists the files you opened last. For shared files these are kept on the server. For files on this device they are kept on this device.

Recents of shared files are recorded when you open them from the file browser, not from a direct link.

### Search, sort and views

**Search files** at the top of the file browser searches both your local and your shared files. Above the files, you can **Filter files**, sort by **Last edited**, **Date created** or **Alphabetical**, and switch between **Grid view** and **List view**.

### Trash

Deleting a **shared** file (only an owner can) moves it to its workspace's **Trash**. Nobody can open it there, and anyone who has it open is disconnected. From the trash you can **Restore** it or **Delete forever…**. Files are deleted for good after 30 days.

Deleting a file **on this device** is permanent. There is no trash for local files.

---

## Desktop app specifics

### Open and save

The desktop app adds a native **File** menu with **New design file**, **New window** (**Ctrl+Shift+N**), **Open…** (**Ctrl+O**), **Open recent**, **Save** (**Ctrl+S**), **Save as…** (**Ctrl+Shift+S**) and **Save a copy as .fig…**.

Files can also reach the app by double-click (the installers register `.evora`, `.opendesign` and `.fig`), by dropping them on the window, or from the system's recent documents.

How saving works:

- The editor always works on a file in the app's library and saves it there automatically.
- A `.evora` file opened from disk is **linked** to its path. **Save** writes it back there. The window title shows **•** while the file on disk is behind.
- `.opendesign`, `.fig` and `.svg` files open as new, unlinked files. **Save** asks where to write a `.evora` file.
- **Save a copy as .fig…** writes a Figma file and lists what it cannot hold.

When you close a window with unsaved changes to a linked file, the app asks: **Save**, **Don't save** (the changes stay in the app's library, and the file on disk keeps its last saved version) or **Cancel**.

### Recovery

While a linked file has unsaved changes, the app keeps a recovery copy. If the app closes unexpectedly, the next start asks "Evora closed unexpectedly. Recover …?" with **Recover** or **Discard**.

If the window crashes or stops responding, the app offers to **Reload** it. Your file comes back from what was saved automatically.

The window's place and size are remembered.

### Collaboration settings

Choose **File ▸ Collaboration…** (on macOS, **Evora ▸ Collaboration…**).

- **Collaboration server**: type the server's address (for example `http://192.168.1.20:8787`) and choose **Connect**. **Use this computer only** goes back to working without a server. Changing this reloads the windows after saving them.

### Hosting a team server

In the same dialog, **Host a team server from this computer** runs Evora's server on your computer for people on your network.

1. Choose a **Port** (8787 by default) and whether to **Use it in this app**.
2. Choose **Start the server**.
3. The dialog lists the addresses others use, in a browser or in their own Evora app.

The server runs while Evora is open, and stops when you quit. Its accounts and files are kept in the app's data folder (the dialog shows where). Your system's firewall may ask whether Evora may accept connections. For a server that runs all the time, see the [self-hosting guide](self-hosting.md).

### Updates

An installed app checks for updates when it starts, and from **Help ▸ Check for updates…** (on macOS, **Evora ▸ Check for updates…**). It downloads in the background and offers **Restart to update** or **Later**. If you choose later, the update is installed when you quit.

- The portable Windows build does not update itself.
- On macOS, unsigned builds can find and download an update but cannot install it. The app offers the releases page instead.
- Updates have not been tried end to end yet, since no release has been published.

### Other menu items

**View ▸ Full screen** (**F11**; **Ctrl+Cmd+F** on macOS). **Help** has **Evora on GitHub**, **Report a problem**, **Show the app's data folder** and **Reload window**.

---

## Keyboard shortcuts

These are the shortcuts of Evora's command table, the same table the menus and **Help ▸ Keyboard shortcuts** are built from. On a Mac, **Cmd** works wherever the table says **Ctrl**.

> This table was generated from the command table in `src/state/commands.ts` (labels, shortcuts and groups) and the main menu's layout in `src/ui/editor/menus.ts`. Keep it in step with those files when commands change.

<!-- shortcuts:begin -->
| Group | Command | Shortcut | Where else to find it |
|---|---|---|---|
| Tools | Move | `V` | Tool dock |
| Tools | Hand | `H` | Tool dock |
| Tools | Frame | `F` | Tool dock |
| Tools | Rectangle | `R` | Tool dock |
| Tools | Ellipse | `O` | Tool dock |
| Tools | Line | `L` | Tool dock |
| Tools | Text | `T` | Tool dock |
| Tools | Pen | `P` | Tool dock |
| Tools | Pencil | `Shift+P` | Tool dock |
| Tools | Comment | `C` | Tool dock |
| Edit | Undo | `Ctrl+Z` | Main menu ▸ Edit |
| Edit | Redo | `Ctrl+Shift+Z` | Main menu ▸ Edit |
| Edit | Cut | `Ctrl+X` | Main menu ▸ Edit |
| Edit | Copy | `Ctrl+C` | Main menu ▸ Edit |
| Edit | Copy as PNG | `Ctrl+Shift+C` | Main menu ▸ Edit |
| Edit | Paste | `Ctrl+V` | Main menu ▸ Edit |
| Edit | Duplicate | `Ctrl+D` | Main menu ▸ Edit |
| Edit | Delete | `Delete` | Main menu ▸ Edit |
| Edit | Select all | `Ctrl+A` | Main menu ▸ Edit |
| Edit | Deselect / cancel | `Esc` | Main menu ▸ Edit |
| Edit | Nudge left | `←` | Shortcut only |
| Edit | Nudge right | `→` | Shortcut only |
| Edit | Nudge up | `↑` | Shortcut only |
| Edit | Nudge down | `↓` | Shortcut only |
| Edit | Nudge left by 10 | `Shift+←` | Shortcut only |
| Edit | Nudge right by 10 | `Shift+→` | Shortcut only |
| Edit | Nudge up by 10 | `Shift+↑` | Shortcut only |
| Edit | Nudge down by 10 | `Shift+↓` | Shortcut only |
| Object | Bring to front | `]` | Main menu ▸ Object |
| Object | Bring forward | `Ctrl+]` | Main menu ▸ Object |
| Object | Send backward | `Ctrl+[` | Main menu ▸ Object |
| Object | Send to back | `[` | Main menu ▸ Object |
| Object | Group selection | `Ctrl+G` | Main menu ▸ Object |
| Object | Ungroup | `Ctrl+Shift+G` | Main menu ▸ Object |
| Object | Create component | `Ctrl+Alt+K` | Main menu ▸ Object |
| Object | Detach instance | `Ctrl+Alt+B` | Main menu ▸ Object |
| Object | Add Auto Layout | `Shift+A` | Main menu ▸ Object |
| Object | Remove Auto Layout | `Alt+Shift+A` | Main menu ▸ Object |
| Object | Flatten to vector | `Ctrl+E` | Main menu ▸ Object |
| Object | Outline stroke | `Ctrl+Shift+O` | Main menu ▸ Object |
| Object | Use as mask | `Ctrl+Alt+M` | Main menu ▸ Object |
| Object | Union selection | `Ctrl+Alt+U` | Main menu ▸ Object |
| Object | Subtract selection | `Ctrl+Alt+S` | Main menu ▸ Object |
| Object | Intersect selection | `Ctrl+Alt+I` | Main menu ▸ Object |
| Object | Exclude selection | `Ctrl+Alt+X` | Main menu ▸ Object |
| Object | Flip horizontal | `Shift+H` | Main menu ▸ Object |
| Object | Flip vertical | `Shift+V` | Main menu ▸ Object |
| Object | Edit text or points | `Enter` | Main menu ▸ Object |
| Object | Join points | `Ctrl+J` | Main menu ▸ Object |
| Object | Rename | `Ctrl+Alt+R` | Main menu ▸ Object |
| Object | Show / hide | `Ctrl+Shift+H` | Main menu ▸ Object |
| Object | Lock / unlock | `Ctrl+Shift+L` | Main menu ▸ Object |
| Arrange | Align left | `Alt+A` | Main menu ▸ Arrange |
| Arrange | Align horizontal centres | `Alt+H` | Main menu ▸ Arrange |
| Arrange | Align right | `Alt+D` | Main menu ▸ Arrange |
| Arrange | Align top | `Alt+W` | Main menu ▸ Arrange |
| Arrange | Align vertical centres | `Alt+V` | Main menu ▸ Arrange |
| Arrange | Align bottom | `Alt+S` | Main menu ▸ Arrange |
| Arrange | Distribute horizontal spacing | `Ctrl+Alt+H` | Main menu ▸ Arrange |
| Arrange | Distribute vertical spacing | `Ctrl+Alt+V` | Main menu ▸ Arrange |
| View | Zoom in | `Ctrl++` | Main menu ▸ View |
| View | Zoom out | `Ctrl+-` | Main menu ▸ View |
| View | Zoom to fit | `Shift+1` | Main menu ▸ View |
| View | Zoom to selection | `Shift+2` | Main menu ▸ View |
| View | Zoom to 100% | `Shift+0` | Main menu ▸ View |
| View | Snap to objects | `Ctrl+Shift+'` | Main menu ▸ View |
| View | Snap to pixel grid | `Ctrl+Alt+'` | Main menu ▸ View |
| View | Present prototype | `Ctrl+Alt+Enter` | Main menu ▸ View |
| View | Prototype panel | `Shift+E` | Main menu ▸ View |
| View | Developer mode (Inspect) | `Shift+D` | Main menu ▸ View |
| View | Rulers and guides | `Shift+R` | Main menu ▸ View |
| View | Show layout grids | `Shift+G` | Main menu ▸ View |
| File | Save now | `Ctrl+S` | Main menu ▸ File |
| File | Save a copy to disk… | `Ctrl+Shift+S` | Main menu ▸ File |
| File | Place image… | `Ctrl+Shift+K` | Main menu ▸ File |
| File | Export… | `Ctrl+Shift+E` | Main menu ▸ File |
| Help | Keyboard shortcuts | `Ctrl+/` | Main menu ▸ Help |
<!-- shortcuts:end -->

Some keys also have a second binding in the command table: **Redo** is also **Ctrl+Y**, **Delete** is also **Backspace**, **Zoom in** and **Zoom out** also work with **=** and **-** without Ctrl, and **Zoom to 100%** is also **Ctrl+0**.

### Other keys

These are handled outside the command table, so they are listed by hand.

| Where | Keys | What they do |
|---|---|---|
| Canvas | Space + drag, or the middle button | Pan |
| Canvas | Ctrl + wheel, or pinch | Zoom |
| Canvas | Wheel (Shift for sideways) | Scroll |
| Canvas | Double-click, or Ctrl + click | Select inside |
| Canvas | Shift + click | Add to selection |
| Canvas | Alt + drag | Duplicate while moving |
| Canvas | Shift while dragging | Constrain |
| Canvas | Alt while resizing or drawing | From the centre |
| Canvas | Hold Alt | Measure distances from the selection |
| Editing text | Ctrl+B, Ctrl+I, Ctrl+U | Bold, italic, underline |
| Editing text | Escape or Ctrl+Enter | Finish editing |
| Editor | Ctrl+Alt+Shift+S | Save to version history |
| Editor | Ctrl+Alt+P | Run last plugin |
| Prototype viewer | R | Restart |
| Desktop app | Ctrl+O | Open… |
| Desktop app | Ctrl+S / Ctrl+Shift+S | Save / Save as… (to disk) |
| Desktop app | Ctrl+Shift+N | New window |
| Desktop app | Ctrl+W | Close window |
| Desktop app | F11 (Ctrl+Cmd+F on macOS) | Full screen |

---

## Troubleshooting

### Unsigned installer warnings

The installers are not code-signed yet.

- **Windows**: SmartScreen warns about an unknown publisher. Choose **More info**, then **Run anyway**.
- **macOS**: Gatekeeper refuses to open the app at first. Allow it in **System Settings ▸ Privacy & Security**, or right-click the app and choose **Open**.

### The app's data folder

In the desktop app, **Help ▸ Show the app's data folder** opens it. It holds:

- `settings.json` (the app's settings, such as the collaboration server) and `window-state.json` (where the window was).
- `recent-files.json` and `disk-links.json` (which library files are linked to which files on disk).
- `recovery/`, the recovery copies of files with unsaved changes.
- `team-server/`, the data of a team server hosted from this computer.

The app's own browser storage, which holds your library of files, is kept there too. Do not delete this folder unless you have copies of your files on disk.

### "This file is in the trash"

The shared file you opened was deleted and is in its workspace's trash. If you can restore it, choose **Go to the trash** and then **Restore**. It can be restored for 30 days after it was deleted. Otherwise, nobody can open it until someone who can edit its workspace restores it.

If the file was deleted while you had it open, you may see **No access** instead.

### "View only"

The **View only** badge in the file header means you cannot change this file. Hover over it to see why:

- "You can look and comment, but not change the design": your role is **Can view**, or the link gives view access. Ask an owner for edit access.
- "This branch has been merged into *main*; it can be viewed but not changed": the branch is archived. Open the main file instead.

### Where are my files?

- **In the browser**: in the browser's storage, for that browser profile and that address only. They are not in a folder you can browse. Use **File ▸ Save a copy to disk…** to keep a copy.
- **In the desktop app**: in the app's library, inside its data folder. Files you open from or save to disk are also on disk where you put them. **File ▸ Open recent** lists them.
- **Shared files**: on the collaboration server. A copy of what you last opened is kept on this device for offline use.

### Other messages

| Message | What to do |
|---|---|
| "This file had problems that were repaired when it was opened." | The file was damaged and has been fixed. Check the listed items. |
| "This file was saved by a newer version of Evora…" | Update Evora to open it. |
| **Figma file opened**, with a list | These parts of the `.fig` file could not be brought over. The rest of the file opens normally. |
| **Not saved** in the file header | Saving to this device failed. Hover over it for the reason, and save a copy to disk. |
| **Offline — *N* changes waiting** | Your changes are kept and will be sent when the connection is back. |
| "Evora's window stopped working." / "Evora is not responding." | Choose **Reload**. Your file comes back from what was saved automatically. |
| The Comment tool opens **Share**, saying comments are kept with shared files | Comments belong to shared files. Share the file first. |
