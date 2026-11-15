import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Housekeeping in the real browser: side panels resized by their edges and
 * remembered, the light theme, a layers list that only makes the rows in
 * view, and frames that are selected by their rounded corners.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const tree = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });

async function newFile(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  return box;
}

const widthOf = async (locator: Locator): Promise<number> => Math.round((await locator.boundingBox())?.width ?? -1);

test('side panels are resized by their edges and remembered; the light theme is too', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const box = await newFile(page);
  const layersPanel = page.getByRole('navigation', { name: 'Pages and layers' });
  const left = page.getByRole('separator', { name: 'Resize the layers panel' });
  const right = page.getByRole('separator', { name: 'Resize the design panel' });
  await expect(left).toHaveAttribute('aria-valuenow', '240');
  await expect(right).toHaveAttribute('aria-valuenow', '252');
  expect(await widthOf(layersPanel)).toBe(240);

  // Drag the layers panel's edge 60 to the right: the panel is 300 wide and the canvas 60 narrower.
  const edge = await left.boundingBox();
  if (!edge) throw new Error('resizer not visible');
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 300);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 30, edge.y + 300, { steps: 3 });
  await page.mouse.move(edge.x + edge.width / 2 + 60, edge.y + 310, { steps: 3 });
  await page.mouse.up();
  await expect(left).toHaveAttribute('aria-valuenow', '300');
  expect(await widthOf(layersPanel)).toBe(300);
  await expect.poll(() => widthOf(canvas(page))).toBe(Math.round(box.width) - 60);

  // The design panel's edge from the keyboard: the arrow that points at the canvas widens it.
  await right.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(right).toHaveAttribute('aria-valuenow', '268');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(right).toHaveAttribute('aria-valuenow', '316');
  await page.keyboard.press('ArrowRight');
  await expect(right).toHaveAttribute('aria-valuenow', '300');
  await page.keyboard.press('Home');
  await expect(right).toHaveAttribute('aria-valuenow', '180');
  // A double-click puts it back.
  await right.dblclick();
  await expect(right).toHaveAttribute('aria-valuenow', '252');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(right).toHaveAttribute('aria-valuenow', '300');

  // The light theme, from the View menu: the panels turn white and the rulers with them.
  const background = (): Promise<string> => layersPanel.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await background()).toBe('rgb(23, 27, 28)');
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'View' }).click();
  await page.getByRole('menuitemcheckbox', { name: /Light theme/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await background()).toBe('rgb(255, 255, 255)');
  await canvas(page).focus();
  await page.keyboard.press('Shift+r');
  const rulerPixel = (): Promise<number[]> =>
    page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const overlay = document.querySelectorAll('canvas')[1] as HTMLCanvasElement;
      return [...(overlay.getContext('2d') as CanvasRenderingContext2D).getImageData(5, 5, 1, 1).data.slice(0, 3)];
    });
  expect(await rulerPixel()).toEqual([255, 255, 255]);

  // All of it is remembered on this device: after a reload, and on the file browser too.
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(left).toHaveAttribute('aria-valuenow', '300');
  await expect(right).toHaveAttribute('aria-valuenow', '300');
  expect(await widthOf(layersPanel)).toBe(300);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New design file' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(231, 235, 234)');

  // And back to dark.
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'View' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: /Light theme/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemcheckbox', { name: /Light theme/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await layersPanel.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(23, 27, 28)');
  await canvas(page).focus();
  expect(await rulerPixel()).toEqual([23, 27, 28]);
  expect(errors).toEqual([]);
});

