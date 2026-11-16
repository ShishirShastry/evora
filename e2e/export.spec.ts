import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { expect, test, type Download, type Locator, type Page } from '@playwright/test';

/**
 * Phase 7, export and handoff, in the real browser. Files are exported the
 * way a designer exports them, saved by the browser, and read here: their
 * size, what is transparent in them, and what they hold.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const select = (page: Page, label: string): Locator => page.getByRole('combobox', { name: label, exact: true });
const button = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true });
const section = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

async function click(page: Page, at: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.click(box.x + at[0], box.y + at[1]);
}

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

/** Clicks something that saves a file, and gives the file's name and bytes. */
async function saved(page: Page, trigger: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [download] = (await Promise.all([page.waitForEvent('download'), trigger()])) as [Download, void];
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

/** A picture's size and the colour of some of its pixels, by letting the browser decode it as any program would. */
async function decode(page: Page, bytes: Buffer, mimeType: string, points: [number, number][]): Promise<{ width: number; height: number; pixels: number[][] }> {
  return page.evaluate(
    async ([base64, type, wanted]) => {
      const image = new Image();
      image.src = `data:${type as string};base64,${base64 as string}`;
      await image.decode();
      const element = document.createElement('canvas');
      element.width = image.naturalWidth;
      element.height = image.naturalHeight;
      const ctx = element.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(image, 0, 0);
      return { width: image.naturalWidth, height: image.naturalHeight, pixels: (wanted as [number, number][]).map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]) };
    },
    [bytes.toString('base64'), mimeType, points] as const,
  );
}

/** The content streams of a PDF, uncompressed. */
function pdfStreams(bytes: Buffer): string[] {
  const text = bytes.toString('latin1');
  const out: string[] = [];
  for (const match of text.matchAll(/<<([^>]*(?:>(?!>)[^>]*)*)>>\nstream\n/g)) {
    const start = (match.index as number) + match[0].length;
    const length = Number(/\/Length (\d+)/.exec(match[1] as string)?.[1]);
    const data = bytes.subarray(start, start + length);
    if ((match[1] as string).includes('/Subtype /Image')) continue;
    out.push((match[1] as string).includes('/FlateDecode') ? inflateSync(data).toString('latin1') : data.toString('latin1'));
  }
  return out;
}

async function design(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
  // A white 200 × 100 frame with a red 60 × 40 box at (20, 20) and a word in it; beside it a green circle.
  await page.keyboard.press('f');
  await drag(page, [100, 100], [300, 200]);
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [120, 120], [180, 160]);
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await canvas(page).focus();
  await page.keyboard.press('t');
  await click(page, [200, 150]);
  await page.keyboard.type('Hi');
  await page.keyboard.press('Escape');
  await canvas(page).focus();
  await page.keyboard.press('o');
  await drag(page, [350, 100], [450, 200]);
  await set(page, 'Fill 1 colour hex', '00FF00');
}

