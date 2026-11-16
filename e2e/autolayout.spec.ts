import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 4, Auto Layout, in the real browser with real mouse and keyboard.
 * What a layout did is read back from the properties panel (which shows the
 * document) and from the pixels of the design canvas, and once more after a
 * page reload, which shows what was stored. A new file opens at 100 %, so a
 * distance on the page is the same distance on the canvas; where the page's
 * origin is on the canvas is worked out in each test from something that was
 * put at a known place.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const select = (page: Page, label: string): Locator => page.getByRole('combobox', { name: label, exact: true });
const checkbox = (page: Page, label: string): Locator => page.getByRole('checkbox', { name: label, exact: true });

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

const number = async (page: Page, label: string): Promise<number> => Number(await field(page, label).inputValue());

/** The four numbers of the selected layer's box, as the properties panel shows them. */
async function boxOf(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  return { x: await number(page, 'X position'), y: await number(page, 'Y position'), w: await number(page, 'Width'), h: await number(page, 'Height') };
}

/** RGB of one pixel of the design canvas (the first canvas), after the next repaint. */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const element = document.querySelector('canvas');
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('design canvas not found');
      const data = ctx.getImageData(Math.round(px as number), Math.round(py as number), 1, 1).data;
      return [data[0], data[1], data[2]] as [number, number, number];
    },
    [x, y],
  );
}

const PAGE: [number, number, number] = [30, 30, 30];
const WHITE: [number, number, number] = [255, 255, 255];
const GREY: [number, number, number] = [217, 217, 217];
const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];

async function newFile(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
}

