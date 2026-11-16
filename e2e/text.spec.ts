import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Text beyond one plain style, in the real browser: lists, justified
 * alignment, and parts of a layer in a style of their own. Text is made red
 * so that its glyphs can be found on the design canvas's pixels.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const select = (page: Page, label: string): Locator => page.getByRole('combobox', { name: label, exact: true });

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

interface Ink {
  count: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Where the pixels of one colour family are inside a region of the design canvas. */
async function ink(page: Page, region: [number, number, number, number], colour: 'red' | 'blue' = 'red'): Promise<Ink> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([x0, y0, x1, y1, which]) => {
      const element = document.querySelector('canvas');
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('design canvas not found');
      const width = (x1 as number) - (x0 as number);
      const height = (y1 as number) - (y0 as number);
      const data = ctx.getImageData(x0 as number, y0 as number, width, height).data;
      const found = { count: 0, left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const [r, g, b] = [data[i] as number, data[i + 1] as number, data[i + 2] as number];
          const hit = which === 'red' ? r > 170 && g < 80 && b < 80 : b > 170 && r < 80 && g < 80;
          if (!hit) continue;
          found.count++;
          found.left = Math.min(found.left, (x0 as number) + x);
          found.right = Math.max(found.right, (x0 as number) + x);
          found.top = Math.min(found.top, (y0 as number) + y);
          found.bottom = Math.max(found.bottom, (y0 as number) + y);
        }
      }
      return found;
    },
    [...region, colour] as [number, number, number, number, string],
  );
}

async function newFile(page: Page): Promise<{ x: number; y: number }> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  return box;
}

test('new text is set in the font that ships with the application, measured only once it has loaded', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const served: string[] = [];
  page.on('response', (response) => {
    if (/inter-[a-z-]+-\d+-(normal|italic)\.woff2/.test(response.url()) && response.ok()) served.push(response.url());
  });
  const box = await newFile(page);
  /** How wide some text is in a font, as the browser's own canvas measures it. */
  const widthIn = (font: string, text: string): Promise<number> =>
    page.evaluate(
      ([cssFont, sample]) => {
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) throw new Error('no canvas');
        ctx.font = cssFont as string;
        return ctx.measureText(sample as string).width;
      },
      [font, text],
    );
  const INTER = '400 16px Inter, Arial, Helvetica, sans-serif';

  // Every face of the font is there before the file is shown: nothing is measured in a stand-in.
  expect(await page.evaluate(() => ['400 16px Inter', '700 16px Inter', 'italic 400 16px Inter', '100 16px Inter', 'italic 900 16px Inter'].every((font) => document.fonts.check(font)))).toBe(true);
  expect(served.some((url) => url.includes('inter-latin-400-normal.woff2'))).toBe(true);

  await page.keyboard.press('t');
  await page.mouse.click(box.x + 200, box.y + 200);
  await page.keyboard.type('Hello bold world');
  await page.keyboard.press('Escape');
  await expect(select(page, 'Font family')).toHaveValue('Inter');
  // The layer is exactly as wide as that text is in Inter, which is not what it is in Arial.
  const inter = await widthIn(INTER, 'Hello bold world');
  const arial = await widthIn('400 16px Arial', 'Hello bold world');
  expect(Math.ceil(inter)).not.toBe(Math.ceil(arial));
  await expect(field(page, 'Width')).toHaveValue(String(Math.ceil(inter)));
  // Another family is still a choice, and text set in it is measured in it.
  await select(page, 'Font family').selectOption('Arial');
  await expect(field(page, 'Width')).toHaveValue(String(Math.ceil(arial)));
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Width')).toHaveValue(String(Math.ceil(inter)));

  // Text in a script whose face was not needed until now: the face is fetched, and the layer is then
  // as wide as the text is in that face.
  expect(served.some((url) => url.includes('inter-cyrillic-400-normal.woff2'))).toBe(false);
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 200, box.y + 320);
  await page.keyboard.type('Привет, мир');
  await page.keyboard.press('Escape');
  await expect.poll(() => served.some((url) => url.includes('inter-cyrillic-400-normal.woff2'))).toBe(true);
  await page.evaluate(() => document.fonts.load('400 16px Inter', 'Привет, мир'));
  const cyrillic = await widthIn(INTER, 'Привет, мир');
  await expect(field(page, 'Width')).toHaveValue(String(Math.ceil(cyrillic)));
  // Sizing it again was not an edit: one undo takes the whole text away.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('lists: bullets and numbers in front of each paragraph, with the text set in', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const box = await newFile(page);

  // Two paragraphs of text that sets its own width, made red.
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 200, box.y + 200);
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Escape');
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await expect(select(page, 'List')).toHaveValue('NONE');
  const region: [number, number, number, number] = [150, 170, 330, 250];
  const plain = await ink(page, region);
  expect(plain.count).toBeGreaterThan(40);
  const width = Number(await field(page, 'Width').inputValue());
  const left = Number(await field(page, 'X position').inputValue());

  // A bulleted list: the layer is 24 wider (one and a half times the 16px font) and stays where it is;
  // the leftmost ink is now a bullet, some way in, and there is more ink than before.
  await select(page, 'List').selectOption('BULLETED');
  await expect(field(page, 'Width')).toHaveValue(String(width + 24));
  await expect(field(page, 'X position')).toHaveValue(String(left));
  const bulleted = await ink(page, region);
  expect(bulleted.left).toBeGreaterThanOrEqual(plain.left + 6);
  expect(bulleted.left).toBeLessThanOrEqual(plain.left + 16);
  expect(bulleted.right).toBeGreaterThanOrEqual(plain.right + 22);
  expect(bulleted.count).toBeGreaterThan(plain.count + 8);
  // Nothing is drawn between the bullets and the text.
  expect((await ink(page, [plain.left + 18, 170, plain.left + 23, 250])).count).toBe(0);

  // A numbered list: the numbers start further left than the bullets did.
  await select(page, 'List').selectOption('NUMBERED');
  const numbered = await ink(page, region);
  expect(numbered.left).toBeLessThan(bulleted.left);
  expect(numbered.left).toBeGreaterThanOrEqual(plain.left);
  expect(numbered.right).toBe(bulleted.right);
  expect(numbered.count).toBeGreaterThan(bulleted.count);

  // It is part of the file: there after a reload, and one undo takes it off again.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(async () => (await ink(page, region)).count).toBe(numbered.count);
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().click();
  await expect(select(page, 'List')).toHaveValue('NUMBERED');
  await select(page, 'List').selectOption('NONE');
  await expect(field(page, 'Width')).toHaveValue(String(width));
  expect((await ink(page, region)).count).toBe(plain.count);
  expect(errors).toEqual([]);
});

