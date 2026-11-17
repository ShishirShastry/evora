import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Phase 9 acceptance criterion: "External developers can extend Evora and
 * users can manage complex collaborative projects". In the real browser,
 * against the real collaboration server:
 *   - version history of a file on this device: a named version, changes,
 *     the old version viewed, compared and restored (one undo step);
 *   - branching of a shared file by two people: a branch made, edited and
 *     merged into main with a conflict resolved, seen live by the other, and
 *     the merge rolled back by restoring "Before merging";
 *   - plugins: one installed from its .evora-plugin file after the
 *     permission prompt, run as one undo step, one without 'write' refused,
 *     and the example widget placed and clicked, its state reaching both
 *     people on a shared file;
 *   - the community: a shared file published as a template, found by a second
 *     person by search and duplicated into their workspace, images and all;
 *   - file management: a project, a file moved into it, a favourite, the
 *     trash and a restore from it.
 * Everything is done through the interface with real mouse and keyboard input.
 */

type RGB = [number, number, number];
const RED: RGB = [255, 0, 0];

/** Encodes an RGB image as a PNG file (as in images.spec.ts). */
function png(width: number, height: number, colourAt: (x: number, y: number) => RGB): Buffer {
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set([...colourAt(x, y), 255], y * row + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PASSWORD = 'a long enough password';
const RUN = Date.now().toString(36);

interface Person {
  name: string;
  email: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
const status = (page: Page): Locator => page.getByRole('navigation', { name: 'Pages and layers' }).getByRole('status');

async function drag(page: Page, from: [number, number], to: [number, number], steps = 6): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps });
  await page.mouse.up();
}

async function setField(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

const numberIn = async (page: Page, label: string): Promise<number> => Number(await field(page, label).inputValue());

/** Opens Main menu ▸ `group` ▸ `item` (the item's name may be a pattern). */
async function menu(page: Page, group: string, item: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: group, exact: true }).click();
  await page.getByRole('menu', { name: group, exact: true }).getByRole(/^Show /.test(String(item)) ? 'menuitemcheckbox' : 'menuitem', { name: item }).first().click();
}

async function placeImage(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await menu(page, 'File', /Place image/);
  await (await chooser).setFiles(file);
}

async function rename(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /^File name:/ }).click();
  await field(page, 'File name').fill(name);
  await field(page, 'File name').press('Enter');
  await expect(page.getByRole('button', { name: new RegExp(`^File name: ${name}`) })).toBeVisible();
}

async function arrive(browser: Browser, name: string): Promise<Person> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return { name, email: `${name.toLowerCase()}-${RUN}@example.test`, context, page, errors };
}

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

async function layerNames(page: Page): Promise<string[]> {
  return layers(page).getByRole('treeitem').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? ''));
}

/** The version history panel. */
const history = (page: Page): Locator => page.getByRole('complementary', { name: 'Version history' });