test('a button resizes itself to its label, padding, spacing and icon', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await newFile(page);

  // The label: text that sets its own width.
  await page.keyboard.press('t');
  await click(page, [300, 300]);
  await page.keyboard.type('Get Started');
  await page.keyboard.press('Escape');
  await expect(layer(page, 'Get Started')).toHaveAttribute('aria-selected', 'true');
  await set(page, 'Fill 1 colour hex', 'FFFFFF');
  const label = await boxOf(page);
  expect(label.w).toBeGreaterThan(50);
  // The text was put with its left edge, and the middle of its line, where the canvas was clicked.
  const onCanvas = (x: number, y: number): [number, number] => [300 + (x - label.x), 300 - label.h / 2 + (y - label.y)];
  const colourAt = (x: number, y: number): Promise<[number, number, number]> => pixel(page, ...onCanvas(x, y));
  // Text hugs what is typed, and says so.
  await expect(select(page, 'Horizontal sizing')).toHaveValue('HUG');

  // Shift+A puts it into a frame that lays it out and hugs it, exactly where it was.
  await canvas(page).focus();
  await page.keyboard.press('Shift+A');
  await expect(layer(page, 'Frame 1')).toHaveAttribute('aria-selected', 'true');
  await expect(layer(page, 'Get Started')).toHaveAttribute('aria-level', '2');
  await expect(select(page, 'Layout direction')).toHaveValue('HORIZONTAL');
  await expect(select(page, 'Horizontal sizing')).toHaveValue('HUG');
  await expect(select(page, 'Vertical sizing')).toHaveValue('HUG');
  expect(await boxOf(page)).toEqual(label);

  // The button of the specification: 24 and 12 of padding, a gap of 8, a radius of 8, and a colour.
  await set(page, 'Horizontal padding', '24');
  await set(page, 'Vertical padding', '12');
  await set(page, 'Spacing between items', '8');
  await set(page, 'Corner radius', '8');
  await page.getByRole('button', { name: 'Add fill' }).click();
  await set(page, 'Fill 1 colour hex', '0000FF');
  const button = await boxOf(page);
  expect(button).toEqual({ x: label.x, y: label.y, w: label.w + 48, h: label.h + 24 });

  // On the canvas: blue in the padding left of the label, the page beyond the button's right edge.
  const midY = button.y + button.h / 2;
  expect(await colourAt(button.x + 12, midY)).toEqual(BLUE);
  expect(await colourAt(button.x + button.w - 12, midY)).toEqual(BLUE);
  expect(await colourAt(button.x + button.w + 12, midY)).toEqual(PAGE);
  // The corner is rounded off.
  expect(await colourAt(button.x + 1, button.y + 1)).toEqual(PAGE);
  expect(await colourAt(button.x + 5, button.y + 5)).toEqual(BLUE);

  // The label sits inside the padding and cannot be given a position of its own.
  await layer(page, 'Get Started').click();
  await expect(field(page, 'X position')).toHaveValue('24');
  await expect(field(page, 'Y position')).toHaveValue('12');
  await expect(field(page, 'X position')).toBeDisabled();

  // "Get Started" becomes "Get Started Today": the button grows by exactly what the label grew.
  await canvas(page).focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Edit text' });
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Today');
  // While it is still being typed, the button has already grown: its right padding is blue where the page was.
  expect(await colourAt(button.x + button.w + 12, midY)).toEqual(BLUE);
  await page.keyboard.press('Escape');
  await expect(layer(page, 'Get Started Today')).toHaveAttribute('aria-selected', 'true');
  const longer = await boxOf(page);
  expect(longer.w).toBeGreaterThan(label.w + 20);
  await layer(page, 'Frame 1').click();
  const grown = await boxOf(page);
  expect(grown).toEqual({ x: button.x, y: button.y, w: longer.w + 48, h: button.h });
  expect(await colourAt(grown.x + grown.w - 12, midY)).toEqual(BLUE);
  expect(await colourAt(grown.x + grown.w + 12, midY)).toEqual(PAGE);

  // An icon in front of the label: drawn into the button, at its left end, it becomes the first item.
  await page.keyboard.press('o');
  await drag(page, onCanvas(grown.x + 4, grown.y + 14), onCanvas(grown.x + 20, grown.y + 30));
  await expect(layer(page, 'Ellipse 1')).toHaveAttribute('aria-level', '2');
  await set(page, 'Fill 1 colour hex', 'FF0000');
  // (Drawing snaps to the lines round it, so its exact size is typed in.)
  await set(page, 'Width', '16');
  await set(page, 'Height', '16');
  expect(await boxOf(page)).toMatchObject({ x: 24, w: 16, h: 16 });
  await layer(page, 'Get Started Today').click();
  // The icon, the gap of 8, then the label.
  await expect(field(page, 'X position')).toHaveValue(String(24 + 16 + 8));
  await layer(page, 'Frame 1').click();
  expect((await boxOf(page)).w).toBe(grown.w + 16 + 8);
  expect(await colourAt(grown.x + 24 + 8, grown.y + 12 + 8)).toEqual(RED);

  // Lined up across the row: the icon is centred on the label's height.
  await select(page, 'Alignment across the layout').selectOption('CENTER');
  await layer(page, 'Ellipse 1').click();
  await expect(field(page, 'Y position')).toHaveValue(String(12 + (longer.h - 16) / 2));

  // Removing the icon closes the button up again; undo brings it back.
  await canvas(page).focus();
  await page.keyboard.press('Delete');
  await layer(page, 'Frame 1').click();
  expect((await boxOf(page)).w).toBe(grown.w);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await layer(page, 'Frame 1').click();
  expect((await boxOf(page)).w).toBe(grown.w + 24);

  // All of it is stored.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await layer(page, 'Frame 1').click();
  expect(await boxOf(page)).toEqual({ ...grown, w: grown.w + 24 });
  await expect(field(page, 'Horizontal padding')).toHaveValue('24');
  await expect(field(page, 'Vertical padding')).toHaveValue('12');
  await expect(field(page, 'Spacing between items')).toHaveValue('8');
  await expect(select(page, 'Alignment across the layout')).toHaveValue('CENTER');
  expect(await colourAt(grown.x + 24 + 8, grown.y + 12 + (longer.h - 16) / 2 + 8)).toEqual(RED);
  expect(errors).toEqual([]);
});

/** Draws a frame from (100, 100) on the canvas and returns how to turn a place inside it into a place on the canvas. */
async function drawFrame(page: Page, to: [number, number]): Promise<(x: number, y: number) => [number, number]> {
  await page.keyboard.press('f');
  await drag(page, [100, 100], to);
  await expect(layer(page, 'Frame 1')).toHaveAttribute('aria-selected', 'true');
  return (x, y) => [100 + x, 100 + y];
}

/** Draws a rectangle inside the frame, given in the frame's own coordinates, and checks it landed exactly there. */
async function drawRect(page: Page, inFrame: (x: number, y: number) => [number, number], box: { x: number; y: number; w: number; h: number }): Promise<void> {
  // A field of the panel may still have the keyboard.
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, inFrame(box.x, box.y), inFrame(box.x + box.w, box.y + box.h));
  expect(await boxOf(page)).toEqual(box);
}

