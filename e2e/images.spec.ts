import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 2 images: placing real image files through the file chooser, by
 * drag-and-drop and by paste, the four fit modes, replacing an image, and
 * persistence. The images are generated here, pixel by pixel, so the test
 * knows exactly what should appear on the canvas.
 */

type RGB = [number, number, number];
const RED: RGB = [255, 0, 0];
const BLUE: RGB = [0, 0, 255];
const GREEN: RGB = [0, 255, 0];
const PAGE: RGB = [30, 30, 30];

/** Encodes an RGB image as a PNG file. */
function png(width: number, height: number, colourAt: (x: number, y: number) => RGB): Buffer {
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colourAt(x, y);
      raw.set([r, g, b, 255], y * row + 1 + x * 4);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits per channel, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 200 × 100: the left half red, the right half blue. */
const TWO_HALVES = png(200, 100, (x) => (x < 100 ? RED : BLUE));
const ALL_GREEN = png(60, 40, () => GREEN);

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const select = (page: Page, label: string): Locator => page.getByRole('combobox', { name: label, exact: true });

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

async function pixel(page: Page, x: number, y: number): Promise<RGB> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const element = document.querySelector('canvas');
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('design canvas not found');
      const data = ctx.getImageData(px as number, py as number, 1, 1).data;
      return [data[0], data[1], data[2]] as [number, number, number];
    },
    [x, y],
  );
}

/** Waits until a pixel has a colour: images are decoded in the background after a reload. */
async function expectPixel(page: Page, x: number, y: number, expected: RGB): Promise<void> {
  await expect.poll(() => pixel(page, x, y), { message: `pixel at ${x}, ${y}` }).toEqual(expected);
}

/** Chooses File → Place image… and answers the file chooser. */
async function placeFromMenu(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Place image/ }).click();
  await (await chooser).setFiles(file);
}

test('place an image, change how it fits, replace it, and find it again after a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  // A new file shows the page origin in the middle of the canvas; the image is centred there.
  const cx = Math.floor(box.width) / 2;
  const cy = Math.floor(box.height) / 2;
  const left = cx - 100;
  const top = cy - 50;

  await placeFromMenu(page, { name: 'two halves.png', mimeType: 'image/png', buffer: TWO_HALVES });
  await expect(layer(page, 'two halves')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Width')).toHaveValue('200');
  await expect(field(page, 'Height')).toHaveValue('100');
  await expect(select(page, 'Fill 1 type')).toHaveValue('IMAGE');
  await expect(page.getByText('two halves.png')).toBeVisible();
  await expectPixel(page, left + 10, cy, RED);
  await expectPixel(page, left + 190, cy, BLUE);
  await expectPixel(page, left - 5, cy, PAGE);

  // Make the layer square. Fill keeps the image's proportions and crops the sides:
  // the middle 100px of the image show, half red and half blue.
  await set(page, 'Width', '100');
  await expect(select(page, 'Fill 1 image fit')).toHaveValue('FILL');
  await expectPixel(page, left + 10, cy, RED);
  await expectPixel(page, left + 90, cy, BLUE);
  await expectPixel(page, left + 50, top + 5, BLUE);

  // Fit shows the whole image, half the size, leaving empty bands above and below.
  await select(page, 'Fill 1 image fit').selectOption('FIT');
  await expectPixel(page, left + 10, cy, RED);
  await expectPixel(page, left + 90, cy, BLUE);
  await expectPixel(page, left + 50, top + 10, PAGE);
  await expectPixel(page, left + 50, top + 90, PAGE);

  // Crop stretches the chosen part over the layer: first the whole image, then only its right half.
  await select(page, 'Fill 1 image fit').selectOption('CROP');
  await expectPixel(page, left + 10, top + 10, RED);
  await expectPixel(page, left + 90, top + 10, BLUE);
  await set(page, 'Fill 1 crop left', '50');
  await expect(field(page, 'Fill 1 crop width')).toHaveValue('50');
  await expectPixel(page, left + 10, top + 10, BLUE);

  // Tile repeats the image. At a quarter size the tiles are 50 × 25: red, blue, red, blue across the layer.
  await select(page, 'Fill 1 image fit').selectOption('TILE');
  await expectPixel(page, left + 90, cy, RED); // at full size only the red half fits
  await set(page, 'Fill 1 tile size', '25');
  await expectPixel(page, left + 10, cy, RED);
  await expectPixel(page, left + 35, cy, BLUE);
  await expectPixel(page, left + 60, cy, RED);
  await expectPixel(page, left + 85, cy, BLUE);

  // Undo steps back through the fit changes.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(select(page, 'Fill 1 image fit')).toHaveValue('CROP');

  // Replace the image with another file; the layer and its settings stay.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image in Fill 1' }).click();
  await (await chooser).setFiles({ name: 'green.png', mimeType: 'image/png', buffer: ALL_GREEN });
  await expect(page.getByText('green.png')).toBeVisible();
  await expectPixel(page, left + 50, cy, GREEN);
  await expect(field(page, 'Width')).toHaveValue('100');

  // Everything is stored on this device: after a reload the image is drawn again.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expectPixel(page, left + 50, cy, GREEN);
  await layer(page, 'two halves').click();
  await expect(select(page, 'Fill 1 type')).toHaveValue('IMAGE');
  await expect(page.getByText('green.png')).toBeVisible();
  expect(errors).toEqual([]);
});

