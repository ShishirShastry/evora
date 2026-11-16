/**
 * Compression, by what the browser (and Node, in tests) has built in:
 * deflate with and without the zlib wrapper. Nothing is bundled for it.
 */

async function through(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Writing and reading go on together: a stream holds only so much before it has to be read from.
  const written = writer.write(bytes as unknown as BufferSource).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await written;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

type Format = 'deflate' | 'deflate-raw';
const pack = (format: Format) => new CompressionStream(format) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> };
const unpack = (format: Format) => new DecompressionStream(format) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> };

/** Whether this browser can compress at all. */
export const canCompress = (): boolean => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** Deflate with the zlib wrapper: what PDF's FlateDecode and PNG read. */
export const deflateZlib = (bytes: Uint8Array): Promise<Uint8Array> => through(bytes, pack('deflate'));
/** Deflate with no wrapper: what a ZIP entry holds. */
export const deflateRaw = (bytes: Uint8Array): Promise<Uint8Array> => through(bytes, pack('deflate-raw'));
export const inflateRaw = (bytes: Uint8Array): Promise<Uint8Array> => through(bytes, unpack('deflate-raw'));
export const inflateZlib = (bytes: Uint8Array): Promise<Uint8Array> => through(bytes, unpack('deflate'));
