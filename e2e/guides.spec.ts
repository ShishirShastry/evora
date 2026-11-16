import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 2 rulers and guides: showing the rulers, pulling guides out of them,
 * snapping to a guide, removing one by dragging it back, and persistence.
 * Rulers and guides are drawn on the overlay canvas, so they are checked by
 * reading its pixels.
 */

const GUIDE: [number, number, number, number] = [74, 168, 255, 255];

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
  await page.mouse.up();
}

async function overlayPixel(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const element = document.querySelectorAll('canvas')[1];
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('overlay canvas not found');
      const data = ctx.getImageData(px as number, py as number, 1, 1).data;
      return [data[0], data[1], data[2], data[3]] as [number, number, number, number];
    },
    [x, y],
  );
}

test('guides of a frame: across the frame only, moving with it, snapped to, handed to the page and back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
  const set = async (label: string, value: string): Promise<void> => {
    await field(page, label).fill(value);
    await field(page, label).press('Enter');
  };

  // A frame from (200, 200) to (500, 400), and the rulers.
  await page.keyboard.press('f');
  await drag(page, [200, 200], [500, 400]);
  await page.keyboard.press('Shift+R');

  // A guide pulled out of the left ruler and let go inside the frame is the frame's: a line from its top to its bottom.
  await drag(page, [10, 300], [300, 300]);
  expect(await overlayPixel(page, 300, 250)).toEqual(GUIDE);
  expect(await overlayPixel(page, 300, 390)).toEqual(GUIDE);
  expect((await overlayPixel(page, 300, 150))[3]).toBe(0);
  expect((await overlayPixel(page, 300, 460))[3]).toBe(0);
  await expect(page.getByText('1 guide in this frame')).toBeVisible();

  // Moved 60 to the right, the frame takes its guide with it.
  const x = Number(await field(page, 'X position').inputValue());
  await set('X position', String(x + 60));
  expect(await overlayPixel(page, 360, 250)).toEqual(GUIDE);
  expect((await overlayPixel(page, 300, 250))[3]).toBe(0);

  // A rectangle in the frame snaps to it: three pixels to the right of the guide, it lands on it, 100 from the frame's left edge.
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [280, 220], [320, 260]);
  await drag(page, [300, 240], [383, 300]);
  await expect(field(page, 'X position')).toHaveValue('100');

  // Dragged out of the frame, the guide is the page's and runs right across; dragged back in, it is the frame's again.
  await page.keyboard.press('Escape');
  await drag(page, [360, 380], [700, 380]);
  expect(await overlayPixel(page, 700, 100)).toEqual(GUIDE);
  expect((await overlayPixel(page, 360, 380))[3]).toBe(0);
  await expect(page.getByText('1 ruler guide')).toBeVisible();
  await drag(page, [700, 500], [420, 380]);
  expect(await overlayPixel(page, 420, 380)).toEqual(GUIDE);
  expect((await overlayPixel(page, 420, 100))[3]).toBe(0);
  await expect(page.getByText(/ruler guide/)).toHaveCount(0);

  // It is in the file, and is taken off from the frame's properties.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(() => overlayPixel(page, 420, 380)).toEqual(GUIDE);
  await page.getByRole('tree', { name: 'Layers' }).locator('[role="treeitem"][aria-level="1"]').first().click();
  await expect(page.getByText('1 guide in this frame')).toBeVisible();
  await page.getByRole('button', { name: 'Remove all guides of this frame' }).click();
  expect((await overlayPixel(page, 420, 380))[3]).toBe(0);
  await expect(page.getByText(/in this frame/)).toHaveCount(0);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  expect(await overlayPixel(page, 420, 380)).toEqual(GUIDE);
  expect(errors).toEqual([]);
});

test('rulers and guides: show, pull out, snap, remove, remember', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  const originY = Math.floor(box.height) / 2;

  // Rulers are off to begin with: nothing is drawn along the top edge.
  expect((await overlayPixel(page, 300, 10))[3]).toBe(0);

  // Shift+R shows them: an opaque band along the top and left edges.
  await canvas(page).focus();
  await page.keyboard.press('Shift+R');
  expect((await overlayPixel(page, 303, 3))[3]).toBe(255);
  expect((await overlayPixel(page, 3, 303))[3]).toBe(255);
  expect((await overlayPixel(page, 300, 300))[3]).toBe(0);

  // Pull a horizontal guide out of the top ruler down to y = 250 on the canvas.
  await drag(page, [400, 10], [400, 250]);
  expect(await overlayPixel(page, 400, 250)).toEqual(GUIDE);
  expect(await overlayPixel(page, 700, 250)).toEqual(GUIDE);
  expect((await overlayPixel(page, 400, 240))[3]).toBe(0);
  await expect(page.getByText('1 ruler guide')).toBeVisible();

  // And a vertical one out of the left ruler to x = 300.
  await drag(page, [10, 400], [300, 400]);
  expect(await overlayPixel(page, 300, 500)).toEqual(GUIDE);
  await expect(page.getByText('2 ruler guides')).toBeVisible();

  // A rectangle dragged to within a few pixels of the horizontal guide snaps onto it.
  await page.keyboard.press('r');
  await drag(page, [500, 400], [600, 480]);
  await drag(page, [550, 440], [550, 293]); // its top edge would be at 253: three pixels below the guide
  await expect(field(page, 'Y position')).toHaveValue(String(250 - originY));

  // Move the vertical guide by dragging it.
  await page.keyboard.press('Escape');
  await drag(page, [300, 600], [350, 600]);
  expect(await overlayPixel(page, 350, 500)).toEqual(GUIDE);
  expect((await overlayPixel(page, 300, 500))[3]).toBe(0);

  // Undo puts it back; redo moves it again.
  await page.keyboard.press('Control+z');
  expect(await overlayPixel(page, 300, 500)).toEqual(GUIDE);
  await page.keyboard.press('Control+Shift+z');
  expect(await overlayPixel(page, 350, 500)).toEqual(GUIDE);

  // Drag the horizontal guide back onto the top ruler: it is removed.
  await drag(page, [700, 250], [700, 8]);
  expect((await overlayPixel(page, 700, 250))[3]).toBe(0);
  await expect(page.getByText('1 ruler guide')).toBeVisible();

  // Hiding the rulers hides the guides with them; they come back with the rulers.
  await page.keyboard.press('Shift+R');
  expect((await overlayPixel(page, 350, 500))[3]).toBe(0);
  expect((await overlayPixel(page, 303, 3))[3]).toBe(0);
  await page.keyboard.press('Shift+R');
  expect(await overlayPixel(page, 350, 500)).toEqual(GUIDE);

  // The guide is stored with the page, and showing rulers is remembered on this device.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(() => overlayPixel(page, 350, 500)).toEqual(GUIDE);
  expect((await overlayPixel(page, 303, 3))[3]).toBe(255);

  // "Remove all" on the page's properties clears the guides.
  await page.getByRole('button', { name: 'Remove all' }).click();
  expect((await overlayPixel(page, 350, 500))[3]).toBe(0);
  await expect(page.getByText(/ruler guide/)).toHaveCount(0);

  await page.screenshot({ path: 'test-results/phase2-rulers.png' });
  expect(errors).toEqual([]);
});
