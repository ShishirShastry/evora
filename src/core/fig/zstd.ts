/**
 * Zstandard decompression (RFC 8878), with nothing but this file. A `.fig`
 * file holds its data compressed this way, and browsers cannot undo it
 * themselves. Dictionaries are not supported: `.fig` files do not use them.
 */

export class ZstdError extends Error {}

const MAGIC = 0xfd2fb528;

const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];
const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];

const highestBit = (value: number): number => 31 - Math.clz32(value);

/** Reads bits from the front of some bytes, lowest bit of each byte first: how table descriptions are written. */
class ForwardBits {
  private bit = 0;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly start: number,
    private readonly end: number,
  ) {}

  read(count: number): number {
    let result = 0;
    for (let got = 0; got < count; ) {
      const index = this.start + (this.bit >> 3);
      if (index >= this.end) throw new ZstdError('The compressed data ends in the middle of a table.');
      const offset = this.bit & 7;
      const take = Math.min(8 - offset, count - got);
      result += (((this.bytes[index] as number) >> offset) & ((1 << take) - 1)) * 2 ** got;
      got += take;
      this.bit += take;
    }
    return result;
  }

  rewind(count: number): void {
    this.bit -= count;
  }

  /** How many whole bytes have been used, counting one that was only partly read. */
  bytesUsed(): number {
    return (this.bit + 7) >> 3;
  }
}

/** Reads bits from the end of some bytes towards their start: how the streams of symbols are written. Bits before the start are zeros. */
class BackwardBits {
  /** How many bits are left before the start. Goes below zero when more are asked for than there are. */
  offset: number;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly start: number,
    length: number,
  ) {
    if (length <= 0) throw new ZstdError('A stream of the compressed data is empty.');
    const last = bytes[start + length - 1] as number;
    // The last byte ends with a one and then zeros, which mark where the stream stops.
    if (last === 0) throw new ZstdError('A stream of the compressed data has no end mark.');
    this.offset = length * 8 - (8 - highestBit(last));
  }

  read(count: number): number {
    if (count === 0) return 0;
    this.offset -= count;
    let at = this.offset;
    let wanted = count;
    let shift = 0;
    if (at < 0) {
      wanted += at;
      shift = -at;
      at = 0;
      if (wanted <= 0) return 0;
    }
    let result = 0;
    let index = this.start + (at >> 3);
    let bit = at & 7;
    for (let got = 0; got < wanted; ) {
      const take = Math.min(8 - bit, wanted - got);
      result += (((this.bytes[index] as number) >> bit) & ((1 << take) - 1)) * 2 ** got;
      got += take;
      bit = 0;
      index++;
    }
    return result * 2 ** shift;
  }
}

/** A table for decoding FSE-coded symbols: for each state, the symbol it stands for and how to get the next state. */
interface FseTable {
  accuracy: number;
  symbols: Uint8Array;
  bits: Uint8Array;
  base: Uint16Array;
}

function fseTable(frequencies: readonly number[], accuracy: number): FseTable {
  const size = 1 << accuracy;
  const symbols = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const base = new Uint16Array(size);
  const next = new Uint16Array(frequencies.length);
  let high = size;
  // Symbols that are "less than one" get the states at the top, one each.
  frequencies.forEach((frequency, symbol) => {
    if (frequency === -1) {
      symbols[--high] = symbol;
      next[symbol] = 1;
    }
  });
  const step = (size >> 1) + (size >> 3) + 3;
  const mask = size - 1;
  let position = 0;
  frequencies.forEach((frequency, symbol) => {
    if (frequency <= 0) return;
    next[symbol] = frequency;
    for (let i = 0; i < frequency; i++) {
      symbols[position] = symbol;
      do {
        position = (position + step) & mask;
      } while (position >= high);
    }
  });
  if (position !== 0) throw new ZstdError('A table of the compressed data does not add up.');
  for (let state = 0; state < size; state++) {
    const symbol = symbols[state] as number;
    const count = next[symbol] as number;
    next[symbol] = count + 1;
    bits[state] = accuracy - highestBit(count);
    base[state] = (count << (bits[state] as number)) - size;
  }
  return { accuracy, symbols, bits, base };
}

