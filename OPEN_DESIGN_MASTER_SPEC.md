# OPEN DESIGN
## Master Product, Engineering & Implementation Prompt for Claude Code

You are acting as the principal software architect, senior frontend engineer, graphics-engine engineer, product designer, backend engineer and technical lead for a major open-source software project called **OPEN DESIGN**.

Your mission is to build a complete, professional-grade, standalone design and prototyping application that aims to achieve functional feature parity with Figma Design.

This is not a landing-page project, a basic vector editor, a static mockup or a simplified design tool.

It must be a fully functional, extensible, collaborative design platform that allows professional designers, developers, students, teams and businesses to create, edit, prototype, share, export and inspect designs.

The application must be completely free, with unrestricted editing and collaboration capabilities.

The product must NOT include Figma Make, prompt-to-app generation, AI-generated designs or AI design agents.

All traditional manual design, vector, layout, component, prototyping, collaboration and developer-handoff capabilities must be included.

---

# 1. PRODUCT IDENTITY AND CORE REQUIREMENTS

**Product name:** OPEN DESIGN

**Product category:** Open-source collaborative vector and interface design platform.

**Product objective:** Build an independent alternative to Figma Design with comprehensive design-editor functionality.

### Core principles

1. Completely free to use.
2. No subscription requirements.
3. No paid editing tools.
4. No paid collaboration features.
5. No artificial restrictions on the number of design files.
6. No artificial restrictions on the number of collaborators.
7. No paywalled export functionality.
8. No mandatory proprietary cloud service.
9. Support self-hosted deployment.
10. Support local-first document creation and editing.
11. Support multiple users editing the same document.
12. Provide a complete design and prototyping workflow.
13. Maintain a modular, extensible architecture.
14. Provide an open-source development and contribution model.
15. Prioritize performance, stability, accessibility and data integrity.

### Product scope

Build the following capabilities:

- Full design editor
- Infinite canvas
- Shape creation
- Vector drawing and editing
- Typography
- Image editing
- Layer management
- Frames and sections
- Constraints
- Auto Layout
- Components and instances
- Component variants
- Design systems
- Variables and design tokens
- Prototyping
- Interactive components
- Animation and transitions
- Export and import
- Real-time collaboration
- Comments
- Version history
- Developer Mode
- Plugins and widgets
- File and project management
- Team and workspace management
- Custom keyboard shortcuts
- Preferences and settings

Do not implement Figma Make or AI-based design generation.

---

# 2. APPLICATION ARCHITECTURE

Build OPEN DESIGN as a standalone application with a complete desktop-quality editing experience.

The application should support:

- Desktop browsers
- Windows desktop application
- macOS desktop application
- Linux desktop application
- Local development
- Self-hosted server deployment
- Optional hosted collaboration infrastructure

### Recommended technology stack

Use these technologies where appropriate. If the existing repository already has a sound architecture, inspect it first and preserve compatible technologies rather than unnecessarily rewriting everything.

**Frontend**
- React
- TypeScript
- Vite
- Tailwind CSS
- Zustand for state management
- React-based component system

**Graphics and canvas**
- WebGL
- Canvas 2D
- SVG
- Custom geometry and rendering engine
- OffscreenCanvas where appropriate
- Web Workers for expensive operations
- Spatial indexing for efficient selection and hit testing

**Backend**
- Node.js
- TypeScript
- REST APIs
- WebSockets
- PostgreSQL
- Redis where required for collaboration and caching
- S3-compatible storage for assets

**Collaboration**
- Yjs or an equivalent CRDT framework
- WebSockets
- Conflict-free document updates
- Presence management
- Cursor synchronization
- Collaborative selections

**Desktop**
- Tauri or Electron
- Native file access
- Native window management
- Local document storage

**Testing**
- Vitest
- Playwright
- React Testing Library
- Graphics and rendering regression tests

### Architectural separation

Build the application using independent modules:

1. Application shell
2. Canvas rendering engine
3. Document and scene graph engine
4. Input and interaction engine
5. Vector geometry engine
6. Typography engine
7. Layout engine
8. Auto Layout engine
9. Component engine
10. Variable and design-system engine
11. Image and asset engine
12. Prototype engine
13. Animation engine
14. Export and import engine
15. Collaboration engine
16. Plugin engine
17. File management engine
18. Developer inspection engine
19. Persistence and versioning engine
20. Authentication and permission engine

Each engine must have clear interfaces and responsibilities.

Do not put the entire application into one large React component.

---

# 3. COMPLETE EDITOR INTERFACE

Create a professional design-editor interface inspired by established design applications.

The interface must be functional, not decorative.

### Main editor layout

**Top toolbar**
- Application logo
- File name
- Save status
- Undo
- Redo
- Main tools
- Zoom percentage
- Resources
- Plugins
- Share
- Present
- Developer Mode
- Account and workspace controls

**Left sidebar**
- Pages
- Layers
- Assets
- Local components
- Shared components
- Libraries
- Layer search
- Layer filtering
- Hierarchical layer tree

