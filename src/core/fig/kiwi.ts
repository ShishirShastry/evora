/**
 * Kiwi: the binary encoding Figma's files are written in. A file carries
 * its own schema (the names and types of everything in it) in the same
 * encoding, so the data can be read into plain objects by name without
 * knowing the schema beforehand, and a schema can be written with the data.
 *
 * A schema has enums (a name for each number), structs (every field,
 * in order) and messages (any of the fields, each announced by its number,
 * ended by a zero).
 */

export class KiwiError extends Error {}

export interface KiwiField {
  name: string;
  /** A built-in type (bool, byte, int, uint, float, string, int64, uint64) or the name of a definition. Unused for an enum's fields. */
  type: string;
  isArray: boolean;
  /** An enum value's number, or a message field's number. For a struct, the field's place, from 1. */
  value: number;
}

export interface KiwiDefinition {
  name: string;
  kind: 'ENUM' | 'STRUCT' | 'MESSAGE';
  fields: KiwiField[];
}

export interface KiwiSchema {
  definitions: KiwiDefinition[];
}

const BUILT_IN = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];
const KINDS = ['ENUM', 'STRUCT', 'MESSAGE'] as const;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const scratch = new DataView(new ArrayBuffer(4));

/** Reads values out of bytes, and writes them into bytes, as Kiwi encodes them. */
export class KiwiBuffer {
  bytes: Uint8Array;
  private at = 0;
  private length: number;

  constructor(bytes?: Uint8Array) {
    this.bytes = bytes ?? new Uint8Array(256);
    this.length = bytes ? bytes.length : 0;
  }

  get position(): number {
    return this.at;
  }

  get atEnd(): boolean {
    return this.at >= this.length;
  }

  /** What has been written. */
  toBytes(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }

  readByte(): number {
    if (this.at >= this.length) throw new KiwiError('The data ends too soon.');
    return this.bytes[this.at++] as number;
  }

  readByteArray(): Uint8Array {
    const size = this.readVarUint();
    if (this.at + size > this.length) throw new KiwiError('The data ends too soon.');
    // A view of the bytes, not a copy: a file's data is read once, and its blobs are most of it.
    const out = this.bytes.subarray(this.at, this.at + size);
    this.at += size;
    return out;
  }

  /** Moves past bytes without reading them. */
  skip(count: number): void {
    if (this.at + count > this.length) throw new KiwiError('The data ends too soon.');
    this.at += count;
  }

  /** Moves past a piece of text without decoding it. */
  skipString(): void {
    let end = this.at;
    while (end < this.length && this.bytes[end] !== 0) end++;
    if (end >= this.length) throw new KiwiError('A piece of text in the data has no end.');
    this.at = end + 1;
  }

  /** Moves past a float as `readVarFloat` reads one. */
  skipVarFloat(): void {
    if (this.at >= this.length) throw new KiwiError('The data ends too soon.');
    this.at += this.bytes[this.at] === 0 ? 1 : 4;
  }

