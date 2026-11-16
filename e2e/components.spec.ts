import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 5, components and instances, in the real browser. What an instance
 * shows is read from the pixels of the design canvas and from the properties
 * panel; a frame is drawn from (100, 100) on the canvas, so a place in it is
 * that much further along on the canvas.
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

async function click(page: Page, at: [number, number], clickCount = 1): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.click(box.x + at[0], box.y + at[1], { clickCount });
}

async function set(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

const number = async (page: Page, label: string): Promise<number> => Number(await field(page, label).inputValue());

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

const WHITE: [number, number, number] = [255, 255, 255];
const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];

test('a component, its instances, overrides that survive, reset, swap and detach', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();

  // A 200 × 100 frame with a red 60 × 40 picture in it becomes a component.
  await page.keyboard.press('f');
  await drag(page, [100, 100], [300, 200]);
  await page.keyboard.press('r');
  await drag(page, [120, 120], [180, 160]);
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await layer(page, 'Frame 1').click();
  await canvas(page).focus();
  await page.keyboard.press('Control+Alt+K');
  await expect(layer(page, 'Component 1')).toHaveAttribute('aria-selected', 'true');
  await expect(section(page, 'Component')).toContainText('0 instances');
  const origin = await number(page, 'X position');

  // An instance of it, placed beside it: it shows the same picture.
  await button(page, 'Create instance').click();
  await expect(section(page, 'Instance')).toBeVisible();
  await expect(select(page, 'Component shown').locator('option:checked')).toHaveText('Component 1');
  expect(await number(page, 'X position')).toBe(origin + 240);
  await expect(field(page, 'Width')).toHaveValue('200');
  // The picture is 20 in from the instance's corner, which is 240 along from the component's.
  const there: [number, number] = [100 + 240 + 50, 140];
  const here: [number, number] = [150, 140];
  expect(await pixel(page, ...there)).toEqual(RED);
  expect(await pixel(page, there[0] + 60, there[1])).toEqual(WHITE);

  // The component's picture turns blue: so does the instance's.
  await click(page, here);
  await expect(layer(page, 'Rectangle 1').last()).toHaveAttribute('aria-selected', 'true');
  await set(page, 'Fill 1 colour hex', '0000FF');
  expect(await pixel(page, ...there)).toEqual(BLUE);

  // A click on the instance picks the instance; a double-click picks the picture inside it, which says where it belongs.
  await click(page, there);
  await expect(section(page, 'Instance')).toBeVisible();
  await click(page, there, 2);
  await expect(page.getByRole('note', { name: 'Part of an instance' })).toContainText('Component 1');
  await expect(field(page, 'X position')).toBeDisabled();
  // Its fill is changed here only.
  await set(page, 'Fill 1 colour hex', '00FF00');
  expect(await pixel(page, ...there)).toEqual(GREEN);
  expect(await pixel(page, ...here)).toEqual(BLUE);

  // The component changes the fill again, and widens the picture: the instance keeps its own fill and takes the width.
  await click(page, here);
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await set(page, 'Width', '100');
  expect(await pixel(page, ...here)).toEqual(RED);
  expect(await pixel(page, ...there)).toEqual(GREEN);
  expect(await pixel(page, there[0] + 60, there[1])).toEqual(GREEN);

  // Reset: the instance is the component again.
  await canvas(page).focus();
  await page.keyboard.press('Escape');
  await click(page, there);
  await expect(section(page, 'Instance')).toBeVisible();
  await expect(button(page, 'Reset instance')).toBeEnabled();
  await button(page, 'Reset instance').click();
  expect(await pixel(page, ...there)).toEqual(RED);
  await expect(button(page, 'Reset instance')).toBeDisabled();
  // Undo brings the override back, in one step.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  expect(await pixel(page, ...there)).toEqual(GREEN);

  // A second, smaller component, blue all over. The instance is made to show that one instead.
  await page.keyboard.press('f');
  await drag(page, [100, 300], [220, 360]);
  await set(page, 'Fill 1 colour hex', '0000FF');
  await canvas(page).focus();
  await page.keyboard.press('Control+Alt+K');
  await expect(layer(page, 'Component 2')).toHaveAttribute('aria-selected', 'true');
  await click(page, there);
  await expect(section(page, 'Instance')).toBeVisible();
  await select(page, 'Component shown').selectOption({ label: 'Component 2' });
  await expect(field(page, 'Width')).toHaveValue('120');
  expect(await pixel(page, ...there)).toEqual(BLUE);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Width')).toHaveValue('200');
  expect(await pixel(page, ...there)).toEqual(GREEN);

  // "Go to component" selects the component the instance shows.
  await button(page, 'Go to component').click();
  await expect(section(page, 'Component')).toContainText('1 instance');
  await field(page, 'Component description').fill('A card with a picture');
  await canvas(page).focus();

  // The components list finds a component by what is typed, and inserts an instance of it.
  const list = page.getByRole('region', { name: 'Components' });
  await expect(list.getByRole('button', { name: /^Go to component / })).toHaveCount(2);
  await field(page, 'Search components').fill('picture');
  await expect(list.getByRole('button', { name: /^Go to component / })).toHaveText(['Component 1']);
  await list.getByRole('button', { name: 'Insert an instance of Component 1' }).click();
  await expect(section(page, 'Instance')).toBeVisible();
  await expect(select(page, 'Component shown').locator('option:checked')).toHaveText('Component 1');
  await canvas(page).focus();
  await page.keyboard.press('Delete');
  await field(page, 'Search components').fill('');

  // Detached, the first instance is an ordinary frame: it keeps its look and no longer follows the component.
  await click(page, there);
  await canvas(page).focus();
  await page.keyboard.press('Control+Alt+B');
  await expect(section(page, 'Instance')).toHaveCount(0);
  expect(await pixel(page, ...there)).toEqual(GREEN);
  await click(page, here);
  await set(page, 'Fill 1 colour hex', '0000FF');
  expect(await pixel(page, ...here)).toEqual(BLUE);
  expect(await pixel(page, ...there)).toEqual(GREEN);
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  // Undone, it is an instance again.
  await click(page, there);
  await expect(section(page, 'Instance')).toBeVisible();

  // Stored: after a reload the instance is still one, with its override, and the component has its description.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  expect(await pixel(page, ...there)).toEqual(GREEN);
  await click(page, there);
  await expect(section(page, 'Instance')).toBeVisible();
  await expect(button(page, 'Reset instance')).toBeEnabled();
  await button(page, 'Go to component').click();
  await expect(field(page, 'Component description')).toHaveValue('A card with a picture');
  expect(errors).toEqual([]);
});