/** Saves a named version through Main menu ▸ Version history ▸ Save to version history…. */
async function saveVersion(page: Page, name: string): Promise<void> {
  await menu(page, 'Version history', /Save to version history/);
  const dialog = page.getByRole('dialog', { name: 'Save to version history' });
  await dialog.getByLabel('Title').fill(name);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('version history of a file on this device', () => {
  test('a named version is saved, viewed, compared and restored in one undo step', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: 'New design file' }).click();
    await expect(canvas(page)).toBeVisible();
    await rename(page, 'History');

    // A rectangle at x 0, saved as "First draft".
    await canvas(page).focus();
    await page.keyboard.press('r');
    await drag(page, [100, 100], [260, 200]);
    await expect(layer(page, 'Rectangle 1')).toBeVisible();
    await setField(page, 'X position', '0');
    await saveVersion(page, 'First draft');

    // Changes after it: the rectangle moves and an ellipse is added.
    await setField(page, 'X position', '300');
    await canvas(page).focus();
    await page.keyboard.press('o');
    await drag(page, [500, 400], [600, 480]);
    await expect(layer(page, 'Ellipse 1')).toBeVisible();

    // The history, opened from the file's header, lists it; clicking it shows it read-only.
    await page.getByRole('button', { name: 'Show version history' }).click();
    const panel = history(page);
    await expect(panel).toBeVisible();
    await panel.getByRole('list', { name: 'Versions' }).getByRole('button', { name: /^First draft/ }).click();
    const viewer = page.getByRole('dialog', { name: 'Viewing First draft' });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Restore this version' })).toBeVisible();
    await viewer.getByRole('button', { name: 'Back to current' }).click();
    await expect(viewer).toHaveCount(0);

    // Compared with the current file: the rectangle changed, the ellipse was added.
    await panel.getByRole('button', { name: 'More actions for First draft' }).click();
    await page.getByRole('menuitem', { name: 'Compare with current' }).click();
    const compare = page.getByRole('dialog', { name: 'Compare versions' });
    await expect(compare).toBeVisible();
    const differences = compare.getByRole('list', { name: 'Differences' });
    await expect(differences.getByRole('button', { name: /Changed\s*Rectangle 1/ })).toBeVisible();
    await expect(differences.getByRole('button', { name: /Added\s*Ellipse 1/ })).toBeVisible();
    await compare.getByRole('tab', { name: 'Overlay' }).click();
    await expect(compare.getByRole('slider', { name: 'Show the newer side' })).toBeVisible();
    await compare.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(compare).toHaveCount(0);

    // Restored: the ellipse is gone and the rectangle is back at 0.
    await panel.getByRole('button', { name: 'More actions for First draft' }).click();
    await page.getByRole('menuitem', { name: 'Restore this version' }).click();
    await expect(layer(page, 'Ellipse 1')).toHaveCount(0);
    expect(await layerNames(page)).toEqual(['Rectangle 1']);
    await layer(page, 'Rectangle 1').click();
    await expect(field(page, 'X position')).toHaveValue('0');
    // The restore kept "Before restoring …" first.
    await expect(panel.getByRole('list', { name: 'Versions' })).toContainText('Before restoring');

    // One undo brings the changes back.
    await canvas(page).focus();
    await page.keyboard.press('Control+z');
    await expect(layer(page, 'Ellipse 1')).toBeVisible();
    await layer(page, 'Rectangle 1').click();
    await expect(field(page, 'X position')).toHaveValue('300');
    expect(errors).toEqual([]);
  });
});

/** An example plugin's installable file, as the file chooser gets it. */
function example(name: string): { name: string; mimeType: string; buffer: Buffer } {
  return { name: `${name}.evora-plugin`, mimeType: 'application/json', buffer: readFileSync(`plugins/examples/${name}.evora-plugin`) };
}

/** A plugin that may only read, which tries to rename the selected layer and says what it was told. */
const READ_ONLY_PLUGIN = {
  name: 'peek.evora-plugin',
  mimeType: 'application/json',
  buffer: Buffer.from(
    JSON.stringify({
      format: 'evora-plugin',
      formatVersion: 1,
      manifest: { id: 'test.peek', name: 'Peek', version: '1.0.0', description: 'Reads the selection, and tries to rename it.', author: 'Tests', kind: 'plugin', api: 1, permissions: ['read'], commands: [{ id: 'run', name: 'Peek' }], main: 'main.js' },
      code: [
        'const [first] = await evora.getSelection();',
        'try {',
        "  await evora.setProperties(first.id, { name: 'Renamed by Peek' });",
        "  evora.closePlugin('Renamed.');",
        '} catch (error) {',
        '  evora.notify(error.message, { error: true });',
        '  evora.closePlugin();',
        '}',
      ].join('\n'),
      ui: null,
    }),
  ),
};

