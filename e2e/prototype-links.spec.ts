import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Shareable prototype links: a shared file (one on the collaboration server)
 * is presented from the editor; "Copy prototype link" gives an address that
 * opens it in presentation at the frame chosen; someone else, in a browser
 * of their own, opening that link without access is told so (never a blank
 * page), and once the file's link lets anyone view it, sees the presentation
 * at that frame and clicks through an interaction. A file only on this
 * device has no such link: copying one asks for it to be shared first.
 *
 * Each person has a browser context of their own, against the real
 * collaboration server the configuration starts with an empty database.
 */

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const stage = (page: Page): Locator => page.getByRole('application', { name: 'Prototype' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const select = (page: Page, label: string): Locator => page.getByRole('combobox', { name: label, exact: true });
const button = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true });
const screen = (page: Page): Locator => page.getByRole('status', { name: 'Current screen' });
const status = (page: Page): Locator => page.getByRole('navigation', { name: 'Pages and layers' }).getByRole('status');

const PASSWORD = 'a long enough password';
const RUN = Date.now().toString(36);
type RGB = [number, number, number];
const RED: RGB = [255, 0, 0];
const GREEN: RGB = [0, 255, 0];

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

/** The colour of one pixel of the prototype (the only canvas on the presentation's page). */
async function pixel(page: Page, x: number, y: number): Promise<RGB> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(
    ([px, py]) => {
      const data = document.querySelector('canvas')?.getContext('2d')?.getImageData(px as number, py as number, 1, 1).data;
      if (!data) throw new Error('canvas not found');
      return [data[0], data[1], data[2]] as RGB;
    },
    [x, y],
  );
}

interface Person {
  name: string;
  email: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

async function arrive(browser: Browser, name: string): Promise<Person> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return { name, email: `${name.toLowerCase()}-proto-${RUN}@example.com`, context, page, errors };
}