test('part of a text layer in a style of its own: from the panel, with shortcuts, kept and edited on', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const box = await newFile(page);
  const editor = page.getByRole('textbox', { name: 'Edit text' });
  /** The stretches the editor shows, each with its text, weight, size and colour. */
  const stretches = (): Promise<string[][]> =>
    editor.locator('span').evaluateAll((spans) =>
      spans.map((span) => {
        const style = (span as HTMLElement).style;
        return [span.textContent ?? '', style.fontWeight, style.fontSize, style.color];
      }),
    );
  const region: [number, number, number, number] = [150, 150, 520, 270];

  await page.keyboard.press('t');
  await page.mouse.click(box.x + 200, box.y + 200);
  await expect(editor).toBeFocused();
  await page.keyboard.type('Hello bold world');

  // Select "bold" with the keyboard; the Text section now speaks for that part.
  await page.keyboard.press('Home');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByText('Text (selected part)')).toBeVisible();

  // A weight, a size and a colour from the panel go to that part only, and the text stays open.
  await page.getByRole('combobox', { name: 'Font weight' }).selectOption('700');
  await set(page, 'Font size', '40');
  await set(page, 'Selected text colour hex', 'FF0000');
  await expect(editor).toHaveCount(1);
  expect((await stretches()).map((stretch) => stretch.slice(0, 3))).toEqual([
    ['Hello ', '400', '16px'],
    ['bold', '700', '40px'],
    [' world', '400', '16px'],
  ]);
  expect((await stretches())[1]?.[3]).toBe('rgb(255, 0, 0)');
  await expect(field(page, 'Font size')).toHaveValue('40');
  await expect(page.getByRole('combobox', { name: 'Font weight' })).toHaveValue('700');

  // Pressing on the layer in the layers panel ends the edit. The layer is as tall as its largest text.
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Hello bold world', exact: true })).toBeVisible();
  await expect(field(page, 'Height')).toHaveValue('48');
  // For the layer as a whole the size is mixed.
  await expect(field(page, 'Font size')).toHaveValue('');
  await expect(field(page, 'Font size')).toHaveAttribute('placeholder', 'Mixed');

  // On the canvas the red ink is the large word, between the two plain ones.
  const red = await ink(page, region);
  expect(red.count).toBeGreaterThan(150);
  expect(red.left).toBeGreaterThan(225);
  expect(red.right).toBeLessThan(350);
  expect(red.bottom - red.top).toBeGreaterThan(22);

  // It is in the file.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(async () => (await ink(page, region)).count).toBe(red.count);
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().click();
  await expect(field(page, 'Height')).toHaveValue('48');

  // A size for the whole layer is the size of all its text; the word keeps its colour. Undo brings the large word back.
  await set(page, 'Font size', '20');
  await expect(field(page, 'Height')).toHaveValue('24');
  expect((await ink(page, region)).count).toBeGreaterThan(40);
  expect((await ink(page, region)).count).toBeLessThan(red.count);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Height')).toHaveValue('48');

  // Open the text again: the stretches are there. Ctrl+A, Ctrl+B makes all of it bold, and again takes that off.
  await page.mouse.dblclick(box.x + 208, box.y + 215);
  await expect(editor).toBeFocused();
  expect((await stretches()).map((stretch) => stretch[0])).toEqual(['Hello ', 'bold', ' world']);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+b');
  expect((await stretches()).map((stretch) => stretch[1])).toEqual(['700', '700', '700']);
  await page.keyboard.press('Control+b');
  expect((await stretches()).map((stretch) => stretch[1])).toEqual(['400', '400', '400']);

  // Typed at the end, new characters are plain like the word before them; typing can be undone and redone in place.
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  expect((await stretches()).map((stretch) => stretch[0])).toEqual(['Hello ', 'bold', ' world!']);
  await page.keyboard.press('Control+z');
  expect((await stretches()).map((stretch) => stretch[0])).toEqual(['Hello ', 'bold', ' world']);
  await page.keyboard.press('Control+Shift+z');
  expect((await stretches()).map((stretch) => stretch[0])).toEqual(['Hello ', 'bold', ' world!']);
  // Typed inside the styled word, they are part of it.
  await page.keyboard.press('Home');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type('L');
  expect((await stretches()).map((stretch) => stretch.slice(0, 3))).toEqual([
    ['Hello ', '400', '16px'],
    ['boLld', '400', '40px'],
    [' world!', '400', '16px'],
  ]);

  // The colour of a part can be given back to the layer's fill.
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: "Use the layer's fill for the selected text" }).click();
  await expect(editor).toHaveCount(1);
  expect((await stretches()).every((stretch) => stretch[3] !== 'rgb(255, 0, 0)')).toBe(true);
  await editor.click();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Hello boLld world!', exact: true })).toBeVisible();
  expect((await ink(page, region)).count).toBe(0);
  expect(errors).toEqual([]);
});