**Central canvas**
- Infinite workspace
- Multiple frames
- Sections
- Shapes
- Images
- Text
- Components
- Vector paths
- Selection handles
- Alignment guides
- Snapping indicators
- Layout grids
- Rulers

**Right properties sidebar**

Include the following tabs:

1. Design
2. Prototype
3. Inspect / Dev Mode

The Design tab must provide context-sensitive controls depending on the selected object.

**Bottom interface**
- Contextual toolbar when appropriate
- Zoom and navigation controls
- Canvas status
- Selection information
- Additional workspace controls

### Main menus

Implement complete functional menus:

- File
- Edit
- View
- Object
- Text
- Arrange
- Vector
- Resources
- Plugins
- Help

Include:

- Right-click context menus
- Object-specific context menus
- Layer-specific context menus
- Canvas context menu
- Command search
- Quick actions
- Keyboard shortcut reference
- Preferences

All menu items must perform their intended actions.

Do not create buttons that look functional but do nothing.

---

# 4. FILE MANAGEMENT AND DOCUMENT SYSTEM

Implement a complete document-management system.

### File operations
- Create design file
- Open design file
- Rename file
- Duplicate file
- Delete file
- Move file
- Copy file
- Import file
- Export file
- Save file
- Save as
- Autosave
- Restore file
- Recover unsaved changes

### Organization
- Workspaces
- Teams
- Projects
- Folders
- Subfolders
- Drafts
- Recent files
- Favorites
- Shared files
- Archived files
- Search files
- File thumbnails
- File descriptions

### Document functionality
- Multiple pages per document
- Page creation
- Page deletion
- Page duplication
- Page renaming
- Page reordering
- Page navigation
- Page-level properties
- Page-level backgrounds
- Page-level design organization

### Persistence

Create a robust native OPEN DESIGN document format.

The format must support:

- Document metadata
- Pages
- Scene graph
- Frames
- Groups
- Layers
- Shapes
- Vector paths
- Text
- Images
- Components
- Instances
- Variables
- Styles
- Constraints
- Auto Layout properties
- Prototype connections
- Animations
- Asset references

Use versioned document schemas and migrations.

Implement reliable autosave, recovery, backups and undo/redo.

The native document must not depend on Figma's servers or file format.

---

# 5. INFINITE CANVAS ENGINE

Build a high-performance infinite canvas.

### Navigation
- Pan
- Zoom
- Zoom to fit
- Zoom to selection
- Zoom to 100%
- Custom zoom percentage
- Mouse-wheel zoom
- Trackpad zoom
- Spacebar + drag
- Middle-mouse drag
- Keyboard navigation
- Canvas centering
- Canvas rotation if supported

### Canvas functionality
- Infinite workspace
- Multiple frames
- Multiple sections
- Multiple pages
- Canvas background
- Rulers
- Guides
- Smart guides
- Grid display
- Pixel grid
- Alignment indicators
- Snap to grid
- Snap to objects
- Snap to guides
- Snap to pixel
- Object distance indicators
- Measurement overlays
- Marquee selection
- Multi-selection
- Selection bounding boxes

### Rendering requirements

Implement:
- Efficient rendering of large documents
- Viewport culling
- Spatial indexing
- Dirty-region rendering
- GPU acceleration
- Batched drawing
- High-DPI display support
- Correct zoom transformations
- Correct object transforms
- Smooth canvas interactions

The canvas must remain usable with thousands of objects.

Do not rely exclusively on DOM elements to render every canvas object.

---

# 6. TOOLBAR AND CREATION TOOLS

Implement all essential design tools.

### Selection and navigation
- Move tool (V)
- Hand tool (H)
- Scale tool (K)
- Selection tool
- Marquee selection
- Multi-selection

### Frame and organization
- Frame tool (F)
- Section tool
- Slice tool (S)

### Shape tools
- Rectangle (R)
- Line (L)
- Arrow
- Ellipse (O)
- Polygon
- Star
- Arc
- Custom shapes

### Drawing tools
- Pen (P)
- Pencil (Shift + P)
- Vector editing
- Freehand drawing
- Brush functionality where supported

### Text and collaboration tools
- Text (T)
- Comment (C)
- Annotation
- Measurement

### Tool behavior

Every tool must have:
- A working keyboard shortcut
- Active tool state
- Cursor state
- Tool-specific settings
- Correct mouse interactions
- Correct touch interactions where supported
- Selection and manipulation behavior
- Undo/redo integration

Implement contextual toolbars and tool-specific property controls.

---

# 7. SHAPE CREATION AND MANIPULATION ENGINE

Support:

- Rectangles
- Rounded rectangles
- Circles
- Ellipses
- Lines
- Arrows
- Polygons
- Stars
- Arcs
- Custom vector shapes

### Shape properties
- X position
- Y position
- Width
- Height
- Rotation
- Opacity
- Corner radius
- Independent corner radii
- Corner smoothing
- Fill
- Stroke
- Stroke width
- Stroke alignment
- Stroke cap
- Stroke join
- Dashed borders
- Blend mode
- Effects