  readVarUint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.readByte();
      value += (byte & 127) * 2 ** shift;
      shift += 7;
      if ((byte & 128) === 0 || shift >= 35) break;
    }
    return value >>> 0;
  }

  readVarInt(): number {
    const value = this.readVarUint();
    return value & 1 ? ~(value >>> 1) : value >>> 1;
  }

  /** A number of up to 64 bits, as a bigint. */
  readVarUint64(): bigint {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.readByte();
      // The ninth byte carries eight bits, not seven.
      if (shift === 56n) {
        value |= BigInt(byte) << shift;
        break;
      }
      value |= BigInt(byte & 127) << shift;
      shift += 7n;
      if ((byte & 128) === 0) break;
    }
    return value;
  }

  readVarInt64(): bigint {
    const value = this.readVarUint64();
    return value & 1n ? ~(value >> 1n) : value >> 1n;
  }

  /** A float, written so that zero is one byte: otherwise its four bytes, turned so that the exponent comes first. */
  readVarFloat(): number {
    if (this.at >= this.length) throw new KiwiError('The data ends too soon.');
    const first = this.bytes[this.at] as number;
    if (first === 0) {
      this.at++;
      return 0;
    }
    if (this.at + 4 > this.length) throw new KiwiError('The data ends too soon.');
    let bits = (first | ((this.bytes[this.at + 1] as number) << 8) | ((this.bytes[this.at + 2] as number) << 16) | ((this.bytes[this.at + 3] as number) << 24)) >>> 0;
    this.at += 4;
    bits = ((bits << 23) | (bits >>> 9)) >>> 0;
    scratch.setUint32(0, bits, true);
    return scratch.getFloat32(0, true);
  }

  /** Text, as UTF-8 that ends with a zero byte. */
  readString(): string {
    let end = this.at;
    while (end < this.length && this.bytes[end] !== 0) end++;
    if (end >= this.length) throw new KiwiError('A piece of text in the data has no end.');
    const text = fromUtf8.decode(this.bytes.subarray(this.at, end));
    this.at = end + 1;
    return text;
  }

  private room(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    const bigger = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
    bigger.set(this.bytes.subarray(0, this.length));
    this.bytes = bigger;
  }

  writeByte(value: number): void {
    this.room(1);
    this.bytes[this.length++] = value & 255;
  }

  writeByteArray(value: Uint8Array): void {
    this.writeVarUint(value.length);
    this.room(value.length);
    this.bytes.set(value, this.length);
    this.length += value.length;
  }

  writeVarUint(value: number): void {
    let rest = value >>> 0;
    do {
      const byte = rest & 127;
      rest = Math.floor(rest / 128);
      this.writeByte(rest ? byte | 128 : byte);
    } while (rest);
  }

  writeVarInt(value: number): void {
    this.writeVarUint(((value << 1) ^ (value >> 31)) >>> 0);
  }

  writeVarUint64(value: bigint): void {
    let rest = BigInt.asUintN(64, value);
    for (let i = 0; i < 8; i++) {
      const byte = Number(rest & 127n);
      rest >>= 7n;
      if (rest === 0n) {
        this.writeByte(byte);
        return;
      }
      this.writeByte(byte | 128);
    }
    this.writeByte(Number(rest & 255n));
  }

  writeVarInt64(value: bigint): void {
    this.writeVarUint64(BigInt.asUintN(64, (value << 1n) ^ (value >> 63n)));
  }

  writeVarFloat(value: number): void {
    scratch.setFloat32(0, value, true);
    let bits = scratch.getUint32(0, true);
    bits = ((bits >>> 23) | (bits << 9)) >>> 0;
    // Zero, and numbers too small to tell from it, are one byte.
    if ((bits & 255) === 0) {
      this.writeByte(0);
      return;
    }
    this.writeByte(bits);
    this.writeByte(bits >>> 8);
    this.writeByte(bits >>> 16);
    this.writeByte(bits >>> 24);
  }

  writeString(value: string): void {
    // A zero inside the text would end it early.
    const encoded = utf8.encode(value.replace(/\0/g, ''));
    this.room(encoded.length + 1);
    this.bytes.set(encoded, this.length);
    this.length += encoded.length;
    this.bytes[this.length++] = 0;
  }
}

