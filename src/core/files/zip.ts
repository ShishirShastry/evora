/**
 * ZIP archives: written without compression (every entry stored as it is),
 * and read whether stored or deflated. A batch export is one, and so is a
 * `.fig` file.
 */

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

let table: Uint32Array | null = null;

/** The CRC-32 checksum ZIP (and PNG) use. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (table[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Writes an archive with the entries stored uncompressed. */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    // Names are UTF-8.
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    // 1 January 1980: the archive says nothing of when it was made, so the same content gives the same file.
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.bytes.length, true);
    local.setUint32(22, entry.bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, 0, true);
    header.setUint16(14, 0x21, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, entry.bytes.length, true);
    header.setUint32(24, entry.bytes.length, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, entry.bytes);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + entry.bytes.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Whether bytes begin as a ZIP archive does. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);
}

/**
 * Reads an archive. `inflate` undoes raw deflate, for the entries that are
 * compressed. Throws when the bytes are not an archive it can read.
 */
export async function readZip(bytes: Uint8Array, inflate: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('This is not a ZIP archive.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('The ZIP archive is damaged.');
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('The ZIP archive is damaged.');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + packed);
    // A name that ends in a slash is a folder, which holds nothing itself.
    if (name.endsWith('/')) continue;
    if (method === 0) out.push({ name, bytes: data });
    else if (method === 8) out.push({ name, bytes: await inflate(data) });
    else throw new Error(`The ZIP archive uses a kind of compression (${method}) that cannot be read.`);
  }
  return out;
}