### Shape operations
- Create
- Delete
- Duplicate
- Copy
- Paste
- Cut
- Resize
- Rotate
- Flip horizontally
- Flip vertically
- Align
- Distribute
- Group
- Ungroup
- Lock
- Unlock
- Hide
- Show
- Flatten
- Outline stroke
- Clip content
- Boolean operations

### Boolean operations
- Union
- Subtract
- Intersect
- Exclude

All shape operations must update the underlying document model and support undo/redo.

---

# 8. VECTOR EDITING ENGINE

This is a major priority.

Build a professional vector-editing system.

### Pen tool
- Click to create anchor points
- Click and drag to create curves
- Bezier curves
- Control handles
- Open paths
- Closed paths
- Smooth curves
- Corner points

### Node editing
- Add nodes
- Delete nodes
- Move nodes
- Select nodes
- Multi-select nodes
- Convert corner points
- Convert smooth points
- Convert mirrored points
- Edit handles independently
- Join paths
- Split paths
- Close paths
- Break paths
- Reverse path direction

### Advanced vector features
- Vector networks
- Path manipulation
- Stroke editing
- Variable-width strokes
- Arc editing
- Vector eraser
- Path flattening
- Outline strokes
- Shape conversion
- Boolean operations
- Vector transformations
- Freehand paths
- Text on path

Provide precise coordinate handling and high-quality Bézier rendering.

---

# 9. TYPOGRAPHY ENGINE

Build a complete text-editing system.

### Text functionality
- Create text layers
- Edit text inline
- Select text ranges
- Copy and paste text
- Resize text
- Fixed-width text
- Auto-width text
- Auto-height text
- Text boxes
- Text alignment
- Vertical alignment
- Paragraph spacing
- Line height
- Letter spacing
- Word spacing
- Indentation
- Text decoration
- Text transformation
- Uppercase
- Lowercase
- Capitalization
- Bulleted lists
- Numbered lists
- Text direction
- Text on path

### Font management
- Font family
- Font size
- Font weight
- Font style
- Variable fonts
- Font collections
- Local fonts
- Custom fonts
- Font loading
- Font fallback
- Font availability checks
- Font preview

### Text styling
- Multiple fills
- Multiple strokes
- Text gradients
- Text shadows
- Text opacity
- Blend modes
- Text effects
- Shared text styles

Preserve typography metrics, line wrapping and text measurements during resizing and exporting.

---

# 10. IMAGE AND MEDIA ENGINE

Implement a complete image placement and manipulation workflow.

### Import
- PNG
- JPG/JPEG
- SVG
- WebP
- GIF
- PDF import where supported
- Clipboard images
- Drag-and-drop images

### Image operations
- Insert image
- Replace image
- Crop image
- Resize image
- Rotate image
- Position image
- Scale image
- Image opacity
- Image masking
- Image clipping
- Image fills
- Image adjustments
- Image export
- Image replacement without losing layout

### Image fill modes
- Fill
- Fit
- Crop
- Tile

Support:
- Transparency
- Aspect ratio
- High-resolution assets
- Image previews
- Image asset management
- Efficient image caching

Do not implement AI image generation or AI background removal.

---

# 11. FILLS, STROKES, EFFECTS AND APPEARANCE

### Fill system
- Solid colors
- Linear gradients
- Radial gradients
- Angular gradients
- Diamond gradients
- Multiple fills
- Fill opacity
- Fill visibility
- Gradient stops
- Gradient positioning
- Color picker
- Eyedropper
- HEX
- RGB
- HSL
- Alpha channel
- Color styles
- Variable-bound colors

### Stroke system
- Stroke color
- Stroke width
- Inside alignment
- Center alignment
- Outside alignment
- Stroke caps
- Stroke joins
- Dashed strokes
- Multiple strokes
- Stroke opacity
- Stroke visibility

### Effects
- Drop shadow
- Inner shadow
- Layer blur
- Background blur
- Multiple effects
- Blur radius
- Shadow X/Y
- Shadow spread
- Shadow color
- Effect opacity
- Effect visibility

### Appearance
- Opacity
- Blend modes
- Corner radius
- Independent corner radii
- Layer visibility
- Layer locking
- Background properties

Implement editable effect stacks.

---

# 12. LAYERS AND SCENE GRAPH

Build a robust hierarchical scene graph.

### Layer types
- Frames
- Sections
- Groups
- Rectangles
- Ellipses
- Lines
- Polygons
- Stars
- Text
- Vector paths
- Images
- Components
- Component instances
- Slices

### Layer management
- Create layers
- Rename layers
- Delete layers
- Duplicate layers
- Group
- Ungroup
- Nest
- Reparent
- Lock
- Unlock
- Hide
- Show
- Reorder
- Drag and drop
- Collapse
- Expand
- Select parent
- Select child
- Select siblings
- Multi-select
- Search
- Filter
- Copy properties
- Paste properties
- Bulk editing