/** Reads a schema as a file carries it. */
export function decodeBinarySchema(bytes: Uint8Array): KiwiSchema {
  const input = new KiwiBuffer(bytes);
  const count = input.readVarUint();
  const raw: { name: string; kind: number; fields: { name: string; type: number; isArray: boolean; value: number }[] }[] = [];
  for (let i = 0; i < count; i++) {
    const name = input.readString();
    const kind = input.readByte();
    const fieldCount = input.readVarUint();
    const fields = [];
    for (let j = 0; j < fieldCount; j++) {
      fields.push({ name: input.readString(), type: input.readVarInt(), isArray: (input.readByte() & 1) !== 0, value: input.readVarUint() });
    }
    raw.push({ name, kind, fields });
  }
  const definitions: KiwiDefinition[] = raw.map((definition) => {
    const kind = KINDS[definition.kind];
    if (!kind) throw new KiwiError(`The schema has a definition of an unknown kind (${definition.kind}).`);
    return {
      name: definition.name,
      kind,
      fields: definition.fields.map((field) => {
        // A type below zero is a built-in one; any other is the place of a definition in the schema.
        const type = kind === 'ENUM' ? '' : field.type < 0 ? BUILT_IN[~field.type] : raw[field.type]?.name;
        if (type === undefined) throw new KiwiError(`The schema's "${definition.name}.${field.name}" is of a type that is not in it.`);
        return { name: field.name, type, isArray: field.isArray, value: field.value };
      }),
    };
  });
  return { definitions };
}

/** Writes a schema as a file carries it. */
export function encodeBinarySchema(schema: KiwiSchema): Uint8Array {
  const out = new KiwiBuffer();
  const places = new Map(schema.definitions.map((definition, index) => [definition.name, index]));
  out.writeVarUint(schema.definitions.length);
  for (const definition of schema.definitions) {
    out.writeString(definition.name);
    out.writeByte(KINDS.indexOf(definition.kind));
    out.writeVarUint(definition.fields.length);
    for (const field of definition.fields) {
      out.writeString(field.name);
      const builtIn = BUILT_IN.indexOf(field.type);
      const place = places.get(field.type);
      if (definition.kind !== 'ENUM' && builtIn < 0 && place === undefined) throw new KiwiError(`"${definition.name}.${field.name}" is of a type, "${field.type}", that the schema does not define.`);
      out.writeVarInt(definition.kind === 'ENUM' ? 0 : builtIn >= 0 ? ~builtIn : (place as number));
      out.writeByte(field.isArray ? 1 : 0);
      out.writeVarUint(field.value);
    }
  }
  return out.toBytes();
}

export type KiwiValue = boolean | number | bigint | string | Uint8Array | KiwiValue[] | { [name: string]: KiwiValue };
export type KiwiObject = { [name: string]: KiwiValue };

/** A schema made ready to read and write data with: its definitions by name, and each message's fields by number. */
export interface KiwiCodec {
  /**
   * Reads data of a type. Fields named in `skip` (at any depth) are moved
   * past without being built: data that is not wanted then costs no memory.
   */
  decode(typeName: string, bytes: Uint8Array, skip?: ReadonlySet<string>): KiwiObject;
  encode(typeName: string, value: KiwiObject): Uint8Array;
}

