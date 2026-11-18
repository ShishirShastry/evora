// Reads src/state/commands.ts (and src/ui/editor/menus.ts for the menu each command sits in) as text,
// and prints a Markdown table of every command that has a shortcut. Read-only: it never imports or runs the app.
// Usage: node scripts/shortcut-table.mjs . docs/user-guide.md   (rewrites the table between the shortcuts:begin/end markers)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const target = process.argv[3];
const source = readFileSync(join(root, 'src/state/commands.ts'), 'utf8');
const menus = readFileSync(join(root, 'src/ui/editor/menus.ts'), 'utf8');

// ALIGN_LABELS, used by alignCommand.
const alignBlock = /const ALIGN_LABELS[^=]*=\s*\{([\s\S]*?)\};/.exec(source)[1];
const alignLabels = Object.fromEntries([...alignBlock.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));

// The COMMANDS array's text.
const start = source.indexOf('export const COMMANDS');
const open = source.indexOf('[', source.indexOf('=', start));
let depth = 0;
let end = open;
for (let i = open; i < source.length; i++) {
  const c = source[i];
  if (c === '/' && source[i + 1] === '/') {
    i = source.indexOf('\n', i);
    continue;
  }
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
    i = j;
    continue;
  }
  if (c === '[' || c === '{' || c === '(') depth++;
  else if (c === ']' || c === '}' || c === ')') {
    depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
const body = source.slice(open + 1, end);

// Split into top-level items, skipping strings and comments.
const items = [];
let current = '';
depth = 0;
for (let i = 0; i < body.length; i++) {
  const c = body[i];
  if (c === '/' && body[i + 1] === '/') {
    const nl = body.indexOf('\n', i);
    i = nl === -1 ? body.length : nl;
    continue;
  }
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < body.length && body[j] !== c) j += body[j] === '\\' ? 2 : 1;
    current += body.slice(i, j + 1);
    i = j;
    continue;
  }
  if (c === '[' || c === '{' || c === '(') depth++;
  if (c === ']' || c === '}' || c === ')') depth--;
  if (c === ',' && depth === 0) {
    if (current.trim()) items.push(current.trim());
    current = '';
    continue;
  }
  current += c;
}
if (current.trim()) items.push(current.trim());

const str = (text) => text.trim().replace(/^(['"])(.*)\1$/, '$2');
const args = (call) => {
  const inner = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'));
  return inner.split(',').map((part) => part.trim());
};
const arrows = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

const commands = [];
for (const item of items) {
  if (item.startsWith('toolCommand(')) {
    const [tool, label, code] = args(item).map(str);
    commands.push({ id: `tool.${tool}`, label, group: 'Tools', shortcut: code ? code.replace('Key', '') : undefined });
  } else if (item.startsWith('alignCommand(')) {
    const [mode, code] = args(item).map(str);
    commands.push({ id: `arrange.align.${mode}`, label: alignLabels[mode], group: 'Arrange', shortcut: `Alt+${code.replace('Key', '')}` });
  } else if (item.startsWith('booleanCommand(')) {
    const [operation, label, code] = args(item).map(str);
    commands.push({ id: `object.${operation.toLowerCase()}`, label, group: 'Object', shortcut: `Ctrl+Alt+${code.replace('Key', '')}` });
  } else if (item.startsWith('nudgeCommand(')) {
    const parts = args(item);
    const [id, label, code] = parts.slice(0, 3).map(str);
    const big = parts[5] === 'true';
    const arrow = arrows[code] ?? code;
    commands.push({ id, label, group: 'Edit', shortcut: big ? `Shift+${arrow}` : arrow });
  } else if (item.startsWith('{')) {
    const field = (name) => {
      const m = new RegExp(`\\b${name}:\\s*(['"])(.*?)\\1`).exec(item);
      return m ? m[2] : undefined;
    };
    commands.push({ id: field('id'), label: field('label'), group: field('group'), shortcut: field('shortcut') });
  } else {
    throw new Error(`Unrecognised command entry: ${item.slice(0, 60)}`);
  }
}

// Which main-menu submenu lists each command (MENU_ORDER in menus.ts); tools are in the tool dock.
const order = /const MENU_ORDER[^=]*=\s*\{([\s\S]*?)\n\};/.exec(menus)[1];
const inMenu = {};
for (const m of order.matchAll(/(\w+):\s*\[([\s\S]*?)\]/g)) {
  for (const id of m[2].matchAll(/'([^']+)'/g)) if (id[1] !== '-') inMenu[id[1]] = m[1];
}

const groupOrder = ['Tools', 'Edit', 'Object', 'Arrange', 'View', 'File', 'Help'];
const withShortcut = commands.filter((c) => c.shortcut);
const lines = [
  '| Group | Command | Shortcut | Where else to find it |',
  '|---|---|---|---|',
];
for (const group of groupOrder) {
  for (const c of withShortcut.filter((c) => c.group === group)) {
    const where = group === 'Tools' ? 'Tool dock' : inMenu[c.id] ? `Main menu ▸ ${inMenu[c.id]}` : 'Shortcut only';
    lines.push(`| ${group} | ${c.label} | \`${c.shortcut}\` | ${where} |`);
  }
}
const table = lines.join('\n');
const summary = `${commands.length} commands read, ${withShortcut.length} with a shortcut`;

if (target) {
  const doc = readFileSync(target, 'utf8');
  const begin = '<!-- shortcuts:begin -->';
  const finish = '<!-- shortcuts:end -->';
  const a = doc.indexOf(begin);
  const b = doc.indexOf(finish);
  if (a === -1 || b === -1) throw new Error('Markers not found');
  writeFileSync(target, `${doc.slice(0, a + begin.length)}\n${table}\n${doc.slice(b)}`);
  console.log(`Injected: ${summary}`);
} else {
  console.log(table);
  console.log(summary);
}
