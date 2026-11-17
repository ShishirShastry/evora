import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * The gaps left by Phase 9, closed, in the real browser against the real
 * collaboration server, with real mouse and keyboard input:
 *   - a file deleted through DELETE /api/documents/:id (as any client would)
 *     goes to its workspace's trash, and its link says it is in the trash,
 *     with the way to the trash for someone who can restore it;
 *   - a branch is listed under its main file (grid and list), not as a file
 *     of its own, and opens from there; once merged, the other person who
 *     has it open sees it turn view-only, and an edit there does not reach
 *     the server;
 *   - repeated installs of one plugin, and repeated duplicates of one
 *     Community resource, by the same person count once; a second person
 *     makes two.
 */

const PASSWORD = 'a long enough password';
const RUN = `${Date.now().toString(36)}g`;

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
const rail = (page: Page): Locator => page.getByRole('navigation', { name: 'Workspaces' });
const workspaceEntry = (page: Page, name: string): Locator => rail(page).getByRole('button', { name: new RegExp(`^${name}`) });

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 6 });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 });
  await page.mouse.up();
}

async function setField(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

/** Opens Main menu ▸ `group` ▸ `item`. */
async function menu(page: Page, group: string, item: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: group, exact: true }).click();
  await page.getByRole('menu', { name: group, exact: true }).getByRole('menuitem', { name: item }).first().click();
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
  await page.getByRole('dialog', { name: 'Sign in' }).getByRole('tab', { name: 'Create account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create an account' });
  await dialog.getByLabel('Name').fill(person.name);
  await dialog.getByLabel('Email').fill(person.email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Account: ${person.name}` })).toBeVisible();
}

/** A new shared file in the person's own workspace, named `name`, with a rectangle at x 0. Returns its address, `/#/doc/<id>`. */
async function newSharedFile(person: Person, name: string): Promise<string> {
  const { page } = person;
  await page.goto('/');
  await workspaceEntry(page, `${person.name}'s workspace`).click();
  await page.getByRole('button', { name: 'New shared file' }).click();
  await expect(status(page)).toHaveText('Synced');
  await rename(page, name);
  await canvas(page).focus();
  await page.keyboard.press('r');
  await drag(page, [100, 100], [260, 200]);
  await expect(layer(page, 'Rectangle 1')).toBeVisible();
  await setField(page, 'X position', '0');
  await expect(status(page)).toHaveText('Synced');
  return `/${new URL(page.url()).hash}`;
}

/** A file's "More actions" menu in the file browser. */
async function fileAction(page: Page, file: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `More actions for ${file}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

const people = {} as Record<'cara' | 'dev', Person>;
/** Errors a test expects a person's browser to log. */
const expected = new Map<Person, RegExp[]>();

test.describe.serial('Phase 9 gaps, two people on the collaboration server', () => {
  test.beforeAll(async ({ browser }) => {
    people.cara = await arrive(browser, 'Cara');
    people.dev = await arrive(browser, 'Dev');
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

  test('a file deleted with DELETE /api/documents/:id goes to the trash, and its link says so', async () => {
    const { cara, dev } = people;
    await signUp(cara);
    await signUp(dev);

    // Cara invites Dev to her workspace as an editor.
    await workspaceEntry(cara.page, "Cara's workspace").click();
    await cara.page.getByRole('button', { name: 'Members', exact: true }).click();
    const members = cara.page.getByRole('dialog', { name: "Members of Cara's workspace" });
    await members.getByRole('textbox', { name: 'Email address to invite' }).fill(dev.email);
    await members.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(members.getByRole('list', { name: 'People with access' })).toContainText('Dev');
    await members.getByRole('button', { name: 'Close' }).click();

    const doomedUrl = await newSharedFile(cara, 'Doomed');
    const docId = doomedUrl.replace('/#/doc/', '');
    await cara.page.goto('/');
    await workspaceEntry(cara.page, "Cara's workspace").click();
    await expect(cara.page.getByRole('button', { name: 'Open Doomed', exact: true })).toBeVisible();

    // Deleted the way any client of the API would: DELETE, with the page's own fetch and session.
    const answer = await cara.page.evaluate(async (id) => {
      const { token } = JSON.parse(localStorage.getItem('evora:account') ?? '{}') as { token?: string };
      const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token ?? ''}` } });
      return response.status;
    }, docId);
    expect(answer).toBe(200);

    // Not in the workspace's files any more; in its trash.
    await cara.page.reload();
    await workspaceEntry(cara.page, "Cara's workspace").click();
    await expect(cara.page.getByRole('button', { name: 'Open Doomed', exact: true })).toHaveCount(0);
    await rail(cara.page).getByRole('button', { name: /^Trash/ }).click();
    await expect(cara.page.getByRole('list', { name: 'Deleted files' })).toContainText('Doomed');

    // Dev, an editor of the workspace, opens its link: it is in the trash, and he is shown the way to it.
    expected.set(dev, [/status of 410/]);
    await dev.page.goto(doomedUrl);
    const notice = dev.page.getByRole('alert');
    await expect(notice).toContainText('This file is in the trash');
    await expect(canvas(dev.page)).toHaveCount(0);
    await notice.getByRole('link', { name: 'Go to the trash' }).click();
    const trash = dev.page.getByRole('list', { name: 'Deleted files' });
    await expect(trash).toContainText('Doomed');
    await trash.getByRole('button', { name: 'Restore Doomed' }).click();
    await expect(dev.page.getByText('The trash is empty.')).toBeVisible();

    // Restored, it opens again.
    await dev.page.goto(doomedUrl);
    await expect(status(dev.page)).toHaveText('Synced');
    await expect(layer(dev.page, 'Rectangle 1')).toBeVisible();
  });

  test('a branch is listed under its main file, and turns view-only for the other person when it is merged', async () => {
    const { cara, dev } = people;
    await newSharedFile(cara, 'Landing');

    // Cara makes a branch, "Hero".
    await menu(cara.page, 'Version history', 'Create branch…');
    const create = cara.page.getByRole('dialog', { name: 'Create branch' });
    await create.getByLabel('Branch name').fill('Hero');
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(cara.page.getByRole('region', { name: 'Branch' })).toContainText('Branch of Landing');
    await expect(status(cara.page)).toHaveText('Synced');

    // In the file browser it is under Landing, not a file of its own: in the grid…
    await cara.page.goto('/');
    await workspaceEntry(cara.page, "Cara's workspace").click();
    const files = cara.page.getByRole('list', { name: 'Shared files' });
    await expect(files.getByRole('button', { name: 'Open Landing', exact: true })).toBeVisible();
    await expect(cara.page.getByRole('button', { name: 'Open Hero', exact: true })).toHaveCount(0);
    const toggle = files.getByRole('button', { name: 'Show 1 branch of Landing' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(files.getByRole('button', { name: 'Hide 1 branch of Landing' })).toHaveAttribute('aria-expanded', 'true');
    await expect(files.getByRole('list', { name: 'Branches of Landing' }).getByRole('button', { name: 'Open branch Hero' })).toBeVisible();
    // …and in the list view.
    await cara.page.getByRole('radio', { name: 'List view' }).click();
    const table = cara.page.getByRole('table', { name: 'Shared files' });
    await expect(table.getByRole('button', { name: 'Open Landing', exact: true })).toBeVisible();
    await expect(table.getByRole('button', { name: 'Open Hero', exact: true })).toHaveCount(0);
    await table.getByRole('button', { name: 'Show 1 branch of Landing' }).click();
    await expect(table.getByRole('list', { name: 'Branches of Landing' }).getByRole('button', { name: 'Open branch Hero' })).toBeVisible();
    await cara.page.getByRole('radio', { name: 'Grid view' }).click();

    // Dev opens the branch from the list on his screen.
    await dev.page.goto('/');
    await workspaceEntry(dev.page, "Cara's workspace").click();
    const devFiles = dev.page.getByRole('list', { name: 'Shared files' });
    await devFiles.getByRole('button', { name: 'Show 1 branch of Landing' }).click();
    await devFiles.getByRole('button', { name: 'Open branch Hero' }).click();
    const devBanner = dev.page.getByRole('region', { name: 'Branch' });
    await expect(devBanner).toContainText('Branch of Landing');
    await expect(status(dev.page)).toHaveText('Synced');
    await expect(dev.page.getByText('View only', { exact: true })).toHaveCount(0);

    // Cara opens it the same way and merges it into main.
    await files.getByRole('button', { name: 'Show 1 branch of Landing' }).click();
    await files.getByRole('button', { name: 'Open branch Hero' }).click();
    const banner = cara.page.getByRole('region', { name: 'Branch' });
    await expect(status(cara.page)).toHaveText('Synced');
    // A change on the branch, which Dev sees live: an ellipse.
    await canvas(cara.page).focus();
    await cara.page.keyboard.press('o');
    await drag(cara.page, [500, 400], [600, 480]);
    await expect(layer(cara.page, 'Ellipse 1')).toBeVisible();
    await expect(status(cara.page)).toHaveText('Synced');
    await expect(layer(dev.page, 'Ellipse 1')).toBeVisible();
    await banner.getByRole('button', { name: 'Merge into main' }).click();
    const merge = cara.page.getByRole('dialog', { name: 'Merge “Hero” into main' });
    await merge.getByRole('button', { name: 'Merge branch' }).click();
    await expect(merge.getByRole('status')).toContainText('Merged into “Landing”');

    // Dev, with the branch still open, sees it become view-only, and why.
    const badge = dev.page.getByText('View only', { exact: true });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('title', 'This branch has been merged into Landing; it can be viewed but not changed');
    await expect(devBanner).toContainText('merged, view only');
    await expect(devBanner.getByRole('button', { name: 'Merge into main' })).toHaveCount(0);
    await expect(dev.page.getByRole('status').filter({ hasText: 'This branch has been merged into Landing' })).toBeVisible();
    await expect(status(dev.page)).toHaveText('Synced');

    // He tries to change it: move the rectangle, and delete it. Nothing changes, here or on the server.
    await layer(dev.page, 'Rectangle 1').click();
    await setField(dev.page, 'X position', '480');
    await canvas(dev.page).focus();
    await dev.page.keyboard.press('Delete');
    await expect(layer(dev.page, 'Rectangle 1')).toBeVisible();
    await dev.page.reload();
    await expect(status(dev.page)).toHaveText('Synced');
    await expect(dev.page.getByText('View only', { exact: true })).toBeVisible();
    await layer(dev.page, 'Rectangle 1').click();
    await expect(field(dev.page, 'X position')).toHaveValue('0');
    // As the server holds it: the branch's registers still have the rectangle at x 0.
    const branchId = new URL(dev.page.url()).hash.replace('#/doc/', '');
    const held = await dev.page.evaluate(async (id) => {
      const { token } = JSON.parse(localStorage.getItem('evora:account') ?? '{}') as { token?: string };
      const response = await fetch(`/api/documents/${encodeURIComponent(id)}/registers`, { headers: { Authorization: `Bearer ${token ?? ''}` } });
      const body = (await response.json()) as { registers: { k: string; v: unknown }[] };
      return body.registers.filter((register) => /(^|[:/.])x$/.test(register.k)).map((register) => register.v);
    }, branchId);
    expect(held.length).toBeGreaterThan(0);
    expect(held).not.toContain(480);

    // In the file browser, the merged branch is no longer listed under Landing.
    await dev.page.goto('/');
    await workspaceEntry(dev.page, "Cara's workspace").click();
    await expect(dev.page.getByRole('button', { name: 'Open Landing', exact: true })).toBeVisible();
    await expect(dev.page.getByRole('button', { name: /branch(es)? of Landing$/ })).toHaveCount(0);
    await expect(dev.page.getByRole('button', { name: 'Open Hero', exact: true })).toHaveCount(0);
  });

  test('installing one plugin twice, and duplicating one Community resource twice, count once per person', async () => {
    const { cara, dev } = people;
    const pluginName = `Counted ${RUN}`;
    const bundle = {
      name: 'counted.evora-plugin',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'evora-plugin',
          formatVersion: 1,
          manifest: { id: `test.counted.${RUN}`, name: pluginName, version: '1.0.0', description: 'Counts installs.', author: 'Tests', kind: 'plugin', api: 1, permissions: ['read'], commands: [{ id: 'run', name: 'Count' }], main: 'main.js' },
          code: 'evora.closePlugin();',
          ui: null,
        }),
      ),
    };

    // Cara installs it from its file and publishes it to the directory, then uninstalls it here.
    await cara.page.goto('/');
    await cara.page.getByRole('button', { name: 'New design file' }).click();
    await expect(canvas(cara.page)).toBeVisible();
    await menu(cara.page, 'Plugins', 'Manage plugins…');
    let manager = cara.page.getByRole('dialog', { name: 'Plugins and widgets' });
    const chooser = cara.page.waitForEvent('filechooser');
    await manager.getByRole('button', { name: 'Install from file…' }).click();
    await (await chooser).setFiles(bundle);
    await cara.page.getByRole('dialog', { name: 'Install plugin' }).getByRole('button', { name: 'Install', exact: true }).click();
    await manager.getByRole('button', { name: `Settings of ${pluginName}` }).click();
    await manager.getByRole('button', { name: 'Publish to directory' }).click();
    await expect(cara.page.getByRole('status').filter({ hasText: `Published ${pluginName} 1.0.0 to the directory.` })).toBeVisible();
    await manager.getByRole('button', { name: `Uninstall ${pluginName}` }).click();
    await expect(manager.getByRole('button', { name: `Settings of ${pluginName}` })).toHaveCount(0);

    /** The directory's entry for the plugin, as the Browse tab shows it (read afresh). */
    const browse = async (page: Page): Promise<Locator> => {
      const dialog = page.getByRole('dialog', { name: 'Plugins and widgets' });
      await dialog.getByRole('tab', { name: 'Installed' }).click();
      await dialog.getByRole('tab', { name: 'Browse' }).click();
      await dialog.getByRole('searchbox', { name: 'Search plugins and widgets' }).fill(RUN);
      return dialog.getByRole('list', { name: 'Directory' }).getByRole('listitem').filter({ hasText: pluginName });
    };

    // Cara installs it from the directory twice: Install, cancelled at the prompt, then Install again and agreed to.
    let entry = await browse(cara.page);
    await expect(entry).toContainText('0 installs');
    await entry.getByRole('button', { name: `Install ${pluginName}` }).click();
    await cara.page.getByRole('dialog', { name: 'Install plugin' }).getByRole('button', { name: 'Cancel' }).click();
    await entry.getByRole('button', { name: `Install ${pluginName}` }).click();
    await cara.page.getByRole('dialog', { name: 'Install plugin' }).getByRole('button', { name: 'Install', exact: true }).click();
    await expect(entry.getByRole('button', { name: `Installed: ${pluginName}` })).toBeVisible();
    entry = await browse(cara.page);
    await expect(entry).toContainText('1 install');

    // Dev installs it once: two.
    await dev.page.goto('/');
    await dev.page.getByRole('button', { name: 'New design file' }).click();
    await expect(canvas(dev.page)).toBeVisible();
    await menu(dev.page, 'Plugins', 'Manage plugins…');
    let devEntry = await browse(dev.page);
    await devEntry.getByRole('button', { name: `Install ${pluginName}` }).click();
    await dev.page.getByRole('dialog', { name: 'Install plugin' }).getByRole('button', { name: 'Install', exact: true }).click();
    devEntry = await browse(dev.page);
    await expect(devEntry).toContainText('2 installs');
    entry = await browse(cara.page);
    await expect(entry).toContainText('2 installs');
    manager = cara.page.getByRole('dialog', { name: 'Plugins and widgets' });
    await manager.getByRole('button', { name: 'Close' }).click();
    await dev.page.getByRole('dialog', { name: 'Plugins and widgets' }).getByRole('button', { name: 'Close' }).click();

    // Cara publishes "Landing" to the Community.
    const title = `Landing kit ${RUN}`;
    await cara.page.goto('/');
    await workspaceEntry(cara.page, "Cara's workspace").click();
    await fileAction(cara.page, 'Landing', 'Publish to Community…');
    const publish = cara.page.getByRole('dialog', { name: 'Publish to Community' });
    await publish.getByLabel('Title').fill(title);
    await publish.getByLabel('Type').selectOption('template');
    await publish.getByRole('button', { name: 'Publish', exact: true }).click();
    const published = cara.page.getByRole('dialog', { name: 'Published' });
    await expect(published.getByRole('status')).toContainText('is published');
    await published.getByRole('button', { name: 'Done' }).click();

    /** The resource's page in the Community, and its number of duplicates. */
    const resourcePage = async (page: Page): Promise<{ resource: Locator; duplicates: Locator }> => {
      await page.goto('/');
      await rail(page).getByRole('button', { name: /^Community/ }).click();
      await page.getByRole('textbox', { name: 'Search the Community' }).fill(`kit ${RUN}`);
      await page.getByRole('list', { name: 'Resources' }).getByRole('button', { name: `Open ${title}` }).click();
      const resource = page.getByRole('article', { name: title });
      return { resource, duplicates: resource.locator('dt', { hasText: 'Duplicates' }).locator('xpath=following-sibling::dd[1]') };
    };
    const duplicateInto = async (person: Person): Promise<void> => {
      const { resource } = await resourcePage(person.page);
      await resource.getByRole('button', { name: 'Duplicate', exact: true }).click();
      const dialog = person.page.getByRole('dialog', { name: `Duplicate “${title}”` });
      await dialog.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: `${person.name}'s workspace` });
      await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
      await expect(canvas(person.page)).toBeVisible();
      await expect(status(person.page)).toHaveText('Synced');
    };

    // Dev duplicates it twice: one.
    let { duplicates } = await resourcePage(dev.page);
    await expect(duplicates).toHaveText('0');
    await duplicateInto(dev);
    await duplicateInto(dev);
    ({ duplicates } = await resourcePage(dev.page));
    await expect(duplicates).toHaveText('1');

    // Cara duplicates it too: two.
    await duplicateInto(cara);
    ({ duplicates } = await resourcePage(cara.page));
    await expect(duplicates).toHaveText('2');
  });
});
