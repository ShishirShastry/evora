/**
 * Makes the desktop app's icons in build/ from the logo (public/favicon.svg,
 * the same drawing as `Logo` in src/ui/components/Icon.tsx), drawn by
 * Electron's own Chromium, so no image tools are needed:
 *
 *   build/icon.png        1024 px (electron-builder, Linux window icon)
 *   build/icon.ico        16–256 px (Windows: the program, installer, files)
 *   build/icon.icns       16–1024 px (macOS)
 *   build/icons/NxN.png   16–512 px (Linux desktop entries)
 *
 * Run: npx electron electron/make-icons.mjs   (the files are committed; run again when the logo changes)
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const svg = readFileSync(join(root, 'public', 'favicon.svg'), 'utf8');

/** The page that draws the icon at a size: the logo on a dark rounded square, as Framer's dark surfaces. */
const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent"><script>
const svg = ${JSON.stringify(svg)};
window.draw = async (size) => {
  const image = new Image();
  image.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  // macOS keeps a margin round the square (824 of 1024); the others use most of the canvas.
  const inset = size * (size >= 128 ? 0.098 : 0.03);
  const side = size - 2 * inset;
  const radius = side * 0.225;
  const path = new Path2D();
  path.roundRect(inset, inset, side, side, radius);
  const fill = g.createLinearGradient(0, inset, 0, inset + side);
  fill.addColorStop(0, '#1d1b27');
  fill.addColorStop(1, '#0b0b10');
  g.fillStyle = fill;
  g.fill(path);
  if (size >= 64) {
    g.save();
    g.clip(path);
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = Math.max(1, size / 256);
    g.stroke(path);
    g.restore();
  }
  const logo = side * 0.66;
  g.drawImage(image, inset + (side - logo) / 2, inset + (side - logo) / 2, logo, logo);
  return canvas.toDataURL('image/png').split(',')[1];
};
</script></body>`;

function ico(entries) {
  // An ICO file holding PNG images (Windows Vista and later).
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((entry) => entry.png)]);
}

function icns(entries) {
  // An ICNS file with PNG images under the types macOS reads for each size.
  const types = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
  const chunks = entries
    .filter(({ size }) => types[size])
    .map(({ size, png }) => {
      const head = Buffer.alloc(8);
      head.write(types[size], 0, 'ascii');
      head.writeUInt32BE(png.length + 8, 4);
      return Buffer.concat([head, png]);
    });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  await window.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const images = [];
  for (const size of sizes) {
    const base64 = await window.webContents.executeJavaScript(`draw(${size})`);
    images.push({ size, png: Buffer.from(base64, 'base64') });
  }
  mkdirSync(join(out, 'icons'), { recursive: true });
  const at = (size) => images.find((image) => image.size === size).png;
  writeFileSync(join(out, 'icon.png'), at(1024));
  writeFileSync(join(out, 'icon.ico'), ico(images.filter(({ size }) => size <= 256)));
  writeFileSync(join(out, 'icon.icns'), icns(images));
  for (const size of [16, 32, 48, 64, 128, 256, 512]) writeFileSync(join(out, 'icons', `${size}x${size}.png`), at(size));
  console.log(`Icons written to ${out}`);
  window.destroy();
  app.exit(0);
});
