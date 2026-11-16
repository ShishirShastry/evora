import { describe, expect, it } from 'vitest';
import { compileSchema, decodeBinarySchema, encodeBinarySchema, KiwiBuffer, KiwiError, parseSchemaText, type KiwiObject } from './kiwi';
import { isZstd, zstdDecompress, ZstdError, zstdStore } from './zstd';

/**
 * The two encodings a `.fig` file is made of. The Zstandard decoder is
 * checked against data compressed by Node's own Zstandard, which is the
 * reference implementation, at every kind of content and compression level
 * that makes it use a different part of the format.
 */

// Node's own Zstandard, which the application itself never uses: it is here only to make data to test against.
const { constants, zstdCompressSync } = (await import('node:zlib' as string)) as {
  constants: Record<string, number>;
  zstdCompressSync(bytes: Uint8Array, options?: { params: Record<number, number> }): Uint8Array;
};

/** Whether two runs of bytes are the same, said in one word so that a failure does not print them all. */
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Bytes that are the same every run: a simple generator, so a failure can be repeated. */
function noise(count: number, seed: number): Uint8Array {
  const out = new Uint8Array(count);
  let state = seed >>> 0;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('Zstandard', () => {
  const pack = (bytes: Uint8Array, level: number): Uint8Array => new Uint8Array(zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel as number]: level } }));
  const samples: [string, Uint8Array][] = [
    ['nothing', new Uint8Array(0)],
    ['one byte', new Uint8Array([7])],
    ['a short sentence', text('The quick brown fox jumps over the lazy dog.')],
    ['one byte many times', new Uint8Array(100000).fill(65)],
    ['a phrase many times', text('figma kiwi zstd '.repeat(5000))],
    ['prose with few distinct letters', text(Array.from({ length: 4000 }, (_, i) => ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'][(i * 7) % 6] + (i % 13 === 0 ? '\n' : ' ')).join(''))],
    ['noise, which does not compress', noise(70000, 1)],
    ['noise of sixteen values, which only Huffman helps', noise(60000, 2).map((byte) => byte & 15)],
    ['noise with stretches repeated', (() => {
      const base = noise(300000, 3);
      for (let i = 20000; i < 300000; i += 9000) base.copyWithin(i, i - 15000, i - 15000 + 4000);
      return base;
    })()],
    ['more than one block of text', text(Array.from({ length: 60000 }, (_, i) => `node ${i} { x: ${i % 97}, y: ${(i * 31) % 211}, name: "Layer ${i % 50}" }\n`).join(''))],
    ['JSON, as a design file is', text(JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ guid: { sessionID: 1, localID: i }, type: i % 3 === 0 ? 'FRAME' : 'RECTANGLE', size: { x: i * 1.5, y: 40 }, fillPaints: [{ type: 'SOLID', color: { r: (i % 255) / 255, g: 0.5, b: 1, a: 1 } }] }))))],
  ];

  it('undoes what the reference implementation compresses, at every level', () => {
    for (const [name, bytes] of samples) {
      for (const level of [1, 3, 9, 19]) {
        const packed = pack(bytes, level);
        expect(isZstd(packed), name).toBe(true);
        const unpacked = zstdDecompress(packed);
        // Compared by length first, so that a failure says which sample and level, not a million numbers.
        expect([name, level, unpacked.length], `${name} at level ${level}`).toEqual([name, level, bytes.length]);
        expect(same(unpacked, bytes), `${name} at level ${level}`).toBe(true);
      }
    }
  }, 60000);

  it('reads frames one after another, with a checksum, and frames that are to be skipped', () => {
    const a = pack(text('first '), 3);
    const b = new Uint8Array(zstdCompressSync(text('second'), { params: { [constants.ZSTD_c_checksumFlag as number]: 1 } }));
    const skip = new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 9, 9, 9]);
    const all = new Uint8Array([...a, ...skip, ...b]);
    expect(new TextDecoder().decode(zstdDecompress(all))).toBe('first second');
  });

  it('wraps bytes uncompressed in a way every reader takes, and says what is wrong with what is not Zstandard', () => {
    for (const bytes of [new Uint8Array(0), text('stored'), noise(300000, 4)]) {
      const stored = zstdStore(bytes);
      expect(isZstd(stored)).toBe(true);
      expect(same(zstdDecompress(stored), bytes)).toBe(true);
    }
    expect(isZstd(text('plain'))).toBe(false);
    expect(() => zstdDecompress(text('plain text'))).toThrow(ZstdError);
    const packed = pack(text('figma kiwi zstd '.repeat(500)), 3);
    expect(() => zstdDecompress(packed.subarray(0, packed.length - 5))).toThrow(ZstdError);
    // Damage inside is noticed or gives other bytes, but never hangs or reads outside the data.
    for (let i = 8; i < packed.length; i += 3) {
      const damaged = packed.slice();
      damaged[i] = (damaged[i] as number) ^ 0x55;
      try {
        zstdDecompress(damaged);
      } catch (error) {
        expect(error).toBeInstanceOf(ZstdError);
      }
    }
  });
});

