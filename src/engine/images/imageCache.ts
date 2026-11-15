/** A decoded image ready to be drawn, with its natural size. */
export interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** What the renderer asks for images through. Returns null while an image is loading or if it is missing. */
export interface ImageSource {
  get(hash: string): DecodedImage | null;
}

export interface AssetBytes {
  mimeType: string;
  bytes: ArrayBuffer;
}

export type AssetLoader = (hash: string) => Promise<AssetBytes | null>;
export type ImageDecoder = (asset: AssetBytes) => Promise<DecodedImage>;

/** Decodes image bytes with the browser's own decoders, which also handle SVG. */
export const decodeWithBrowser: ImageDecoder = async (asset) => {
  const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mimeType }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    // An SVG without a size of its own reports none; give it a usable one.
    return { image, width: image.naturalWidth || 100, height: image.naturalHeight || 100 };
  } finally {
    URL.revokeObjectURL(url);
  }
};

type Entry = { status: 'loading' } | { status: 'ready'; decoded: DecodedImage } | { status: 'missing' };

/**
 * Decoded images by asset hash. The renderer asks synchronously; an image
 * that is not decoded yet is fetched from storage in the background and the
 * listeners are told when it arrives, so the canvas can repaint with it.
 */
export class ImageCache implements ImageSource {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly load: AssetLoader,
    private readonly decode: ImageDecoder = decodeWithBrowser,
  ) {}

  get(hash: string): DecodedImage | null {
    const entry = this.entries.get(hash);
    if (!entry) {
      this.entries.set(hash, { status: 'loading' });
      void this.fetch(hash);
      return null;
    }
    return entry.status === 'ready' ? entry.decoded : null;
  }

  /** True once it is known that the image cannot be shown: its bytes are gone or cannot be decoded. */
  isMissing(hash: string): boolean {
    return this.entries.get(hash)?.status === 'missing';
  }

  /** Decodes freshly imported bytes and keeps the result. Rejects if they are not an image. */
  async put(hash: string, asset: AssetBytes): Promise<DecodedImage> {
    const existing = this.entries.get(hash);
    if (existing?.status === 'ready') return existing.decoded;
    const decoded = await this.decode(asset);
    this.entries.set(hash, { status: 'ready', decoded });
    this.notify();
    return decoded;
  }

  /** Calls `listener` whenever an image becomes available or is found to be missing. Returns how to stop. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async fetch(hash: string): Promise<void> {
    try {
      const asset = await this.load(hash);
      // `put` may have supplied the image while storage was being read.
      if (this.entries.get(hash)?.status === 'ready') return;
      this.entries.set(hash, asset ? { status: 'ready', decoded: await this.decode(asset) } : { status: 'missing' });
    } catch {
      this.entries.set(hash, { status: 'missing' });
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
