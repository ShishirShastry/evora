import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Mirrored pictures and text in the real browser: Flip turns an image fill
 * and the glyphs of text over, and a resize dragged past the edge that stays
 * fixed mirrors what is in the layer. Checked on the design canvas's pixels.
 */

type RGB = [number, number, number];
const RED: RGB = [255, 0, 0];
const BLUE: RGB = [0, 0, 255];

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
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** 200 × 100: the left half red, the right half blue. */
const TWO_HALVES = png(200, 100, (x) => (x < 100 ? RED : BLUE));

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });

async function pixel(page: Page, x: number, y: number): Promise<RGB> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const data = document.querySelector('canvas')?.getContext('2d')?.getImageData(px as number, py as number, 1, 1).data;
      if (!data) throw new Error('design canvas not found');
      return [data[0], data[1], data[2]] as [number, number, number];
    },
    [x, y],
  );
}

const expectPixel = (page: Page, x: number, y: number, expected: RGB): Promise<void> =>
  expect.poll(() => pixel(page, x, y), { message: `pixel at ${x}, ${y}` }).toEqual(expected);

/** How many red pixels there are in a region of the design canvas. */
async function redIn(page: Page, region: [number, number, number, number]): Promise<number> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(([x0, y0, x1, y1]) => {
    const ctx = document.querySelector('canvas')?.getContext('2d');
    if (!ctx) throw new Error('design canvas not found');
    const data = ctx.getImageData(x0 as number, y0 as number, (x1 as number) - (x0 as number), (y1 as number) - (y0 as number)).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if ((data[i] as number) > 170 && (data[i + 1] as number) < 80 && (data[i + 2] as number) < 80) count++;
    return count;
  }, region);
}

test('a picture is mirrored by Flip, and by a resize dragged past its fixed edge', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  // A new file shows the page origin in the middle of the canvas; a placed image is centred there.
  const cx = Math.floor(box.width) / 2;
  const cy = Math.floor(box.height) / 2;
  const left = cx - 100;

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Place image/ }).click();
  await (await chooser).setFiles({ name: 'two halves.png', mimeType: 'image/png', buffer: TWO_HALVES });
  await expect(field(page, 'Width')).toHaveValue('200');
  await expectPixel(page, left + 10, cy, RED);
  await expectPixel(page, left + 190, cy, BLUE);

  // Flipped left to right, the blue half is on the left. Flipped again, or undone, it is as it was.
  await canvas(page).focus();
  await page.keyboard.press('Shift+h');
  await expectPixel(page, left + 10, cy, BLUE);
  await expectPixel(page, left + 190, cy, RED);
  await page.keyboard.press('Shift+h');
  await expectPixel(page, left + 10, cy, RED);
  await page.keyboard.press('Control+z');
  await expectPixel(page, left + 10, cy, BLUE);
  await page.keyboard.press('Control+z');
  await expectPixel(page, left + 10, cy, RED);

  // The handle in the middle of the right edge, dragged 100 past the left edge: the layer is now a
  // square on the other side of that edge, showing the middle of the picture, mirrored.
  await page.mouse.move(box.x + left + 200, box.y + cy);
  await page.mouse.down();
  await page.mouse.move(box.x + left + 100, box.y + cy, { steps: 4 });
  await page.mouse.move(box.x + left - 100, box.y + cy, { steps: 6 });
  // While it is held there, and after it is let go.
  await expectPixel(page, left - 90, cy, BLUE);
  await expectPixel(page, left - 10, cy, RED);
  await page.mouse.up();
  await expect(field(page, 'Width')).toHaveValue('100');
  await expectPixel(page, left - 90, cy, BLUE);
  await expectPixel(page, left - 10, cy, RED);
  // It is kept in the file.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expectPixel(page, left - 90, cy, BLUE);
  await expectPixel(page, left - 10, cy, RED);
  expect(errors).toEqual([]);
});

test('the glyphs of text are mirrored by Flip', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');

  // A large red "L": its upright is on the left of its box.
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 300, box.y + 300);
  await page.keyboard.type('L');
  await page.keyboard.press('Escape');
  await field(page, 'Fill 1 colour hex').fill('FF0000');
  await field(page, 'Fill 1 colour hex').press('Enter');
  await field(page, 'Font size').fill('160');
  await field(page, 'Font size').press('Enter');
  const width = Number(await field(page, 'Width').inputValue());
  const height = Number(await field(page, 'Height').inputValue());
  expect(width).toBeGreaterThan(60);
  // The layer's left edge is where the text was started; the font size grew it down and to the right.
  const top = 300 - 10;
  const leftThird: [number, number, number, number] = [300, top, Math.round(300 + width / 3), top + height];
  const rightThird: [number, number, number, number] = [Math.round(300 + (2 * width) / 3), top, 300 + width, top + height];
  const uprightLeft = await redIn(page, leftThird);
  const footRight = await redIn(page, rightThird);
  expect(uprightLeft).toBeGreaterThan(footRight * 2);

  // Flipped left to right, the upright is on the right; the layer has not moved or changed size.
  await canvas(page).focus();
  await page.keyboard.press('Shift+h');
  expect(await redIn(page, rightThird)).toBeGreaterThan((await redIn(page, leftThird)) * 2);
  await expect(field(page, 'Width')).toHaveValue(String(width));
  // After a reload it is still mirrored; flipped back, it reads as an L again.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(async () => (await redIn(page, rightThird)) > (await redIn(page, leftThird)) * 2).toBe(true);
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().click();
  await canvas(page).focus();
  await page.keyboard.press('Shift+h');
  expect(await redIn(page, leftThird)).toBeGreaterThan((await redIn(page, rightThird)) * 2);
  expect(errors).toEqual([]);
});
