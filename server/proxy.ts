/**
 * Which address a request came from, when Evora runs behind a reverse proxy
 * (nginx, Caddy, a load balancer).
 *
 * Without a proxy, it is the connection's own address. Behind one, every
 * request comes from the proxy, so the limits on repeated attempts and the
 * counting of people without an account would treat everyone as one person.
 * With "trust proxy" set (EVORA_TRUST_PROXY / --trust-proxy), the address is
 * read from X-Forwarded-For instead: the right-most hop that is not a trusted
 * proxy. Off by default, because anyone can write that header: a server that
 * is reached directly must not believe it.
 *
 * The setting is one of:
 * - off: "0", "false", "no", "off" or nothing (the default);
 * - a number of proxies, e.g. "1": the connection and that many minus one
 *   hops from the right of X-Forwarded-For are trusted, whatever they are
 *   ("true", "yes" and "on" mean 1);
 * - a list of proxy addresses or ranges, separated by commas, e.g.
 *   "127.0.0.1, 10.0.0.0/8, ::1"; the words "loopback", "private" and
 *   "linklocal" name the usual ranges. Only hops in the list are trusted.
 *
 * `app.ts` works the address out once per request (`resolveClientAddress`)
 * and keeps it with the request (`setClientAddress`); `requestAddress` gives
 * it back, or the connection's own address when nothing was kept.
 */
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

export type TrustProxy = { kind: 'off' } | { kind: 'hops'; hops: number } | { kind: 'list'; list: BlockList; text: string };

export const TRUST_NOTHING: TrustProxy = { kind: 'off' };

const NAMED: Record<string, [string, number, 'ipv4' | 'ipv6'][]> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6'],
  ],
  private: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6'],
  ],
};

/** Reads the trust-proxy setting; throws an Error with a message for the person running the server when it is not one. */
export function parseTrustProxy(value: string | undefined | null): TrustProxy {
  const text = (value ?? '').trim();
  const lower = text.toLowerCase();
  if (lower === '' || lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return TRUST_NOTHING;
  if (lower === 'true' || lower === 'yes' || lower === 'on') return { kind: 'hops', hops: 1 };
  if (/^\d+$/.test(lower)) {
    const hops = Number(lower);
    if (hops > 32) throw new Error(`trust proxy: ${text} proxies in a row is not believable (at most 32)`);
    return { kind: 'hops', hops };
  }
  const list = new BlockList();
  for (const raw of text.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const named = NAMED[item.toLowerCase()];
    if (named) {
      for (const [net, prefix, type] of named) list.addSubnet(net, prefix, type);
      continue;
    }
    const [address, prefixText, extra] = item.split('/');
    const type = isIP(address ?? '');
    if (extra !== undefined || !address || type === 0) {
      throw new Error(`trust proxy: "${item}" is not an address, a range (like 10.0.0.0/8) or one of loopback, private, linklocal`);
    }
    const family = type === 4 ? 'ipv4' : 'ipv6';
    if (prefixText === undefined) {
      list.addAddress(address, family);
      continue;
    }
    const prefix = Number(prefixText);
    if (!/^\d+$/.test(prefixText) || prefix > (type === 4 ? 32 : 128)) throw new Error(`trust proxy: "${item}" has a prefix length that is not one`);
    list.addSubnet(address, prefix, family);
  }
  return { kind: 'list', list, text };
}

/** An address as compared and kept: IPv4 written inside IPv6 (::ffff:1.2.3.4) as plain IPv4, brackets and ports taken off. */
export function normaliseAddress(value: string): string {
  let address = value.trim();
  // "[::1]:1234" and "1.2.3.4:1234", which some proxies write.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1] as string;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(':'));
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(address);
  if (mapped) address = mapped[1] as string;
  return address.toLowerCase();
}

function trusted(trust: TrustProxy, address: string): boolean {
  if (trust.kind !== 'list') return false;
  const type = isIP(address);
  if (type === 0) return false;
  return trust.list.check(address, type === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The client's address: the connection's, or with a trusted proxy in front,
 * the right-most hop of X-Forwarded-For that is not a trusted proxy. A hop
 * that is not an address at all ends the walk: what is left of it is not
 * believed, and the last trusted hop is used.
 */
export function resolveClientAddress(socketAddress: string | undefined, forwardedFor: string | string[] | undefined, trust: TrustProxy): string {
  const peer = socketAddress ? normaliseAddress(socketAddress) : 'unknown';
  if (trust.kind === 'off' || forwardedFor === undefined) return peer;
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
    .split(',')
    .map((hop) => normaliseAddress(hop))
    .filter((hop) => hop !== '');
  if (trust.kind === 'hops') {
    if (trust.hops === 0) return peer;
    // The peer is the first trusted proxy; each further one added a hop on the right.
    const index = hops.length - trust.hops;
    const chosen = hops[Math.max(0, index)];
    return chosen && isIP(chosen) ? chosen : peer;
  }
  if (!trusted(trust, peer)) return peer;
  let address = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!isIP(hop)) return address;
    address = hop;
    if (!trusted(trust, hop)) return hop;
  }
  // Every hop was a trusted proxy: the left-most is as far as can be known.
  return address;
}

const addresses = new WeakMap<IncomingMessage, string>();

/** Keeps the address worked out for a request (by `app.ts`, as it arrives). */
export function setClientAddress(req: IncomingMessage, address: string): void {
  addresses.set(req, address);
}

/** The address a request came from, for limits on repeated attempts and counting: as worked out for it, or the connection's own. */
export function requestAddress(req: IncomingMessage): string {
  return addresses.get(req) ?? (req.socket.remoteAddress ? normaliseAddress(req.socket.remoteAddress) : 'unknown');
}
