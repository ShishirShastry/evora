import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Even spacing and distances in the real browser: a layer dragged beside two
 * others takes up their gap, the gaps are drawn with their sizes while it is
 * held there, and holding Alt measures from the selection to the layer under
 * the pointer. What is drawn is read from the overlay canvas's pixels.
 */

type RGB = [number, number, number];
/** The colour of smart guides and distances. */
const GUIDE: RGB = [255, 79, 123];

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });

/** Is there a solid pixel of a colour on the overlay within `reach` pixels of a point? */
async function overlayHas(page: Page, x: number, y: number, colour: RGB, reach = 1): Promise<boolean> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py, r, g, b, n]) => {
      const element = document.querySelectorAll('canvas')[1] as HTMLCanvasElement | undefined;
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('overlay canvas not found');
      const ratio = element.width / element.clientWidth;
      const size = Math.round((2 * (n as number) + 1) * ratio);
      const data = ctx.getImageData(Math.round(((px as number) - (n as number)) * ratio), Math.round(((py as number) - (n as number)) * ratio), size, size).data;
      for (let i = 0; i < data.length; i += 4) {
        const near = (channel: number, wanted: number): boolean => Math.abs((data[i + channel] as number) - wanted) < 12;
        if ((data[i + 3] as number) > 200 && near(0, r as number) && near(1, g as number) && near(2, b as number)) return true;
      }
      return false;
    },
    [x, y, ...colour, reach],
  );
}

test('even spacing: a dragged layer takes up the gap of its neighbours, and Alt measures', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  const square = async (x: number, y: number): Promise<void> => {
    await page.keyboard.press('r');
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + x + 60, box.y + y + 60, { steps: 4 });
    await page.mouse.up();
  };

  // Two squares in a row, 40 apart, and a third well away from them.
  await square(100, 200);
  await square(200, 200);
  await square(400, 400);
  await expect(field(page, 'Width')).toHaveValue('60');
  const startX = Number(await field(page, 'X position').inputValue());
  const startY = Number(await field(page, 'Y position').inputValue());

  // Drag the third to three pixels right of the even place beside the pair, and three below their tops.
  await page.mouse.move(box.x + 430, box.y + 430);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 300, { steps: 5 });
  await page.mouse.move(box.x + 333, box.y + 233, { steps: 5 });
  // Held there, both gaps are marked: a bar across each end of the first one, and its size in a label below it.
  expect(await overlayHas(page, 160, 227, GUIDE)).toBe(true);
  expect(await overlayHas(page, 200, 227, GUIDE)).toBe(true);
  expect(await overlayHas(page, 173, 239, GUIDE)).toBe(true);
  // And the second gap, between the pair and the layer being dragged.
  expect(await overlayHas(page, 260, 227, GUIDE)).toBe(true);
  expect(await overlayHas(page, 300, 227, GUIDE)).toBe(true);
  expect(await overlayHas(page, 273, 239, GUIDE)).toBe(true);
  await page.mouse.up();

  // It has snapped: 100 left and 200 up of where it was, not 97 and 197.
  await expect(field(page, 'X position')).toHaveValue(String(startX - 100));
  await expect(field(page, 'Y position')).toHaveValue(String(startY - 200));
  // The marks go when the drag ends.
  expect(await overlayHas(page, 160, 227, GUIDE)).toBe(false);
  expect(await overlayHas(page, 173, 239, GUIDE)).toBe(false);

  // Alt held over the first square measures from the selected one to it: 140 across, drawn between them.
  await page.mouse.move(box.x + 130, box.y + 245);
  expect(await overlayHas(page, 230, 230, GUIDE)).toBe(false);
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + 130, box.y + 246);
  expect(await overlayHas(page, 230, 230, GUIDE)).toBe(true);
  expect(await overlayHas(page, 219, 239, GUIDE)).toBe(true);
  // Letting go of Alt puts it away without the pointer moving, and pressing it again brings it back.
  await page.keyboard.up('Alt');
  expect(await overlayHas(page, 230, 230, GUIDE)).toBe(false);
  await page.keyboard.down('Alt');
  expect(await overlayHas(page, 230, 230, GUIDE)).toBe(true);
  await page.keyboard.up('Alt');

  // Nothing moved while measuring, and one undo puts the dragged layer back.
  await expect(field(page, 'X position')).toHaveValue(String(startX - 100));
  await page.keyboard.press('Control+z');
  await expect(field(page, 'X position')).toHaveValue(String(startX));
  expect(errors).toEqual([]);
});
