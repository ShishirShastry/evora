// evora-mcp: lets AI agents (Claude Code, Cursor, Claude Desktop and any
// other MCP client) design in Evora. It edits .evora files in one folder:
//
//   node evora-mcp.mjs --root ~/Designs
//
// See docs/mcp.md.

import path from 'node:path';
import { version } from '../package.json';
import { serve } from './protocol.ts';
import { createTools, Workspace } from './tools.ts';

function option(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`evora-mcp ${version}: an MCP server that lets AI agents create and edit Evora designs.

Usage: node evora-mcp.mjs [--root <folder>]

  --root <folder>  The folder whose .evora files agents may read and write.
                   Defaults to EVORA_MCP_ROOT, then the current folder.

Add it to Claude Code with:
  claude mcp add evora -- node /path/to/evora-mcp.mjs --root ~/Designs
`);
  process.exit(0);
}

const root = path.resolve(option('--root') ?? process.env.EVORA_MCP_ROOT ?? process.cwd());
const workspace = new Workspace(root);

process.stderr.write(`[evora-mcp] ${version}: designs in ${root}\n`);

await serve(createTools(workspace), {
  name: 'evora',
  version,
  instructions:
    `Evora is a free, open-source design tool. These tools create and edit Evora design files (.evora) in ${root}. ` +
    'Start with list_files, or create_file for a new design. read_file shows the layer ids. Build screens as a FRAME on the page ' +
    '(for example 390 x 844 for a phone or 1440 x 1024 for a desktop) and nest frames with "layout" (auto layout) for rows, columns, cards and buttons. ' +
    'Check the result with export_svg. The person opens the file in the Evora app (File > Open) to see and refine it; ' +
    'if it is already open there, they reopen it to see your changes.',
});