test('a row: spacing and padding, fill and hug, limits, and wrapping follow the frame', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await newFile(page);
  const inFrame = await drawFrame(page, [500, 300]);
  const colourAt = (x: number, y: number): Promise<[number, number, number]> => pixel(page, ...inFrame(x, y));
  // Three squares of 50, side by side, 40 apart, 20 in from the frame's top-left corner.
  await drawRect(page, inFrame, { x: 20, y: 20, w: 50, h: 50 });
  await drawRect(page, inFrame, { x: 110, y: 20, w: 50, h: 50 });
  await drawRect(page, inFrame, { x: 200, y: 20, w: 50, h: 50 });

  // Auto Layout reads the arrangement off the frame: nothing moves.
  await layer(page, 'Frame 1').click();
  await expect(page.getByRole('region', { name: 'Auto layout' })).toContainText('No auto layout');
  await page.getByRole('button', { name: 'Add Auto Layout' }).click();
  await expect(select(page, 'Layout direction')).toHaveValue('HORIZONTAL');
  await expect(field(page, 'Spacing between items')).toHaveValue('40');
  await expect(field(page, 'Left padding')).toHaveValue('20');
  await expect(field(page, 'Right padding')).toHaveValue('150');
  await expect(field(page, 'Top padding')).toHaveValue('20');
  await expect(field(page, 'Bottom padding')).toHaveValue('130');
  await expect(field(page, 'Width')).toHaveValue('400');
  await expect(field(page, 'Height')).toHaveValue('200');
  await layer(page, 'Rectangle 2').click();
  await expect(field(page, 'X position')).toHaveValue('110');

  // Padding: the frame hugs its children, so less padding makes it smaller.
  await layer(page, 'Frame 1').click();
  await set(page, 'Right padding', '20');
  await expect(field(page, 'Width')).toHaveValue('270');
  await set(page, 'Bottom padding', '20');
  await expect(field(page, 'Height')).toHaveValue('90');
  // With opposite sides equal, one field does for both.
  await expect(field(page, 'Horizontal padding')).toHaveValue('20');
  await expect(field(page, 'Vertical padding')).toHaveValue('20');
  await expect(field(page, 'Left padding')).toHaveCount(0);
  // The four sides can still be shown, and put away again.
  await checkbox(page, 'Separate padding').check();
  await expect(field(page, 'Left padding')).toHaveValue('20');
  await expect(field(page, 'Horizontal padding')).toHaveCount(0);
  await checkbox(page, 'Separate padding').uncheck();
  await expect(field(page, 'Horizontal padding')).toHaveValue('20');

  // Spacing: the children close up and the frame with them.
  await set(page, 'Spacing between items', '10');
  await expect(field(page, 'Width')).toHaveValue('210');
  expect(await colourAt(80 + 25, 45)).toEqual(GREY);
  expect(await colourAt(75, 45)).toEqual(WHITE);
  expect(await colourAt(215, 45)).toEqual(PAGE);
  // One undo step for the spacing, children and frame together.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Width')).toHaveValue('270');
  await page.keyboard.press('Control+Shift+z');
  await expect(field(page, 'Width')).toHaveValue('210');

  // Fill container: the middle square takes whatever room the frame has. The frame stops hugging its width.
  await layer(page, 'Rectangle 2').click();
  await expect(select(page, 'Horizontal sizing').locator('option')).toHaveText(['Fixed width', 'Fill container']);
  await select(page, 'Horizontal sizing').selectOption('FILL');
  await layer(page, 'Frame 1').click();
  await expect(select(page, 'Horizontal sizing')).toHaveValue('FIXED');
  await expect(select(page, 'Vertical sizing')).toHaveValue('HUG');
  await set(page, 'Width', '400');
  await layer(page, 'Rectangle 2').click();
  await expect(field(page, 'Width')).toHaveValue('240');
  await layer(page, 'Rectangle 3').click();
  await expect(field(page, 'X position')).toHaveValue('330');
  expect(await colourAt(200, 45)).toEqual(GREY);
  expect(await colourAt(325, 45)).toEqual(WHITE);
  expect(await colourAt(355, 45)).toEqual(GREY);

  // The frame's right edge dragged in by 80 on the canvas: the square that fills gives up exactly that.
  await layer(page, 'Frame 1').click();
  await drag(page, inFrame(400, 45), inFrame(320, 45));
  await expect(field(page, 'Width')).toHaveValue('320');
  await layer(page, 'Rectangle 2').click();
  await expect(field(page, 'Width')).toHaveValue('160');

  // Limits: no wider than 100, then no narrower than 60 in a frame that leaves it only 40.
  await set(page, 'Maximum width', '100');
  await expect(field(page, 'Width')).toHaveValue('100');
  await layer(page, 'Rectangle 3').click();
  await expect(field(page, 'X position')).toHaveValue('190');

  // Alignment along the row: the squares now take 220 of the 280 between the padding, which leaves 60 to place them in.
  const firstAndLast = async (): Promise<[number, number]> => {
    await layer(page, 'Rectangle 1').click();
    const first = await number(page, 'X position');
    await layer(page, 'Rectangle 3').click();
    const last = await number(page, 'X position');
    await layer(page, 'Frame 1').click();
    return [first, last];
  };
  await layer(page, 'Frame 1').click();
  await expect(select(page, 'Alignment along the layout').locator('option')).toHaveText(['Left', 'Center', 'Right', 'Space between']);
  await select(page, 'Alignment along the layout').selectOption('CENTER');
  expect(await firstAndLast()).toEqual([50, 220]);
  await select(page, 'Alignment along the layout').selectOption('MAX');
  expect(await firstAndLast()).toEqual([80, 250]);
  // Spread from edge to edge: the gap is whatever is left over, so it can no longer be typed.
  await select(page, 'Alignment along the layout').selectOption('SPACE_BETWEEN');
  expect(await firstAndLast()).toEqual([20, 250]);
  await expect(field(page, 'Spacing between items')).toBeDisabled();
  expect(await colourAt(20 + 50 + 20, 45)).toEqual(WHITE);
  expect(await colourAt(20 + 50 + 40 + 50, 45)).toEqual(GREY);
  await select(page, 'Alignment along the layout').selectOption('MIN');
  expect(await firstAndLast()).toEqual([20, 190]);
  await expect(field(page, 'Spacing between items')).toBeEnabled();

  await set(page, 'Width', '200');
  await layer(page, 'Rectangle 2').click();
  await expect(field(page, 'Width')).toHaveValue('40');
  await set(page, 'Minimum width', '60');
  await expect(field(page, 'Width')).toHaveValue('60');
  await set(page, 'Minimum width', '');
  await expect(field(page, 'Width')).toHaveValue('40');

  // Wrapping: at 150 wide the third square no longer fits and starts a second line; the frame hugs both lines.
  await layer(page, 'Frame 1').click();
  await select(page, 'Layout direction').selectOption('WRAP');
  await set(page, 'Width', '150');
  await expect(field(page, 'Height')).toHaveValue('140');
  await set(page, 'Spacing between lines', '10');
  await expect(field(page, 'Height')).toHaveValue('150');
  await layer(page, 'Rectangle 3').click();
  expect(await boxOf(page)).toEqual({ x: 20, y: 80, w: 50, h: 50 });
  await layer(page, 'Rectangle 2').click();
  // On its own line with the first square, it fills what that leaves: 110 less 50 and the gap.
  expect(await boxOf(page)).toEqual({ x: 80, y: 20, w: 50, h: 50 });
  expect(await colourAt(45, 105)).toEqual(GREY);
  expect(await colourAt(45, 75)).toEqual(WHITE);
  expect(await colourAt(105, 105)).toEqual(WHITE);
  // Lines: given a height of its own, with room to spare, the frame can spread its lines from top to bottom.
  await layer(page, 'Frame 1').click();
  await set(page, 'Height', '200');
  await expect(select(page, 'Vertical sizing')).toHaveValue('FIXED');
  await select(page, 'Line distribution').selectOption('SPACE_BETWEEN');
  await expect(field(page, 'Spacing between lines')).toBeDisabled();
  await layer(page, 'Rectangle 3').click();
  await expect(field(page, 'Y position')).toHaveValue('130');
  await layer(page, 'Frame 1').click();
  await select(page, 'Line distribution').selectOption('AUTO');
  await select(page, 'Vertical sizing').selectOption('HUG');
  await expect(field(page, 'Height')).toHaveValue('150');
  // Wider again, and it is one line.
  await set(page, 'Width', '260');
  await expect(field(page, 'Height')).toHaveValue('90');
  await set(page, 'Width', '150');

  // Stored as laid out.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await layer(page, 'Frame 1').click();
  await expect(select(page, 'Layout direction')).toHaveValue('WRAP');
  await expect(field(page, 'Width')).toHaveValue('150');
  await expect(field(page, 'Height')).toHaveValue('150');
  await expect(field(page, 'Spacing between lines')).toHaveValue('10');
  await layer(page, 'Rectangle 3').click();
  expect(await boxOf(page)).toEqual({ x: 20, y: 80, w: 50, h: 50 });
  expect(await colourAt(45, 105)).toEqual(GREY);
  expect(errors).toEqual([]);
});