### Scene graph requirements
- Parent-child relationships
- Hierarchical transforms
- Clipping
- Inheritance
- Layer ordering
- Layer metadata
- Stable object IDs
- Document references
- Efficient selection
- Efficient rendering

Keep the layer panel synchronized with the actual canvas document model.

---

# 13. POSITIONING, ALIGNMENT AND ARRANGEMENT

### Transform properties
- X
- Y
- Width
- Height
- Rotation
- Aspect ratio locking
- Proportional scaling
- Horizontal flip
- Vertical flip
- Fixed dimensions
- Min/max dimensions

### Alignment
- Align left
- Align center
- Align right
- Align top
- Align middle
- Align bottom
- Distribute horizontally
- Distribute vertically
- Smart spacing
- Tidy up
- Smart selection

### Arrangement
- Bring to front
- Send to back
- Bring forward
- Send backward
- Group
- Ungroup
- Frame selection
- Flatten
- Clip content
- Boolean operations

Support keyboard-based nudging and precision positioning.

---

# 14. FRAMES, CONSTRAINTS AND LAYOUT GRIDS

### Frames
- Custom frames
- Desktop presets
- Mobile presets
- Tablet presets
- Device presets
- Frame backgrounds
- Nested frames
- Frame resizing
- Frame rotation
- Frame clipping
- Frame selection
- Frame export

### Constraints
- Left
- Right
- Top
- Bottom
- Center
- Left and right
- Top and bottom
- Scale

### Layout grids
- Grid
- Columns
- Rows
- Gutter
- Margin
- Alignment
- Multiple grids
- Custom grid configurations
- Grid visibility
- Grid editing

### Responsive behavior
- Fixed dimensions
- Hug contents
- Fill container
- Minimum dimensions
- Maximum dimensions
- Nested layouts
- Responsive resizing
- Constraints-based resizing

Ensure the actual geometry updates when frames are resized.

---

# 15. AUTO LAYOUT ENGINE

This is one of the most important modules.

Build a functional Auto Layout engine, not just a visual settings panel.

### Layout directions
- Horizontal
- Vertical

### Spacing
- Fixed spacing
- Automatic spacing
- Space between
- Item spacing
- Horizontal padding
- Vertical padding
- Independent padding

### Alignment
- Main-axis alignment
- Cross-axis alignment
- Start
- Center
- End
- Space between
- Stretch where supported

### Resizing
- Fixed width
- Fixed height
- Hug contents
- Fill container
- Minimum width
- Maximum width
- Minimum height
- Maximum height

### Advanced behavior
- Wrapping
- Nested Auto Layout
- Reverse order
- Absolute positioning
- Layout participation controls
- Nested responsive behavior
- Dynamic content resizing
- Automatic container resizing
- Child alignment
- Child spacing
- Layout direction changes

### Required behavior

Example:

Create a button with:
- Text: Get Started
- Horizontal padding: 24px
- Vertical padding: 12px
- Gap: 8px
- Radius: 8px

When the text changes to "Get Started Today", the button must automatically resize.

When a child is removed, the layout must recalculate.

When the container width changes, children must respond according to their sizing rules.

All calculations must update immediately and consistently.

---

# 16. COMPONENTS AND INSTANCES

Implement a reusable component system.

### Component operations
- Create component
- Create component set
- Main component
- Component instance
- Duplicate component
- Detach instance
- Swap instance
- Reset instance
- Replace instance
- Component description
- Component organization
- Component search
- Component publishing
- Component importing
- Nested components
- Component overrides

### Component properties
- Boolean properties
- Text properties
- Instance swap properties
- Variant properties
- Exposed nested properties

### Variants

Support combinations such as:

Button:
- Type: Primary / Secondary / Tertiary
- Size: Small / Medium / Large
- State: Default / Hover / Pressed / Disabled / Loading
- Appearance: Filled / Outlined / Text

The right sidebar must expose variant controls.

Changing a variant must update the selected instance correctly.

### Instance behavior
- Override text
- Override images
- Override fills where permitted
- Override visibility where permitted
- Preserve overrides
- Reset overrides
- Change component source
- Swap components
- Handle nested component overrides

Component updates must propagate to instances without unexpectedly destroying overrides.

---

# 17. DESIGN SYSTEMS, STYLES AND VARIABLES

### Shared styles
- Color styles
- Text styles
- Effect styles
- Grid styles
- Local styles
- Shared styles
- Create styles
- Edit styles
- Apply styles
- Detach styles
- Publish styles
- Import styles

### Variables
- Color variables
- Number variables
- String variables
- Boolean variables
- Variable collections
- Variable modes
- Light mode
- Dark mode
- Variable aliases
- Variable references
- Variable scopes
- Variable descriptions
- Variable editing
- Variable binding
- Variable publishing
- Variable importing

### Design tokens

Support reusable tokens for:
- Colors
- Spacing
- Typography
- Border radius
- Shadows
- Dimensions
- Opacity
- Other supported numerical properties

Example:

