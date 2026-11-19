import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFileText } from '../src/core';
import { handleMessage, serve } from './protocol.ts';
import { createTools, interMeasurer, Workspace, type Tool } from './tools.ts';

let root: string;
let tools: Tool[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'evora-mcp-'));
  tools = createTools(new Workspace(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.find((t) => t.name === name)!;
  return tool.run(args);
}
async function json(name: string, args: Record<string, unknown> = {}) {
  return JSON.parse((await call(name, args)).content[0]!.text);
}
const info = { name: 'evora', version: 'test', instructions: 'test' };

describe('Evora MCP tools', () => {
  it('creates a file that Evora can open, and builds a screen with auto layout', async () => {
    const created = await json('create_file', { path: 'designs/app.evora', name: 'App' });
    const pageId = created.pages[0].id;

    const { added } = await json('add_layers', {
      path: 'designs/app.evora',
      parentId: pageId,
      layers: [
        {
          type: 'FRAME', name: 'Home', width: 390, height: 844, fill: '#0C0B14',
          layout: { direction: 'VERTICAL', gap: 16, padding: 24 },
          children: [
            { type: 'TEXT', name: 'Title', text: 'Good morning', fontSize: 28, fontWeight: 700, fill: '#FFFFFF' },
            {
              type: 'FRAME', name: 'Button', fill: '#7C5CFF', cornerRadius: 12, widthSizing: 'HUG', heightSizing: 'HUG',
              layout: { direction: 'HORIZONTAL', padding: { top: 12, right: 20, bottom: 12, left: 20 } },
              shadow: { y: 8, blur: 24, color: '#7C5CFF66' },
              children: [{ type: 'TEXT', text: 'Get started', fontSize: 16, fontWeight: 600, fill: '#FFFFFF' }],
            },
          ],
        },
      ],
    });
    expect(added[0].name).toBe('Home');
    expect(added[0].children).toHaveLength(2);

    // The file on disk is a valid Evora file.
    const { file, repairs } = parseFileText(readFileSync(path.join(root, 'designs/app.evora'), 'utf8'));
    expect(repairs).toEqual([]);
    expect(file.document.name).toBe('App');

    const read = await json('read_file', { path: 'designs/app.evora' });
    const home = read.layers[0];
    expect(home).toMatchObject({ name: 'Home', width: 390, height: 844, fill: '#0C0B14', layout: { direction: 'VERTICAL', gap: 16, padding: [24, 24, 24, 24] } });
    const [title, button] = home.children;
    expect(title).toMatchObject({ type: 'TEXT', text: 'Good morning', x: 24, y: 24 });
    // Auto layout placed the button under the title, and it hugs its label.
    expect(button.y).toBeCloseTo(24 + title.height + 16, 1);
    expect(button.height).toBeCloseTo(12 + button.children[0].height + 12, 1);
    expect(button.width).toBeCloseTo(20 + button.children[0].width + 20, 1);
  });

  it('updates, deletes and draws layers', async () => {
    const { pages } = await json('create_file', { path: 'a.evora' });
    const { added } = await json('add_layers', {
      path: 'a.evora', parentId: pages[0].id,
      layers: [{ type: 'FRAME', name: 'Card', width: 200, height: 120, children: [{ type: 'RECTANGLE', width: 50, height: 50, fill: '#FF9D5C' }] }],
    });
    const card = added[0].id;
    const box = added[0].children[0].id;

    await call('update_layers', { path: 'a.evora', updates: [{ id: card, fill: '#123456', cornerRadius: 16 }] });
    let read = await json('read_file', { path: 'a.evora' });
    expect(read.layers[0]).toMatchObject({ fill: '#123456', cornerRadius: 16 });

    const svg = (await call('export_svg', { path: 'a.evora', id: card, saveTo: 'out/card.svg' })).content[0]!.text;
    expect(svg).toContain('Saved to out/card.svg');
    expect(svg).toContain('<svg');
    expect(readFileSync(path.join(root, 'out/card.svg'), 'utf8')).toContain('#ff9d5c'.toLowerCase().slice(1));

    await call('delete_layers', { path: 'a.evora', ids: [box] });
    read = await json('read_file', { path: 'a.evora' });
    expect(read.layers[0].children).toBeUndefined();

    const page = await json('add_page', { path: 'a.evora', name: 'Flows' });
    read = await json('read_file', { path: 'a.evora', pageId: page.id });
    expect(read.pages.map((p: { name: string }) => p.name)).toEqual(['Page 1', 'Flows']);
    expect(await json('list_files')).toMatchObject({ files: ['a.evora'] });
  });

  it('refuses paths outside the workspace and explains bad input', async () => {
    await expect(call('create_file', { path: '../escape.evora' })).rejects.toThrow(/outside the workspace/);
    await expect(call('create_file', { path: 'notes.txt' })).rejects.toThrow(/must end in \.evora/);
    const { pages } = await json('create_file', { path: 'b.evora' });
    await expect(call('add_layers', { path: 'b.evora', parentId: pages[0].id, layers: [{ type: 'RECTANGLE', fill: 'purple' }] })).rejects.toThrow(/not a colour/);
    await expect(call('add_layers', { path: 'b.evora', parentId: pages[0].id, layers: [{ type: 'ELLIPSE', text: 'Hi' }] })).rejects.toThrow(/only to TEXT/);
    await expect(call('read_file', { path: 'missing.evora' })).rejects.toThrow(/no file/);
  });

  it('keeps parallel edits to one file', async () => {
    const { pages } = await json('create_file', { path: 'c.evora' });
    await Promise.all(Array.from({ length: 5 }, (_, i) => call('add_layers', { path: 'c.evora', parentId: pages[0].id, layers: [{ type: 'RECTANGLE', name: `R${i}` }] })));
    const read = await json('read_file', { path: 'c.evora' });
    expect(read.layers).toHaveLength(5);
  });

  it('estimates Inter widths', () => {
    const style = { fontFamily: 'Inter', fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 };
    expect(interMeasurer.width('Hello world', style)).toBeGreaterThan(90);
    expect(interMeasurer.width('Hello world', style)).toBeLessThan(130);
  });
});

describe('MCP protocol', () => {
  it('answers initialize, tools/list and tools/call', async () => {
    const init = (await handleMessage(tools, info, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as { result: Record<string, unknown> };
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'evora' } });
    expect(await handleMessage(tools, info, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();

    const list = (await handleMessage(tools, info, { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['list_files', 'create_file', 'read_file', 'add_layers', 'update_layers', 'delete_layers', 'add_page', 'export_svg']);

    const bad = (await handleMessage(tools, info, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'nope.evora' } } })) as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
    const unknown = (await handleMessage(tools, info, { jsonrpc: '2.0', id: 4, method: 'nope' })) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
  });

  it('serves line-delimited JSON-RPC over streams', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk) => chunks.push(String(chunk)));
    const done = serve(tools, info, input, output);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    input.write('not json\n');
    input.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_files', arguments: {} } }) + '\n');
    await done;
    const replies = chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(replies).toContainEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(replies.some((r) => r.error?.code === -32700)).toBe(true);
    expect(replies.find((r) => r.id === 2).result.content[0].text).toContain('no .evora files');
  });
});