test('the layers list makes only the rows in view, however many layers there are', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const box = await newFile(page);

  // One rectangle, duplicated 160 times. Each copy lies 10 further down and right, on top of the last.
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 100, { steps: 3 });
  await page.mouse.up();
  for (let i = 0; i < 160; i++) await page.keyboard.press('Control+d');

  // 161 layers: the list is as long as 161 rows, but far fewer rows exist.
  const rows = tree(page).getByRole('treeitem');
  const scrollHeight = await tree(page).evaluate((element) => element.scrollHeight);
  expect(scrollHeight).toBeGreaterThanOrEqual(161 * 28);
  const made = await rows.count();
  expect(made).toBeGreaterThan(10);
  expect(made).toBeLessThan(80);
  // The newest copy is selected and at the top of the list.
  await expect(tree(page).locator('[aria-selected="true"]')).toBeInViewport();
  expect(await tree(page).evaluate((element) => element.scrollTop)).toBe(0);

  // Scrolled to the end, the rows there exist and the first ones do not; still only a screenful.
  await tree(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(tree(page).locator('[aria-selected="true"]')).toHaveCount(0);
  await expect(rows.last()).toBeInViewport();
  expect(await rows.count()).toBeLessThan(80);

  // Selecting the first rectangle on the canvas (its top-left corner is not covered) shows its row,
  // and selecting the newest scrolls the list back up to its row.
  await tree(page).evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.mouse.click(box.x + 63, box.y + 63);
  await expect(tree(page).locator('[aria-selected="true"]')).toHaveCount(1);
  await expect(tree(page).locator('[aria-selected="true"]')).toBeInViewport();
  expect(await tree(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(100 * 28);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await expect(tree(page).locator('[aria-selected="true"]')).toBeInViewport();
  expect(await tree(page).evaluate((element) => element.scrollTop)).toBe(0);
  expect(errors).toEqual([]);
});

test('copied layers go on the system clipboard and are pasted in another window', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const box = await newFile(page);

  // A red rectangle, 80 by 60, copied with Ctrl+C.
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 160, { steps: 4 });
  await page.mouse.up();
  await field(page, 'Fill 1 colour hex').fill('FF0000');
  await field(page, 'Fill 1 colour hex').press('Enter');
  await canvas(page).focus();
  await page.keyboard.press('Control+c');

  // Another window of the application, with another file: it has only the system clipboard to go by.
  const other = await context.newPage();
  other.on('pageerror', (error) => errors.push(error.message));
  await other.goto('/');
  await other.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(other)).toBeVisible();
  await canvas(other).focus();
  await expect(tree(other).getByRole('treeitem')).toHaveCount(0);
  await other.keyboard.press('Control+v');
  await expect(tree(other).getByRole('treeitem')).toHaveCount(1);
  await expect(tree(other).locator('[aria-selected="true"]')).toHaveCount(1);
  await expect(field(other, 'Width')).toHaveValue('80');
  await expect(field(other, 'Height')).toHaveValue('60');
  await expect(field(other, 'Fill 1 colour hex')).toHaveValue('FF0000');
  // It is an ordinary edit there: undone with one step, pasted again with another.
  await other.keyboard.press('Control+z');
  await expect(tree(other).getByRole('treeitem')).toHaveCount(0);
  await other.keyboard.press('Control+v');
  await expect(tree(other).getByRole('treeitem')).toHaveCount(1);

  // Cut there, pasted back in the first window, beside the original.
  await other.keyboard.press('Control+x');
  await expect(tree(other).getByRole('treeitem')).toHaveCount(0);
  await page.bringToFront();
  await canvas(page).focus();
  await page.keyboard.press('Control+v');
  await expect(tree(page).getByRole('treeitem')).toHaveCount(2);
  await expect(field(page, 'Width')).toHaveValue('80');
  expect(errors).toEqual([]);
});

test('a frame with rounded corners is not selected where its corner is cut away', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const box = await newFile(page);
  await page.keyboard.press('f');
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 400, { steps: 4 });
  await page.mouse.up();
  await field(page, 'Corner radius').fill('80');
  await field(page, 'Corner radius').press('Enter');
  const selected = tree(page).locator('[aria-selected="true"]');
  await expect(selected).toHaveCount(1);

  // A click on empty canvas deselects; a click in the frame's cut-away corner selects nothing either.
  await page.mouse.click(box.x + 600, box.y + 500);
  await expect(selected).toHaveCount(0);
  await page.mouse.click(box.x + 206, box.y + 206);
  await expect(selected).toHaveCount(0);
  await page.mouse.click(box.x + 394, box.y + 394);
  await expect(selected).toHaveCount(0);
  // Inside the curve it is the frame.
  await page.mouse.click(box.x + 230, box.y + 230);
  await expect(selected).toHaveCount(1);
  await expect(field(page, 'Corner radius')).toHaveValue('80');
  expect(errors).toEqual([]);
});