/** Reads the description of an FSE table. Returns the table and how many bytes the description took. */
function readFseTable(bytes: Uint8Array, start: number, end: number, maxAccuracy: number, maxSymbols: number): { table: FseTable; used: number } {
  const input = new ForwardBits(bytes, start, end);
  const accuracy = 5 + input.read(4);
  if (accuracy > maxAccuracy) throw new ZstdError('A table of the compressed data is finer than is allowed.');
  let remaining = 1 << accuracy;
  const frequencies: number[] = [];
  while (remaining > 0 && frequencies.length < maxSymbols) {
    const count = highestBit(remaining + 1) + 1;
    let value = input.read(count);
    // Small values are written in one bit fewer.
    const lowerMask = (1 << (count - 1)) - 1;
    const threshold = (1 << count) - 1 - (remaining + 1);
    if ((value & lowerMask) < threshold) {
      input.rewind(1);
      value &= lowerMask;
    } else if (value > lowerMask) value -= threshold;
    const probability = value - 1;
    remaining -= probability < 0 ? -probability : probability;
    frequencies.push(probability);
    if (probability === 0) {
      // A zero is followed by how many more zeros there are, two bits at a time.
      let repeat = input.read(2);
      for (;;) {
        for (let i = 0; i < repeat && frequencies.length < maxSymbols; i++) frequencies.push(0);
        if (repeat !== 3) break;
        repeat = input.read(2);
      }
    }
  }
  if (remaining !== 0) throw new ZstdError('A table of the compressed data does not add up.');
  return { table: fseTable(frequencies, accuracy), used: input.bytesUsed() };
}

/** A table for decoding Huffman-coded literals. */
interface HuffmanTable {
  maxBits: number;
  symbols: Uint8Array;
  bits: Uint8Array;
}

function huffmanTable(weights: readonly number[]): HuffmanTable {
  // The last weight is not written: it is whatever makes the total a power of two.
  let sum = 0;
  for (const weight of weights) if (weight > 0) sum += 1 << (weight - 1);
  if (sum === 0) throw new ZstdError('A Huffman table of the compressed data is empty.');
  const maxBits = highestBit(sum) + 1;
  const left = (1 << maxBits) - sum;
  if ((left & (left - 1)) !== 0) throw new ZstdError('A Huffman table of the compressed data does not add up.');
  const all = [...weights, highestBit(left) + 1];
  const lengths = all.map((weight) => (weight > 0 ? maxBits + 1 - weight : 0));
  const size = 1 << maxBits;
  const symbols = new Uint8Array(size);
  const bits = new Uint8Array(size);
  // Where the codes of each length start: the longest codes first.
  const count = new Array<number>(maxBits + 1).fill(0);
  for (const length of lengths) count[length] = (count[length] as number) + 1;
  const index = new Array<number>(maxBits + 1).fill(0);
  for (let length = maxBits; length >= 1; length--) {
    index[length - 1] = (index[length] as number) + (count[length] as number) * (1 << (maxBits - length));
    bits.fill(length, index[length] as number, index[length - 1] as number);
  }
  if (index[0] !== size) throw new ZstdError('A Huffman table of the compressed data does not add up.');
  lengths.forEach((length, symbol) => {
    if (length === 0) return;
    const span = 1 << (maxBits - length);
    symbols.fill(symbol, index[length] as number, (index[length] as number) + span);
    index[length] = (index[length] as number) + span;
  });
  return { maxBits, symbols, bits };
}