test('a column: reordering, children outside the flow, and a layout nested in a layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await newFile(page);
  const inFrame = await drawFrame(page, [400, 500]);
  const colourAt = (x: number, y: number): Promise<[number, number, number]> => pixel(page, ...inFrame(x, y));
  // Three bars of 100 × 40, one under another, 20 apart: red, grey and blue.
  await drawRect(page, inFrame, { x: 20, y: 20, w: 100, h: 40 });
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await drawRect(page, inFrame, { x: 20, y: 80, w: 100, h: 40 });
  await drawRect(page, inFrame, { x: 20, y: 140, w: 100, h: 40 });
  await set(page, 'Fill 1 colour hex', '0000FF');

  // Shift+A on the frame: a column, read off the bars.
  await layer(page, 'Frame 1').click();
  await canvas(page).focus();
  await page.keyboard.press('Shift+A');
  await expect(select(page, 'Layout direction')).toHaveValue('VERTICAL');
  await expect(field(page, 'Spacing between items')).toHaveValue('20');
  expect(await boxOf(page)).toMatchObject({ w: 300, h: 400 });
  await set(page, 'Bottom padding', '120');
  await expect(field(page, 'Height')).toHaveValue('300');

  // The red bar dragged below the blue one takes the last place; the others move up.
  await drag(page, inFrame(70, 40), inFrame(70, 200));
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Y position')).toHaveValue('140');
  expect(await colourAt(70, 160)).toEqual(RED);
  expect(await colourAt(70, 40)).toEqual(GREY);
  expect(await colourAt(70, 100)).toEqual(BLUE);
  // The arrow keys move it a place at a time along the column, and undo puts it back.
  await canvas(page).focus();
  await page.keyboard.press('ArrowUp');
  await expect(field(page, 'Y position')).toHaveValue('80');
  expect(await colourAt(70, 100)).toEqual(RED);
  await page.keyboard.press('ArrowLeft');
  await expect(field(page, 'Y position')).toHaveValue('80');
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Y position')).toHaveValue('140');

  // Reversed, the column runs from the top of the stack down: the red bar, last in the stack, comes first.
  await layer(page, 'Frame 1').click();
  await checkbox(page, 'Reverse order').check();
  expect(await colourAt(70, 40)).toEqual(RED);
  expect(await colourAt(70, 160)).toEqual(GREY);
  await checkbox(page, 'Reverse order').uncheck();
  expect(await colourAt(70, 160)).toEqual(RED);

  // Taken out of the flow, the grey bar can be put anywhere; the others close up and the frame hugs only them.
  await layer(page, 'Rectangle 2').click();
  await expect(field(page, 'X position')).toBeDisabled();
  await checkbox(page, 'Ignore auto layout').check();
  await expect(field(page, 'X position')).toBeEnabled();
  await set(page, 'X position', '150');
  await set(page, 'Y position', '130');
  expect(await boxOf(page)).toEqual({ x: 150, y: 130, w: 100, h: 40 });
  expect(await colourAt(200, 150)).toEqual(GREY);
  expect(await colourAt(70, 40)).toEqual(BLUE);
  expect(await colourAt(70, 100)).toEqual(RED);
  await layer(page, 'Frame 1').click();
  await expect(field(page, 'Height')).toHaveValue('240');
  // Out of the flow it follows its constraints: kept to the right edge, it moves when the frame grows by 100.
  await layer(page, 'Rectangle 2').click();
  await select(page, 'Horizontal constraint').selectOption('MAX');
  await layer(page, 'Frame 1').click();
  await set(page, 'Right padding', '280');
  await expect(field(page, 'Width')).toHaveValue('400');
  await layer(page, 'Rectangle 2').click();
  await expect(field(page, 'X position')).toHaveValue('250');
  // The bars in the flow have no constraints to set, and did not move.
  await layer(page, 'Rectangle 3').click();
  await expect(select(page, 'Horizontal constraint')).toHaveCount(0);
  await expect(field(page, 'X position')).toHaveValue('20');

  // A layout inside the layout: Shift+A on the blue bar wraps it in a frame of its own, in its place in the column.
  await canvas(page).focus();
  await page.keyboard.press('Shift+A');
  await expect(layer(page, 'Frame 2')).toHaveAttribute('aria-selected', 'true');
  await expect(layer(page, 'Frame 2')).toHaveAttribute('aria-level', '2');
  await expect(layer(page, 'Rectangle 3')).toHaveAttribute('aria-level', '3');
  await set(page, 'Horizontal padding', '10');
  await set(page, 'Vertical padding', '5');
  expect(await boxOf(page)).toEqual({ x: 20, y: 20, w: 120, h: 50 });
  // What comes after it in the column moved down by the padding, and the outer frame grew.
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'Y position')).toHaveValue('90');
  await layer(page, 'Frame 1').click();
  await expect(field(page, 'Height')).toHaveValue('250');

  // The inner frame fills the column, and the bar fills the inner frame: resizing the outer frame reaches the bar.
  await set(page, 'Right padding', '20');
  await layer(page, 'Frame 2').click();
  await select(page, 'Horizontal sizing').selectOption('FILL');
  await layer(page, 'Rectangle 3').click();
  await select(page, 'Horizontal sizing').selectOption('FILL');
  await layer(page, 'Frame 1').click();
  await expect(select(page, 'Horizontal sizing')).toHaveValue('FIXED');
  await set(page, 'Width', '300');
  await layer(page, 'Frame 2').click();
  await expect(field(page, 'Width')).toHaveValue('260');
  await layer(page, 'Rectangle 3').click();
  await expect(field(page, 'Width')).toHaveValue('240');
  expect(await colourAt(20 + 10 + 235, 45)).toEqual(BLUE);
  await layer(page, 'Frame 1').click();
  await set(page, 'Width', '200');
  await layer(page, 'Rectangle 3').click();
  await expect(field(page, 'Width')).toHaveValue('140');
  expect(await colourAt(20 + 10 + 135, 45)).toEqual(BLUE);
  expect(await colourAt(20 + 10 + 145, 45)).toEqual(WHITE);

  // Auto Layout switched off again leaves everything where it was.
  await layer(page, 'Frame 1').click();
  await page.getByRole('button', { name: 'Remove Auto Layout' }).click();
  await expect(page.getByRole('region', { name: 'Auto layout' })).toContainText('No auto layout');
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'X position')).toBeEnabled();
  await expect(field(page, 'Y position')).toHaveValue('90');
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  // Undo also selects what was selected when the layout was switched off: the frame, which has it again.
  await expect(layer(page, 'Frame 1')).toHaveAttribute('aria-selected', 'true');
  await expect(select(page, 'Layout direction')).toHaveValue('VERTICAL');
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'X position')).toBeDisabled();
  // The same from the keyboard.
  await layer(page, 'Frame 1').click();
  await canvas(page).focus();
  await page.keyboard.press('Alt+Shift+A');
  await expect(page.getByRole('region', { name: 'Auto layout' })).toContainText('No auto layout');
  await page.keyboard.press('Control+z');
  await expect(select(page, 'Layout direction')).toHaveValue('VERTICAL');

  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await layer(page, 'Rectangle 3').click();
  await expect(field(page, 'Width')).toHaveValue('140');
  await expect(select(page, 'Horizontal sizing')).toHaveValue('FILL');
  await layer(page, 'Rectangle 2').click();
  await expect(checkbox(page, 'Ignore auto layout')).toBeChecked();
  expect(errors).toEqual([]);
});