Primary color: #2563EB
Background: #FFFFFF
Text primary: #111827
Spacing: 16px
Radius: 8px
Font size: 16px

When a token changes, all bound elements should update automatically.

Implement semantic tokens and aliases.

---

# 18. PROTOTYPING ENGINE

Traditional manual prototyping is mandatory.

Do not confuse this with Figma Make.

### Prototype connections
- Connect frames
- Connect components
- Create interactions
- Set starting frames
- Create multiple flows
- Name flows
- Connect overlays
- Navigate between screens

### Triggers
- On click
- On tap
- On drag
- While hovering
- While pressing
- After delay
- Keyboard interactions
- Gamepad interactions where supported

### Actions
- Navigate to
- Open overlay
- Swap overlay
- Close overlay
- Scroll to
- Back
- Change to
- Set variable
- Conditional actions
- Multiple actions

### Transitions
- Instant
- Dissolve
- Smart Animate
- Move in
- Move out
- Push
- Slide in
- Slide out
- Custom easing
- Duration
- Delay

### Advanced prototyping
- Interactive components
- Component state changes
- Overlays
- Modal windows
- Dropdowns
- Hover states
- Press states
- Scroll behavior
- Fixed elements
- Sticky elements
- Horizontal scrolling
- Vertical scrolling
- Nested interactions
- Variables
- Conditional logic
- Expressions
- Interactive input fields
- Prototype permissions

### Prototype viewer
- Full-screen preview
- Device frames
- Presentation mode
- Flow navigation
- Interactive testing
- Shareable prototype links
- Browser-based preview
- Responsive viewing

### Smart Animate

Implement property-based animation between matching objects.

Support interpolation of:
- Position
- Size
- Rotation
- Opacity
- Fill
- Stroke
- Corner radius
- Other supported visual properties

Use stable layer matching and predictable animation behavior.

---

# 19. EXPORT AND IMPORT ENGINE

### Export formats
- PNG
- JPG/JPEG
- SVG
- PDF

### Export capabilities
- Export selected objects
- Export frames
- Export pages
- Export multiple objects
- Multiple scales
- 1x
- 2x
- 3x
- Custom scale
- Custom dimensions
- Transparent backgrounds
- SVG configuration
- PDF configuration
- File naming
- Export suffixes
- Batch export
- Copy as PNG
- Copy as SVG
- Copy as CSS where applicable

### Import capabilities
- SVG
- PNG
- JPG
- WebP
- GIF
- PDF
- Clipboard images
- Drag-and-drop assets
- Supported vector formats
- Supported document formats

Implement reliable rendering and correct asset resolution.

---

# 20. REAL-TIME COLLABORATION

All editing functionality must be available to collaborators without payment.

### Collaboration
- Multiple users in one document
- Real-time editing
- Live cursor positions
- User avatars
- Cursor labels
- Live selection indicators
- Collaborative selection
- Collaborative layer editing
- Shared canvas state
- Shared document changes
- Presence management
- User activity

### Comments
- Add comments
- Reply to comments
- Comment threads
- Resolve comments
- Reopen comments
- Mention collaborators
- Comment notifications
- Comment positioning
- Comment permissions

### Sharing
- Shareable document links
- View access
- Edit access
- Team access
- Workspace access
- Document permissions
- Guest collaboration
- Public sharing options

### Technical requirements
- CRDT-based synchronization
- WebSocket communication
- Offline editing
- Reconnection handling
- Conflict resolution
- Concurrent editing
- Operation ordering
- Presence synchronization
- Collaborative undo/redo strategy
- Document synchronization
- Recovery after disconnection

Use Yjs or an equivalent technology where appropriate.

The collaboration engine must preserve document consistency when multiple users edit simultaneously.

No paid collaborator seats or edit restrictions.

---

# 21. VERSION HISTORY AND BRANCHING

Implement:
- Automatic version snapshots
- Manual version creation
- Version history
- Version comparison
- Restore previous version
- Version naming
- Version descriptions
- Change tracking
- Document backups
- Recovery

### Branching and merging
- Create branches
- Work independently
- Compare branches
- Merge changes
- Resolve conflicts
- Preserve document history

Implement branching carefully so concurrent editing and document recovery remain reliable.

---

# 22. DEVELOPER MODE

Provide a dedicated inspection and handoff mode.

### Inspection
- Inspect selected layers
- Width
- Height
- Position
- Spacing
- Padding
- Typography
- Colors
- Borders
- Effects
- Auto Layout
- Components
- Variables
- Design tokens

### Code inspection
- CSS properties
- iOS-related snippets
- Android-related snippets
- Asset inspection
- SVG export
- Image export
- Code Connect-style component mapping
- Token inspection

### Developer workflow
- Design annotations
- Measurements
- Development status
- Ready for development
- Compare design changes
- Track changes
- Component inspection
- Development resources
- VS Code integration

The Dev Mode must inspect the actual document model rather than display hardcoded sample properties.

---

# 23. PLUGINS, WIDGETS AND EXTENSIBILITY

Build a plugin architecture that allows external developers to extend OPEN DESIGN.

