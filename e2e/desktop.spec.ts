import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The desktop app (Phase 10), launched with Electron on the built app
 * (`npm run desktop:build`, then `npm run e2e:desktop`). Each test has its
 * own data folder. Native dialogs cannot be clicked by a test, so the Save
 * dialog and the close question are answered by replacing Electron's `dialog`
 * functions in the main process (the app calls them as usual); everything in
 * the window is real input.
 */

test.skip(!process.env.EVORA_DESKTOP_E2E, 'The desktop app has its own configuration: npm run e2e:desktop');

const ROOT = resolve(process.cwd());
const MAIN = join(ROOT, 'dist-electron', 'electron', 'main.js');
/** The team server's port in these tests (not one of the ports other tests use). */
const HOST_PORT = 18787;

const folders: string[] = [];
function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'evora-desktop-'));
  folders.push(folder);
  return folder;
}
test.afterAll(() => {
  for (const folder of folders) {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      // A file still held by a closing app; the system cleans its temporary folder.
    }
  }
});

interface Launched {
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

async function launch(userData: string, files: string[] = []): Promise<Launched> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'EVORA_DEV_URL' && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  // Starting Electron can take long on a busy machine.
  const app = await electron.launch({ args: [MAIN, ...files], cwd: ROOT, env: { ...env, EVORA_USER_DATA: userData }, timeout: 180_000 });
  const page = await app.firstWindow({ timeout: 180_000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // A failed request to /api (no collaboration server) is logged by the browser itself; it is not the app's error.
    if (message.type() === 'error' && !/status of 50[23]/.test(message.text())) errors.push(message.text());
  });
  return { app, page, errors };
}

/** Chooses a native menu item, as a click on it does. */
async function menuClick(app: ElectronApplication, menu: string, label: string): Promise<void> {
  await app.evaluate(({ Menu }, [menuLabel, itemLabel]) => {
    const top = Menu.getApplicationMenu()?.items.find((item) => item.label === menuLabel);
    const item = top?.submenu?.items.find((entry) => entry.label === itemLabel);
    if (!item) throw new Error(`No menu item ${menuLabel} ▸ ${itemLabel}`);
    item.click();
  }, [menu, label] as const);
}

/** The Save dialog answers with this path from now on. */
async function answerSaveWith(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    const record = globalThis as unknown as { saveDialogs?: number };
    record.saveDialogs = 0;
    dialog.showSaveDialog = (async () => {
      record.saveDialogs = (record.saveDialogs ?? 0) + 1;
      return { canceled: false, filePath: target };
    }) as typeof dialog.showSaveDialog;
  }, path);
}

const saveDialogsShown = (app: ElectronApplication): Promise<number> => app.evaluate(() => (globalThis as unknown as { saveDialogs?: number }).saveDialogs ?? 0);
const windowTitle = (app: ElectronApplication): Promise<string> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '');

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layer = (page: Page, name: string): Locator => page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });

async function drawRectangle(page: Page): Promise<void> {
  await canvas(page).focus();
  await page.keyboard.press('r');
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 250, { steps: 4 });
  await page.mouse.move(box.x + 320, box.y + 300, { steps: 4 });
  await page.mouse.up();
  await expect(layer(page, 'Rectangle 1')).toBeVisible();
}

async function newFile(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New design file' }).click();
  await expect(canvas(page)).toBeVisible();
}

/** The document of a saved .evora file, without what differs between two saves of the same thing (its ID and times). */
function documentOf(path: string): unknown {
  const file = JSON.parse(readFileSync(path, 'utf8')) as { document: Record<string, unknown>; assetData?: unknown };
  const { id: _id, ...rest } = file.document;
  return { document: rest, assetData: file.assetData ?? null };
}

