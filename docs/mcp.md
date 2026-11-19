# Design with your AI agent (MCP)

Evora comes with an [MCP](https://modelcontextprotocol.io) server, so AI agents such as **Claude Code, Cursor, Claude Desktop, VS Code and Windsurf** can create and edit Evora designs. Ask your agent for a screen, a component or a whole flow, then open the file in Evora to refine it yourself.

Everything stays on your computer: the server reads and writes `.evora` files in one folder you choose, and talks to nothing on the internet.

## Get it

You need [Node.js](https://nodejs.org/) 20 or later.

- **Download** `evora-mcp.mjs` from the [latest release](https://github.com/ShishirShastry/evora/releases/latest). It is one file with nothing else to install.
- **Or build it** from a clone of this repository: `npm ci`, then `npm run mcp:build`, which writes `dist-mcp/evora-mcp.mjs`.

## Connect your agent

In the examples, replace `/path/to/evora-mcp.mjs` with where you saved the file, and `~/Designs` with the folder for your designs. Use full paths in JSON files.

**Claude Code**

```bash
claude mcp add evora -- node /path/to/evora-mcp.mjs --root ~/Designs
```

**Cursor** (`~/.cursor/mcp.json`) and **Claude Desktop** (Settings → Developer → Edit Config)

```json
{
  "mcpServers": {
    "evora": {
      "command": "node",
      "args": ["/path/to/evora-mcp.mjs", "--root", "/Users/you/Designs"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "evora": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/evora-mcp.mjs", "--root", "/Users/you/Designs"]
    }
  }
}
```

Without `--root`, the server uses the `EVORA_MCP_ROOT` environment variable, then the folder the agent starts it in.

## Try it

- "Create `onboarding.evora` with three phone screens for a meditation app: welcome, pick your goals, and a daily reminder."
- "Read `dashboard.evora` and make the sidebar narrower, with 8 pixels more space between the items."
- "Add a dark version of the Home frame next to the light one."

Then open the file in Evora (**File → Open**). If it is already open, open it again to see the agent's changes.

## What the agent can do

| Tool | What it does |
|---|---|
| `list_files` | Lists the `.evora` files in the folder. |
| `create_file` | Starts a new design with one page. |
| `read_file` | Shows a page's layers as a tree: ids, positions, sizes, colours, text and auto layout. |
| `add_layers` | Adds frames, rectangles, ellipses, lines and text, nested as deep as needed, with fills, strokes, corner radius, shadows, text styles and auto layout (direction, gap, padding, alignment, hug and fill sizing). |
| `update_layers` | Changes any of those settings on existing layers. |
| `delete_layers` | Deletes layers and what is inside them. |
| `add_page` | Adds a page. |
| `export_svg` | Draws a layer as SVG, so the agent can check its work, and can save it as a `.svg` file. |

## Good to know

- The agent edits files, not the open app: changes show up when the file is next opened in Evora. Live editing alongside you is planned.
- Text sizes are estimated for the Inter font; Evora measures text exactly when you next edit it.
- Not yet available to agents: images, components and variants, styles and variables, and prototype connections. Make those in Evora itself.
- `export_svg` draws fills, strokes, corners, shadows and text, but not blur effects.
- The server only touches `.evora` and `.svg` files inside the folder you gave it.

The server's code is in [`mcp/`](../mcp).
