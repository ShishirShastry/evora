// The Model Context Protocol over stdio: one JSON-RPC 2.0 message per line.
// Only what a tools-only server needs: initialize, ping, tools/list and
// tools/call. Node built-ins only.

import { createInterface } from 'node:readline';
import { ToolError, type Tool } from './tools.ts';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface ServerInfo {
  name: string;
  version: string;
  instructions: string;
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const ok = (id: Message['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: Message['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Answers one message; notifications (no id) get no answer. */
export async function handleMessage(tools: readonly Tool[], info: ServerInfo, message: Message): Promise<object | null> {
  const { id, method, params = {} } = message;
  if (id === undefined) return null;
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, title: 'Evora', version: info.version },
        instructions: info.instructions,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      try {
        return ok(id, await tool.run(args));
      } catch (error) {
        const known = error instanceof ToolError || (error instanceof Error && error.name === 'FileFormatError');
        const text = known ? (error as Error).message : `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
        if (!known) process.stderr.write(`[evora-mcp] ${tool.name} failed: ${error instanceof Error ? error.stack : String(error)}\n`);
        return ok(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${String(method)}`);
  }
}

/** Reads messages from stdin and writes answers to stdout until stdin closes. */
export function serve(tools: readonly Tool[], info: ServerInfo, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    let pending = Promise.resolve();
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        output.write(JSON.stringify(fail(null, -32700, 'Parse error')) + '\n');
        return;
      }
      // Answers go out as each call finishes; calls on one file are queued by the workspace.
      const answer = handleMessage(tools, info, message).then((reply) => {
        if (reply) output.write(JSON.stringify(reply) + '\n');
      });
      pending = pending.then(() => answer);
    });
    lines.on('close', () => {
      pending.then(() => resolve(), () => resolve());
    });
  });
}
