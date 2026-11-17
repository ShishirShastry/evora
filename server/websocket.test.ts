/**
 * The WebSocket protocol itself, spoken byte by byte over a plain TCP
 * connection, as a browser would: masked frames, fragments, the three length
 * forms, control frames, closing, and the server's answers to frames that
 * break the rules.
 */
import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptKey, OP_BINARY, OP_CLOSE, OP_CONTINUATION, OP_PING, OP_PONG, OP_TEXT } from './websocket.ts';
import { clock, newDoc, signUp, testServer, TestSocket, type TestServer } from './testing.ts';

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  /** How the length was written: 7, 16 or 64 bits. */
  lengthBits: 7 | 16 | 64;
}

/** Encodes a frame as a client must: masked (unless told not to). */
function clientFrame(opcode: number, payload: Buffer | string, options: { fin?: boolean; mask?: boolean; rsv?: number } = {}): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const mask = options.mask ?? true;
  const parts: Buffer[] = [];
  const b0 = ((options.fin ?? true) ? 0x80 : 0) | (options.rsv ?? 0) | opcode;
  const maskBit = mask ? 0x80 : 0;
  if (data.length < 126) parts.push(Buffer.from([b0, maskBit | data.length]));
  else if (data.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = b0;
    header[1] = maskBit | 126;
    header.writeUInt16BE(data.length, 2);
    parts.push(header);
  } else {
    const header = Buffer.alloc(10);
    header[0] = b0;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
    parts.push(header);
  }
  if (mask) {
    const key = randomBytes(4);
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = (data[i] as number) ^ (key[i & 3] as number);
    parts.push(key, masked);
  } else parts.push(data);
  return Buffer.concat(parts);
}

/** A WebSocket client written by hand on a TCP socket. */
class RawClient {
  readonly socket: Socket;
  readonly ended: Promise<void>;
  private buffer = Buffer.alloc(0);
  private frames: Frame[] = [];
  private waiters: ((frame: Frame) => void)[] = [];

  constructor(socket: Socket, rest: Buffer) {
    this.socket = socket;
    this.ended = new Promise((resolve) => socket.on('close', () => resolve()));
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    if (rest.length) this.receive(rest);
  }