test('a frame and a circle exported as PNG, JPG, SVG and PDF, a page, and a batch', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await design(page);

  // The frame as a PNG at twice its size: 400 × 200, red where the box is, white beside it.
  await layer(page, 'Frame 1').click();
  await button(page, 'Add export setting').click();
  await set(page, 'Export 1 size', '2x');
  await expect(field(page, 'Export 1 suffix')).toHaveValue('@2x');
  let file = await saved(page, () => button(page, 'Export Frame 1').click());
  expect(file.name).toBe('Frame 1@2x.png');
  expect(file.bytes.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
  let picture = await decode(page, file.bytes, 'image/png', [[80, 80], [300, 20]]);
  expect([picture.width, picture.height]).toEqual([400, 200]);
  expect(picture.pixels).toEqual([[255, 0, 0, 255], [255, 255, 255, 255]]);
  await expect(page.getByRole('status', { name: 'Export result' })).toContainText('Exported 1 file.');

  // By width: 500 pixels wide, and as tall as that makes it.
  await set(page, 'Export 1 size', '500w');
  file = await saved(page, () => button(page, 'Export Frame 1').click());
  picture = await decode(page, file.bytes, 'image/png', []);
  expect([picture.width, picture.height]).toEqual([500, 250]);

  // The circle as a PNG: transparent round it. As a JPG: white there instead.
  await layer(page, 'Ellipse 1').click();
  await button(page, 'Add export setting').click();
  file = await saved(page, () => button(page, 'Export Ellipse 1').click());
  expect(file.name).toBe('Ellipse 1.png');
  picture = await decode(page, file.bytes, 'image/png', [[2, 2], [50, 50]]);
  expect([picture.width, picture.height]).toEqual([100, 100]);
  expect(picture.pixels).toEqual([[0, 0, 0, 0], [0, 255, 0, 255]]);
  await select(page, 'Export 1 format').selectOption('JPG');
  file = await saved(page, () => button(page, 'Export Ellipse 1').click());
  expect(file.name).toBe('Ellipse 1.jpg');
  expect([file.bytes[0], file.bytes[1]]).toEqual([0xff, 0xd8]);
  picture = await decode(page, file.bytes, 'image/jpeg', [[2, 2], [50, 50]]);
  expect([picture.width, picture.height]).toEqual([100, 100]);
  expect(picture.pixels[0]?.every((channel) => channel >= 250)).toBe(true);
  const green = picture.pixels[1] as number[];
  expect(green[0]).toBeLessThan(40);
  expect(green[1]).toBeGreaterThan(215);

  // The frame as SVG: real shapes and real text, which a browser draws the same.
  await layer(page, 'Frame 1').click();
  await set(page, 'Export 1 size', '1x');
  await select(page, 'Export 1 format').selectOption('SVG');
  file = await saved(page, () => button(page, 'Export Frame 1').click());
  expect(file.name).toBe('Frame 1.svg');
  const svg = file.bytes.toString('utf8');
  expect(svg).toContain('width="200" height="100" viewBox="0 0 200 100"');
  expect(svg).toContain('<path d="M0 0L200 0L200 100L0 100Z" fill="#ffffff"/>');
  expect(svg).toContain('<path d="M0 0L60 0L60 40L0 40Z" fill="#ff0000"/>');
  expect(svg).toMatch(/<tspan [^>]*font-family="Inter, Arial, Helvetica, sans-serif"[^>]*>Hi<\/tspan>/);
  picture = await decode(page, file.bytes, 'image/svg+xml', [[40, 40], [150, 20]]);
  expect([picture.width, picture.height]).toEqual([200, 100]);
  expect(picture.pixels).toEqual([[255, 0, 0, 255], [255, 255, 255, 255]]);

  // The frame as a PDF: a page of its size, with the box as a path and the word as text.
  await select(page, 'Export 1 format').selectOption('PDF');
  file = await saved(page, () => button(page, 'Export Frame 1').click());
  expect(file.name).toBe('Frame 1.pdf');
  const pdf = file.bytes.toString('latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain('/MediaBox [0 0 200 100]');
  expect(pdf).toContain('/BaseFont /Helvetica');
  expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  const content = pdfStreams(file.bytes).join('\n');
  expect(content).toContain('1 0 0 rg\n0 0 m\n60 0 l\n60 40 l\n0 40 l\nh\nf');
  expect(content).toMatch(/Tm \(H\) Tj\n1 0 0 -1 [\d.]+ [\d.]+ Tm \(i\) Tj/);

  // The page as a whole: everything on it, 350 × 100.
  await click(page, [600, 420]);
  await expect(section(page, 'Export')).toBeVisible();
  await button(page, 'Add export setting').click();
  file = await saved(page, () => button(page, 'Export Page 1').click());
  expect(file.name).toBe('Page 1.png');
  picture = await decode(page, file.bytes, 'image/png', [[30, 30], [225, 50], [300, 50]]);
  expect([picture.width, picture.height]).toEqual([350, 100]);
  // The box, the gap between the frame and the circle (transparent), and the circle.
  expect(picture.pixels).toEqual([[255, 0, 0, 255], [0, 0, 0, 0], [0, 255, 0, 255]]);

  // Everything with export settings, together: one ZIP archive with the three files.
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Export…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog.getByRole('list', { name: 'Files to export' }).getByRole('listitem')).toHaveCount(3);
  file = await saved(page, () => dialog.getByRole('button', { name: 'Export 3 files', exact: true }).click());
  expect(file.name).toBe('Untitled.zip');
  expect(file.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  const names = file.bytes.toString('latin1');
  for (const name of ['Page 1.png', 'Ellipse 1.jpg', 'Frame 1.pdf']) expect(names).toContain(name);
  await expect(dialog.getByRole('status', { name: 'Export result' })).toContainText('Exported 3 files in one ZIP archive.');

  // The settings are part of the file: after a reload the frame still exports as a PDF.
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.getByRole('status').first()).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await layer(page, 'Frame 1').click();
  await expect(select(page, 'Export 1 format')).toHaveValue('PDF');
  expect(errors).toEqual([]);
});