describe('Kiwi', () => {
  const schemaText = `
    enum Kind { NONE = 0; FRAME = 4; TEXT = 13; }
    struct Point { float x; float y; }
    struct Guid { uint sessionID; uint localID; }
    message Paint { Kind kind = 1; float opacity = 2; bool visible = 3; Point[] stops = 4; }
    message Node {
      Guid guid = 1;
      Kind type = 2;
      string name = 3;
      Point size = 4;
      Paint[] fills = 5;
      byte[] blob = 6;
      int delta = 7;
      int64 big = 8;
      uint64 bigger = 9;
      Node[] children = 10;
      float[] numbers = 11;
      string[] words = 12;
    }
  `;

  it('writes numbers, floats and text the way Kiwi does, and reads them back', () => {
    const buffer = new KiwiBuffer();
    for (const value of [0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 32 - 1]) buffer.writeVarUint(value);
    for (const value of [0, -1, 1, -64, 64, 2 ** 31 - 1, -(2 ** 31)]) buffer.writeVarInt(value);
    for (const value of [0, 1, -1, 0.5, 123.456, 1e-30, -3.4e38]) buffer.writeVarFloat(value);
    buffer.writeString('héllo ✓');
    buffer.writeByteArray(new Uint8Array([1, 2, 3]));
    for (const value of [0n, 1n, 2n ** 40n, 2n ** 64n - 1n]) buffer.writeVarUint64(value);
    for (const value of [0n, -1n, 2n ** 62n, -(2n ** 63n)]) buffer.writeVarInt64(value);
    const bytes = buffer.toBytes();
    // The first numbers are one byte each; 128 is two.
    expect([...bytes.subarray(0, 5)]).toEqual([0, 1, 127, 0x80, 1]);
    const input = new KiwiBuffer(bytes);
    expect([0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 32 - 1].map(() => input.readVarUint())).toEqual([0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 32 - 1]);
    expect([1, 2, 3, 4, 5, 6, 7].map(() => input.readVarInt())).toEqual([0, -1, 1, -64, 64, 2 ** 31 - 1, -(2 ** 31)]);
    expect([1, 2, 3, 4].map(() => input.readVarFloat())).toEqual([0, 1, -1, 0.5]);
    expect(input.readVarFloat()).toBeCloseTo(123.456, 3);
    expect(input.readVarFloat()).toBeCloseTo(1e-30, 35);
    expect(input.readVarFloat()).toBeCloseTo(-3.4e38, -32);
    expect(input.readString()).toBe('héllo ✓');
    expect(input.readByteArray()).toEqual(new Uint8Array([1, 2, 3]));
    expect([1, 2, 3, 4].map(() => input.readVarUint64())).toEqual([0n, 1n, 2n ** 40n, 2n ** 64n - 1n]);
    expect([1, 2, 3, 4].map(() => input.readVarInt64())).toEqual([0n, -1n, 2n ** 62n, -(2n ** 63n)]);
    expect(input.atEnd).toBe(true);
    // Zero is one byte as a float; one is four, with the exponent first.
    const one = new KiwiBuffer();
    one.writeVarFloat(0);
    one.writeVarFloat(1);
    expect([...one.toBytes()]).toEqual([0, 0x7f, 0, 0, 0]);
    expect(() => new KiwiBuffer(new Uint8Array([0x80])).readVarUint()).toThrow(KiwiError);
  });

  it('carries its schema in binary, and reads and writes data by it', () => {
    const schema = parseSchemaText(schemaText);
    expect(schema.definitions.map((definition) => [definition.name, definition.kind, definition.fields.length])).toEqual([['Kind', 'ENUM', 3], ['Point', 'STRUCT', 2], ['Guid', 'STRUCT', 2], ['Paint', 'MESSAGE', 4], ['Node', 'MESSAGE', 12]]);
    // The schema survives being written as bytes and read again.
    const binary = encodeBinarySchema(schema);
    expect(decodeBinarySchema(binary)).toEqual(schema);
    const codec = compileSchema(decodeBinarySchema(binary));
    const node = {
      guid: { sessionID: 1, localID: 42 },
      type: 'FRAME',
      name: 'Card “one”',
      size: { x: 200, y: 100.5 },
      fills: [{ kind: 'TEXT', opacity: 0.5, visible: true, stops: [{ x: 0, y: 0 }, { x: 1, y: 0.25 }] }, { visible: false }],
      blob: new Uint8Array([0, 255, 7]),
      delta: -12,
      big: -5n,
      bigger: 2n ** 60n,
      children: [{ name: 'child', children: [] }],
      numbers: [0, 1.5, -2],
      words: ['a', '', 'ccc'],
    };
    const bytes = codec.encode('Node', node as unknown as KiwiObject);
    expect(codec.decode('Node', bytes)).toEqual(node);
    // A message holds only the fields it was given: an empty one is a single zero.
    expect([...codec.encode('Node', {})]).toEqual([0]);
    expect(codec.decode('Node', new Uint8Array([0]))).toEqual({});
    // Field 3 (the name), the text, its end, and the end of the message.
    expect([...codec.encode('Node', { name: 'A' })]).toEqual([3, 65, 0, 0]);
    // A number the schema has no name for is kept; a name it does not have cannot be written.
    expect(codec.decode('Node', new Uint8Array([2, 9, 0]))).toEqual({ type: 9 });
    expect(() => codec.encode('Node', { type: 'SPHERE' })).toThrow('not one of the values');
    expect(() => codec.encode('Node', { colour: 1 })).toThrow('has no field "colour"');
    expect(() => codec.encode('Node', { size: { x: 1 } })).toThrow('needs every one of its fields');
    expect(() => codec.decode('Node', new Uint8Array([99, 0]))).toThrow('does not have');
    expect(() => codec.decode('Shape', new Uint8Array([0]))).toThrow('no message or struct');
  });
});