/** Reads the description of a Huffman table. Returns the table and how many bytes the description took. */
function readHuffmanTable(bytes: Uint8Array, start: number, end: number): { table: HuffmanTable; used: number } {
  if (start >= end) throw new ZstdError('The compressed data ends where a Huffman table should be.');
  const header = bytes[start] as number;
  const weights: number[] = [];
  if (header >= 128) {
    // The weights themselves, four bits each.
    const count = header - 127;
    const length = (count + 1) >> 1;
    if (start + 1 + length > end) throw new ZstdError('The compressed data ends in the middle of a Huffman table.');
    for (let i = 0; i < count; i++) {
      const byte = bytes[start + 1 + (i >> 1)] as number;
      weights.push(i % 2 === 0 ? byte >> 4 : byte & 15);
    }
    return { table: huffmanTable(weights), used: 1 + length };
  }
  // The weights, FSE-coded with two states that take turns.
  if (start + 1 + header > end) throw new ZstdError('The compressed data ends in the middle of a Huffman table.');
  const { table, used } = readFseTable(bytes, start + 1, start + 1 + header, 6, 256);
  const stream = new BackwardBits(bytes, start + 1 + used, header - used);
  let first = stream.read(table.accuracy);
  let second = stream.read(table.accuracy);
  for (;;) {
    weights.push(table.symbols[first] as number);
    first = (table.base[first] as number) + stream.read(table.bits[first] as number);
    if (stream.offset < 0) {
      weights.push(table.symbols[second] as number);
      break;
    }
    weights.push(table.symbols[second] as number);
    second = (table.base[second] as number) + stream.read(table.bits[second] as number);
    if (stream.offset < 0) {
      weights.push(table.symbols[first] as number);
      break;
    }
    if (weights.length > 255) throw new ZstdError('A Huffman table of the compressed data is too long.');
  }
  return { table: huffmanTable(weights), used: 1 + header };
}

function huffmanStream(table: HuffmanTable, bytes: Uint8Array, start: number, length: number, out: Uint8Array, at: number, count: number): void {
  const stream = new BackwardBits(bytes, start, length);
  const mask = (1 << table.maxBits) - 1;
  let state = stream.read(table.maxBits);
  for (let i = 0; i < count; i++) {
    out[at + i] = table.symbols[state] as number;
    const width = table.bits[state] as number;
    state = ((state << width) + stream.read(width)) & mask;
  }
  // Every bit of the stream is used, and no more: the last state reads exactly up to its start.
  if (stream.offset !== -table.maxBits) throw new ZstdError('A stream of literals in the compressed data is damaged.');
}

/** What one frame carries from block to block. */
interface FrameState {
  huffman: HuffmanTable | null;
  literalLengths: FseTable | null;
  offsets: FseTable | null;
  matchLengths: FseTable | null;
  repeats: [number, number, number];
}

/** Grows as it is written to; what was written stays where matches can copy it from. */
class Output {
  bytes: Uint8Array;
  length = 0;
  private readonly limit: number;
  constructor(size: number, limit: number) {
    this.limit = limit;
    this.bytes = new Uint8Array(Math.min(limit, Math.max(1024, size)));
  }

  private room(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    // A few bytes can stand for gigabytes (a run of one byte, or a match repeated): what comes out is limited.
    if (this.length + extra > this.limit) throw new ZstdError(`The compressed data comes to more than ${Math.round(this.limit / 2 ** 20)} MB, which is more than a file is read to.`);
    const bigger = new Uint8Array(Math.min(this.limit, Math.max(this.bytes.length * 2, this.length + extra)));
    bigger.set(this.bytes.subarray(0, this.length));
    this.bytes = bigger;
  }

  write(source: Uint8Array, start: number, count: number): void {
    this.room(count);
    this.bytes.set(source.subarray(start, start + count), this.length);
    this.length += count;
  }

  fill(value: number, count: number): void {
    this.room(count);
    this.bytes.fill(value, this.length, this.length + count);
    this.length += count;
  }

  /** Copies bytes written `distance` back: one at a time, since what is copied may run into what it writes. */
  copy(distance: number, count: number, frameStart: number): void {
    if (distance <= 0 || distance > this.length - frameStart) throw new ZstdError('The compressed data refers to something before its own start.');
    this.room(count);
    const bytes = this.bytes;
    let from = this.length - distance;
    let to = this.length;
    for (let i = 0; i < count; i++) bytes[to++] = bytes[from++] as number;
    this.length = to;
  }
}