### Plugin functionality
- Plugin marketplace
- Install plugins
- Run plugins
- Uninstall plugins
- Manage plugins
- Plugin search
- Plugin permissions
- Plugin settings
- Plugin UI
- Plugin APIs
- Plugin documentation
- Plugin development tools

### Plugin API

Provide controlled access to:
- Current document
- Selected objects
- Pages
- Layers
- Components
- Variables
- Styles
- Object creation
- Object modification
- Notifications
- Document events
- Selection events
- Export functionality where authorized

### Widgets
- Custom widgets
- Widget UI
- Widget state
- Document interactions
- Custom controls

### Resource ecosystem
- Components
- Libraries
- Plugins
- Widgets
- Local assets
- Published assets
- Templates
- UI kits
- Icon libraries
- Community resources

Use sandboxing and permission controls for third-party plugins.

---

# 24. COMMUNITY AND RESOURCE LIBRARY

Create an optional public resource ecosystem.

### Community capabilities
- Publish design files
- Browse public files
- Duplicate public resources
- Share templates
- Share UI kits
- Publish components
- Publish plugins
- Publish widgets
- Download assets
- Search resources
- View resource descriptions
- Resource versioning

All resources should remain usable without paid subscriptions.

---

# 25. KEYBOARD SHORTCUT SYSTEM

Implement a complete keyboard shortcut system.

Initial shortcuts:

| Action | Windows |
|---|---|
| Move | V |
| Hand | H |
| Scale | K |
| Frame | F |
| Rectangle | R |
| Ellipse | O |
| Line | L |
| Text | T |
| Pen | P |
| Pencil | Shift + P |
| Comment | C |
| Undo | Ctrl + Z |
| Redo | Ctrl + Shift + Z |
| Copy | Ctrl + C |
| Paste | Ctrl + V |
| Duplicate | Ctrl + D |
| Group | Ctrl + G |
| Ungroup | Ctrl + Shift + G |
| Quick actions | Ctrl + K |
| Zoom to fit | Shift + 1 |
| Zoom to selection | Shift + 2 |
| Zoom to 100% | Shift + 0 |

Also support:
- Configurable shortcuts
- Shortcut search
- Shortcut reference
- Context-sensitive shortcuts
- Multi-selection shortcuts
- Nudge shortcuts
- Precision positioning
- Modifier keys
- Mac keyboard equivalents

---

# 26. SETTINGS AND PREFERENCES

Implement:
- Light theme
- Dark theme
- Canvas background
- Ruler settings
- Grid settings
- Zoom settings
- Measurement units
- Pixel snapping
- Nudge settings
- Color profiles
- Font settings
- Autosave settings
- File settings
- Notifications
- Account settings
- Workspace settings
- Privacy settings
- Collaboration settings
- Plugin settings
- Keyboard shortcuts
- Accessibility preferences

---

# 27. PERFORMANCE AND QUALITY REQUIREMENTS

OPEN DESIGN must be engineered for professional workloads.

### Performance
- Smooth canvas navigation
- Responsive selection
- Efficient rendering
- Efficient hit testing
- Efficient vector calculations
- Efficient text rendering
- Asset caching
- Lazy loading
- Virtualized layer lists
- Viewport culling
- GPU acceleration
- Background processing
- Memory management

### Document stability
- Autosave
- Crash recovery
- Undo/redo
- Document validation
- Schema migrations
- Asset integrity
- Reliable import/export
- Corruption detection
- Backup and restoration

### Accessibility
- Keyboard navigation
- Screen-reader support for application controls
- Accessible menus
- High-contrast support
- Focus management
- Keyboard-operable controls

### Security
- Secure authentication
- Session management
- Document access permissions
- Secure file uploads
- Plugin sandboxing
- API authorization
- Rate limiting against abuse
- Secure WebSocket connections
- Data isolation between users and workspaces

---

# 28. STANDALONE APPLICATION AND DEPLOYMENT

OPEN DESIGN must not depend on Figma or any Figma account.

### Deployment modes

**Mode A: Local application**
- Run locally
- Create local files
- Edit offline
- Import and export locally
- Local autosave
- No mandatory account

**Mode B: Self-hosted**
- Deploy the backend independently
- PostgreSQL database
- Object storage
- Collaboration server
- Authentication
- User management
- Workspace management

**Mode C: Public hosted service**
- Free accounts
- Free editing
- Free collaboration
- Free file sharing
- Free exports
- Free design features

No feature should be artificially locked behind a paid subscription.

### Desktop support
- Windows
- macOS
- Linux

The desktop app should provide native-feeling window management, file access and application controls.

---

# 29. PRODUCT UI AND VISUAL DESIGN

The application should look and feel like a polished professional desktop design tool.

### Design direction
- Professional
- Minimal
- Clean
- High information density
- Precise spacing
- Consistent icons
- Clear visual hierarchy
- Neutral interface colors
- Customizable themes

