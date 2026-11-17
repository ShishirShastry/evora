/**
 * Passwords, session tokens and a limit on repeated attempts.
 *
 * Passwords are kept as scrypt hashes with a random salt of their own and
 * compared in constant time. Session and guest tokens are 32 random bytes;
 * only their SHA-256 is stored, so the database alone cannot be used to sign in.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, length, { N: n, r, p, maxmem: 128 * n * r * 2 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** A password as it is kept: `scrypt:N:r:p:<salt>:<hash>`, both in base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH);
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${key.toString('base64')}`;
}

/** Whether a password matches what is kept, compared in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A password hash to check against when there is no such account, so that an unknown email takes as long as a wrong password. */
let decoy: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(16).toString('hex'));
  return decoy;
}

/** A new secret token: 32 random bytes, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored for a token: its SHA-256 in hex. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Counts attempts per key in a fixed window, against abuse: signing in with
 * wrong passwords over and over, or making accounts or guests in bulk.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private counts = new Map<string, { count: number; until: number }>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Whether another attempt is allowed now. */
  allowed(key: string, nowMs = Date.now()): boolean {
    const entry = this.counts.get(key);
    return !entry || entry.until <= nowMs || entry.count < this.limit;
  }

  /** Counts an attempt. */
  hit(key: string, nowMs = Date.now()): void {
    const entry = this.counts.get(key);
    if (!entry || entry.until <= nowMs) this.counts.set(key, { count: 1, until: nowMs + this.windowMs });
    else entry.count++;
    if (this.counts.size > 10_000) this.sweep(nowMs);
  }

  reset(key: string): void {
    this.counts.delete(key);
  }

  private sweep(nowMs: number): void {
    for (const [key, entry] of this.counts) if (entry.until <= nowMs) this.counts.delete(key);
  }
}
