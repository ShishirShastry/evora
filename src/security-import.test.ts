/**
 * Hostile and damaged files (Phase 10): `.fig` (a ZIP of a kiwi-encoded,
 * compressed canvas), `.evora` (JSON) and SVG. Fuzz-style: inputs mutated
 * from fixtures made here, with a fixed seed so that every run tries the same
 * ones, must either open or be refused with a message of the importer's own
 * error type, each within a time limit. Then the attacks by name: ZIP and
 * Zstandard bombs, arrays that claim billions of elements, structures nested
 * without end, cycles of parents, enormous numbers, `<use>` bombs.
 */
import { describe, expect, it } from 'vitest';
import {
  addLayer,
  approximateMeasurer,
  compileSchema,
  createDocument,
  encodeBinarySchema,
  FIG_SCHEMA,
  FigError,
  FileFormatError,
  getPages,
  KiwiError,
  parseSchemaText,
  readFig,
  readSvg,
  readZip,
  serializeFile,
  sha256Hex,
  solidPaint,
  SvgImportError,
  toFile,
  writeFig,
  writeZip,
  zstdDecompress,
  ZstdError,
  type Document,
  type FigEnvironment,
  type KiwiObject,
  type KiwiSchema,
} from './core';
import { importFileText } from './persistence/files';
import { MemoryStorage } from './persistence/storage';
import { InflateLimitError, inflateRaw } from './persistence/compression';

const zlib = (await import('node:zlib' as string)) as {
  deflateRawSync(bytes: Uint8Array): Uint8Array;
  inflateRawSync(bytes: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array;
};

/** The inflate the app uses (the platform's DecompressionStream), with its limit. */
const env: FigEnvironment = {
  inflateRaw: (bytes, limit) => inflateRaw(bytes, limit),
  deflateRaw: async (bytes) => new Uint8Array(zlib.deflateRawSync(bytes)),
  sha256Hex,
  measurer: approximateMeasurer,
};

/** A small, fast, seeded generator (mulberry32): the same inputs on every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PER_INPUT_MS = 5000;

/** Runs one input: it must open, or be refused with one of `allowed`, within PER_INPUT_MS. */
async function survives(label: string, run: () => Promise<unknown> | unknown, allowed: (new (...args: never[]) => Error)[], problems: string[]): Promise<'opened' | 'refused'> {
  const started = performance.now();
  let outcome: 'opened' | 'refused' = 'opened';
  try {
    await run();
  } catch (error) {
    outcome = 'refused';
    if (!allowed.some((type) => error instanceof type)) problems.push(`${label}: ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`);
    else if (!(error as Error).message) problems.push(`${label}: refused without a message`);
  }
  const took = performance.now() - started;
  if (took > PER_INPUT_MS) problems.push(`${label}: took ${Math.round(took)} ms`);
  return outcome;
}

function mutateBytes(bytes: Uint8Array, rnd: () => number): Uint8Array {
  const out = new Uint8Array(bytes);
  const kind = Math.floor(rnd() * 5);
  if (kind === 0) {
    // Flip a few bytes.
    for (let i = 0, n = 1 + Math.floor(rnd() * 8); i < n; i++) out[Math.floor(rnd() * out.length)] = Math.floor(rnd() * 256);
    return out;
  }
  if (kind === 1) return out.subarray(0, Math.floor(rnd() * out.length));
  if (kind === 2) {
    // A length field turned enormous: 0xff bytes in a row read as huge varints and sizes.
    const at = Math.floor(rnd() * out.length);
    for (let i = 0; i < 5 && at + i < out.length; i++) out[at + i] = 0xff;
    return out;
  }
  if (kind === 3) {
    // A run repeated (structures read twice).
    const at = Math.floor(rnd() * out.length);
    const length = Math.min(out.length - at, 1 + Math.floor(rnd() * 64));
    const copy = new Uint8Array(out.length + length);
    copy.set(out.subarray(0, at + length));
    copy.set(out.subarray(at, at + length), at + length);
    copy.set(out.subarray(at + length), at + 2 * length);
    return copy;
  }
  // Zeros over a stretch.
  const at = Math.floor(rnd() * out.length);
  out.fill(0, at, Math.min(out.length, at + 1 + Math.floor(rnd() * 32)));
  return out;
}

/** A small document with a bit of everything that is written to a .fig file. */
function sampleDocument(): Document {
  let doc = createDocument('Fixture');
  const page = getPages(doc)[0]!.id;
  const frame = addLayer(doc, 'FRAME', page, { name: 'Screen', x: 0, y: 0, width: 375, height: 812, fills: [solidPaint({ r: 1, g: 1, b: 1 })] });
  doc = frame.doc;
  doc = addLayer(doc, 'RECTANGLE', frame.id, { name: 'Box', x: 10, y: 10, width: 100, height: 50, cornerRadius: 8 }).doc;
  doc = addLayer(doc, 'ELLIPSE', frame.id, { name: 'Dot', x: 200, y: 10, width: 40, height: 40 }).doc;
  doc = addLayer(doc, 'TEXT', frame.id, { name: 'Title', x: 10, y: 100, characters: 'Hello, world' } as never).doc;
  return doc;
}

/** A Figma canvas from a schema and a message, each stored (uncompressed) as Zstandard data, so mutations reach the decoder itself. */
function canvasOf(schemaBytes: Uint8Array, message: Uint8Array): Uint8Array {
  const store = (bytes: Uint8Array): Uint8Array => {
    // One frame of raw blocks of at most 128 KB each.
    const blocks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length || at === 0; at += 131_072) {
      const part = bytes.subarray(at, Math.min(bytes.length, at + 131_072));
      const last = at + 131_072 >= bytes.length ? 1 : 0;
      const header = (part.length << 3) | last;
      blocks.push(new Uint8Array([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff]), part);
      if (bytes.length === 0) break;
    }
    const frame = [new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00]), ...blocks];
    const total = frame.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of frame) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const parts = [store(schemaBytes), store(message)];
  const canvas = new Uint8Array(12 + parts.reduce((sum, part) => sum + 4 + part.length, 0));
  const view = new DataView(canvas.buffer);
  canvas.set(new TextEncoder().encode('fig-kiwi'));
  view.setUint32(8, 48, true);
  let offset = 12;
  for (const part of parts) {
    view.setUint32(offset, part.length, true);
    canvas.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return canvas;
}