/** Installs a plugin from its file through Plugins ▸ Manage plugins… ▸ Install from file…, agreeing to what it asks for. */
async function installPlugin(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, kind: 'plugin' | 'widget', permissions: RegExp[]): Promise<void> {
  await menu(page, 'Plugins', 'Manage plugins…');
  const manager = page.getByRole('dialog', { name: 'Plugins and widgets' });
  const chooser = page.waitForEvent('filechooser');
  await manager.getByRole('button', { name: 'Install from file…' }).click();
  await (await chooser).setFiles(file);
  const prompt = page.getByRole('dialog', { name: `Install ${kind}` });
  const asks = prompt.getByRole('region', { name: 'Permissions' });
  for (const permission of permissions) await expect(asks).toContainText(permission);
  await prompt.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await manager.getByRole('button', { name: 'Close' }).click();
  await expect(manager).toHaveCount(0);
}


/** The middle of the Counter widget's + button, from the widget's top left: 10 + 32 + 10 + 48 + 10 + 16 across, halfway down its 48. */
const ADD_ONE = { x: 126, y: 24, width: 152, height: 48 };

/** Clicks a point of a widget with the Move tool: the view is zoomed to the widget first, so where it is on the screen is known. */
async function clickWidget(page: Page, name: string, at: { x: number; y: number; width: number; height: number }): Promise<void> {
  await layer(page, name).click();
  await canvas(page).focus();
  await page.keyboard.press('Shift+2');
  const zoom = Number(await field(page, 'Zoom percentage').inputValue()) / 100;
  await page.keyboard.press('Escape');
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.click(box.x + box.width / 2 + (at.x - at.width / 2) * zoom, box.y + box.height / 2 + (at.y - at.height / 2) * zoom);
}

/** The colour of one pixel of the design canvas, once it has been drawn. */
async function pixel(page: Page, at: [number, number]): Promise<RGB> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(([x, y]) => {
    const data = document.querySelector('canvas')?.getContext('2d')?.getImageData(x as number, y as number, 1, 1).data;
    if (!data) throw new Error('design canvas not found');
    return [data[0], data[1], data[2]] as RGB;
  }, at);
}

/** The colour in the middle of a layer, with the view zoomed to it. */
async function colourOf(page: Page, name: string): Promise<RGB> {
  await layer(page, name).click();
  await canvas(page).focus();
  await page.keyboard.press('Shift+2');
  await page.keyboard.press('Escape');
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  return pixel(page, [Math.floor(box.width / 2), Math.floor(box.height / 2)]);
}