function sequenceTable(mode: number, bytes: Uint8Array, at: number, end: number, defaults: readonly number[], defaultAccuracy: number, maxAccuracy: number, previous: FseTable | null): { table: FseTable; used: number } {
  if (mode === 0) return { table: fseTable(defaults, defaultAccuracy), used: 0 };
  if (mode === 1) {
    // One symbol, always: a table of one state that needs no bits.
    if (at >= end) throw new ZstdError('The compressed data ends in the middle of its sequences.');
    return { table: { accuracy: 0, symbols: new Uint8Array([bytes[at] as number]), bits: new Uint8Array(1), base: new Uint16Array(1) }, used: 1 };
  }
  if (mode === 2) return readFseTable(bytes, at, end, maxAccuracy, 256);
  if (!previous) throw new ZstdError('The compressed data repeats a table it never had.');
  return { table: previous, used: 0 };
}

function compressedBlock(bytes: Uint8Array, start: number, end: number, out: Output, state: FrameState, frameStart: number): void {
  // The literals: bytes that are copied as they are, between matches.
  let at = start;
  if (at >= end) throw new ZstdError('A block of the compressed data is empty.');
  const b0 = bytes[at] as number;
  const type = b0 & 3;
  const format = (b0 >> 2) & 3;
  let literals: Uint8Array;
  if (type < 2) {
    let size: number;
    let header: number;
    if (format === 0 || format === 2) {
      size = b0 >> 3;
      header = 1;
    } else if (format === 1) {
      size = (b0 >> 4) | ((bytes[at + 1] as number) << 4);
      header = 2;
    } else {
      size = (b0 >> 4) | ((bytes[at + 1] as number) << 4) | ((bytes[at + 2] as number) << 12);
      header = 3;
    }
    if (type === 0) {
      if (at + header + size > end) throw new ZstdError('The compressed data ends in the middle of its literals.');
      literals = bytes.subarray(at + header, at + header + size);
      at += header + size;
    } else {
      literals = new Uint8Array(size).fill(bytes[at + header] as number);
      at += header + 1;
    }
  } else {
    let size: number;
    let packed: number;
    let header: number;
    const streams = format === 0 ? 1 : 4;
    const b1 = bytes[at + 1] as number;
    const b2 = bytes[at + 2] as number;
    if (format < 2) {
      size = ((b0 >> 4) | (b1 << 4)) & 0x3ff;
      packed = ((b1 >> 6) | (b2 << 2)) & 0x3ff;
      header = 3;
    } else if (format === 2) {
      const b3 = bytes[at + 3] as number;
      size = ((b0 >> 4) | (b1 << 4) | (b2 << 12)) & 0x3fff;
      packed = ((b2 >> 2) | (b3 << 6)) & 0x3fff;
      header = 4;
    } else {
      const b3 = bytes[at + 3] as number;
      const b4 = bytes[at + 4] as number;
      size = ((b0 >> 4) | (b1 << 4) | (b2 << 12)) & 0x3ffff;
      packed = ((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3ffff;
      header = 5;
    }
    let body = at + header;
    const bodyEnd = body + packed;
    if (bodyEnd > end) throw new ZstdError('The compressed data ends in the middle of its literals.');
    if (type === 2) {
      const tree = readHuffmanTable(bytes, body, bodyEnd);
      state.huffman = tree.table;
      body += tree.used;
    }
    const table = state.huffman;
    if (!table) throw new ZstdError('The compressed data reuses a Huffman table it never had.');
    literals = new Uint8Array(size);
    if (streams === 1) huffmanStream(table, bytes, body, bodyEnd - body, literals, 0, size);
    else {
      // Four streams, each a quarter of the literals; the sizes of the first three are written first.
      if (body + 6 > bodyEnd) throw new ZstdError('The compressed data ends in the middle of its literals.');
      const sizes = [0, 1, 2].map((i) => (bytes[body + i * 2] as number) | ((bytes[body + i * 2 + 1] as number) << 8));
      const quarter = (size + 3) >> 2;
      let from = body + 6;
      let to = 0;
      for (let i = 0; i < 4; i++) {
        const length = i < 3 ? (sizes[i] as number) : bodyEnd - from;
        const count = i < 3 ? quarter : size - quarter * 3;
        if (count < 0 || from + length > bodyEnd) throw new ZstdError('The literals of the compressed data are damaged.');
        if (count > 0) huffmanStream(table, bytes, from, length, literals, to, count);
        from += length;
        to += count;
      }
    }
    at = bodyEnd;
  }

  // The sequences: how many literals to copy, then how far back and how much to copy from what is already written.
  if (at >= end) {
    out.write(literals, 0, literals.length);
    return;
  }
  let count = bytes[at++] as number;
  if (count === 0) {
    out.write(literals, 0, literals.length);
    return;
  }
  if (count >= 128) {
    if (count === 255) {
      count = (bytes[at] as number) + ((bytes[at + 1] as number) << 8) + 0x7f00;
      at += 2;
    } else {
      count = ((count - 128) << 8) + (bytes[at] as number);
      at += 1;
    }
  }
  if (at >= end) throw new ZstdError('The compressed data ends in the middle of its sequences.');
  const modes = bytes[at++] as number;
  const ll = sequenceTable(modes >> 6, bytes, at, end, LL_DEFAULT, 6, 9, state.literalLengths);
  at += ll.used;
  const of = sequenceTable((modes >> 4) & 3, bytes, at, end, OF_DEFAULT, 5, 8, state.offsets);
  at += of.used;
  const ml = sequenceTable((modes >> 2) & 3, bytes, at, end, ML_DEFAULT, 6, 9, state.matchLengths);
  at += ml.used;
  state.literalLengths = ll.table;
  state.offsets = of.table;
  state.matchLengths = ml.table;

  const stream = new BackwardBits(bytes, at, end - at);
  let llState = stream.read(ll.table.accuracy);
  let ofState = stream.read(of.table.accuracy);
  let mlState = stream.read(ml.table.accuracy);
  const repeats = state.repeats;
  let used = 0;
  for (let i = 0; i < count; i++) {
    const ofCode = of.table.symbols[ofState] as number;
    const llCode = ll.table.symbols[llState] as number;
    const mlCode = ml.table.symbols[mlState] as number;
    if (llCode >= LL_BASE.length || mlCode >= ML_BASE.length || ofCode > 31) throw new ZstdError('The sequences of the compressed data are damaged.');
    const offsetValue = 2 ** ofCode + stream.read(ofCode);
    const matchLength = (ML_BASE[mlCode] as number) + stream.read(ML_BITS[mlCode] as number);
    const literalLength = (LL_BASE[llCode] as number) + stream.read(LL_BITS[llCode] as number);
    if (i < count - 1) {
      llState = (ll.table.base[llState] as number) + stream.read(ll.table.bits[llState] as number);
      mlState = (ml.table.base[mlState] as number) + stream.read(ml.table.bits[mlState] as number);
      ofState = (of.table.base[ofState] as number) + stream.read(of.table.bits[ofState] as number);
    }
    // How far back: a new distance, or one of the last three again.
    let distance: number;
    if (offsetValue > 3) {
      distance = offsetValue - 3;
      repeats[2] = repeats[1];
      repeats[1] = repeats[0];
      repeats[0] = distance;
    } else {
      let index = offsetValue - 1;
      if (literalLength === 0) index++;
      if (index === 0) distance = repeats[0];
      else {
        distance = index < 3 ? (repeats[index] as number) : repeats[0] - 1;
        if (index > 1) repeats[2] = repeats[1];
        repeats[1] = repeats[0];
        repeats[0] = distance;
      }
    }
    if (used + literalLength > literals.length) throw new ZstdError('The compressed data asks for more literals than it has.');
    out.write(literals, used, literalLength);
    used += literalLength;
    out.copy(distance, matchLength, frameStart);
  }
  if (stream.offset < 0) throw new ZstdError('The sequences of the compressed data are damaged.');
  out.write(literals, used, literals.length - used);
}

/** Whether bytes begin as Zstandard data does. */
export function isZstd(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}

/** Undoes Zstandard compression. Throws a `ZstdError` when the data is damaged or uses what is not supported. */
/** The most bytes compressed data is read to (1 GiB): beyond that it is refused as damaged or hostile. */
export const MAX_DECOMPRESSED_BYTES = 2 ** 30;

export function zstdDecompress(bytes: Uint8Array, maxOutput: number = MAX_DECOMPRESSED_BYTES): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Output(bytes.length * 4, maxOutput);
  let at = 0;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) throw new ZstdError('The compressed data ends too soon.');
    const magic = view.getUint32(at, true);
    // A frame that is to be skipped: its size, then that many bytes of anything.
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
      if (at + 8 > bytes.length) throw new ZstdError('The compressed data ends too soon.');
      at += 8 + view.getUint32(at + 4, true);
      continue;
    }
    if (magic !== MAGIC) throw new ZstdError('This is not Zstandard data.');
    at += 4;
    const descriptor = bytes[at++] as number;
    const single = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionary = descriptor & 3;
    const sizeFlag = descriptor >> 6;
    if ((descriptor & 0x08) !== 0) throw new ZstdError('The compressed data uses something that is reserved.');
    if (!single) at += 1;
    if (dictionary !== 0) {
      const length = dictionary === 3 ? 4 : dictionary;
      let id = 0;
      for (let i = 0; i < length; i++) id += (bytes[at + i] as number) * 2 ** (8 * i);
      at += length;
      if (id !== 0) throw new ZstdError('The compressed data needs a dictionary, which is not supported.');
    }
    at += sizeFlag === 0 ? (single ? 1 : 0) : sizeFlag === 1 ? 2 : sizeFlag === 2 ? 4 : 8;
    const frameStart = out.length;
    const state: FrameState = { huffman: null, literalLengths: null, offsets: null, matchLengths: null, repeats: [1, 4, 8] };
    for (;;) {
      if (at + 3 > bytes.length) throw new ZstdError('The compressed data ends in the middle of a frame.');
      const header = (bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16);
      at += 3;
      const last = (header & 1) !== 0;
      const type = (header >> 1) & 3;
      const size = header >> 3;
      if (type === 0) {
        if (at + size > bytes.length) throw new ZstdError('The compressed data ends in the middle of a block.');
        out.write(bytes, at, size);
        at += size;
      } else if (type === 1) {
        if (at >= bytes.length) throw new ZstdError('The compressed data ends in the middle of a block.');
        out.fill(bytes[at] as number, size);
        at += 1;
      } else if (type === 2) {
        if (at + size > bytes.length) throw new ZstdError('The compressed data ends in the middle of a block.');
        compressedBlock(bytes, at, at + size, out, state, frameStart);
        at += size;
      } else throw new ZstdError('The compressed data has a block of a kind that is reserved.');
      if (last) break;
    }
    if (checksum) at += 4;
  }
  return out.bytes.slice(0, out.length);
}

/**
 * Wraps bytes as Zstandard data without compressing them: one frame of raw
 * blocks, which every Zstandard reader accepts.
 */
export function zstdStore(bytes: Uint8Array): Uint8Array {
  const BLOCK = 0x1ffff;
  const blocks = Math.max(1, Math.ceil(bytes.length / BLOCK));
  // Magic, a descriptor that says "one segment, the size follows in 8 bytes", the size, then the blocks.
  const out = new Uint8Array(4 + 1 + 8 + blocks * 3 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  out[4] = 0xe0;
  view.setUint32(5, bytes.length >>> 0, true);
  view.setUint32(9, Math.floor(bytes.length / 2 ** 32), true);
  let at = 13;
  for (let i = 0; i < blocks; i++) {
    const start = i * BLOCK;
    const size = Math.min(BLOCK, bytes.length - start);
    const header = (size << 3) | (i === blocks - 1 ? 1 : 0);
    out[at] = header & 0xff;
    out[at + 1] = (header >> 8) & 0xff;
    out[at + 2] = (header >> 16) & 0xff;
    out.set(bytes.subarray(start, start + size), at + 3);
    at += 3 + size;
  }
  return out;
}
