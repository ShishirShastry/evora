/**
 * The WebSocket protocol (RFC 6455), written on Node's own sockets: the
 * opening handshake, reading the frames a browser sends (always masked; text,
 * binary, messages in fragments, close, ping and pong, lengths in 7, 16 or 64
 * bits) and writing the server's frames (never masked). No extensions are
 * offered, so frames never carry compressed data.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** Close codes used here (RFC 6455 §7.4.1). */
export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_UNSUPPORTED = 1003;
export const CLOSE_NO_STATUS = 1005;
export const CLOSE_ABNORMAL = 1006;
export const CLOSE_INVALID_DATA = 1007;
export const CLOSE_POLICY = 1008;
export const CLOSE_TOO_BIG = 1009;

/** The value of Sec-WebSocket-Accept for a client's Sec-WebSocket-Key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
}

function refuse(socket: Duplex, status: string, headers: Record<string, string> = {}): void {
  const lines = [`HTTP/1.1 ${status}`, 'Connection: close', 'Content-Length: 0', ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)];
  socket.end(`${lines.join('\r\n')}\r\n\r\n`);
}

/**
 * Answers a request to upgrade to a WebSocket. Returns true when the
 * connection is now a WebSocket; otherwise it has answered with an error and
 * closed the socket.
 */
export function handshake(req: IncomingMessage, socket: Duplex): boolean {
  if (req.method !== 'GET') {
    refuse(socket, '405 Method Not Allowed');
    return false;
  }
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const connection = String(req.headers.connection ?? '').toLowerCase();
  if (upgrade !== 'websocket' || !connection.split(/\s*,\s*/).includes('upgrade')) {
    refuse(socket, '400 Bad Request');
    return false;
  }
  if (req.headers['sec-websocket-version'] !== '13') {
    refuse(socket, '426 Upgrade Required', { 'Sec-WebSocket-Version': '13' });
    return false;
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    refuse(socket, '400 Bad Request');
    return false;
  }
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'),
  );
  return true;
}

/** The header of a server frame: FIN set, no mask, the shortest length form. */
export function frameHeader(opcode: number, length: number, fin = true): Buffer {
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return header;
}

/** Whether a close code may be sent in a close frame (RFC 6455 §7.4). */
export function validCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

/** Received bytes, kept as the chunks they came in until a whole frame is there. */
class ByteQueue {
  private chunks: Buffer[] = [];
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** The first `n` bytes, without taking them. */
  peek(n: number): Buffer {
    const first = this.chunks[0] as Buffer;
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.alloc(n);
    let offset = 0;
    for (const chunk of this.chunks) {
      const count = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, count);
      offset += count;
      if (offset === n) break;
    }
    return out;
  }

  /** Takes the first `n` bytes. */
  take(n: number): Buffer {
    this.length -= n;
    const first = this.chunks[0];
    if (first && first.length === n) {
      this.chunks.shift();
      return first;
    }
    if (first && first.length > n) {
      this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.alloc(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0] as Buffer;
      const count = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, count);
      offset += count;
      if (count === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
    return out;
  }
}

export interface ConnectionOptions {
  /** The largest message accepted, in bytes; a larger one closes the connection with 1009. */
  maxMessageBytes: number;
  /** How long to wait for the other side's close frame before dropping the connection. */
  closeTimeoutMs?: number;
  /** A peer that takes more than this many bytes behind is dropped. */
  maxBufferedBytes?: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * One WebSocket connection, server side. Set `onMessage` and `onClose`;
 * `lastSeen` is when anything last arrived (used for the heartbeat).
 */
export class WebSocketConnection {
  onMessage: (data: string | Buffer, binary: boolean) => void = () => {};
  onClose: (code: number, reason: string) => void = () => {};
  lastSeen = Date.now();
  state: 'open' | 'closing' | 'closed' = 'open';

  private readonly socket: Duplex;
  private readonly options: ConnectionOptions;
  private queue = new ByteQueue();
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private closeCode = CLOSE_ABNORMAL;
  private closeReason = '';
  private failed = false;

  constructor(socket: Duplex, head: Buffer, options: ConnectionOptions) {
    this.socket = socket;
    this.options = options;
    const net = socket as Duplex & { setNoDelay?: (on: boolean) => void; setTimeout?: (ms: number) => void };
    net.setNoDelay?.(true);
    net.setTimeout?.(0);
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());
    socket.on('end', () => this.finish());
    if (head.length > 0) queueMicrotask(() => this.receive(head));
  }