async function signUp(person: Person): Promise<void> {
  const { page } = person;
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sign in' }).getByRole('tab', { name: 'Create account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create an account' });
  await dialog.getByLabel('Name').fill(person.name);
  await dialog.getByLabel('Email').fill(person.email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Account: ${person.name}` })).toBeVisible();
}

/**
 * Two 200 × 200 frames, the second green, and a red button in the first that
 * goes to the second when clicked. Frame 2 starts the flow "Finish", listed
 * first; Frame 1 the flow "Checkout", so a link from Checkout names a frame
 * that is not where the prototype would start on its own.
 */
async function buildPrototype(page: Page): Promise<void> {
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
  await page.getByRole('tab', { name: 'Prototype' }).click();
  await button(page, 'Add interaction').click();
  await select(page, 'Interaction 1 action 1 destination').selectOption({ label: 'Frame 2' });
  await select(page, 'Interaction 1 action 1 transition').selectOption({ label: 'Instant' });
  await layer(page, 'Frame 2').click();
  await button(page, 'Start a flow here').click();
  await set(page, 'Flow name', 'Finish');
  await layer(page, 'Frame 1').click();
  await button(page, 'Start a flow here').click();
  await set(page, 'Flow name', 'Checkout');
  // Nothing selected: the panel shows the page's prototype, with Present, the link and the flows.
  await canvas(page).focus();
  await page.keyboard.press('Escape');
  await expect(button(page, 'Copy prototype link for flow Checkout')).toBeVisible();
}

const people = {} as Record<'ada' | 'gil', Person>;
let docId = '';
let link = '';

test.describe.serial('prototype links', () => {
  test.beforeAll(async ({ browser }) => {
    people.ada = await arrive(browser, 'Ada');
    people.gil = await arrive(browser, 'Gil');
  });

  test.afterAll(async () => {
    for (const person of Object.values(people)) await person.context?.close();
  });

  test('a shared file is presented, and its prototype link is copied at a chosen flow', async () => {
    const { ada } = people;
    await signUp(ada);
    await ada.page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: /^Ada's workspace/ }).click();
    await ada.page.getByRole('button', { name: 'New shared file' }).click();
    await expect(canvas(ada.page)).toBeVisible();
    await expect(status(ada.page)).toHaveText('Synced');
    docId = /#\/doc\/([0-9A-Za-z_-]+)$/.exec(ada.page.url())?.[1] ?? '';
    expect(docId).not.toBe('');
    await buildPrototype(ada.page);

    // Presenting a shared file works: from the first flow, and the button leads on.
    await button(ada.page, 'Present prototype').click();
    await expect(stage(ada.page)).toBeVisible();
    expect(ada.page.url()).toContain(`#/doc/${docId}/present`);
    await select(ada.page, 'Flow').selectOption({ label: 'Checkout' });
    await expect(screen(ada.page)).toHaveText('Frame 1');
    expect(await pixel(ada.page, 50, 40)).toEqual(RED);
    await tap(ada.page, 50, 40);
    await expect(screen(ada.page)).toHaveText('Frame 2');

    // The presentation's own "Copy prototype link" gives the link of the flow showing, and says who it opens for.
    await button(ada.page, 'Copy prototype link').click();
    const card = ada.page.getByRole('status', { name: 'Prototype link' });
    await expect(card).toContainText(`#/doc/${docId}/present/`);
    await expect(card).toContainText('Only people the file is shared with can open it');
    await button(ada.page, 'Back to the editor').click();
    await expect(canvas(ada.page)).toBeVisible();

    // In the Prototype panel, the link of the flow Checkout: it names Frame 1.
    await ada.page.getByRole('tab', { name: 'Prototype' }).click();
    await button(ada.page, 'Copy prototype link for flow Checkout').click();
    const notice = ada.page.getByRole('alert').filter({ hasText: 'prototype link' });
    await expect(notice).toBeVisible();
    link = (await notice.getByRole('listitem').first().textContent()) ?? '';
    expect(link).toMatch(new RegExp(`^http://localhost:\\d+/#/doc/${docId}/present/[0-9A-Za-z]+$`));
  });

  test('someone without access who opens the link is told so, and sees it once the link allows viewing', async () => {
    const { ada, gil } = people;
    // Gil has no account: he is asked for a name, then told he has no access, never shown a blank page.
    await gil.page.goto(link);
    await gil.page.getByRole('textbox', { name: 'Your name' }).fill('Gil');
    await gil.page.getByRole('button', { name: 'Continue as a guest' }).click();
    const refused = gil.page.getByRole('alert', { name: 'Prototype not opened' });
    await expect(refused).toContainText('You do not have access to this prototype');
    await expect(refused).toContainText('Ask the person who sent the link');
    await expect(button(gil.page, 'Sign in')).toBeVisible();

    // Ada lets anyone with the link view the file.
    await button(ada.page, 'Share').click();
    const share = ada.page.getByRole('dialog', { name: 'Share “Untitled”' });
    await share.getByRole('radio', { name: /Anyone with the link can view/ }).click();
    await expect(share.getByRole('radio', { name: /Anyone with the link can view/ })).toHaveAttribute('aria-checked', 'true');
    await share.getByRole('button', { name: 'Close' }).click();

    // Now the link opens for Gil, in presentation, at Frame 1 (the flow Checkout), and the button leads to Frame 2.
    await button(gil.page, 'Try again').click();
    await expect(stage(gil.page)).toBeVisible();
    await expect(screen(gil.page)).toHaveText('Frame 1');
    expect(await pixel(gil.page, 50, 40)).toEqual(RED);
    await tap(gil.page, 50, 40);
    await expect(screen(gil.page)).toHaveText('Frame 2');
    expect(await pixel(gil.page, 50, 40)).toEqual(GREEN);
    await button(gil.page, 'Back').click();
    await expect(screen(gil.page)).toHaveText('Frame 1');

    // The link Gil copies says anyone with it can open it.
    await button(gil.page, 'Copy prototype link').click();
    await expect(gil.page.getByRole('status', { name: 'Prototype link' })).toContainText('Anyone with the link can open it');
    // The only errors were the refused requests before access was given.
    expect(gil.errors.filter((error) => !/status of 403/.test(error))).toEqual([]);
    expect(ada.errors).toEqual([]);
  });

  test('a file on this device asks to be shared before it has a prototype link', async () => {
    const { ada } = people;
    await ada.page.goto('/');
    await ada.page.getByRole('button', { name: 'New design file' }).click();
    await expect(canvas(ada.page)).toBeVisible();
    await canvas(ada.page).focus();
    await ada.page.keyboard.press('f');
    await drag(ada.page, [100, 100], [300, 300]);
    await canvas(ada.page).focus();
    await ada.page.keyboard.press('Escape');

    // From the Prototype panel: the Share dialog opens, saying why.
    await ada.page.getByRole('tab', { name: 'Prototype' }).click();
    await button(ada.page, 'Copy prototype link').click();
    const share = ada.page.getByRole('dialog', { name: 'Share “Untitled”' });
    await expect(share).toContainText('A prototype link only works for other people once the file is shared');
    await share.getByRole('button', { name: 'Close' }).click();

    // From the presentation: the card explains, and "Share this file…" goes back to the editor with Share open.
    await button(ada.page, 'Present prototype').click();
    await expect(stage(ada.page)).toBeVisible();
    await button(ada.page, 'Copy prototype link').click();
    const card = ada.page.getByRole('status', { name: 'Prototype link' });
    await expect(card).toContainText('A prototype link only works for other people once the file is shared');
    await card.getByRole('button', { name: 'Share this file…' }).click();
    await expect(canvas(ada.page)).toBeVisible();
    await expect(ada.page.getByRole('dialog', { name: 'Share “Untitled”' })).toContainText('A prototype link only works for other people once the file is shared');
    expect(ada.page.url()).toMatch(/#\/file\/[0-9A-Za-z]+$/);
    expect(ada.errors).toEqual([]);
  });
});
