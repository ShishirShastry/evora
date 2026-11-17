/**
 * Helpers for the server's tests: a server started in the same process on a
 * free port with a data folder of its own, requests to its API, and a
 * WebSocket client (Node's own) that keeps what it receives so a test can
 * wait for a particular message.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer, type ServerOptions } from './app.ts';
import { makeClock, type AuthResult, type ClientMessage, type DocInfo, type Register, type ServerMessage } from '../src/collab/protocol.ts';

export interface TestServer extends RunningServer {
  dataDir: string;
  /** Stops the server and removes its data folder. */
  stop(): Promise<void>;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'evora-server-test-'));
}

export async function testServer(options: Partial<ServerOptions> = {}): Promise<TestServer> {
  const dataDir = options.dataDir ?? tempDir();
  const server = await startServer({ port: 0, ...options, dataDir });
  return {
    ...server,
    dataDir,
    async stop() {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Answer<T = any> {
  status: number;
  body: T;
}

export interface RequestOptions {
  token?: string;
  guest?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Calls the API and reads the JSON answer. */
export async function call<T = any>(server: { url: string }, method: string, path: string, options: RequestOptions = {}): Promise<Answer<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.guest) headers['X-Evora-Guest'] = options.guest;
  let body: string | Uint8Array | undefined;
  if (options.body instanceof Uint8Array) body = options.body;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${server.url}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the text as it is.
  }
  return { status: res.status, body: parsed as T };
}

let people = 0;

/** Signs up a new person with a unique email. */
export async function signUp(server: { url: string }, name: string, email?: string): Promise<AuthResult> {
  people++;
  const answer = await call<AuthResult>(server, 'POST', '/api/auth/signup', {
    body: { email: email ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.${people}.${Date.now()}@example.com`, name, password: 'correct horse battery' },
  });
  if (answer.status !== 201) throw new Error(`Sign up failed: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** The ID of someone's own workspace (made when they signed up). */
export async function personalWorkspace(server: { url: string }, token: string): Promise<string> {
  const me = await call(server, 'GET', '/api/me', { token });
  return me.body.workspaces[0].id as string;
}

/** Makes a document in someone's own workspace. */
export async function newDoc(server: { url: string }, token: string, name = 'Shared file', registers?: Register[]): Promise<DocInfo> {
  const workspaceId = await personalWorkspace(server, token);
  const answer = await call<DocInfo>(server, 'POST', '/api/documents', { token, body: { workspaceId, name, registers } });
  if (answer.status !== 201) throw new Error(`Making a document failed: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** A clock for a change made by `clientId` at `ms`. */
export function clock(ms: number, clientId: string, counter = 0): string {
  return makeClock(ms, counter, clientId);
}

type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

/** A WebSocket client for tests: what arrives is kept until a test takes it with `next`. */
export class TestSocket {
  readonly ws: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  private queue: ServerMessage[] = [];
  private waiters: { want: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      const index = this.waiters.findIndex((waiter) => waiter.want(message));
      if (index >= 0) this.waiters.splice(index, 1)[0]?.resolve(message);
      else this.queue.push(message);
    });
  }

  static open(server: { url: string }): Promise<TestSocket> {
    const ws = new WebSocket(`${server.url.replace(/^http/, 'ws')}/ws`);
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(new TestSocket(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error('The WebSocket did not open')), { once: true });
    });
  }

  /** Opens a connection and says hello; resolves with the welcome. */
  static async join(
    server: { url: string },
    docId: string,
    who: { token?: string; guestToken?: string },
    clientId: string,
    since = 0,
  ): Promise<{ socket: TestSocket; welcome: Of<'welcome'> }> {
    const socket = await TestSocket.open(server);
    socket.send({ t: 'hello', docId, since, clientId, ...who });
    const welcome = await socket.next('welcome');
    return { socket, welcome };
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  /** The next message of a type (and matching `where`), from what has arrived or what arrives within `timeoutMs`. */
  next<T extends ServerMessage['t']>(t: T, where: (message: Of<T>) => boolean = () => true, timeoutMs = 4000): Promise<Of<T>> {
    const want = (message: ServerMessage): boolean => message.t === t && where(message as Of<T>);
    const index = this.queue.findIndex(want);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0] as Of<T>);
    return new Promise((resolve, reject) => {
      const waiter = { want, resolve: (message: ServerMessage) => (clearTimeout(timer), resolve(message as Of<T>)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`No "${t}" message arrived; had: ${JSON.stringify(this.queue.map((m) => m.t))}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** The messages of a type that have arrived and not been taken. */
  held(t: ServerMessage['t']): ServerMessage[] {
    return this.queue.filter((message) => message.t === t);
  }

  /** Waits for a round trip, so that whatever the server sent before it has arrived. */
  async settle(): Promise<void> {
    this.send({ t: 'ping' });
    await this.next('pong');
  }

  close(): Promise<{ code: number; reason: string }> {
    this.ws.close();
    return this.closed;
  }
}