export function compileSchema(schema: KiwiSchema): KiwiCodec {
  const byName = new Map(schema.definitions.map((definition) => [definition.name, definition]));
  const byNumber = new Map<string, Map<number, KiwiField>>();
  const enumNames = new Map<string, Map<number, string>>();
  const enumNumbers = new Map<string, Map<string, number>>();
  for (const definition of schema.definitions) {
    if (definition.kind === 'MESSAGE') byNumber.set(definition.name, new Map(definition.fields.map((field) => [field.value, field])));
    if (definition.kind === 'ENUM') {
      enumNames.set(definition.name, new Map(definition.fields.map((field) => [field.value, field.name])));
      enumNumbers.set(definition.name, new Map(definition.fields.map((field) => [field.name, field.value])));
    }
  }

  const readOne = (type: string, input: KiwiBuffer): KiwiValue => {
    switch (type) {
      case 'bool':
        return input.readByte() !== 0;
      case 'byte':
        return input.readByte();
      case 'int':
        return input.readVarInt();
      case 'uint':
        return input.readVarUint();
      case 'float':
        return input.readVarFloat();
      case 'string':
        return input.readString();
      case 'int64':
        return input.readVarInt64();
      case 'uint64':
        return input.readVarUint64();
    }
    const definition = byName.get(type);
    if (!definition) throw new KiwiError(`The data is of a type, "${type}", that its schema does not define.`);
    if (definition.kind === 'ENUM') {
      const number = input.readVarUint();
      // A number the schema has no name for is kept as a number.
      return enumNames.get(type)?.get(number) ?? number;
    }
    return readObject(definition, input);
  };

  const readField = (field: KiwiField, input: KiwiBuffer): KiwiValue => {
    if (!field.isArray) return readOne(field.type, input);
    // Bytes together are kept together.
    if (field.type === 'byte') return input.readByteArray();
    const count = input.readVarUint();
    const out: KiwiValue[] = [];
    for (let i = 0; i < count; i++) out.push(readOne(field.type, input));
    return out;
  };

  let skipping: ReadonlySet<string> = new Set();

  const skipOne = (type: string, input: KiwiBuffer): void => {
    switch (type) {
      case 'bool':
      case 'byte':
        input.skip(1);
        return;
      case 'int':
      case 'uint':
        input.readVarUint();
        return;
      case 'float':
        input.skipVarFloat();
        return;
      case 'string':
        input.skipString();
        return;
      case 'int64':
      case 'uint64':
        input.readVarUint64();
        return;
    }
    const definition = byName.get(type);
    if (!definition) throw new KiwiError(`The data is of a type, "${type}", that its schema does not define.`);
    if (definition.kind === 'ENUM') {
      input.readVarUint();
      return;
    }
    if (definition.kind === 'STRUCT') {
      for (const field of definition.fields) skipField(field, input);
      return;
    }
    const fields = byNumber.get(definition.name) as Map<number, KiwiField>;
    for (;;) {
      const number = input.readVarUint();
      if (number === 0) return;
      const field = fields.get(number);
      if (!field) throw new KiwiError(`The data has a field (number ${number} of "${definition.name}") that its schema does not have.`);
      skipField(field, input);
    }
  };

  function skipField(field: KiwiField, input: KiwiBuffer): void {
    if (!field.isArray) {
      skipOne(field.type, input);
      return;
    }
    const count = input.readVarUint();
    if (field.type === 'byte') {
      input.skip(count);
      return;
    }
    for (let i = 0; i < count; i++) skipOne(field.type, input);
  }

  function readObject(definition: KiwiDefinition, input: KiwiBuffer): KiwiObject {
    const out: KiwiObject = {};
    if (definition.kind === 'STRUCT') {
      for (const field of definition.fields) out[field.name] = readField(field, input);
      return out;
    }
    const fields = byNumber.get(definition.name) as Map<number, KiwiField>;
    for (;;) {
      const number = input.readVarUint();
      if (number === 0) return out;
      const field = fields.get(number);
      if (!field) throw new KiwiError(`The data has a field (number ${number} of "${definition.name}") that its schema does not have.`);
      if (skipping.has(field.name)) skipField(field, input);
      else out[field.name] = readField(field, input);
    }
  }

  const writeOne = (type: string, value: KiwiValue, output: KiwiBuffer, where: string): void => {
    switch (type) {
      case 'bool':
        output.writeByte(value ? 1 : 0);
        return;
      case 'byte':
        output.writeByte(Number(value));
        return;
      case 'int':
        output.writeVarInt(Number(value));
        return;
      case 'uint':
        output.writeVarUint(Number(value));
        return;
      case 'float':
        output.writeVarFloat(Number(value));
        return;
      case 'string':
        output.writeString(String(value));
        return;
      case 'int64':
        output.writeVarInt64(BigInt(value as bigint | number));
        return;
      case 'uint64':
        output.writeVarUint64(BigInt(value as bigint | number));
        return;
    }
    const definition = byName.get(type);
    if (!definition) throw new KiwiError(`"${where}" is of a type, "${type}", that the schema does not define.`);
    if (definition.kind === 'ENUM') {
      const number = typeof value === 'number' ? value : enumNumbers.get(type)?.get(String(value));
      if (number === undefined) throw new KiwiError(`"${String(value)}" is not one of the values of "${type}" (at ${where}).`);
      output.writeVarUint(number);
      return;
    }
    writeObject(definition, value as KiwiObject, output);
  };

  const writeField = (field: KiwiField, value: KiwiValue, output: KiwiBuffer, where: string): void => {
    if (!field.isArray) {
      writeOne(field.type, value, output, where);
      return;
    }
    if (field.type === 'byte') {
      output.writeByteArray(value as Uint8Array);
      return;
    }
    const items = value as KiwiValue[];
    output.writeVarUint(items.length);
    for (const item of items) writeOne(field.type, item, output, where);
  };

  function writeObject(definition: KiwiDefinition, value: KiwiObject, output: KiwiBuffer): void {
    if (definition.kind === 'STRUCT') {
      for (const field of definition.fields) {
        const given = value[field.name];
        if (given === undefined) throw new KiwiError(`"${definition.name}.${field.name}" has no value, and a struct needs every one of its fields.`);
        writeField(field, given, output, `${definition.name}.${field.name}`);
      }
      return;
    }
    const known = new Set(definition.fields.map((field) => field.name));
    for (const name in value) if (value[name] !== undefined && !known.has(name)) throw new KiwiError(`"${definition.name}" has no field "${name}".`);
    for (const field of definition.fields) {
      const given = value[field.name];
      if (given === undefined) continue;
      output.writeVarUint(field.value);
      writeField(field, given, output, `${definition.name}.${field.name}`);
    }
    output.writeVarUint(0);
  }

  const definitionOf = (typeName: string): KiwiDefinition => {
    const definition = byName.get(typeName);
    if (!definition || definition.kind === 'ENUM') throw new KiwiError(`The schema has no message or struct "${typeName}".`);
    return definition;
  };

  return {
    decode(typeName, bytes, skip) {
      skipping = skip ?? new Set();
      try {
        return readObject(definitionOf(typeName), new KiwiBuffer(bytes));
      } finally {
        skipping = new Set();
      }
    },
    encode(typeName, value) {
      const output = new KiwiBuffer();
      writeObject(definitionOf(typeName), value, output);
      return output.toBytes();
    },
  };
}