  /** Connects and sends the opening handshake; resolves with the answer's head and, when it is 101, the client. */
  static handshake(server: TestServer, request?: string): Promise<{ head: string; client: RawClient | null }> {
    const key = randomBytes(16).toString('base64');
    const port = new URL(server.url).port;
    const text = request ?? `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    return new Promise((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => socket.write(text));
      let received = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const end = received.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        const head = received.subarray(0, end).toString('latin1');
        const rest = received.subarray(end + 4);
        if (head.startsWith('HTTP/1.1 101')) {
          expect(head).toContain(`Sec-WebSocket-Accept: ${acceptKey(key)}`);
          resolve({ head, client: new RawClient(socket, rest) });
        } else {
          socket.destroy();
          resolve({ head, client: null });
        }
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });
  }

  static async open(server: TestServer): Promise<RawClient> {
    const { client } = await RawClient.handshake(server);
    if (!client) throw new Error('The handshake failed');
    return client;
  }

  send(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  sendText(text: string): void {
    this.send(clientFrame(OP_TEXT, text));
  }

  next(timeoutMs = 4000): Promise<Frame> {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No frame arrived')), timeoutMs);
      this.waiters.push((f) => {
        clearTimeout(timer);
        resolve(f);
      });
    });
  }

  /** The next text frame, parsed as JSON (skipping pings the server sends). */
  async nextMessage(): Promise<any> {
    for (;;) {
      const frame = await this.next();
      if (frame.opcode === OP_TEXT) return JSON.parse(frame.payload.toString('utf8'));
      if (frame.opcode !== OP_PING) throw new Error(`Expected text, got opcode ${frame.opcode}`);
    }
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0] as number;
      const b1 = this.buffer[1] as number;
      // A server never masks.
      expect(b1 & 0x80).toBe(0);
      let length = b1 & 0x7f;
      let offset = 2;
      let lengthBits: Frame['lengthBits'] = 7;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
        lengthBits = 16;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
        lengthBits = 64;
      }
      if (this.buffer.length < offset + length) return;
      const frame: Frame = { fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload: this.buffer.subarray(offset, offset + length), lengthBits };
      this.buffer = this.buffer.subarray(offset + length);
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    }
  }
}

function closeCode(frame: Frame): number {
  expect(frame.opcode).toBe(OP_CLOSE);
  return frame.payload.readUInt16BE(0);
}

let server: TestServer;
let small: TestServer;
let token: string;
let docId: string;

beforeAll(async () => {
  server = await testServer();
  small = await testServer({ maxMessageBytes: 1024 });
  const owner = await signUp(server, 'Framer');
  token = owner.token;
  docId = (await newDoc(server, token, 'Frames')).id;
});

afterAll(async () => {
  await server.stop();
  await small.stop();
});

function hello(clientId: string): string {
  return JSON.stringify({ t: 'hello', docId, since: 0, clientId, token });
}

describe('the WebSocket handshake', () => {
  it('computes Sec-WebSocket-Accept as RFC 6455 does', () => {
    // The example in RFC 6455, section 1.3.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('switches protocols for a valid request, and refuses others', async () => {
    const ok = await RawClient.handshake(server);
    expect(ok.head).toMatch(/^HTTP\/1\.1 101 Switching Protocols/);
    expect(ok.head).toMatch(/Upgrade: websocket/i);
    ok.client?.socket.destroy();

    const port = new URL(server.url).port;
    const noKey = await RawClient.handshake(server, `GET /ws HTTP/1.1\r\nHost: x:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    expect(noKey.head).toMatch(/^HTTP\/1\.1 400/);
    const oldVersion = await RawClient.handshake(
      server,
      `GET /ws HTTP/1.1\r\nHost: x:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 8\r\n\r\n`,
    );
    expect(oldVersion.head).toMatch(/^HTTP\/1\.1 426/);
    expect(oldVersion.head).toContain('Sec-WebSocket-Version: 13');
    const elsewhere = await RawClient.handshake(
      server,
      `GET /other HTTP/1.1\r\nHost: x:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    expect(elsewhere.head).toMatch(/^HTTP\/1\.1 404/);
  });
});

describe('WebSocket frames', () => {
  it('puts together a message sent in fragments, with a ping between them', async () => {
    const client = await RawClient.open(server);
    const text = hello('fragments');
    const a = text.slice(0, 10);
    const b = text.slice(10, 30);
    const c = text.slice(30);
    client.send(clientFrame(OP_TEXT, a, { fin: false }));
    client.send(clientFrame(OP_PING, 'between'));
    client.send(clientFrame(OP_CONTINUATION, b, { fin: false }));
    client.send(clientFrame(OP_CONTINUATION, c, { fin: true }));
    const pong = await client.next();
    expect(pong.opcode).toBe(OP_PONG);
    expect(pong.payload.toString()).toBe('between');
    const welcome = await client.nextMessage();
    expect(welcome.t).toBe('welcome');
    client.socket.destroy();
  });

  it('reads and writes lengths in 16 and 64 bits', async () => {
    const sender = await RawClient.open(server);
    sender.sendText(hello('bigsender'));
    expect((await sender.nextMessage()).t).toBe('welcome');
    const receiver = await RawClient.open(server);
    receiver.sendText(hello('bigreceiver'));
    expect((await receiver.nextMessage()).t).toBe('welcome');
    expect((await sender.nextMessage()).t).toBe('presence');

    // 16 bits: a message of a few hundred bytes.
    const medium = JSON.stringify({ t: 'ops', id: 'medium', ops: [{ k: 'n:text:chars', v: 'm'.repeat(500), c: clock(Date.now(), 'bigsender') }] });
    sender.send(clientFrame(OP_TEXT, medium));
    expect(await sender.nextMessage()).toEqual({ t: 'ack', id: 'medium', seq: 2 });
    const mediumFrame = await receiver.next();
    expect(mediumFrame.lengthBits).toBe(16);

    // 64 bits: a message of more than 65,535 bytes, both ways.
    const big = 'x'.repeat(100_000);
    sender.send(clientFrame(OP_TEXT, JSON.stringify({ t: 'ops', id: 'big', ops: [{ k: 'n:text:chars', v: big, c: clock(Date.now() + 1, 'bigsender') }] })));
    expect(await sender.nextMessage()).toEqual({ t: 'ack', id: 'big', seq: 3 });
    const bigFrame = await receiver.next();
    expect(bigFrame.lengthBits).toBe(64);
    expect(JSON.parse(bigFrame.payload.toString('utf8')).ops[0].v).toBe(big);
    sender.socket.destroy();
    receiver.socket.destroy();
  });

  it('answers a ping with a pong carrying the same bytes', async () => {
    const client = await RawClient.open(server);
    client.send(clientFrame(OP_PING, Buffer.from([1, 2, 3, 250])));
    const pong = await client.next();
    expect(pong.opcode).toBe(OP_PONG);
    expect([...pong.payload]).toEqual([1, 2, 3, 250]);
    client.socket.destroy();
  });

  it('answers a close with a close of the same code, then ends the connection', async () => {
    const client = await RawClient.open(server);
    const payload = Buffer.alloc(5);
    payload.writeUInt16BE(1000, 0);
    payload.write('bye', 2);
    client.send(clientFrame(OP_CLOSE, payload));
    expect(closeCode(await client.next())).toBe(1000);
    await client.ended;
  });

  it('closes with 1002 for a frame that is not masked, has reserved bits, or continues nothing', async () => {
    for (const bad of [
      clientFrame(OP_TEXT, '{"t":"ping"}', { mask: false }),
      clientFrame(OP_TEXT, '{"t":"ping"}', { rsv: 0x40 }),
      clientFrame(OP_CONTINUATION, 'nothing to continue'),
      clientFrame(OP_PING, 'not whole', { fin: false }),
      clientFrame(0x3, 'unknown opcode'),
    ]) {
      const client = await RawClient.open(server);
      client.send(bad);
      expect(closeCode(await client.next())).toBe(1002);
      await client.ended;
    }
  });

  it('closes with 1007 for text that is not UTF-8', async () => {
    const client = await RawClient.open(server);
    client.send(clientFrame(OP_TEXT, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])));
    expect(closeCode(await client.next())).toBe(1007);
    await client.ended;
  });

  it('closes with 1009 for a message larger than allowed, also in fragments', async () => {
    const one = await RawClient.open(small);
    one.send(clientFrame(OP_TEXT, 'y'.repeat(2000)));
    expect(closeCode(await one.next())).toBe(1009);
    await one.ended;

    const pieces = await RawClient.open(small);
    pieces.send(clientFrame(OP_TEXT, 'z'.repeat(600), { fin: false }));
    pieces.send(clientFrame(OP_CONTINUATION, 'z'.repeat(600), { fin: true }));
    expect(closeCode(await pieces.next())).toBe(1009);
    await pieces.ended;
  });

  it('answers a binary message with an error and stays open', async () => {
    const client = await RawClient.open(server);
    client.send(clientFrame(OP_BINARY, Buffer.from([1, 2, 3])));
    expect(await client.nextMessage()).toMatchObject({ t: 'error', code: 'bad-request' });
    client.sendText('{"t":"ping"}');
    expect(await client.nextMessage()).toEqual({ t: 'pong' });
    client.socket.destroy();
  });
});

describe('the heartbeat', () => {
  it('pings connections and drops one that stays silent, but not one that answers', async () => {
    const quick = await testServer({ heartbeatMs: 100 });
    const owner = await signUp(quick, 'Beat');
    const doc = await newDoc(quick, owner.token, 'Beats');
    const silent = await RawClient.open(quick);
    const ping = await silent.next();
    expect(ping.opcode).toBe(OP_PING);
    const started = Date.now();
    await silent.ended;
    expect(Date.now() - started).toBeLessThan(2000);

    // Node's own WebSocket answers pings, so it stays.
    const alive = await TestSocket.join(quick, doc.id, { token: owner.token }, 'alive');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(alive.socket.ws.readyState).toBe(WebSocket.OPEN);
    await alive.socket.close();
    await quick.stop();
  });
});