test('position a cropped image by dragging it, and adjust how it is drawn', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  const cx = Math.floor(box.width) / 2;
  const cy = Math.floor(box.height) / 2;
  const left = cx - 100;
  const drag = async (from: [number, number], to: [number, number]): Promise<void> => {
    await page.mouse.move(box.x + from[0], box.y + from[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
    await page.mouse.up();
  };
  const near = async (x: number, y: number, expected: RGB, tolerance = 4): Promise<void> => {
    await expect
      .poll(async () => (await pixel(page, x, y)).every((channel, i) => Math.abs(channel - (expected[i] as number)) <= tolerance), {
        message: `pixel at ${x}, ${y} about rgb(${expected.join(', ')})`,
      })
      .toBe(true);
  };

  // The 200 × 100 layer shows the middle half of the image's width: red on its left, blue on its right.
  await placeFromMenu(page, { name: 'two halves.png', mimeType: 'image/png', buffer: TWO_HALVES });
  await expect(field(page, 'Width')).toHaveValue('200');
  await select(page, 'Fill 1 image fit').selectOption('CROP');
  await set(page, 'Fill 1 crop left', '25');
  await set(page, 'Fill 1 crop width', '50');
  await expectPixel(page, left + 50, cy, RED);
  await expectPixel(page, left + 150, cy, BLUE);
  const layerX = await field(page, 'X position').inputValue();

  // Positioning: the image follows the pointer and the layer stays where it is.
  const toggle = page.getByRole('button', { name: 'Position Fill 1 on the canvas' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Half the layer's width to the right is a quarter of the image: its left half now fills the layer.
  await drag([cx, cy], [cx + 100, cy]);
  await expect(field(page, 'Fill 1 crop left')).toHaveValue('0');
  await expect(field(page, 'Fill 1 crop width')).toHaveValue('50');
  await expect(field(page, 'X position')).toHaveValue(layerX);
  await expectPixel(page, left + 50, cy, RED);
  await expectPixel(page, left + 150, cy, RED);
  // Far to the left: it stops at the image's right edge, and the layer is all blue.
  await drag([cx + 50, cy], [cx - 350, cy]);
  await expect(field(page, 'Fill 1 crop left')).toHaveValue('50');
  await expectPixel(page, left + 50, cy, BLUE);
  // Each drag is one undo step.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Fill 1 crop left')).toHaveValue('0');
  await expectPixel(page, left + 150, cy, RED);
  // Escape ends it; the same drag now moves the layer.
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await drag([cx, cy], [cx + 40, cy]);
  await expect(field(page, 'Fill 1 crop left')).toHaveValue('0');
  await expect(field(page, 'X position')).toHaveValue(String(Number(layerX) + 40));
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'X position')).toHaveValue(layerX);

  // Adjustments. With no saturation, red is drawn as the grey of its brightness.
  await set(page, 'Fill 1 saturation', '-100');
  await near(left + 100, cy, [54, 54, 54]);
  await set(page, 'Fill 1 saturation', '0');
  await expectPixel(page, left + 100, cy, RED);
  // Half the exposure is half as bright; none at all is black.
  await set(page, 'Fill 1 exposure', '-50');
  await near(left + 100, cy, [128, 0, 0]);
  await set(page, 'Fill 1 exposure', '-100');
  await near(left + 100, cy, [0, 0, 0]);
  // No contrast at all is a flat mid grey, whatever the image.
  await set(page, 'Fill 1 exposure', '0');
  await set(page, 'Fill 1 contrast', '-100');
  await near(left + 100, cy, [128, 128, 128]);

  // The adjustments are part of the file: they are there after a reload.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await near(left + 100, cy, [128, 128, 128]);
  await layer(page, 'two halves').click();
  await expect(field(page, 'Fill 1 contrast')).toHaveValue('-100');
  await set(page, 'Fill 1 contrast', '0');
  await expectPixel(page, left + 100, cy, RED);
  expect(errors).toEqual([]);
});

test('drop and paste images, and refuse files that are not images', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');

  /** Builds a DataTransfer holding one file and dispatches an event carrying it, as the browser would. */
  const deliver = (kind: 'drop' | 'paste', name: string, type: string, bytes: Buffer, at: [number, number]): Promise<void> =>
    page.evaluate(
      ({ kind: eventKind, name: fileName, type: fileType, base64, x, y }) => {
        const binary = atob(base64);
        const data = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([data], fileName, { type: fileType }));
        if (eventKind === 'drop') {
          const target = document.querySelector('[aria-label="Design canvas"]');
          target?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        } else {
          document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
        }
      },
      { kind, name, type, base64: bytes.toString('base64'), x: box.x + at[0], y: box.y + at[1] },
    );

  // Dropped at (200, 150) on the canvas: the 60 × 40 image is centred on that point.
  await deliver('drop', 'dropped.png', 'image/png', ALL_GREEN, [200, 150]);
  await expect(layer(page, 'dropped')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Width')).toHaveValue('60');
  await expectPixel(page, 200, 150, GREEN);
  await expectPixel(page, 172, 132, GREEN);
  await expectPixel(page, 168, 150, PAGE);

  // Pasted from the clipboard: placed in the middle of the view.
  await canvas(page).focus();
  await deliver('paste', 'pasted.png', 'image/png', TWO_HALVES, [0, 0]);
  await expect(layer(page, 'pasted')).toHaveAttribute('aria-selected', 'true');
  await expectPixel(page, Math.floor(box.width) / 2 - 90, Math.floor(box.height) / 2, RED);

  // One undo removes the pasted image; the dropped one is still there.
  await page.keyboard.press('Control+z');
  await expect(layer(page, 'pasted')).toHaveCount(0);
  await expect(layer(page, 'dropped')).toBeVisible();

  // With no image on the clipboard, Ctrl+C / Ctrl+V copy and paste layers as before.
  await layer(page, 'dropped').click();
  await canvas(page).focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(layer(page, 'dropped')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(layer(page, 'dropped')).toHaveCount(1);

  // A file that is not an image is refused with an explanation, and nothing is added.
  await deliver('drop', 'notes.txt', 'text/plain', Buffer.from('hello'), [400, 300]);
  await expect(page.getByRole('alert')).toContainText('could not be placed');
  await expect(layers(page).getByRole('treeitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // A file that claims to be an image but is not one is refused too.
  await deliver('drop', 'broken.png', 'image/png', Buffer.from('this is not a png'), [400, 300]);
  await expect(page.getByRole('alert')).toContainText('could not be placed');
  await expect(layers(page).getByRole('treeitem')).toHaveCount(1);
  expect(errors).toEqual([]);
});