/**
 * Reads a schema written as text, the way Kiwi schemas are written:
 *
 *   enum Kind { A = 0; B = 1; }
 *   struct Point { float x; float y; }
 *   message Shape { Kind kind = 1; Point[] points = 2; }
 */
export function parseSchemaText(text: string): KiwiSchema {
  const definitions: KiwiDefinition[] = [];
  const source = text.replace(/\/\/[^\n]*/g, '');
  for (const match of source.matchAll(/(enum|struct|message)\s+(\w+)\s*\{([^}]*)\}/g)) {
    const kind = (match[1] as string).toUpperCase() as KiwiDefinition['kind'];
    const fields: KiwiField[] = [];
    for (const line of (match[3] as string).split(';')) {
      const entry = line.trim();
      if (entry === '') continue;
      if (kind === 'ENUM') {
        const parts = /^(\w+)\s*=\s*(\d+)$/.exec(entry);
        if (!parts) throw new KiwiError(`In enum ${match[2]}: "${entry}" is not NAME = number.`);
        fields.push({ name: parts[1] as string, type: '', isArray: false, value: Number(parts[2]) });
      } else {
        const parts = /^(\w+)(\[\])?\s+(\w+)(?:\s*=\s*(\d+))?$/.exec(entry);
        if (!parts) throw new KiwiError(`In ${match[1]} ${match[2]}: "${entry}" is not type name${kind === 'MESSAGE' ? ' = number' : ''}.`);
        if (kind === 'MESSAGE' && parts[4] === undefined) throw new KiwiError(`In message ${match[2]}: "${parts[3]}" has no number.`);
        fields.push({ name: parts[3] as string, type: parts[1] as string, isArray: parts[2] !== undefined, value: kind === 'MESSAGE' ? Number(parts[4]) : fields.length + 1 });
      }
    }
    definitions.push({ name: match[2] as string, kind, fields });
  }
  return { definitions };
}