/** A file's "More actions" menu in the file browser. */
async function fileAction(page: Page, file: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `More actions for ${file}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

const people = {} as Record<'ada' | 'ben', Person>;
/** The shared file's address, `/#/doc/<id>`. */
let mainUrl = '';
/** Errors a test expects a person's browser to log. */
const expected = new Map<Person, RegExp[]>();

test.describe.serial('two people on the collaboration server', () => {
  test.beforeAll(async ({ browser }) => {
    people.ada = await arrive(browser, 'Ada');
    people.ben = await arrive(browser, 'Ben');
  });

  test.afterEach(async () => {
    for (const person of Object.values(people)) {
      const allowed = expected.get(person) ?? [];
      expect(person.errors.filter((error) => !allowed.some((pattern) => pattern.test(error)))).toEqual([]);
      person.errors.length = 0;
    }
    expected.clear();
  });

  test.afterAll(async () => {
    for (const person of Object.values(people)) await person.context?.close();
  });

  test('a branch is made, edited, merged into main with a conflict resolved, seen live, and rolled back', async () => {
    const { ada, ben } = people;
    await signUp(ada);
    await signUp(ben);

    // Ada invites Ben to her workspace as an editor and makes a shared file with a rectangle.
    await workspaceEntry(ada.page, "Ada's workspace").click();
    await ada.page.getByRole('button', { name: 'Members', exact: true }).click();
    const members = ada.page.getByRole('dialog', { name: "Members of Ada's workspace" });
    await members.getByRole('textbox', { name: 'Email address to invite' }).fill(ben.email);
    await members.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(members.getByRole('list', { name: 'People with access' })).toContainText('Ben');
    await members.getByRole('button', { name: 'Close' }).click();
    await ada.page.getByRole('button', { name: 'New shared file' }).click();
    await expect(status(ada.page)).toHaveText('Synced');
    mainUrl = `/${new URL(ada.page.url()).hash}`;
    await rename(ada.page, 'Checkout');
    await canvas(ada.page).focus();
    await ada.page.keyboard.press('r');
    await drag(ada.page, [100, 100], [260, 200]);
    await setField(ada.page, 'X position', '0');
    await expect(status(ada.page)).toHaveText('Synced');

    await ben.page.goto(mainUrl);
    await expect(status(ben.page)).toHaveText('Synced');
    await expect(layer(ben.page, 'Rectangle 1')).toBeVisible();

    // Ada makes a branch; it opens, marked as a branch of "Checkout".
    await menu(ada.page, 'Version history', 'Create branch…');
    const create = ada.page.getByRole('dialog', { name: 'Create branch' });
    await create.getByLabel('Branch name').fill('Bigger');
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    const banner = ada.page.getByRole('region', { name: 'Branch' });
    await expect(banner).toContainText('Branch of Checkout');
    expect(`/${new URL(ada.page.url()).hash}`).not.toBe(mainUrl);
    await expect(status(ada.page)).toHaveText('Synced');
    await expect(layer(ada.page, 'Rectangle 1')).toBeVisible();

    // On the branch she moves the rectangle and adds an ellipse; meanwhile Ben moves the same rectangle on main.
    await layer(ada.page, 'Rectangle 1').click();
    await setField(ada.page, 'X position', '200');
    await canvas(ada.page).focus();
    await ada.page.keyboard.press('o');
    await drag(ada.page, [500, 400], [600, 480]);
    await expect(layer(ada.page, 'Ellipse 1')).toBeVisible();
    await expect(status(ada.page)).toHaveText('Synced');
    await layer(ben.page, 'Rectangle 1').click();
    await setField(ben.page, 'X position', '-200');
    await expect(status(ben.page)).toHaveText('Synced');
    // The branch is apart: main has no ellipse.
    await expect(layer(ben.page, 'Ellipse 1')).toHaveCount(0);

    // Ada merges: the rectangle is a conflict, and she takes the branch's.
    await banner.getByRole('button', { name: 'Merge into main' }).click();
    const merge = ada.page.getByRole('dialog', { name: 'Merge “Bigger” into main' });
    const conflicts = merge.getByRole('region', { name: 'Conflicts to resolve' });
    await expect(conflicts).toContainText('Rectangle 1');
    await expect(merge.getByRole('button', { name: 'Merge branch' })).toBeDisabled();
    await conflicts.getByRole('radiogroup', { name: 'Keep for Rectangle 1' }).getByRole('radio', { name: 'Take branch' }).click();
    await merge.getByRole('button', { name: 'Merge branch' }).click();
    await expect(merge.getByRole('status')).toContainText('Merged into “Checkout”');

    // Ben sees the merge arrive live on main.
    await expect(layer(ben.page, 'Ellipse 1')).toBeVisible();
    await layer(ben.page, 'Rectangle 1').click();
    await expect(field(ben.page, 'X position')).toHaveValue('200');

    // Ada opens main from the dialog: the same.
    await merge.getByRole('button', { name: 'Open main file' }).click();
    await expect.poll(() => `/${new URL(ada.page.url()).hash}`).toBe(mainUrl);
    await expect(status(ada.page)).toHaveText('Synced');
    await expect(layer(ada.page, 'Ellipse 1')).toBeVisible();

    // Ben rolls the merge back by restoring "Before merging": both see main as it was.
    await menu(ben.page, 'Version history', 'Show version history');
    const panel = history(ben.page);
    const versions = panel.getByRole('list', { name: 'Versions' });
    await expect(versions.getByRole('button', { name: /^Merged Bigger/ })).toBeVisible();
    await versions.getByRole('button', { name: /^More actions for Before merging/ }).click();
    await ben.page.getByRole('menuitem', { name: 'Restore this version' }).click();
    for (const person of [ben, ada]) {
      await expect(layer(person.page, 'Ellipse 1')).toHaveCount(0);
      await layer(person.page, 'Rectangle 1').click();
      await expect(field(person.page, 'X position')).toHaveValue('-200');
    }
    await panel.getByRole('button', { name: 'Close version history' }).click();
  });

  test('a plugin is installed from its file, runs as one undo step, a plugin without "write" is refused, and a widget is shared', async () => {
    const { ada, ben } = people;
    // Ada installs Tidy up: the prompt says what it may do.
    await installPlugin(ada.page, example('tidy-up'), 'plugin', [/Read the current file/, /Change the current file/]);
    await expect(ada.page.getByRole('status').filter({ hasText: 'Installed Tidy up 1.0.0.' })).toBeVisible();

    // The rectangle off the 8 px grid; Tidy up ▸ Snap puts it on, for both, as one undo step.
    await layer(ada.page, 'Rectangle 1').click();
    await setField(ada.page, 'X position', '-197');
    await expect(status(ada.page)).toHaveText('Synced');
    await menu(ada.page, 'Plugins', 'Tidy up');
    await ada.page.getByRole('menu', { name: 'Tidy up' }).getByRole('menuitem', { name: 'Snap to the 8 px grid' }).click();
    await expect(ada.page.getByRole('status').filter({ hasText: 'Snapped 1 layer to the 8 px grid.' })).toBeVisible();
    await expect(field(ada.page, 'X position')).toHaveValue('-200');
    await layer(ben.page, 'Rectangle 1').click();
    await expect(field(ben.page, 'X position')).toHaveValue('-200');
    await canvas(ada.page).focus();
    await ada.page.keyboard.press('Control+z');
    await expect(field(ada.page, 'X position')).toHaveValue('-197');
    await expect(field(ben.page, 'X position')).toHaveValue('-197');

    // A plugin that may only read is refused when it tries to change the file.
    await installPlugin(ada.page, READ_ONLY_PLUGIN, 'plugin', [/Read the current file/]);
    await layer(ada.page, 'Rectangle 1').click();
    await menu(ada.page, 'Plugins', 'Peek');
    await expect(ada.page.getByRole('alert').filter({ hasText: 'Peek does not have the "write" permission' })).toBeVisible();
    await expect(layer(ada.page, 'Rectangle 1')).toBeVisible();
    await expect(layer(ada.page, 'Renamed by Peek')).toHaveCount(0);

    // Both install Vote counter; Ada places a Counter, and each clicks its +: both see the count go up.
    await installPlugin(ada.page, example('vote-counter'), 'widget', [/no permissions/i]);
    await installPlugin(ben.page, example('vote-counter'), 'widget', [/no permissions/i]);
    await canvas(ada.page).focus();
    await ada.page.keyboard.press('Escape');
    await menu(ada.page, 'Plugins', 'Widgets');
    await ada.page.getByRole('menu', { name: 'Widgets' }).getByRole('menuitem', { name: 'Counter' }).click();
    await expect(layer(ada.page, 'Counter')).toBeVisible();
    await expect(layer(ben.page, 'Counter')).toBeVisible();
    // The count, read from its text layer in Inspect's SwiftUI code ("Text("3")").
    const count = async (page: Page): Promise<string> => {
      await layer(page, 'Count').click();
      await page.getByRole('tab', { name: 'Inspect', exact: true }).click();
      await page.getByRole('combobox', { name: 'Code language' }).selectOption('SWIFT');
      const code = (await page.getByLabel('iOS (SwiftUI) code', { exact: true }).textContent()) ?? '';
      await page.getByRole('tab', { name: 'Design', exact: true }).click();
      await canvas(page).focus();
      await page.keyboard.press('Escape');
      return /Text\("([^"]*)"\)/.exec(code)?.[1] ?? code;
    };
    await expect.poll(() => count(ada.page)).toBe('0');
    await layer(ada.page, 'Counter').click();
    const frame = { x: await numberIn(ada.page, 'X position'), y: await numberIn(ada.page, 'Y position') };
    await clickWidget(ada.page, 'Counter', ADD_ONE);
    await expect.poll(() => count(ada.page)).toBe('1');
    await expect.poll(() => count(ben.page)).toBe('1');

    // Ben clicks + on his screen: 2 for both; his undo takes his click back, for both.
    await clickWidget(ben.page, 'Counter', ADD_ONE);
    await expect.poll(() => count(ben.page)).toBe('2');
    await expect.poll(() => count(ada.page)).toBe('2');
    await canvas(ben.page).focus();
    await ben.page.keyboard.press('Control+z');
    await expect.poll(() => count(ben.page)).toBe('1');
    await expect.poll(() => count(ada.page)).toBe('1');
    // The widget is one object: its parts were not changed by hand, and it is still where it was put.
    await layer(ada.page, 'Counter').click();
    await expect(field(ada.page, 'X position')).toHaveValue(String(frame.x));
  });

  test('a shared file is published as a template, and a second person finds it and duplicates it, images and all', async () => {
    const { ada, ben } = people;
    // Ada makes "Starter kit": a rectangle and a picture.
    await ada.page.goto('/');
    await workspaceEntry(ada.page, "Ada's workspace").click();
    await ada.page.getByRole('button', { name: 'New shared file' }).click();
    await expect(status(ada.page)).toHaveText('Synced');
    await rename(ada.page, 'Starter kit');
    await canvas(ada.page).focus();
    await ada.page.keyboard.press('r');
    await drag(ada.page, [100, 100], [200, 160]);
    await expect(layer(ada.page, 'Rectangle 1')).toBeVisible();
    await placeImage(ada.page, { name: 'red.png', mimeType: 'image/png', buffer: png(40, 40, () => RED) });
    await expect(layer(ada.page, 'red')).toBeVisible();
    await expect(status(ada.page)).toHaveText('Synced');
    expect(await colourOf(ada.page, 'red')).toEqual(RED);

    // She publishes it from the file browser as a template.
    await ada.page.goto('/');
    await workspaceEntry(ada.page, "Ada's workspace").click();
    await fileAction(ada.page, 'Starter kit', 'Publish to Community…');
    const publish = ada.page.getByRole('dialog', { name: 'Publish to Community' });
    await expect(publish.getByRole('img', { name: 'Cover' }).locator('img')).toBeVisible();
    await publish.getByLabel('Title').fill(`Starter kit ${RUN}`);
    await publish.getByLabel('Type').selectOption('template');
    await publish.getByLabel('Description').fill('A rectangle and a red square, to start from.');
    await publish.getByLabel('Tags').fill('starter, checkout');
    await publish.getByRole('button', { name: 'Publish', exact: true }).click();
    const published = ada.page.getByRole('dialog', { name: 'Published' });
    await expect(published.getByRole('status')).toContainText('is published');
    await published.getByRole('button', { name: 'Done' }).click();

    // Ben finds it in the Community by searching, and duplicates it into his own workspace.
    await ben.page.goto('/');
    await ben.page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: /^Community/ }).click();
    await ben.page.getByRole('textbox', { name: 'Search the Community' }).fill(`kit ${RUN}`);
    const results = ben.page.getByRole('list', { name: 'Resources' });
    await expect(results.getByRole('listitem')).toHaveCount(1);
    await results.getByRole('button', { name: `Open Starter kit ${RUN}` }).click();
    const resource = ben.page.getByRole('article', { name: `Starter kit ${RUN}` });
    await expect(resource).toContainText('A rectangle and a red square, to start from.');
    await expect(resource.getByRole('img', { name: `Cover of Starter kit ${RUN}` })).toBeVisible();
    await resource.getByRole('button', { name: 'Duplicate', exact: true }).click();
    const duplicate = ben.page.getByRole('dialog', { name: `Duplicate “Starter kit ${RUN}”` });
    await duplicate.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: "Ben's workspace" });
    await duplicate.getByRole('button', { name: 'Duplicate', exact: true }).click();

    // The copy opens: his own, with the rectangle and the picture.
    await expect(canvas(ben.page)).toBeVisible();
    await expect(status(ben.page)).toHaveText('Synced');
    await expect(layer(ben.page, 'Rectangle 1')).toBeVisible();
    await expect(layer(ben.page, 'red')).toBeVisible();
    await expect.poll(() => colourOf(ben.page, 'red')).toEqual(RED);
    await ben.page.goto('/');
    await workspaceEntry(ben.page, "Ben's workspace").click();
    // The copy keeps the published file's name.
    await expect(ben.page.getByRole('button', { name: 'Open Starter kit', exact: true })).toBeVisible();
  });

  test('files are organised: a project, a file moved into it, a favourite, the trash and a restore', async () => {
    const { page } = people.ada;
    await people.ben.page.goto('/');
    await page.goto('/');
    await workspaceEntry(page, "Ada's workspace").click();

    // A project.
    await page.getByRole('button', { name: 'Workspace actions' }).click();
    await page.getByRole('menuitem', { name: 'New project…' }).click();
    const naming = page.getByRole('dialog', { name: 'New project' });
    await naming.getByLabel('Name').fill('Mobile app');
    await naming.getByRole('button', { name: 'Create project' }).click();
    // It opens, empty, and is listed under the workspace in the rail and on the workspace's page.
    await expect(page.getByText('No files in this project yet.')).toBeVisible();
    const rail = page.getByRole('navigation', { name: 'Workspaces' });
    await expect(rail.getByRole('button', { name: /^Mobile app/ })).toBeVisible();
    await workspaceEntry(page, "Ada's workspace").click();
    await expect(page.getByRole('button', { name: 'Open project Mobile app' })).toBeVisible();

    // "Checkout" moved into it.
    await fileAction(page, 'Checkout', 'Move to…');
    const move = page.getByRole('dialog', { name: 'Move “Checkout”' });
    await move.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: 'Mobile app' });
    await move.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(move).toHaveCount(0);
    await page.getByRole('button', { name: 'Open project Mobile app' }).click();
    await expect(page.getByRole('button', { name: 'Open Checkout' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Starter kit' })).toHaveCount(0);

    // A favourite.
    await fileAction(page, 'Checkout', 'Add to favorites');
    await rail.getByRole('button', { name: /^Favorites/ }).click();
    await expect(page.getByRole('button', { name: 'Open Checkout' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Starter kit' })).toHaveCount(0);

    // Deleted: to the trash, where nobody can open it, and restored from there into its project.
    await workspaceEntry(page, "Ada's workspace").click();
    await page.getByRole('button', { name: 'Open project Mobile app' }).click();
    await fileAction(page, 'Checkout', 'Delete…');
    await page.getByRole('dialog', { name: 'Delete shared file' }).getByRole('button', { name: 'Delete file' }).click();
    await expect(page.getByRole('button', { name: 'Open Checkout' })).toHaveCount(0);
    await rail.getByRole('button', { name: /^Trash/ }).click();
    const trash = page.getByRole('list', { name: 'Deleted files' });
    await expect(trash).toContainText('Checkout');
    // Ben, a member of the workspace, cannot open it while it is there.
    expected.set(people.ben, [/status of 403/]);
    await people.ben.page.goto(mainUrl);
    await expect(people.ben.page.getByText(/do not have access/i)).toBeVisible();
    await expect(canvas(people.ben.page)).toHaveCount(0);
    await trash.getByRole('button', { name: 'Restore Checkout' }).click();
    await expect(page.getByText('The trash is empty.')).toBeVisible();
    await workspaceEntry(page, "Ada's workspace").click();
    await page.getByRole('button', { name: 'Open project Mobile app' }).click();
    await page.getByRole('button', { name: 'Open Checkout' }).click();
    await expect(status(page)).toHaveText('Synced');
    await expect(layer(page, 'Counter')).toBeVisible();
    await expect(layer(page, 'Rectangle 1')).toBeVisible();
  });
});