const schema = parseSchemaText(FIG_SCHEMA);
const schemaBytes = encodeBinarySchema(schema);
const g = (session: number, local: number): KiwiObject => ({ sessionID: session, localID: local });
const T = (x: number, y: number): KiwiObject => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

function message(nodeChanges: KiwiObject[]): Uint8Array {
  return compileSchema(schema).encode('Message', { type: 1, nodeChanges, blobs: [] });
}

const baseNodes = (): KiwiObject[] => [
  { guid: g(0, 0), type: 'DOCUMENT', name: 'Document' },
  { guid: g(0, 1), type: 'CANVAS', name: 'Page', parentIndex: { guid: g(0, 0), position: 'a' } },
  { guid: g(1, 1), type: 'FRAME', name: 'Screen', parentIndex: { guid: g(0, 1), position: 'a' }, size: { x: 100, y: 100 }, transform: T(0, 0) },
];

describe('fuzzed .fig files', () => {
  it('open or are refused with a FigError, quickly, for 300 mutated files (seed 20261118)', async () => {
    const rnd = random(20261118);
    const written = await writeFig(sampleDocument(), {}, env);
    const zip = written.bytes;
    // The canvas inside the archive the app wrote, and its message, to mutate at each level.
    const entries = await readZip(zip, env.inflateRaw);
    const canvas = entries.find((entry) => entry.name === 'canvas.fig')!.bytes;
    const plain = canvasOf(schemaBytes, message(baseNodes()));
    const problems: string[] = [];
    const outcomes = { opened: 0, refused: 0 };
    for (let i = 0; i < 300; i++) {
      const level = i % 4;
      const input =
        level === 0
          ? mutateBytes(zip, rnd)
          : level === 1
            ? mutateBytes(canvas, rnd)
            : level === 2
              ? canvasOf(schemaBytes, mutateBytes(message(baseNodes()), rnd))
              : canvasOf(mutateBytes(schemaBytes, rnd), message(baseNodes()));
      outcomes[await survives(`fig #${i} (level ${level})`, () => readFig(input, 'Fuzzed', env), [FigError], problems)]++;
    }
    // The unmutated ones open.
    await readFig(zip, 'Plain', env);
    await readFig(plain, 'Plain', env);
    expect(problems).toEqual([]);
    expect(outcomes.refused).toBeGreaterThan(50);
  }, 120_000);
});

