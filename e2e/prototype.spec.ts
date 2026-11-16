import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 6, prototyping, in the real browser: an interaction is built in the
 * Prototype panel, the prototype is presented, and what it shows is read
 * from the pixels of the viewer's canvas and from the name of the screen.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const stage = (page: Page): Locator => page.getByRole('application', { name: 'Prototype' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const select = (page: Page, label: string): Locator => page.getByRole('combobox', { name: label, exact: true });
const button = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true });
const screen = (page: Page): Locator => page.getByRole('status', { name: 'Current screen' });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

/** Clicks a point of the prototype, in the prototype's own pixels. */
async function tap(page: Page, x: number, y: number): Promise<void> {
  const box = await stage(page).boundingBox();
  if (!box) throw new Error('prototype not visible');
  await page.mouse.click(box.x + x, box.y + y);
}

async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const element = document.querySelector('canvas');
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('canvas not found');
      const data = ctx.getImageData(Math.round(px as number), Math.round(py as number), 1, 1).data;
      return [data[0], data[1], data[2]] as [number, number, number];
    },
    [x, y],
  );
}

const WHITE: [number, number, number] = [255, 255, 255];
const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];

test('an interaction built in the panel and played: navigate, back, an overlay, a flow and a device', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();

  // Two 200 × 200 frames, the second green; a red button in the first.
  await page.keyboard.press('f');
  await drag(page, [100, 100], [300, 300]);
  await canvas(page).focus();
  await page.keyboard.press('f');
  await drag(page, [350, 100], [550, 300]);
  await set(page, 'Fill 1 colour hex', '00FF00');
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [120, 120], [200, 160]);
  await set(page, 'Fill 1 colour hex', 'FF0000');

  // The button gets an interaction: on click, go to the second frame, at once.
  await page.getByRole('tab', { name: 'Prototype' }).click();
  await button(page, 'Add interaction').click();
  await expect(select(page, 'Interaction 1 trigger')).toHaveValue('ON_CLICK');
  await select(page, 'Interaction 1 action 1 destination').selectOption({ label: 'Frame 2' });
  await select(page, 'Interaction 1 action 1 transition').selectOption({ label: 'Instant' });

  // Presented: it starts on the first frame; a click on the button shows the second; Back returns.
  await button(page, 'Present prototype').click();
  await expect(stage(page)).toBeVisible();
  await expect(screen(page)).toHaveText('Frame 1');
  expect(await pixel(page, 50, 40)).toEqual(RED);
  expect(await pixel(page, 150, 150)).toEqual(WHITE);
  await tap(page, 150, 150);
  await expect(screen(page)).toHaveText('Frame 1');
  await tap(page, 50, 40);
  await expect(screen(page)).toHaveText('Frame 2');
  expect(await pixel(page, 50, 40)).toEqual(GREEN);
  await button(page, 'Back').click();
  await expect(screen(page)).toHaveText('Frame 1');
  expect(await pixel(page, 50, 40)).toEqual(RED);
  await expect(button(page, 'Back')).toBeDisabled();

  // In the editor again, the interaction is changed to open the frame as an overlay, and the second frame starts a flow.
  await button(page, 'Back to the editor').click();
  await expect(canvas(page)).toBeVisible();
  await layer(page, 'Rectangle 1').click();
  await page.getByRole('tab', { name: 'Prototype' }).click();
  await select(page, 'Interaction 1 action 1 type').selectOption({ label: 'Open overlay' });
  await select(page, 'Interaction 1 action 1 destination').selectOption({ label: 'Frame 2' });
  await select(page, 'Interaction 1 action 1 transition').selectOption({ label: 'Instant' });
  await layer(page, 'Frame 2').click();
  await button(page, 'Start a flow here').click();
  await set(page, 'Flow name', 'Second');
  await layer(page, 'Frame 1').click();
  await button(page, 'Present prototype').click();
  await expect(screen(page)).toHaveText('Frame 1');
  await tap(page, 50, 40);
  // The overlay covers the first frame, which is still the screen.
  await expect(screen(page)).toHaveText('Frame 1');
  expect(await pixel(page, 50, 40)).toEqual(GREEN);
  await button(page, 'Back').click();
  expect(await pixel(page, 50, 40)).toEqual(RED);
  // The flow is offered, and choosing it starts there.
  await select(page, 'Flow').selectOption({ label: 'Second' });
  await expect(screen(page)).toHaveText('Frame 2');
  // A device gives the prototype that screen.
  await select(page, 'Device').selectOption({ label: 'Phone' });
  await expect(page.locator('[data-device="PHONE"]')).toBeVisible();
  await button(page, 'Restart').click();
  await expect(screen(page)).toHaveText('Frame 2');
  // The link names the file and the frame, and opens the same prototype.
  expect(page.url()).toMatch(/#\/proto\/[0-9A-Za-z]+\/[0-9A-Za-z]+$/);
  await page.reload();
  await expect(stage(page)).toBeVisible();
  await expect(screen(page)).toHaveText('Frame 1');
  expect(errors).toEqual([]);
});

test('a connection dragged on the canvas from a layer to a frame, undone, redone and played', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
  await page.keyboard.press('f');
  await drag(page, [100, 100], [300, 300]);
  await canvas(page).focus();
  await page.keyboard.press('f');
  await drag(page, [350, 100], [550, 300]);
  await set(page, 'Fill 1 colour hex', '00FF00');
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [120, 120], [200, 160]);
  await set(page, 'Fill 1 colour hex', 'FF0000');

  // With the Prototype tab open, the selected rectangle has a handle beside its right edge; dragged to the second frame, it connects.
  await page.getByRole('tab', { name: 'Prototype' }).click();
  await expect(page.getByRole('region', { name: 'Interactions' })).toContainText('No interactions');
  await drag(page, [214, 140], [450, 200]);
  await expect(select(page, 'Interaction 1 trigger')).toHaveValue('ON_CLICK');
  await expect(select(page, 'Interaction 1 action 1 type')).toHaveValue('NAVIGATE');
  await expect(select(page, 'Interaction 1 action 1 destination').locator('option:checked')).toHaveText('Frame 2');
  await expect(layer(page, 'Rectangle 1')).toHaveAttribute('aria-selected', 'true');
  // Dropped on nothing, a drag from the handle connects nothing.
  await drag(page, [214, 140], [450, 400]);
  await expect(select(page, 'Interaction 2 trigger')).toHaveCount(0);
  // One undo step takes the connection away; redo brings it back.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('region', { name: 'Interactions' })).toContainText('No interactions');
  await page.keyboard.press('Control+Shift+z');
  await expect(select(page, 'Interaction 1 action 1 destination').locator('option:checked')).toHaveText('Frame 2');

  // Played: the click goes to the second frame, with the transition a new connection has.
  await button(page, 'Present prototype').click();
  await expect(screen(page)).toHaveText('Frame 1');
  await tap(page, 50, 40);
  await expect(screen(page)).toHaveText('Frame 2');
  await expect.poll(() => pixel(page, 50, 40)).toEqual(GREEN);
  expect(errors).toEqual([]);
});
