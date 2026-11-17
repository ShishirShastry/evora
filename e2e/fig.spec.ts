import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Figma `.fig` files in the browser: a design saved as a `.fig` file through
 * "Save a copy to disk", and that file opened from the file browser as a new
 * file. Whether Figma itself opens the file cannot be checked here.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

async function menu(page: Page, group: string, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: group }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('a design saved as a .fig file and opened again from it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await page.getByRole('button', { name: /^File name:/ }).click();
  await field(page, 'File name').fill('Handoff');
  await field(page, 'File name').press('Enter');

  // A 200 × 100 frame with a red rectangle in it.
  await canvas(page).focus();
  await page.keyboard.press('f');
  await drag(page, [100, 100], [300, 200]);
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [120, 120], [180, 160]);
  await field(page, 'Fill 1 colour hex').fill('FF0000');
  await field(page, 'Fill 1 colour hex').press('Enter');

  // Saved as a Figma file: an archive with the canvas in it.
  await menu(page, 'File', 'Save a copy to disk…');
  const dialog = page.getByRole('dialog', { name: 'Save a copy to disk' });
  await expect(dialog.getByRole('button', { name: 'OPEN DESIGN (.opendesign)' })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Figma (.fig)' }).click()]);
  expect(download.suggestedFilename()).toBe('Handoff.fig');
  await expect(dialog.getByRole('status', { name: 'Figma file saved' })).toContainText('Saved as a Figma file.');
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(bytes.toString('latin1')).toContain('canvas.fig');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await menu(page, 'File', 'Back to files');

  // Opened from the file browser: a new file with the same layers, sizes and colour.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import file…' }).click()]);
  await chooser.setFiles({ name: 'Handoff.fig', mimeType: 'application/octet-stream', buffer: bytes });
  // Nothing in it was left out, so it opens at once, as a file of its own.
  await expect(canvas(page)).toBeVisible();
  await expect(page.getByRole('button', { name: /^File name: Handoff/ })).toBeVisible();
  await layer(page, 'Frame 1').click();
  await expect(field(page, 'Width')).toHaveValue('200');
  await expect(field(page, 'Height')).toHaveValue('100');
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'Width')).toHaveValue('60');
  await expect(field(page, 'Fill 1 colour hex')).toHaveValue('FF0000');
  expect(errors).toEqual([]);
});

test('a Figma file with something this application keeps only approximately says so before it opens', async ({ page }) => {
  const { compileSchema, encodeBinarySchema, parseSchemaText, writeZip } = await import('../src/core');
  const { deflateRawSync } = await import('node:zlib');
  // A file laid out as Figma's: a page with a FigJam sticky note on it, which is kept as a frame with its text.
  const schema = parseSchemaText(`
    struct GUID { uint sessionID; uint localID; }
    struct Color { float r; float g; float b; float a; }
    struct Vector { float x; float y; }
    struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
    message ParentIndex { GUID guid = 1; string position = 2; }
    message Paint { string type = 1; Color color = 2; float opacity = 3; bool visible = 4; }
    message TextData { string characters = 1; }
    message NodeChange { GUID guid = 1; ParentIndex parentIndex = 2; string type = 3; string name = 4; Vector size = 5; Matrix transform = 6; Paint[] fillPaints = 7; TextData textData = 8; float fontSize = 9; }
    message Message { uint type = 1; NodeChange[] nodeChanges = 2; }
  `);
  const g = (localID: number) => ({ sessionID: 0, localID });
  const message = compileSchema(schema).encode('Message', {
    type: 1,
    nodeChanges: [
      { guid: g(0), type: 'DOCUMENT', name: 'Document' },
      { guid: g(1), type: 'CANVAS', name: 'Board', parentIndex: { guid: g(0), position: 'a' } },
      { guid: g(2), type: 'STICKY', name: 'Note', parentIndex: { guid: g(1), position: 'a' }, size: { x: 200, y: 200 }, transform: { m00: 1, m01: 0, m02: 40, m10: 0, m11: 1, m12: 40 }, fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0.9, b: 0.5, a: 1 }, opacity: 1, visible: true }], textData: { characters: 'Remember this' }, fontSize: 16 },
    ],
  });
  const parts = [new Uint8Array(deflateRawSync(encodeBinarySchema(schema))), new Uint8Array(deflateRawSync(message))];
  const canvasBytes = new Uint8Array(12 + parts.reduce((sum, part) => sum + 4 + part.length, 0));
  canvasBytes.set(new TextEncoder().encode('fig-kiwi'));
  const view = new DataView(canvasBytes.buffer);
  view.setUint32(8, 101, true);
  let offset = 12;
  for (const part of parts) {
    view.setUint32(offset, part.length, true);
    canvasBytes.set(part, offset + 4);
    offset += 4 + part.length;
  }
  const file = writeZip([{ name: 'canvas.fig', bytes: canvasBytes }]);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import file…' }).click()]);
  await chooser.setFiles({ name: 'Board.fig', mimeType: 'application/octet-stream', buffer: Buffer.from(file) });
  // What was kept only approximately is listed first.
  const report = page.getByRole('dialog', { name: 'Figma file opened' });
  await expect(report).toBeVisible();
  await expect(report.getByRole('list', { name: 'Not converted' }).getByRole('listitem')).toHaveText(['Layers of the kind “STICKY” (kept as frames): 1']);
  await report.getByRole('button', { name: 'Open the file' }).click();
  // The note is there, a frame with its words in it.
  await expect(canvas(page)).toBeVisible();
  await layer(page, 'Note').click();
  await expect(field(page, 'Width')).toHaveValue('200');
  await expect(layers(page).getByRole('treeitem', { name: 'Text', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