describe('hostile .fig files', () => {
  it('refuses a ZIP bomb: entries that unpack to more than the limit, also when they all point at the same bytes', async () => {
    const zeros = new Uint8Array(8 * 1024 * 1024);
    const packed = new Uint8Array(zlib.deflateRawSync(zeros));
    expect(packed.length).toBeLessThan(20_000);
    // An archive whose one entry is deflated.
    const stored = writeZip([{ name: 'canvas.fig', bytes: packed }]);
    const deflated = new Uint8Array(stored);
    const view = new DataView(deflated.buffer);
    // Mark the entry deflated in both headers (method 8).
    view.setUint16(8, 8, true);
    const central = deflated.length - 22 - (46 + 'canvas.fig'.length);
    view.setUint16(central + 10, 8, true);
    await expect(readZip(deflated, env.inflateRaw, 1024 * 1024)).rejects.toThrow(/more than 1 MB/);
    // The stream stops at the limit rather than unpacking everything first.
    await expect(inflateRaw(packed, 1024 * 1024)).rejects.toBeInstanceOf(InflateLimitError);
    expect((await inflateRaw(packed)).length).toBe(zeros.length);

    // Many entries, all pointing at the same stored bytes: each is small, together they are not.
    const one = new Uint8Array(512 * 1024);
    const overlapping = writeZip(Array.from({ length: 8 }, (_, i) => ({ name: `images/${i}`, bytes: one })));
    await expect(readZip(overlapping, env.inflateRaw, 3 * 512 * 1024)).rejects.toThrow(/unpacks to more than/);
    // As a .fig file, a bomb is a FigError.
    await expect(readFig(deflated, 'Bomb', { ...env, inflateRaw: (bytes) => inflateRaw(bytes, 1024 * 1024) })).rejects.toBeInstanceOf(FigError);
  });

  it('refuses a Zstandard bomb: runs of one byte that would come to gigabytes', () => {
    // A frame of RLE blocks, each 4 bytes standing for 2 MB less one byte.
    const blocks: number[] = [];
    for (let i = 0; i < 600; i++) {
      const header = ((2 ** 21 - 1) << 3) | (1 << 1) | (i === 599 ? 1 : 0);
      blocks.push(header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff, 0x41);
    }
    const bomb = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, ...blocks]);
    expect(bomb.length).toBeLessThan(3000);
    const started = performance.now();
    expect(() => zstdDecompress(bomb, 16 * 1024 * 1024)).toThrow(ZstdError);
    expect(() => zstdDecompress(bomb, 16 * 1024 * 1024)).toThrow(/more than 16 MB/);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('refuses an array that claims billions of elements, and a struct that holds itself', () => {
    const hostile: KiwiSchema = parseSchemaText(`
      struct Empty { }
      message Many { Empty[] items = 1; }
      struct Loop { Loop inner; }
      message Endless { Loop loop = 1; }
    `);
    const codec = compileSchema(hostile);
    // Field 1, an array of 2^32 - 1 empty structs: five bytes of data.
    const many = new Uint8Array([1, 0xff, 0xff, 0xff, 0xff, 0x0f, 0]);
    const started = performance.now();
    expect(() => codec.decode('Many', many)).toThrow(KiwiError);
    expect(() => codec.decode('Many', many)).toThrow(/longer than the data/);
    expect(() => codec.decode('Endless', new Uint8Array([1, 0]))).toThrow(/nested more than/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps a node listed twice, or inside itself, once, and finishes', async () => {
    const nodes: KiwiObject[] = [
      ...baseNodes(),
      // The same frame again, now inside itself: a cycle of parents.
      { guid: g(1, 1), type: 'FRAME', name: 'Screen again', parentIndex: { guid: g(1, 1), position: 'b' }, size: { x: 10, y: 10 }, transform: T(0, 0) },
      // Two nodes inside each other, hanging from nothing on a page.
      { guid: g(2, 1), type: 'FRAME', name: 'A', parentIndex: { guid: g(2, 2), position: 'a' }, size: { x: 1, y: 1 }, transform: T(0, 0) },
      { guid: g(2, 2), type: 'FRAME', name: 'B', parentIndex: { guid: g(2, 1), position: 'a' }, size: { x: 1, y: 1 }, transform: T(0, 0) },
      // The document inside its own page.
      { guid: g(0, 0), type: 'DOCUMENT', name: 'Document', parentIndex: { guid: g(0, 1), position: 'z' } },
    ];
    const started = performance.now();
    const read = await readFig(canvasOf(schemaBytes, message(nodes)), 'Cycles', env);
    expect(performance.now() - started).toBeLessThan(PER_INPUT_MS);
    const names = Object.values(read.doc.nodes).map((node) => node.name);
    expect(names.filter((name) => name === 'Screen' || name === 'Screen again')).toHaveLength(1);
    expect(read.notConverted.join('\n')).toMatch(/listed more than once, or inside themselves/);
  });

  it('reads a page with 50,000 layers side by side in reasonable time (children are not copied for each sibling)', async () => {
    const nodes = baseNodes();
    for (let i = 0; i < 50_000; i++) nodes.push({ guid: g(5, i), type: 'ROUNDED_RECTANGLE', name: `R${i}`, parentIndex: { guid: g(0, 1), position: `a${i.toString(36).padStart(4, '0')}` }, size: { x: 1, y: 1 }, transform: T(i, 0) });
    const started = performance.now();
    const read = await readFig(canvasOf(schemaBytes, message(nodes)), 'Wide', env);
    const took = performance.now() - started;
    expect(Object.keys(read.doc.nodes).length).toBeGreaterThan(50_000);
    expect(took).toBeLessThan(30_000);
  }, 60_000);

  it('turns enormous and non-finite numbers into usable ones', async () => {
    const nodes = [
      ...baseNodes(),
      { guid: g(3, 1), type: 'ROUNDED_RECTANGLE', name: 'Huge', parentIndex: { guid: g(1, 1), position: 'b' }, size: { x: Infinity, y: NaN }, transform: { m00: NaN, m01: Infinity, m02: -Infinity, m10: 1e308, m11: -1e308, m12: NaN }, opacity: NaN, cornerRadius: Infinity, strokeWeight: -Infinity },
    ];
    const read = await readFig(canvasOf(schemaBytes, message(nodes)), 'Numbers', env);
    const huge = Object.values(read.doc.nodes).find((node) => node.name === 'Huge') as unknown as Record<string, unknown> | undefined;
    expect(huge).toBeDefined();
    for (const key of ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'cornerRadius', 'strokeWeight']) {
      const value = huge?.[key];
      if (value !== undefined) expect(Number.isFinite(value), `${key} = ${String(value)}`).toBe(true);
    }
  });
});

