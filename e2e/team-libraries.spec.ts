import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Team libraries, in the real browser against the real collaboration server:
 * two people in one workspace, each in a browser context of their own. Alex
 * publishes a shared file with a component whose fill is a colour style; Sam
 * opens a file on his own device, adds Alex's library from the Libraries
 * dialog's "Team libraries" and places the component; Alex changes the colour
 * and publishes again; Sam is told "Library updates available", accepts, and
 * the instance shows the new colour. What the instance shows is read from the
 * pixels of Sam's design canvas.
 */

type RGB = [number, number, number];
const RED: RGB = [255, 0, 0];
const GREEN: RGB = [0, 255, 0];

const PASSWORD = 'a long enough password';
/** Addresses of their own for each run, so the test can also run against a server that has seen them before. */
const RUN = Date.now().toString(36);

interface Person {
  name: string;
  email: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const section = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });
const libraries = (page: Page): Locator => page.getByRole('dialog', { name: 'Libraries' });
/** The connection's state in the file's header ("Synced"…). */
const status = (page: Page): Locator => page.getByRole('navigation', { name: 'Pages and layers' }).getByRole('status');

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

async function pixel(page: Page, x: number, y: number): Promise<RGB> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const ctx = document.querySelector('canvas')?.getContext('2d');
      if (!ctx) throw new Error('design canvas not found');
      const data = ctx.getImageData(Math.round(px as number), Math.round(py as number), 1, 1).data;
      return [data[0], data[1], data[2]] as RGB;
    },
    [x, y],
  );
}

async function menu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

async function rename(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /^File name:/ }).click();
  await field(page, 'File name').fill(name);
  await field(page, 'File name').press('Enter');
  await expect(page.getByRole('button', { name: new RegExp(`^File name: ${name}`) })).toBeVisible();
}

const closeLibraries = (page: Page): Promise<void> => libraries(page).getByRole('button', { name: 'Close', exact: true }).click();

async function arrive(browser: Browser, name: string): Promise<Person> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return { name, email: `${name.toLowerCase()}-${RUN}@example.com`, context, page, errors };
}

/** Creates an account from the file browser's "Sign in" button. */
async function signUp(person: Person): Promise<void> {
  const { page } = person;
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Sign in' });
  await signIn.getByRole('tab', { name: 'Create account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create an account' });
  await dialog.getByLabel('Name').fill(person.name);
  await dialog.getByLabel('Email').fill(person.email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Account: ${person.name}` })).toBeVisible();
}

const workspaceEntry = (page: Page, name: string): Locator => page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: new RegExp(`^${name}`) });

test('a team library: published in a shared file, added to a file on another person’s device, and updated there', async ({ browser }) => {
  test.setTimeout(120_000);
  const alex = await arrive(browser, 'Alex');
  const sam = await arrive(browser, 'Sam');
  try {
    await signUp(alex);
    await signUp(sam);

    // Alex invites Sam into his workspace, as an editor.
    await workspaceEntry(alex.page, "Alex's workspace").click();
    await alex.page.getByRole('button', { name: 'Members', exact: true }).click();
    const members = alex.page.getByRole('dialog', { name: "Members of Alex's workspace" });
    await members.getByRole('textbox', { name: 'Email address to invite' }).fill(sam.email);
    await members.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(members.getByRole('list', { name: 'People with access' })).toContainText('Sam');
    await members.getByRole('button', { name: 'Close' }).click();

    // Alex makes a shared file "Kit": a red component whose fill is a colour style, and publishes it.
    const a = alex.page;
    await a.getByRole('button', { name: 'New shared file' }).click();
    await expect(canvas(a)).toBeVisible();
    await expect(status(a)).toHaveText('Synced');
    await rename(a, 'Kit');
    await canvas(a).focus();
    await a.keyboard.press('f');
    await drag(a, [100, 100], [300, 200]);
    await set(a, 'Fill 1 colour hex', 'FF0000');
    await a.getByRole('combobox', { name: 'Fill style' }).selectOption({ label: 'New style from this layer' });
    await expect(a.getByRole('combobox', { name: 'Fill style' })).toContainText('Colour style');
    await canvas(a).focus();
    await a.keyboard.press('Control+Alt+K');
    await expect(section(a, 'Component')).toBeVisible();
    await menu(a, 'Libraries…');
    await expect(libraries(a)).toContainText('This file has 1 component, 1 style, 0 variables.');
    await libraries(a).getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(libraries(a).getByRole('status', { name: 'Publishing status' })).toContainText('Published as version 1');
    await closeLibraries(a);
    await expect(status(a)).toHaveText('Synced');

    // Sam opens a file on his own device and adds Alex's library from "Team libraries".
    const s = sam.page;
    await s.goto('/');
    await s.getByRole('button', { name: 'New design file' }).click();
    await expect(canvas(s)).toBeVisible();
    await rename(s, 'Screens');
    await menu(s, 'Libraries…');
    const group = libraries(s).getByRole('group', { name: "Alex's workspace" });
    await expect(group).toContainText('Kit');
    await expect(group).toContainText('1 component, 1 style, 0 variables. Version 1.');
    await group.getByRole('button', { name: 'Add Kit', exact: true }).click();
    await expect(section(s, 'Libraries used in this file')).toContainText('Version 1. Up to date.');
    await closeLibraries(s);

    // A rectangle from (100, 100) on the canvas tells where the page is on it; then the component is placed.
    await canvas(s).focus();
    await s.keyboard.press('r');
    await drag(s, [100, 100], [120, 120]);
    const originX = 100 - (await number(s, 'X position'));
    const originY = 100 - (await number(s, 'Y position'));
    await s.getByRole('region', { name: 'Components' }).getByRole('button', { name: 'Insert an instance of Kit/Component 1' }).click();
    await expect(section(s, 'Instance')).toBeVisible();
    const inside: [number, number] = [originX + (await number(s, 'X position')) + 150, originY + (await number(s, 'Y position')) + 80];
    expect(await pixel(s, ...inside)).toEqual(RED);

    // Alex changes the style's colour and publishes again.
    await click(a, [600, 450]);
    await expect(section(a, 'Local styles')).toBeVisible();
    await set(a, 'Colour of style Colour style hex', '00FF00');
    await menu(a, 'Libraries…');
    await expect(libraries(a).getByRole('status', { name: 'Publishing status' })).toContainText('with changes since that are not published');
    await libraries(a).getByRole('button', { name: 'Publish changes', exact: true }).click();
    await expect(libraries(a).getByRole('status', { name: 'Publishing status' })).toContainText('Published as version 2');
    await closeLibraries(a);
    await expect(status(a)).toHaveText('Synced');

    // Sam opens Libraries, which looks again: "Library updates available", in the dialog and above his canvas.
    await menu(s, 'Libraries…');
    await expect(libraries(s).getByRole('region', { name: 'Library updates available' })).toContainText('Kit: version 1 → 2');
    await closeLibraries(s);
    const notice = section(s, 'Library updates available');
    await expect(notice).toContainText('Kit: version 1 → 2');
    expect(await pixel(s, ...inside)).toEqual(RED);
    await notice.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect.poll(() => pixel(s, ...inside)).toEqual(GREEN);

    // One undo step goes back to the old version.
    await canvas(s).focus();
    await s.keyboard.press('Control+z');
    expect(await pixel(s, ...inside)).toEqual(RED);
    await s.keyboard.press('Control+Shift+z');
    expect(await pixel(s, ...inside)).toEqual(GREEN);

    expect(alex.errors).toEqual([]);
    expect(sam.errors).toEqual([]);
  } finally {
    await alex.context.close();
    await sam.context.close();
  }
});