test('a component set: variants chosen on an instance, and a property that hides a layer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
  const checkbox = (name: string): Locator => page.getByRole('checkbox', { name, exact: true });

  // A blue button, 120 × 40, with a red square for an icon, made a component and then a set of one variant.
  await page.keyboard.press('f');
  await drag(page, [100, 100], [220, 140]);
  await set(page, 'Fill 1 colour hex', '0000FF');
  const fx = await number(page, 'X position');
  const fy = await number(page, 'Y position');
  /** Where a point of the page is on the canvas: the frame's corner was drawn at (100, 100). */
  const onCanvas = (x: number, y: number): [number, number] => [100 + x - fx, 100 + y - fy];
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [108, 112], [124, 128]);
  await set(page, 'Fill 1 colour hex', 'FF0000');
  await layer(page, 'Frame 1').click();
  await canvas(page).focus();
  await page.keyboard.press('Control+Alt+K');
  await button(page, 'Combine as variants').click();
  await expect(section(page, 'Component set')).toBeVisible();

  // Its one property is named "State", and a second variant is added: a copy, under the first, which is made green.
  await field(page, 'Name of variant property Property 1').fill('State');
  await field(page, 'Name of variant property Property 1').press('Enter');
  await expect(layer(page, 'State=Default')).toBeVisible();
  await button(page, 'Add variant').click();
  await expect(section(page, 'Component')).toBeVisible();
  await expect(field(page, 'Value of State')).toHaveValue('Variant 2');
  await field(page, 'Value of State').fill('Hover');
  await field(page, 'Value of State').press('Enter');
  await expect(layer(page, 'State=Hover')).toHaveAttribute('aria-selected', 'true');
  await set(page, 'Fill 1 colour hex', '00FF00');
  // The copy is 60 further down the canvas.
  expect(await pixel(page, 200, 180)).toEqual(GREEN);
  expect(await pixel(page, 200, 120)).toEqual(BLUE);

  // A property of the set, for all its variants: whether the icon shows. The icon of each variant is bound to it.
  await layer(page, 'Component 1').click();
  await button(page, 'Add boolean property').click();
  await field(page, 'Name of property Show').fill('Show icon');
  await field(page, 'Name of property Show').press('Enter');
  for (const y of [120, 180]) {
    await click(page, [116, y], 2);
    await expect(section(page, 'Component properties')).toBeVisible();
    await select(page, 'Visibility property').selectOption({ label: 'Show icon' });
  }

  // An instance of the first variant, from the Components list.
  await page.getByRole('region', { name: 'Components' }).getByRole('button', { name: 'Insert an instance of Component 1/State=Default' }).click();
  await expect(section(page, 'Instance')).toBeVisible();
  await expect(layer(page, 'Component 1').first()).toHaveAttribute('aria-selected', 'true');
  const [ix, iy] = onCanvas(await number(page, 'X position'), await number(page, 'Y position'));
  const body: [number, number] = [ix + 90, iy + 20];
  const icon: [number, number] = [ix + 16, iy + 20];
  expect(await pixel(page, ...body)).toEqual(BLUE);
  expect(await pixel(page, ...icon)).toEqual(RED);
  await expect(select(page, 'Variant State').locator('option')).toHaveText(['Default', 'Hover']);
  await expect(select(page, 'Variant State')).toHaveValue('Default');
  await expect(checkbox('Property Show icon')).toBeChecked();

  // The other variant is chosen: the instance turns green.
  await select(page, 'Variant State').selectOption('Hover');
  expect(await pixel(page, ...body)).toEqual(GREEN);
  expect(await pixel(page, ...icon)).toEqual(RED);
  // The icon is switched off by the property, and stays off when the variant is changed back.
  await checkbox('Property Show icon').uncheck();
  expect(await pixel(page, ...icon)).toEqual(GREEN);
  await select(page, 'Variant State').selectOption('Default');
  expect(await pixel(page, ...body)).toEqual(BLUE);
  expect(await pixel(page, ...icon)).toEqual(BLUE);
  await expect(checkbox('Property Show icon')).not.toBeChecked();
  // The variants themselves still show their icons.
  expect(await pixel(page, 116, 120)).toEqual(RED);
  // One undo step for the variant, one for the property.
  await canvas(page).focus();
  await page.keyboard.press('Control+z');
  expect(await pixel(page, ...body)).toEqual(GREEN);
  await page.keyboard.press('Control+Shift+z');

  // Stored: after a reload the instance is the Default variant without its icon; reset brings the icon back.
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(canvas(page)).toBeVisible();
  expect(await pixel(page, ...icon)).toEqual(BLUE);
  await click(page, body);
  await expect(select(page, 'Variant State')).toHaveValue('Default');
  await expect(checkbox('Property Show icon')).not.toBeChecked();
  await button(page, 'Reset instance').click();
  expect(await pixel(page, ...icon)).toEqual(RED);
  await expect(checkbox('Property Show icon')).toBeChecked();
  expect(errors).toEqual([]);
});