### Interface behavior
- Resizable sidebars
- Collapsible panels
- Tooltips
- Context menus
- Keyboard navigation
- Searchable commands
- Property controls
- Numeric inputs
- Color pickers
- Dropdowns
- Popovers
- Sliders
- Checkboxes
- Toggle controls
- Drag-and-drop
- Contextual toolbars

All panels must interact with the real document model.

Avoid unnecessary animations that interfere with the design workflow.

Create an original OPEN DESIGN visual identity rather than copying proprietary Figma branding.

---

# 30. EXPLICIT EXCLUSIONS: FIGMA MAKE AND AI

Do not implement:

- Figma Make
- AI prompt-to-app generation
- AI-generated interfaces
- AI-generated layouts
- AI-generated prototypes
- AI design agents
- AI design editing
- AI-generated illustrations
- AI image generation
- AI background removal
- AI-powered text rewriting
- AI-powered layer renaming
- AI-powered content replacement
- AI-based design generation workflows

Do not remove traditional manual tools because an equivalent AI capability exists in another product.

Keep manual drawing, manual editing, manual prototyping and traditional design workflows fully functional.

---

# 31. IMPLEMENTATION STRATEGY

Do not attempt to generate the entire application in one enormous untested code-generation operation.

Work incrementally and maintain a functional application at every milestone.

### Phase 0 — Repository audit and planning

Before modifying code:

1. Inspect the entire existing repository.
2. Identify the current framework.
3. Identify existing components.
4. Identify backend infrastructure.
5. Identify existing rendering libraries.
6. Identify incomplete functionality.
7. Identify reusable code.
8. Inspect package dependencies.
9. Identify architecture limitations.
10. Create a technical implementation plan.

Do not overwrite existing working functionality unnecessarily.

Create:

- PROJECT_ARCHITECTURE.md
- PRODUCT_REQUIREMENTS.md
- IMPLEMENTATION_ROADMAP.md
- DOCUMENT_SCHEMA.md
- ENGINEERING_DECISIONS.md
- FEATURE_TRACKER.md

### Phase 1 — Editor foundation

Build:
- Application shell
- Top toolbar
- Left sidebar
- Right sidebar
- Infinite canvas
- Zoom and pan
- Selection
- Frames
- Layers
- Basic shapes
- Position and dimension properties
- Undo and redo
- Document persistence

Acceptance criterion: A user can create a document, create frames, draw shapes, move and resize objects, manage layers, save and reopen their work.

### Phase 2 — Design functionality

Build:
- Shape properties
- Fills
- Strokes
- Effects
- Typography
- Image import
- Image cropping
- Alignment
- Distribution
- Grouping
- Clipping
- Rulers
- Guides
- Snapping
- Layout grids
- Constraints

Acceptance criterion: A designer can create a complete static UI design without needing another design application.

### Phase 3 — Advanced vector editing

Build:
- Pen
- Pencil
- Bezier curves
- Nodes
- Control handles
- Vector networks
- Boolean operations
- Path editing
- Arc tools
- Advanced stroke editing

Acceptance criterion: A designer can create and edit vector illustrations and icons.

### Phase 4 — Auto Layout and responsive design

Build:
- Horizontal and vertical Auto Layout
- Padding
- Spacing
- Alignment
- Wrapping
- Hug contents
- Fill container
- Fixed dimensions
- Constraints
- Responsive resizing
- Nested layouts

Acceptance criterion: Complex responsive UI components work correctly when content and dimensions change.

### Phase 5 — Components and design systems

Build:
- Components
- Instances
- Component sets
- Variants
- Component properties
- Instance overrides
- Libraries
- Styles
- Variables
- Modes
- Design tokens

Acceptance criterion: Designers can build a reusable design system and maintain consistency across multiple pages.

### Phase 6 — Prototyping

Build:
- Prototype connections
- Triggers
- Actions
- Transitions
- Smart Animate
- Overlays
- Scroll behavior
- Interactive components
- Variables
- Conditional logic
- Presentation mode

Acceptance criterion: Users can build and share fully interactive prototypes.

### Phase 7 — Export and production workflows

Build:
- PNG
- JPG
- SVG
- PDF
- Batch export
- Import improvements
- Developer Mode
- Measurements
- Code inspection
- Annotations

Acceptance criterion: Designs can be handed off to developers and exported for production.

### Phase 8 — Collaboration

Build:
- Authentication
- Workspaces
- User management
- Document permissions
- Real-time editing
- Multiplayer cursors
- Comments
- Sharing
- CRDT synchronization
- Offline recovery

Acceptance criterion: Multiple users can edit the same document simultaneously without losing changes.

### Phase 9 — Ecosystem

Build:
- Plugins
- Plugin APIs
- Widgets
- Libraries
- Community resources
- Version history
- Branching
- Merging
- Advanced file management

Acceptance criterion: External developers can extend OPEN DESIGN and users can manage complex collaborative projects.

### Phase 10 — Desktop and production release

Build:
- Windows application
- macOS application
- Linux application
- Local-first workflows
- Self-hosted deployment
- Documentation
- Security testing
- Performance testing
- Release pipeline

