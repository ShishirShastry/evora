import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The colour picker in the real browser: numbers for red, green and blue and
 * for hue, saturation and lightness, the square and the hue strip dragged
 * with the mouse, each checked on the canvas's pixels.
 */

type RGB = [number, number, number];

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const picker = (page: Page): Locator => page.getByRole('dialog', { name: 'Fill 1 colour picker' });

async function set(scope: Page | Locator, label: string, value: string): Promise<void> {
  const input = scope.getByRole('textbox', { name: label, exact: true });
  await input.fill(value);
  await input.press('Enter');
}

async function pixel(page: Page, x: number, y: number): Promise<RGB> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const element = document.querySelector('canvas');
      const ctx = element?.getContext('2d');
      if (!element || !ctx) throw new Error('design canvas not found');
      const ratio = element.width / element.clientWidth;
      const data = ctx.getImageData(Math.round((px as number) * ratio), Math.round((py as number) * ratio), 1, 1).data;
      return [data[0], data[1], data[2]] as [number, number, number];
    },
    [x, y],
  );
}

function expectNear(actual: RGB, expected: RGB, tolerance = 4): void {
  const ok = actual.every((channel, i) => Math.abs(channel - (expected[i] as number)) <= tolerance);
  expect(ok, `expected about rgb(${expected.join(', ')}), got rgb(${actual.join(', ')})`).toBe(true);
}

test('colour picker: numbers, the square and the hue strip', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
  await page.keyboard.press('r');
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 400, { steps: 5 });
  await page.mouse.up();
  expectNear(await pixel(page, 300, 300), [217, 217, 217]);

  // The swatch opens the picker, which starts on the fill's colour.
  await page.getByRole('button', { name: 'Fill 1 colour picker' }).click();
  await expect(picker(page)).toBeVisible();
  await expect(field(page, 'Red')).toHaveValue('217');
  await expect(field(page, 'Lightness')).toHaveValue('85');

  // Red, green and blue as numbers.
  await set(picker(page), 'Red', '255');
  await set(picker(page), 'Green', '0');
  await set(picker(page), 'Blue', '0');
  expectNear(await pixel(page, 300, 300), [255, 0, 0]);
  await expect(field(page, 'Fill 1 colour hex')).toHaveValue('FF0000');
  await expect(field(page, 'Hex colour')).toHaveValue('FF0000');

  // Hue, saturation and lightness as numbers: a third of the way round is green.
  await set(picker(page), 'Hue', '120');
  expectNear(await pixel(page, 300, 300), [0, 255, 0]);
  await set(picker(page), 'Lightness', '25');
  expectNear(await pixel(page, 300, 300), [0, 128, 0]);
  await set(picker(page), 'Lightness', '50');

  // The middle of the square is half saturated and half bright.
  const square = await picker(page).getByRole('slider', { name: 'Saturation and brightness' }).boundingBox();
  if (!square) throw new Error('square not visible');
  await page.mouse.move(square.x + square.width - 2, square.y + 2);
  await page.mouse.down();
  await page.mouse.move(square.x + square.width * 0.75, square.y + square.height * 0.25, { steps: 4 });
  // While it is dragged the canvas follows.
  expectNear(await pixel(page, 300, 300), [48, 191, 48], 6);
  await page.mouse.move(square.x + square.width * 0.5, square.y + square.height * 0.5, { steps: 4 });
  await page.mouse.up();
  expectNear(await pixel(page, 300, 300), [64, 128, 64], 6);
  await expect(field(page, 'Hue')).toHaveValue('120');

  // The hue strip: two thirds of the way along is blue, at the same saturation and brightness.
  const strip = await picker(page).getByRole('slider', { name: 'Hue' }).boundingBox();
  if (!strip) throw new Error('hue strip not visible');
  await page.mouse.click(strip.x + (strip.width * 2) / 3, strip.y + strip.height / 2);
  expectNear(await pixel(page, 300, 300), [64, 64, 128], 6);

  // A HEX value typed into the picker.
  await set(picker(page), 'Hex colour', '19C2B3');
  expectNear(await pixel(page, 300, 300), [25, 194, 179]);
  await expect(field(page, 'Red')).toHaveValue('25');

  // Escape closes it. The whole drag across the square was one undo step.
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  expectNear(await pixel(page, 300, 300), [64, 64, 128], 6);
  await page.keyboard.press('Control+z');
  expectNear(await pixel(page, 300, 300), [64, 128, 64], 6);
  await page.keyboard.press('Control+z');
  expectNear(await pixel(page, 300, 300), [0, 255, 0]);

  // Pressing anywhere else closes it too.
  await page.getByRole('button', { name: 'Fill 1 colour picker' }).click();
  await expect(picker(page)).toBeVisible();
  await page.mouse.click(box.x + 60, box.y + 60);
  await expect(picker(page)).toHaveCount(0);

  expect(errors).toEqual([]);
});