  /** Sends a text message. */
  send(text: string): void {
    this.write(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  sendBinary(bytes: Buffer): void {
    this.write(OP_BINARY, bytes);
  }

  ping(payload: Buffer = Buffer.alloc(0)): void {
    this.write(OP_PING, payload);
  }

  /** Starts the closing handshake: sends a close frame and waits for the other side's. */
  close(code = CLOSE_NORMAL, reason = ''): void {
    if (this.state !== 'open') return;
    const text = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    this.write(OP_CLOSE, payload);
    this.state = 'closing';
    this.closeCode = code;
    this.closeReason = reason;
    this.closeTimer = setTimeout(() => this.terminate(), this.options.closeTimeoutMs ?? 5000);
  }

  /** Drops the connection at once, without a closing handshake. */
  terminate(): void {
    this.socket.destroy();
    this.finish();
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.state === 'closed' || (this.state === 'closing' && opcode !== OP_CLOSE) || this.socket.destroyed) return;
    const header = frameHeader(opcode, payload.length);
    if (payload.length < 16 * 1024) this.socket.write(Buffer.concat([header, payload]));
    else {
      this.socket.write(header);
      this.socket.write(payload);
    }
    const buffered = (this.socket as Duplex & { writableLength: number }).writableLength;
    if (buffered > (this.options.maxBufferedBytes ?? 256 * 1024 * 1024)) this.terminate();
  }

  /** Fails the connection (RFC 6455 §7.1.7): a close frame with the reason, then the end. */
  private fail(code: number, reason: string): void {
    if (this.state === 'open') this.close(code, reason);
    this.failed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.state = 'closing';
    this.socket.end();
  }

  private finish(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.fragments = [];
    // Let what was written (a close frame) go out before the socket is let go.
    if (!this.socket.destroyed) {
      const socket = this.socket as Socket;
      if (typeof socket.destroySoon === 'function') socket.destroySoon();
      else socket.end();
    }
    this.onClose(this.closeCode, this.closeReason);
  }

  private receive(chunk: Buffer): void {
    if (this.state === 'closed' || this.failed) return;
    this.lastSeen = Date.now();
    this.queue.push(chunk);
    this.parse();
  }

  private parse(): void {
    while (this.state !== 'closed' && !this.failed && this.queue.length >= 2) {
      const start = this.queue.peek(2);
      const b0 = start[0] as number;
      const b1 = start[1] as number;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if ((b0 & 0x70) !== 0) return this.fail(CLOSE_PROTOCOL_ERROR, 'Reserved bits set');
      if ((b1 & 0x80) === 0) return this.fail(CLOSE_PROTOCOL_ERROR, 'Frames from a client must be masked');
      const control = opcode >= 0x8;
      if (![OP_CONTINUATION, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) return this.fail(CLOSE_PROTOCOL_ERROR, 'Unknown opcode');
      let length = b1 & 0x7f;
      let offset = 2;
      if (control && (!fin || length > 125)) return this.fail(CLOSE_PROTOCOL_ERROR, 'Control frames must be whole and short');
      if (length === 126) {
        if (this.queue.length < 4) return;
        length = this.queue.peek(4).readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.queue.length < 10) return;
        const big = this.queue.peek(10).readBigUInt64BE(2);
        if (big > BigInt(this.options.maxMessageBytes)) return this.fail(CLOSE_TOO_BIG, 'Message too big');
        length = Number(big);
        offset = 10;
      }
      if (!control) {
        if (opcode === OP_CONTINUATION && this.fragmentOpcode === 0) return this.fail(CLOSE_PROTOCOL_ERROR, 'Continuation without a message');
        if (opcode !== OP_CONTINUATION && this.fragmentOpcode !== 0) return this.fail(CLOSE_PROTOCOL_ERROR, 'A new message inside a fragmented one');
        if (this.fragmentBytes + length > this.options.maxMessageBytes) return this.fail(CLOSE_TOO_BIG, 'Message too big');
      }
      if (this.queue.length < offset + 4 + length) return;
      this.queue.take(offset);
      const mask = this.queue.take(4);
      const payload = this.queue.take(length);
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i & 3] as number);
      this.frame(fin, opcode, payload);
    }
  }

  private frame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === OP_PING) {
      this.write(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) return;
    if (opcode === OP_CLOSE) {
      this.receiveClose(payload);
      return;
    }
    if (opcode !== OP_CONTINUATION) this.fragmentOpcode = opcode;
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (!fin) return;
    const kind = this.fragmentOpcode;
    const whole = this.fragments.length === 1 ? (this.fragments[0] as Buffer) : Buffer.concat(this.fragments, this.fragmentBytes);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    if (this.state !== 'open') return;
    if (kind === OP_TEXT) {
      let text: string;
      try {
        text = utf8.decode(whole);
      } catch {
        return this.fail(CLOSE_INVALID_DATA, 'Text is not valid UTF-8');
      }
      this.onMessage(text, false);
    } else this.onMessage(whole, true);
  }

  private receiveClose(payload: Buffer): void {
    let code = CLOSE_NO_STATUS;
    let reason = '';
    if (payload.length === 1) return this.fail(CLOSE_PROTOCOL_ERROR, 'A close frame cannot hold one byte');
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCloseCode(code)) return this.fail(CLOSE_PROTOCOL_ERROR, 'Invalid close code');
      try {
        reason = utf8.decode(payload.subarray(2));
      } catch {
        return this.fail(CLOSE_INVALID_DATA, 'Close reason is not valid UTF-8');
      }
    }
    if (this.state === 'open') {
      // The other side started closing: answer with the same code, then end.
      this.write(OP_CLOSE, payload.subarray(0, payload.length >= 2 ? 2 : 0));
      this.closeCode = code;
      this.closeReason = reason;
    }
    this.state = 'closing';
    this.socket.end();
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.terminate(), this.options.closeTimeoutMs ?? 5000);
  }
}