test('developer mode: what a layer is, its code, a status, a note, and copying as CSS and SVG', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await design(page);

  // The Inspect tab says what the red box is, from the box itself.
  await layer(page, 'Rectangle 1').click();
  await page.getByRole('tab', { name: 'Inspect' }).click();
  const inspect = page.getByRole('complementary', { name: 'Inspect' });
  await expect(inspect.getByRole('region', { name: 'Layout' })).toContainText('Width60px');
  await expect(inspect.getByRole('region', { name: 'Layout' })).toContainText('Height40px');
  await expect(inspect.getByRole('region', { name: 'Spacing in its parent' })).toContainText('Left20px');
  await expect(inspect.getByRole('region', { name: 'Spacing in its parent' })).toContainText('Right120px');
  await expect(inspect.getByRole('region', { name: 'Colours' })).toContainText('#FF0000');
  await expect(inspect.getByLabel('CSS code')).toContainText('background: #FF0000;');
  await expect(inspect.getByLabel('CSS code')).toContainText('left: 20px;');
  await select(page, 'Code language').selectOption({ label: 'iOS (SwiftUI)' });
  await expect(inspect.getByLabel('iOS (SwiftUI) code')).toContainText('Rectangle()');
  await select(page, 'Code language').selectOption({ label: 'Android (Compose)' });
  await expect(inspect.getByLabel('Android (Compose) code')).toContainText('.size(width = 60.dp, height = 40.dp)');

  // In this mode the canvas measures and selects; it does not move things.
  await drag(page, [150, 140], [220, 170]);
  await expect(inspect.getByRole('region', { name: 'Spacing in its parent' })).toContainText('Left20px');
  // A click selects the layer under it, however deep: the word inside the frame.
  await click(page, [205, 150]);
  await expect(layer(page, 'Hi')).toHaveAttribute('aria-selected', 'true');
  await expect(inspect.getByRole('region', { name: 'Typography' })).toContainText('ContentHi');
  await layer(page, 'Rectangle 1').click();

  // Marked ready, with a note and a link.
  await select(page, 'Development status').selectOption({ label: 'Ready for development' });
  await field(page, 'New annotation').fill('Use an 8px radius');
  await inspect.getByRole('region', { name: 'Annotations' }).getByRole('button', { name: 'Add', exact: true }).click();
  await expect(field(page, 'Annotation 1')).toHaveValue('Use an 8px radius');
  await field(page, 'Link name').fill('Ticket');
  await field(page, 'Link address').fill('javascript:alert(1)');
  await expect(inspect.getByRole('region', { name: 'Development resources' }).getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await field(page, 'Link address').fill('https://example.com/ticket/7');
  await inspect.getByRole('region', { name: 'Development resources' }).getByRole('button', { name: 'Add', exact: true }).click();
  await expect(inspect.getByRole('link', { name: 'Ticket' })).toHaveAttribute('href', 'https://example.com/ticket/7');

  // With nothing selected the mode lists what is marked and what is noted; they are kept in the file.
  await click(page, [600, 420]);
  await expect(inspect.getByRole('list', { name: 'Marked for development' })).toContainText('Rectangle 1Ready for development');
  await expect(inspect.getByRole('list', { name: 'Annotations on this page' })).toContainText('Use an 8px radius');
  await expect(page.getByRole('status').first()).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await layer(page, 'Rectangle 1').click();
  await page.getByRole('tab', { name: 'Inspect' }).click();
  await expect(select(page, 'Development status')).toHaveValue('READY');
  await expect(field(page, 'Annotation 1')).toHaveValue('Use an 8px radius');

  // An asset straight from the mode.
  const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Export as SVG').click()]);
  expect(download.suggestedFilename()).toBe('Rectangle 1.svg');

  // Copied as CSS and as SVG: what is on the clipboard is the layer's own.
  const menu = async (item: string): Promise<void> => {
    await page.getByRole('button', { name: 'Main menu' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  await menu('Copy as CSS');
  await expect(page.getByRole('alert')).toContainText('Copied as CSS.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('background: #FF0000;');
  await menu('Copy as SVG');
  await expect(page.getByRole('alert')).toContainText('Copied as SVG.');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"')).toBe(true);
  expect(copied).toContain('fill="#ff0000"');
  await menu('Copy as PNG');
  await expect(page.getByRole('alert')).toContainText('Copied “Rectangle 1” as PNG.');
  const kinds = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => [...item.types]));
  expect(kinds).toContain('image/png');
  expect(errors).toEqual([]);
});

test('an SVG file placed as layers that can be edited', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();

  // A 120 × 80 drawing: a red rounded rectangle, a blue triangle in a group with a circle, and a word.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">' +
    '<rect id="plate" x="10" y="10" width="40" height="30" rx="4" fill="#ff0000"/>' +
    '<g id="marks"><path d="M70 10 L110 10 L110 40 Z" fill="#0000ff"/><circle cx="80" cy="60" r="10" fill="#00ff00"/></g>' +
    '<text x="10" y="70" font-family="Inter" font-size="12" fill="#000000">Label</text>' +
    '</svg>';
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'File' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Place image…' }).click()]);
  await chooser.setFiles({ name: 'badge.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg, 'utf8') });

  // It is a frame named after the file, with a layer for each thing in the drawing, not a picture.
  await expect(layer(page, 'badge')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Width')).toHaveValue('120');
  await expect(field(page, 'Height')).toHaveValue('80');
  for (const name of ['plate', 'marks', 'Label']) await expect(layer(page, name)).toBeVisible();
  // Its shapes are drawn where the file has them: the frame is in the middle of the view.
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  const left = Math.round(box.width / 2 - 60);
  const top = Math.round(box.height / 2 - 40);
  const pixel = async (x: number, y: number): Promise<number[]> => {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(([px, py]) => [...(document.querySelector('canvas') as HTMLCanvasElement).getContext('2d')!.getImageData(px as number, py as number, 1, 1).data].slice(0, 3), [left + x, top + y]);
  };
  expect(await pixel(30, 25)).toEqual([255, 0, 0]);
  expect(await pixel(100, 20)).toEqual([0, 0, 255]);
  expect(await pixel(80, 60)).toEqual([0, 255, 0]);

  // The rectangle is a rectangle: its size, its corner radius and its colour are there to change, and changing them shows.
  await layer(page, 'plate').click();
  await expect(field(page, 'Width')).toHaveValue('40');
  await expect(field(page, 'Corner radius')).toHaveValue('4');
  await expect(field(page, 'Fill 1 colour hex')).toHaveValue('FF0000');
  await set(page, 'Fill 1 colour hex', '00FFFF');
  expect(await pixel(30, 25)).toEqual([0, 255, 255]);
  // The word is text.
  await layer(page, 'Label').click();
  await expect(field(page, 'Font size')).toHaveValue('12');
  // Placing it was one undo step for each change: undoing both takes the drawing away.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(layer(page, 'badge')).toHaveCount(0);
  expect(errors).toEqual([]);
});