describe('fuzzed and hostile .evora files', () => {
  const base = (): string => serializeFile(toFile(sampleDocument(), { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));

  /** A hostile change to the parsed file. */
  function mutateJson(text: string, rnd: () => number): string {
    const file = JSON.parse(text) as { document: { nodes: Record<string, Record<string, unknown>> } } & Record<string, unknown>;
    const nodes = file.document.nodes;
    const ids = Object.keys(nodes);
    const pick = () => nodes[ids[Math.floor(rnd() * ids.length)] as string] as Record<string, unknown>;
    const kind = Math.floor(rnd() * 12);
    const node = pick();
    const keys = Object.keys(node);
    const key = keys[Math.floor(rnd() * keys.length)] as string;
    switch (kind) {
      case 0:
        node.parentId = node.id; // inside itself
        break;
      case 1: {
        // A cycle of two.
        const other = pick();
        node.parentId = other.id;
        other.parentId = node.id;
        break;
      }
      case 2:
        node[key] = 'NUMBER_TOKEN'; // replaced below by an enormous number
        break;
      case 3:
        node[key] = null;
        break;
      case 4:
        node[key] = 'x'.repeat(100_000);
        break;
      case 5:
        node[key] = 'DEEP_TOKEN'; // replaced below by arrays nested 5,000 deep
        break;
      case 6:
        node[key] = { __proto__: { polluted: true } };
        (node as Record<string, unknown>)['__proto__'] = { polluted: true };
        break;
      case 7:
        node.type = ['PAGE', 'FRAME', 'NOPE', 7, null][Math.floor(rnd() * 5)];
        break;
      case 8:
        delete nodes[node.id as string];
        break;
      case 9:
        node[key] = Array.from({ length: 10_000 }, () => ({}));
        break;
      case 10:
        file.document = 'not a document' as never;
        break;
      default:
        file[['format', 'version', 'meta'][Math.floor(rnd() * 3)] as string] = 999_999;
    }
    let out = JSON.stringify(file);
    out = out.replace('"DEEP_TOKEN"', `${'['.repeat(5000)}1${']'.repeat(5000)}`);
    out = out.replace('"NUMBER_TOKEN"', ['1e999', '-1e999', '1e308', '-0', '123456789012345678901234567890'][Math.floor(rnd() * 5)] as string);
    // A JSON-level __proto__ key, as a file can hold it.
    if (kind === 6) out = out.replace('{', '{"__proto__":{"polluted":true},');
    return out;
  }

  it('open or are refused with a FileFormatError, quickly, for 300 mutated files (seed 18112026)', async () => {
    const rnd = random(18112026);
    const text = base();
    const problems: string[] = [];
    const outcomes = { opened: 0, refused: 0 };
    for (let i = 0; i < 300; i++) {
      const input = i % 3 === 0 ? new TextDecoder().decode(mutateBytes(new TextEncoder().encode(text), rnd)) : mutateJson(text, rnd);
      const storage = new MemoryStorage();
      outcomes[await survives(`evora #${i}`, () => importFileText(storage, input), [FileFormatError], problems)]++;
    }
    expect(problems).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(outcomes.opened).toBeGreaterThan(50);
  }, 120_000);

  it('opens a file whose layers are inside each other with every layer reachable from a page', async () => {
    const file = JSON.parse(base());
    const ids = Object.keys(file.document.nodes).filter((id) => file.document.nodes[id].type !== 'PAGE');
    file.document.nodes[ids[0]].parentId = ids[1];
    file.document.nodes[ids[1]].parentId = ids[0];
    const storage = new MemoryStorage();
    const { id } = await importFileText(storage, JSON.stringify(file));
    const opened = (await storage.load(id))!.document;
    // Every layer's chain of parents ends at a page.
    for (const node of Object.values(opened.nodes)) {
      const seen = new Set<string>();
      type Linked = { id: string; parentId?: string | null };
      let current: Linked | undefined = node as unknown as Linked;
      while (current && current.parentId) {
        expect(seen.has(current.id)).toBe(false);
        seen.add(current.id);
        current = opened.nodes[current.parentId] as unknown as Linked | undefined;
      }
    }
  });
});

describe('fuzzed and hostile SVG files', () => {
  const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" viewBox="0 0 200 100">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
  <symbol id="s"><rect width="10" height="10"/></symbol></defs>
  <style>.a { fill: red } #b { stroke: blue }</style>
  <g transform="translate(10 10) rotate(15)" opacity="0.5">
    <rect class="a" x="0" y="0" width="50" height="20" rx="4"/>
    <circle id="b" cx="80" cy="20" r="10" fill="url(#g)"/>
    <path d="M0 0 L10 10 C 20 20 30 0 40 10 Z m 5 5 a 10 10 0 1 1 5 5"/>
    <use xlink:href="#s" x="100" y="50"/>
    <text x="0" y="90" font-size="12">Hello &amp; &#x263A; &constructor;</text>
  </g>
</svg>`;

  it('read or are refused with an SvgImportError, quickly, for 400 mutated files (seed 1118)', async () => {
    const rnd = random(1118);
    const problems: string[] = [];
    const tokens = ['<', '>', '"', '/', '<g>', '</g>', '<use href="#s"/>', ' d="M1e999 NaN L-Infinity 5"', ' width="1e309"', ' transform="matrix(1e308 0 0 1e308 NaN 0)"', '&#x110000;', '&#0;', '<![CDATA[', ']]>', '<!--', '-->', '<!DOCTYPE x [<!ENTITY a "aaaa">]>', ' points="1,2,3"', ' r="-5"', ' __proto__="x"'];
    for (let i = 0; i < 400; i++) {
      let text = SVG;
      for (let n = 0, count = 1 + Math.floor(rnd() * 4); n < count; n++) {
        const at = Math.floor(rnd() * text.length);
        const choice = rnd();
        if (choice < 0.4) text = text.slice(0, at) + (tokens[Math.floor(rnd() * tokens.length)] as string) + text.slice(at);
        else if (choice < 0.7) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rnd() * 20));
        else text = text.slice(0, at);
      }
      await survives(`svg #${i}`, () => readSvg(text), [SvgImportError], problems);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('refuses a <use> bomb (a "billion laughs") instead of making billions of layers', () => {
    // Ten levels, each a group of ten <use>s of the level below: 10^10 rectangles once repeated.
    let defs = '<g id="l0"><rect width="1" height="1"/></g>';
    for (let level = 1; level <= 10; level++) defs += `<g id="l${level}">${Array.from({ length: 10 }, () => `<use href="#l${level - 1}"/>`).join('')}</g>`;
    const bomb = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs><use href="#l10"/></svg>`;
    const started = performance.now();
    expect(() => readSvg(bomb)).toThrow(SvgImportError);
    expect(() => readSvg(bomb)).toThrow(/more than 50,000 shapes/);
    expect(performance.now() - started).toBeLessThan(PER_INPUT_MS);
  });

  it('reads past a file nested a hundred thousand deep, and a <use> that refers to itself', () => {
    const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(100_000)}<rect width="1" height="1"/>${'</g>'.repeat(100_000)}<text>${'<tspan>'.repeat(100_000)}x${'</tspan>'.repeat(100_000)}</text></svg>`;
    const started = performance.now();
    let outcome = 'read';
    try {
      readSvg(deep);
    } catch (error) {
      outcome = error instanceof SvgImportError ? 'refused' : `crashed: ${String(error)}`;
    }
    expect(outcome).not.toMatch(/crashed/);
    const loop = `<svg xmlns="http://www.w3.org/2000/svg"><g id="a"><use href="#a"/><rect width="1" height="1"/></g></svg>`;
    expect(() => readSvg(loop)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(PER_INPUT_MS * 2);
  });

  it('does not take "&constructor;" for a character reference', () => {
    const read = readSvg(`<svg xmlns="http://www.w3.org/2000/svg"><text>&constructor; &amp;</text></svg>`);
    const text = JSON.stringify(read);
    expect(text).toContain('&constructor; &');
    expect(text).not.toContain('native code');
  });
});