test('opens offline with the file browser; app://evora serves the app and keeps navigation inside it', async () => {
  const { app, page, errors } = await launch(tempFolder());
  await expect(page.getByRole('button', { name: 'New design file' })).toBeVisible();
  expect(page.url()).toMatch(/^app:\/\/evora\//);

  // Everything the page loaded came from the app itself: nothing from the network.
  const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
  expect(loaded.length).toBeGreaterThan(0);
  for (const url of loaded) expect(url).toMatch(/^(app:\/\/evora\/|data:|blob:)/);

  // The page is isolated: no Node, the bridge only.
  expect(await page.evaluate(() => [typeof (globalThis as { require?: unknown }).require, typeof (globalThis as { process?: unknown }).process, typeof (window as { evoraDesktop?: unknown }).evoraDesktop])).toEqual(['undefined', 'undefined', 'object']);

  // The protocol: a strict policy on the page, nothing outside the app's folder, /api answered without a server.
  const served = await page.evaluate(async () => {
    const index = await fetch('/');
    const outside = await fetch('/%2e%2e/package.json');
    const api = await fetch('/api/health');
    return { csp: index.headers.get('content-security-policy'), outside: outside.status, api: api.status, apiBody: await api.json() };
  });
  expect(served.csp).toContain("default-src 'self'");
  expect(served.csp).toContain("object-src 'none'");
  expect(served.outside).toBe(404);
  expect(served.api).toBe(503);
  expect(String(served.apiBody.error)).toContain('No collaboration server');

  // Leaving the app: web links go to the system's browser, the window stays.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { opened: string[] }).opened = opened;
    shell.openExternal = (async (url: string) => {
      opened.push(url);
    }) as typeof shell.openExternal;
  });
  expect(await page.evaluate(() => window.open('https://example.org/popup') === null)).toBe(true);
  await page.evaluate(() => {
    window.location.href = 'https://example.org/away';
  });
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual(['https://example.org/popup', 'https://example.org/away']);
  expect(page.url()).toMatch(/^app:\/\/evora\//);
  await expect(page.getByRole('button', { name: 'New design file' })).toBeVisible();
  expect(errors).toEqual([]);
  await app.close();
});