test('stretch: every item is as tall as the row, whatever its own sizing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await newFile(page);
  const inFrame = await drawFrame(page, [500, 300]);
  const colourAt = (x: number, y: number): Promise<[number, number, number]> => pixel(page, ...inFrame(x, y));
  // A square of 50 and a bar 80 tall, side by side at the top of a 400 × 200 frame.
  await drawRect(page, inFrame, { x: 20, y: 20, w: 50, h: 50 });
  await drawRect(page, inFrame, { x: 110, y: 20, w: 50, h: 80 });
  await layer(page, 'Frame 1').click();
  await page.getByRole('button', { name: 'Add Auto Layout' }).click();
  await expect(field(page, 'Height')).toHaveValue('200');
  await expect(select(page, 'Vertical sizing')).toHaveValue('HUG');
  await expect(select(page, 'Alignment across the layout').locator('option')).toHaveText(['Top', 'Center', 'Bottom', 'Stretch']);
  // Under the square, which ends 70 down, the frame shows.
  expect(await colourAt(45, 85)).toEqual(WHITE);

  // Stretch: the frame keeps its height but no longer hugs it, and says what Stretch does to its items.
  await select(page, 'Alignment across the layout').selectOption('STRETCH');
  await expect(field(page, 'Height')).toHaveValue('200');
  await expect(select(page, 'Vertical sizing')).toHaveValue('FIXED');
  await expect(select(page, 'Vertical sizing').locator('option')).toHaveText(['Fixed height']);
  await expect(select(page, 'Horizontal sizing')).toHaveValue('HUG');
  await expect(page.getByRole('note', { name: 'What Stretch does' })).toContainText('is not used while Stretch is on');

  // Both items are the 80 that is left between the padding of 20 and of 100.
  await layer(page, 'Rectangle 1').click();
  expect(await boxOf(page)).toEqual({ x: 20, y: 20, w: 50, h: 80 });
  expect(await colourAt(45, 85)).toEqual(GREY);
  // The square's own vertical sizing is shown, cannot be changed, and is said not to be in use.
  await expect(select(page, 'Vertical sizing')).toHaveValue('FIXED');
  await expect(select(page, 'Vertical sizing')).toBeDisabled();
  await expect(select(page, 'Horizontal sizing')).toBeEnabled();
  await expect(page.getByRole('note', { name: 'Stretched by the frame' })).toContainText('Height: stretched');

  // A taller frame, and both follow it.
  await layer(page, 'Frame 1').click();
  await set(page, 'Height', '300');
  await layer(page, 'Rectangle 2').click();
  await expect(field(page, 'Height')).toHaveValue('180');
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'Height')).toHaveValue('180');
  expect(await colourAt(45, 190)).toEqual(GREY);
  expect(await colourAt(45, 210)).toEqual(WHITE);

  // An item's own limits still hold.
  await set(page, 'Maximum height', '100');
  await expect(field(page, 'Height')).toHaveValue('100');
  expect(await colourAt(45, 130)).toEqual(WHITE);
  await set(page, 'Maximum height', '');
  await expect(field(page, 'Height')).toHaveValue('180');
  // One undo step takes the limit back off... and the one before puts it on again.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Height')).toHaveValue('100');
  await page.keyboard.press('Control+Shift+z');
  await expect(field(page, 'Height')).toHaveValue('180');

  // Stored.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await layer(page, 'Frame 1').click();
  await expect(select(page, 'Alignment across the layout')).toHaveValue('STRETCH');
  await layer(page, 'Rectangle 1').click();
  await expect(field(page, 'Height')).toHaveValue('180');
  await expect(select(page, 'Vertical sizing')).toBeDisabled();
  expect(await colourAt(45, 190)).toEqual(GREY);

  // Back to the top: the items keep the height the stretch gave them, and their own sizing is theirs again.
  await layer(page, 'Frame 1').click();
  await select(page, 'Alignment across the layout').selectOption('MIN');
  await expect(page.getByRole('note', { name: 'What Stretch does' })).toHaveCount(0);
  await expect(select(page, 'Vertical sizing').locator('option')).toHaveText(['Fixed height', 'Hug contents']);
  await layer(page, 'Rectangle 1').click();
  await expect(select(page, 'Vertical sizing')).toBeEnabled();
  await expect(page.getByRole('note', { name: 'Stretched by the frame' })).toHaveCount(0);
  await expect(field(page, 'Height')).toHaveValue('180');
  expect(errors).toEqual([]);
});