test('justified text: wrapped lines reach both edges, the last line does not', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const box = await newFile(page);

  // A box 200 wide: three of these words fit on a line, the fourth wraps.
  await page.keyboard.press('t');
  await page.mouse.move(box.x + 200, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 360, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.type('mmmm mmmm mmmm mmmm');
  await page.keyboard.press('Escape');
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await expect(field(page, 'Width')).toHaveValue('200');
  const all = await ink(page, [190, 290, 420, 380]);
  expect(all.count).toBeGreaterThan(100);
  const lineHeight = (all.bottom - all.top + 1) / 2;
  const first: [number, number, number, number] = [190, all.top - 2, 420, Math.round(all.top + lineHeight - 2)];
  const second: [number, number, number, number] = [190, Math.round(all.top + lineHeight + 2), 420, all.bottom + 2];

  // Aligned left, the first line stops well short of the right edge.
  const ragged = await ink(page, first);
  const lastLine = await ink(page, second);
  expect(ragged.right).toBeLessThan(385);
  expect(lastLine.right).toBeLessThan(270);

  // Justified, it reaches the edge; its left end and the last line stay where they were.
  await page.getByRole('radio', { name: 'Justify text' }).click();
  const justified = await ink(page, first);
  expect(justified.right).toBeGreaterThanOrEqual(396);
  expect(justified.right).toBeLessThanOrEqual(401);
  expect(justified.left).toBe(ragged.left);
  // The same three words, so ink of the same order. (Thin stems that now fall between two pixels are
  // drawn fainter and are not all counted, so the count is only roughly the same.)
  expect(justified.count).toBeGreaterThan(ragged.count * 0.4);
  expect(justified.count).toBeLessThan(ragged.count * 1.6);
  expect(await ink(page, second)).toEqual(lastLine);

  // Kept across a reload; undone with one step.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(async () => (await ink(page, first)).right).toBe(justified.right);
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().click();
  await expect(page.getByRole('radio', { name: 'Justify text' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Align text left' }).click();
  expect((await ink(page, first)).right).toBe(ragged.right);
  expect(errors).toEqual([]);
});