test('Save writes a .evora file that opens again identically, from the command line; unsaved changes are asked about', async () => {
  const folder = tempFolder();
  const first = join(folder, 'First.evora');
  const second = join(folder, 'Second.evora');

  const one = await launch(tempFolder());
  await newFile(one.page);
  await drawRectangle(one.page);
  await expect(field(one.page, 'X position')).toHaveValue(/.+/);
  const x = Number(await field(one.page, 'X position').inputValue());

  // File ▸ Save as… writes the file, and the window is named after it.
  await answerSaveWith(one.app, first);
  await menuClick(one.app, 'File', 'Save as…');
  await expect.poll(() => existsSync(first)).toBe(true);
  await expect.poll(() => windowTitle(one.app)).toBe('Untitled — Evora');

  // A change: the title says so; the editor's own shortcuts still work under the native menus (Ctrl+Z).
  await canvas(one.page).focus();
  await one.page.keyboard.press('ArrowRight');
  await expect(field(one.page, 'X position')).toHaveValue(String(x + 1));
  await expect.poll(() => windowTitle(one.app)).toBe('• Untitled — Evora');
  await one.page.keyboard.press('Control+z');
  await expect(field(one.page, 'X position')).toHaveValue(String(x));
  await expect.poll(() => windowTitle(one.app)).toBe('Untitled — Evora');
  await one.page.keyboard.press('ArrowRight');
  await one.page.keyboard.press('ArrowRight');
  await expect(field(one.page, 'X position')).toHaveValue(String(x + 2));

  // While it has unsaved changes a recovery copy is kept; Ctrl+S saves in place (no dialog) and lets it go.
  const userData = (await one.app.evaluate(({ app }) => app.getPath('userData'))) as string;
  const recovery = join(userData, 'recovery');
  await expect.poll(() => (existsSync(recovery) ? readdirSync(recovery).length : 0), { timeout: 15_000 }).toBe(1);
  const dialogsBefore = await saveDialogsShown(one.app);
  await one.page.keyboard.press('Control+s');
  await expect.poll(() => windowTitle(one.app)).toBe('Untitled — Evora');
  expect(await saveDialogsShown(one.app)).toBe(dialogsBefore);
  await expect.poll(() => readdirSync(recovery).length).toBe(0);
  const saved = JSON.parse(readFileSync(first, 'utf8')) as { format: string; document: { name: string } };
  expect(saved.format).toBe('evora');

  // Closing with unsaved changes asks; "Don't save" closes.
  await one.page.keyboard.press('ArrowDown');
  await expect.poll(() => windowTitle(one.app)).toBe('• Untitled — Evora');
  await one.app.evaluate(({ dialog }) => {
    const asked: string[] = [];
    (globalThis as unknown as { asked: string[] }).asked = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args[args.length - 1] as { message: string };
      asked.push(options.message);
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  const asked = one.app.evaluate(() => new Promise<string[]>((done) => setTimeout(() => done((globalThis as unknown as { asked: string[] }).asked), 1500)));
  await one.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  expect(await asked).toEqual(['Save the changes to “First.evora” before closing?']);
  await one.app.waitForEvent('close');
  expect(one.errors).toEqual([]);

  // The saved file, given on the command line of a new launch (a fresh data folder: nothing of it in the library), opens.
  const two = await launch(tempFolder(), [first]);
  await expect(layer(two.page, 'Rectangle 1')).toBeVisible();
  await layer(two.page, 'Rectangle 1').click();
  await expect(field(two.page, 'X position')).toHaveValue(String(x + 2));
  await expect.poll(() => windowTitle(two.app)).toBe('Untitled — Evora');
  await answerSaveWith(two.app, second);
  await menuClick(two.app, 'File', 'Save as…');
  await expect.poll(() => existsSync(second)).toBe(true);
  expect(documentOf(second)).toEqual(documentOf(first));
  expect(two.errors).toEqual([]);
  await two.app.close();
});

test('a renderer that crashes is reloaded with the open file', async () => {
  const { app, page } = await launch(tempFolder());
  await newFile(page);
  await drawRectangle(page);
  await expect(page.getByRole('navigation', { name: 'Pages and layers' }).getByRole('status')).toHaveText('Saved');
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer());
  // "Reload" was chosen: the same file opens again from what was saved automatically.
  await expect(layer(page, 'Rectangle 1')).toBeVisible({ timeout: 30_000 });
  await app.close();
});

test('a plugin from plugins/examples runs in its sandboxed frame', async () => {
  const { app, page, errors } = await launch(tempFolder());
  await newFile(page);
  await drawRectangle(page);
  await field(page, 'X position').fill('-197');
  await field(page, 'X position').press('Enter');

  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Plugins', exact: true }).click();
  await page.getByRole('menu', { name: 'Plugins', exact: true }).getByRole('menuitem', { name: 'Manage plugins…' }).click();
  const manager = page.getByRole('dialog', { name: 'Plugins and widgets' });
  const chooser = page.waitForEvent('filechooser');
  await manager.getByRole('button', { name: 'Install from file…' }).click();
  await (await chooser).setFiles(join(ROOT, 'plugins', 'examples', 'tidy-up.evora-plugin'));
  const prompt = page.getByRole('dialog', { name: 'Install plugin' });
  await prompt.getByRole('button', { name: 'Install', exact: true }).click();
  await manager.getByRole('button', { name: 'Close' }).click();

  await layer(page, 'Rectangle 1').click();
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Plugins', exact: true }).click();
  await page.getByRole('menu', { name: 'Plugins', exact: true }).getByRole('menuitem', { name: 'Tidy up' }).click();
  await page.getByRole('menu', { name: 'Tidy up' }).getByRole('menuitem', { name: 'Snap to the 8 px grid' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Snapped 1 layer to the 8 px grid.' })).toBeVisible();
  await expect(field(page, 'X position')).toHaveValue('-200');
  expect(errors).toEqual([]);
  await app.close();
});

test('"Host a team server" starts the collaboration server, which answers /api/health, also through the app', async () => {
  const { app, page } = await launch(tempFolder());
  await expect(page.getByRole('button', { name: 'New design file' })).toBeVisible();
  try {
    await menuClick(app, 'File', 'Collaboration…');
    const dialog = page.getByRole('dialog', { name: 'Collaboration' });
    await dialog.getByRole('textbox', { name: 'Port' }).fill(String(HOST_PORT));
    await dialog.getByRole('button', { name: 'Start the server' }).click();
    await expect(page.getByRole('status', { name: 'Team server' })).toContainText(`Running on port ${HOST_PORT}`, { timeout: 30_000 });

    // Others reach it on the network; here, at this computer's own address.
    const health = (await (await fetch(`http://127.0.0.1:${HOST_PORT}/api/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
    // It serves the app too, for people with only a browser.
    expect(await (await fetch(`http://127.0.0.1:${HOST_PORT}/`)).text()).toContain('<div id="root">');

    // "Use it in this app" was on: the window reloads, and the app's /api reaches that server.
    await expect
      .poll(async () => {
        try {
          return await page.evaluate(async () => (await fetch('/api/health')).status);
        } catch {
          return 0;
        }
      }, { timeout: 20_000 })
      .toBe(200);

    await menuClick(app, 'File', 'Collaboration…');
    await page.getByRole('dialog', { name: 'Collaboration' }).getByRole('button', { name: 'Stop the server' }).click();
    await expect(page.getByRole('status', { name: 'Team server' })).toContainText('Not running');
    await expect.poll(async () => fetch(`http://127.0.0.1:${HOST_PORT}/api/health`).then(() => 'up', () => 'down')).toBe('down');
  } finally {
    await app.close();
  }
  // Quitting stops it in any case.
  await expect.poll(async () => fetch(`http://127.0.0.1:${HOST_PORT}/api/health`).then(() => 'up', () => 'down')).toBe('down');
});
