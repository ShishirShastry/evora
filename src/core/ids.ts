const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 16;
// Largest multiple of 62 that fits in a byte; bytes at or above it are rejected
// so every character is uniformly distributed.
const REJECT_FROM = 248;

/** Creates a stable, globally unique ID for a document or node. */
export function createId(): string {
  let out = '';
  const bytes = new Uint8Array(ID_LENGTH * 2);
  while (out.length < ID_LENGTH) {
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < ID_LENGTH; i++) {
      const byte = bytes[i] as number;
      if (byte < REJECT_FROM) out += ALPHABET[byte % 62];
    }
  }
  return out;
}