Acceptance criterion: OPEN DESIGN can be installed and operated independently of Figma.

---

# 32. ENGINEERING RULES FOR CLAUDE CODE

Follow these rules throughout development.

1. Do not build fake functionality.
2. Do not use placeholder buttons for core features.
3. Do not simulate working Auto Layout with static styling.
4. Do not simulate components with ordinary duplicated objects.
5. Do not hardcode design properties.
6. Do not create a canvas that only looks interactive.
7. Do not store all design objects in component-local React state.
8. Do not implement collaboration as cursor animations without actual synchronization.
9. Do not implement version history as a list of fake entries.
10. Do not implement export by taking arbitrary screenshots when proper rendering is required.
11. Do not ignore undo/redo integration.
12. Do not break previously completed functionality when adding new modules.
13. Do not replace the document model with temporary UI state.
14. Do not leave TypeScript errors.
15. Do not ignore runtime errors.
16. Do not skip automated testing.
17. Do not unnecessarily rewrite stable architecture.
18. Do not install large dependencies without evaluating their purpose.
19. Do not implement paid restrictions.
20. Do not introduce Figma Make or AI features.

### Required engineering practices

For every feature:

- Define requirements.
- Define data structures.
- Define user interactions.
- Implement the backend or engine logic where necessary.
- Implement the UI.
- Connect UI to the document model.
- Implement undo/redo.
- Implement persistence.
- Implement collaboration compatibility where relevant.
- Add automated tests.
- Verify actual functionality.
- Update documentation.
- Update the feature tracker.

Use stable IDs for document objects.

Maintain a clear separation between document state, editor state, transient interaction state and collaborative state.

Implement migrations whenever the document schema changes.

---

# 33. ACCEPTANCE TESTING

Create automated tests for every major module.

### Canvas tests
- Create frame
- Move object
- Resize object
- Rotate object
- Zoom
- Pan
- Multi-select
- Snap to grid
- Snap to objects

### Vector tests
- Create path
- Add node
- Remove node
- Move node
- Edit Bezier handles
- Close path
- Join paths
- Perform Boolean operations

### Auto Layout tests
- Horizontal layout
- Vertical layout
- Padding
- Spacing
- Hug contents
- Fill container
- Wrapping
- Nested layout
- Dynamic text resizing

### Component tests
- Create component
- Create instance
- Change master component
- Preserve instance overrides
- Swap instance
- Change variant
- Reset overrides

### Prototype tests
- Create connection
- Trigger click
- Navigate between frames
- Open overlay
- Close overlay
- Run transition
- Change component state
- Execute conditional action

### Collaboration tests
- Two users edit simultaneously
- Multiple users create objects
- Concurrent text editing
- Concurrent object movement
- Disconnect and reconnect
- Conflict resolution
- Permission enforcement
- Document recovery

### Export tests
- Export PNG
- Export JPG
- Export SVG
- Export PDF
- Verify dimensions
- Verify transparency
- Verify text and vector fidelity

All tests must verify real application behavior.

---

# 34. PROJECT COMPLETION CRITERIA

OPEN DESIGN should not be declared complete simply because the editor looks good.

The project is complete only when:

- Every core design tool works.
- The canvas is genuinely interactive.
- The layer system works.
- Vector editing works.
- Typography works.
- Image editing works.
- Auto Layout works.
- Components and variants work.
- Variables and styles work.
- Prototyping works.
- Export works.
- Import works.
- Collaboration works.
- Comments work.
- Version history works.
- Developer Mode works.
- Plugins can be installed and executed securely.
- Files persist reliably.
- Local editing works.
- Self-hosted deployment works.
- Desktop packaging works.
- All major features have automated tests.
- There are no critical unresolved data-loss bugs.

Maintain a feature-completion matrix with:

- Not started
- In progress
- Implemented
- Tested
- Production ready

Do not mark a feature complete merely because its UI exists.

---

# 35. FIRST ACTION REQUIRED

Start by auditing the existing OPEN DESIGN repository.

Do not immediately generate a new application or replace existing code.

First:

1. Inspect the project structure.
2. Understand the existing implementation.
3. Identify the current working functionality.
4. Identify incomplete modules.
5. Map the current architecture against this specification.
6. Identify missing dependencies.
7. Recommend the most suitable rendering and document architecture.
8. Create the required project documentation.
9. Create a detailed phased implementation plan.
10. Identify the first milestone that can be implemented safely.

After the audit, begin Phase 1.

Work directly in the existing repository.

Implement features completely, test them and preserve working functionality.

Continue through the phases systematically. Do not stop after building the editor shell or a visually convincing prototype.

If a task is too large for one session, document the exact implementation state, completed features, outstanding work, relevant files, known bugs and next actions so development can resume without losing context.

**The ultimate objective: OPEN DESIGN must become a genuinely usable, professional-grade, free and open-source design platform, with the complete traditional Figma Design workflow and no Figma Make or AI design-generation functionality.**

Build the real product, not just its appearance.
