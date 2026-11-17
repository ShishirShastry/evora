import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Phase 8 acceptance criterion: "Multiple users can edit the same document
 * simultaneously without losing changes", and the specification's
 * collaboration tests: people signing up, sharing by email, by an invite link
 * and by the file's link, editing the same file at the same time (layers
 * drawn, the same layer moved, different texts typed), seeing each other's
 * pointers, selections and avatars, a comment that mentions someone, editing
 * offline, a viewer who cannot change the file, a guest, and the file found
 * again after a reload and on another device.
 *
 * Each person has a browser context of their own (their own storage, as on
 * their own computer), against the real collaboration server the
 * configuration starts with an empty database. Everything is done through the
 * interface with real mouse and keyboard input, apart from one message a
 * viewer sends the server directly to show that the server itself refuses
 * it. What each person has is read back from their layers and properties
 * panels, from what their canvas shows of the others, and from a reload and a
 * fresh sign-in, which show what the server kept.
 *
 * The tests run in order and share the people and the file: each picks up
 * where the one before left off.
 */

type RGB = [number, number, number];
const RED: RGB = [255, 0, 0];
const BLUE: RGB = [0, 0, 255];
const GREEN: RGB = [0, 255, 0];

/** Encodes an RGB image as a PNG file (as in images.spec.ts), so the test knows exactly what should appear on the canvas. */
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
/** Addresses of their own for each run, so the tests can also run against a server that has seen them before. */
const RUN = Date.now().toString(36);

interface Person {
  name: string;
  email: string;
  context: BrowserContext;
  page: Page;
  /** What the application logged as an error in this person's browser. */
  errors: string[];
}

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Layers' });
const layer = (page: Page, name: string): Locator => layers(page).getByRole('treeitem', { name, exact: true });
const field = (page: Page, label: string): Locator => page.getByRole('textbox', { name: label, exact: true });
/** The connection's state in the file's header ("Synced", "Offline — 3 changes waiting"…). */
const status = (page: Page): Locator => page.getByRole('navigation', { name: 'Pages and layers' }).getByRole('status');

/** Drags on the canvas between two points given in canvas pixels. */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 4): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps });
  await page.mouse.up();
}

async function click(page: Page, at: [number, number]): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  await page.mouse.click(box.x + at[0], box.y + at[1]);
}

/** Types a value into a field of the properties panel and confirms it. */
async function setField(page: Page, label: string, value: string): Promise<void> {
  await field(page, label).fill(value);
  await field(page, label).press('Enter');
}

/** The selected layer's box, from the properties panel. */
async function boxOf(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const read = async (label: string): Promise<number> => Number(await field(page, label).inputValue());
  return { x: await read('X position'), y: await read('Y position'), w: await read('Width'), h: await read('Height') };
}

/** Where a point of the page is on the canvas, in canvas pixels, at 100% with the page's origin in the middle of the view (a new file's view). */
async function onCanvas(page: Page, point: { x: number; y: number }): Promise<[number, number]> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('canvas not visible');
  return [Math.floor(box.width) / 2 + point.x, Math.floor(box.height) / 2 + point.y];
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

/** Chooses File → Place image… and answers the file chooser. */
async function placeImage(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Place image/ }).click();
  await (await chooser).setFiles(file);
}

/** A browser context of its own for one person, with what the application logs as errors collected. */
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

async function fillAccountForm(page: Page, person: Person, signup: boolean): Promise<void> {
  const dialog = page.getByRole('dialog', { name: signup ? 'Create an account' : 'Sign in' });
  if (signup) await dialog.getByLabel('Name').fill(person.name);
  await dialog.getByLabel('Email').fill(person.email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: signup ? 'Create account' : 'Sign in', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** Creates an account from the file browser's "Sign in" button. */
async function signUp(person: Person): Promise<void> {
  const { page } = person;
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sign in' }).getByRole('tab', { name: 'Create account' }).click();
  await fillAccountForm(page, person, true);
  await expect(page.getByRole('button', { name: `Account: ${person.name}` })).toBeVisible();
}

/** The rail entry of a workspace, by the start of its name. */
const workspaceEntry = (page: Page, name: string): Locator => page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: new RegExp(`^${name}`) });

/** The names of the layers in a person's layers panel, in order. */
async function layerNames(page: Page): Promise<string[]> {
  return layers(page).getByRole('treeitem').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? ''));
}

/** Waits until both people's layers panels list the same layers, and returns them. */
async function sameLayers(a: Page, b: Page): Promise<string[]> {
  await expect.poll(async () => JSON.stringify(await layerNames(a)) === JSON.stringify(await layerNames(b)), { timeout: 7_000 }).toBe(true);
  return layerNames(a);
}

/** Makes a comment with the Comment tool where the canvas is clicked, mentioning `mention` when given. */
async function comment(page: Page, at: [number, number], text: string, mention?: string): Promise<void> {
  await page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Comment', exact: true }).click();
  await click(page, at);
  const composer = page.getByRole('dialog', { name: 'New comment' }).getByRole('textbox', { name: 'Comment' });
  await expect(composer).toBeFocused();
  if (mention) {
    await page.keyboard.type(`@${mention.slice(0, 2)}`);
    await expect(page.getByRole('listbox', { name: 'People to mention' }).getByRole('option', { name: new RegExp(`^${mention}`) })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(composer).toHaveValue(`@${mention} `);
  }
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'New comment' })).toHaveCount(0);
  // The comment is posted and opens; Escape closes it and puts the Comment tool down.
  await expect(page.getByRole('dialog', { name: 'Comment thread' })).toBeVisible();
  await canvas(page).focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Comment', exact: true })).toHaveAttribute('aria-pressed', 'false');
}

const people = {} as Record<'ada' | 'ben' | 'cleo', Person>;
/** The shared file's address, `/#/doc/<id>`. */
let fileUrl = '';
/** Errors that a test expects a person's browser to log (a request the server refuses on purpose). */
const expected = new Map<Person, RegExp[]>();

test.describe.serial('collaboration', () => {
  test.beforeAll(async ({ browser }) => {
    people.ada = await arrive(browser, 'Ada');
    people.ben = await arrive(browser, 'Ben');
    people.cleo = await arrive(browser, 'Cleo');
  });

  test.afterEach(async () => {
    // Fail any test during which the application logged an error it was not expected to.
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

  test('two people sign up, one shares a file with the other by email, and both open it', async () => {
    const { ada, ben } = people;
    await signUp(ada);
    await signUp(ben);

    // Each has a workspace of their own, free, with no plan to choose.
    await expect(workspaceEntry(ada.page, "Ada's workspace")).toBeVisible();
    await expect(workspaceEntry(ben.page, "Ben's workspace")).toBeVisible();

    // Ada invites Ben to her workspace by email, as an editor.
    await workspaceEntry(ada.page, "Ada's workspace").click();
    await ada.page.getByRole('button', { name: 'Members', exact: true }).click();
    const members = ada.page.getByRole('dialog', { name: "Members of Ada's workspace" });
    await members.getByRole('textbox', { name: 'Email address to invite' }).fill(ben.email);
    await expect(members.getByRole('combobox', { name: 'Role for the invited person' })).toHaveValue('editor');
    await members.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(members.getByRole('list', { name: 'People with access' })).toContainText('Ben');
    await members.getByRole('button', { name: 'Close' }).click();
    await expect(workspaceEntry(ada.page, "Ada's workspace")).toContainText('2 members');

    // She makes a shared file in it, which opens connected.
    await ada.page.getByRole('button', { name: 'New shared file' }).click();
    await expect(canvas(ada.page)).toBeVisible();
    await expect(status(ada.page)).toHaveText('Synced');
    expect(ada.page.url()).toMatch(/#\/doc\/[0-9A-Za-z_-]+$/);
    fileUrl = `/${new URL(ada.page.url()).hash}`;

    // Ben is told he was invited; the notification leads to the workspace, where the file is.
    await ben.page.getByRole('button', { name: 'Notifications' }).click();
    const invite = ben.page.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: /Ada invited you to a workspace/ });
    await expect(invite).toBeVisible();
    await invite.click();
    await expect(ben.page).toHaveURL(/#\/workspace\//);
    await ben.page.getByRole('button', { name: 'Open Untitled' }).click();
    await expect(canvas(ben.page)).toBeVisible();
    await expect(status(ben.page)).toHaveText('Synced');
    expect(`/${new URL(ben.page.url()).hash}`).toBe(fileUrl);

    // Each sees the other in the file's header.
    await expect(ada.page.getByRole('button', { name: 'Follow Ben' })).toBeVisible();
    await expect(ben.page.getByRole('button', { name: 'Follow Ada' })).toBeVisible();
  });

  test('both draw at the same time and each sees what the other drew', async () => {
    const { ada, ben } = people;
    // Each drawing is a gesture that is still going on when the other's layer arrives: neither may be lost.
    await Promise.all([
      (async () => {
        await canvas(ada.page).focus();
        await ada.page.keyboard.press('r');
        await drag(ada.page, [120, 120], [260, 220], 8);
      })(),
      (async () => {
        await canvas(ben.page).focus();
        await ben.page.keyboard.press('o');
        await drag(ben.page, [420, 300], [540, 420], 8);
      })(),
    ]);
    for (const person of [ada, ben]) {
      await expect(layer(person.page, 'Rectangle 1')).toBeVisible();
      await expect(layer(person.page, 'Ellipse 1')).toBeVisible();
      await expect(status(person.page)).toHaveText('Synced');
    }
    expect((await sameLayers(ada.page, ben.page)).sort()).toEqual(['Ellipse 1', 'Rectangle 1']);

    // Both have the same layers in the same places.
    for (const name of ['Rectangle 1', 'Ellipse 1']) {
      await layer(ada.page, name).click();
      await layer(ben.page, name).click();
      expect(await boxOf(ben.page)).toEqual(await boxOf(ada.page));
    }
  });

  test('moves of the same layer at the same time end the same for both', async () => {
    const { ada, ben } = people;
    await layer(ada.page, 'Rectangle 1').click();
    await layer(ben.page, 'Rectangle 1').click();
    const start = await boxOf(ada.page);

    // Both type a new X at once: the later change wins, the same on both.
    await Promise.all([setField(ada.page, 'X position', '-100'), setField(ben.page, 'X position', '0')]);
    await expect.poll(async () => (await field(ada.page, 'X position').inputValue()) === (await field(ben.page, 'X position').inputValue())).toBe(true);
    const typed = Number(await field(ada.page, 'X position').inputValue());
    expect([-100, 0]).toContain(typed);

    // Then Ada drags it to the right while Ben drags it down: both moves are kept, on both screens.
    const centre = await onCanvas(ada.page, { x: typed + start.w / 2, y: start.y + start.h / 2 });
    await Promise.all([
      (async () => {
        await ada.page.keyboard.down('Shift');
        await drag(ada.page, centre, [centre[0] + 100, centre[1]], 10);
        await ada.page.keyboard.up('Shift');
      })(),
      (async () => {
        await ben.page.keyboard.down('Shift');
        await drag(ben.page, centre, [centre[0], centre[1] + 80], 10);
        await ben.page.keyboard.up('Shift');
      })(),
    ]);
    await expect(status(ada.page)).toHaveText('Synced');
    await expect(status(ben.page)).toHaveText('Synced');
    await expect.poll(async () => JSON.stringify(await boxOf(ben.page)) === JSON.stringify(await boxOf(ada.page))).toBe(true);
    const moved = await boxOf(ada.page);
    expect(moved.x).toBeGreaterThan(typed + 90);
    expect(moved.y).toBeGreaterThan(start.y + 70);
    expect([moved.w, moved.h]).toEqual([start.w, start.h]);
  });

  test('texts typed and changed by both at the same time are all kept', async () => {
    const { ada, ben } = people;
    const write = async (page: Page, at: [number, number], text: string): Promise<void> => {
      await canvas(page).focus();
      await page.keyboard.press('t');
      await click(page, at);
      const editor = page.getByRole('textbox', { name: 'Edit text' });
      await expect(editor).toBeFocused();
      await page.keyboard.type(text, { delay: 20 });
      await page.keyboard.press('Escape');
      await expect(editor).toHaveCount(0);
    };
    await Promise.all([write(ada.page, [60, 520], 'Alpha'), write(ben.page, [60, 620], 'Beta')]);
    for (const person of [ada, ben]) {
      await expect(layer(person.page, 'Alpha')).toBeVisible();
      await expect(layer(person.page, 'Beta')).toBeVisible();
    }

    // Each opens a different text and adds to it, at the same time.
    const change = async (page: Page, name: string, added: string): Promise<void> => {
      await layer(page, name).click();
      await canvas(page).focus();
      await page.keyboard.press('Enter');
      const editor = page.getByRole('textbox', { name: 'Edit text' });
      await expect(editor).toBeFocused();
      await page.keyboard.press('End');
      await page.keyboard.type(added, { delay: 20 });
      await page.keyboard.press('Escape');
      await expect(editor).toHaveCount(0);
    };
    await Promise.all([change(ada.page, 'Alpha', ' one'), change(ben.page, 'Beta', ' two')]);
    for (const person of [ada, ben]) {
      await expect(layer(person.page, 'Alpha one')).toBeVisible();
      await expect(layer(person.page, 'Beta two')).toBeVisible();
      await expect(status(person.page)).toHaveText('Synced');
    }
    expect((await sameLayers(ada.page, ben.page)).sort()).toEqual(['Alpha one', 'Beta two', 'Ellipse 1', 'Rectangle 1']);
  });

  test("each sees the other's pointer, selection and avatar, and can follow their view", async () => {
    const { ada, ben } = people;
    // Ada's pointer over her canvas shows on Ben's, with her name, where she points.
    const box = await canvas(ada.page).boundingBox();
    if (!box) throw new Error('canvas not visible');
    await ada.page.mouse.move(box.x + 300, box.y + 700, { steps: 3 });
    const pointer = ben.page.locator('[data-cursor="Ada"]');
    await expect(pointer).toContainText('Ada');
    await expect(pointer).toHaveCSS('opacity', '1');
    const theirs = await canvas(ben.page).boundingBox();
    await expect
      .poll(async () => {
        const at = await pointer.boundingBox();
        // Within a pixel or two: the pointer is sent in page units rounded to a tenth.
        return at && theirs ? Math.abs(at.x - theirs.x - 300) <= 2 && Math.abs(at.y - theirs.y - 700) <= 2 : false;
      })
      .toBe(true);

    // What Ada selects is outlined on Ben's canvas.
    await layer(ada.page, 'Ellipse 1').click();
    await expect(ben.page.getByRole('group', { name: 'Collaboration' }).locator('polygon')).toHaveCount(1);
    await ada.page.keyboard.press('Escape');
    await expect(ben.page.getByRole('group', { name: 'Collaboration' }).locator('polygon')).toHaveCount(0);

    // Ben follows Ada: her zoom becomes his, until he stops.
    await ben.page.getByRole('button', { name: 'Follow Ada' }).click();
    await expect(ben.page.getByText('Following Ada')).toBeVisible();
    await setField(ada.page, 'Zoom percentage', '200');
    await expect(field(ben.page, 'Zoom percentage')).toHaveValue('200');
    await ben.page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(ben.page.getByText('Following Ada')).toHaveCount(0);
    await setField(ada.page, 'Zoom percentage', '100');
    await expect(field(ben.page, 'Zoom percentage')).toHaveValue('200');
    // Back to the view both started with (zoomed about the middle of the view), for the tests that follow.
    await setField(ben.page, 'Zoom percentage', '100');
  });

  test('a comment that mentions someone reaches them, with a notification', async () => {
    const { ada, ben } = people;
    await comment(ada.page, [60, 300], 'please look at the rectangle', 'Ben');
    const pin = (page: Page): Locator => page.getByRole('button', { name: 'Comment by Ada: @Ben please look at the rectangle' });
    await expect(pin(ada.page)).toBeVisible();
    // Ben's canvas shows it at once.
    await expect(pin(ben.page)).toBeVisible();

    // In the file browser Ben is notified, and the notification opens the file at the comment.
    await ben.page.goto('/');
    const bell = ben.page.getByRole('button', { name: 'Notifications' });
    await expect(bell).toHaveAttribute('title', /unread/);
    await bell.click();
    const mention = ben.page.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: /Ada mentioned you/ });
    await expect(mention).toContainText('@Ben please look at the rectangle');
    await mention.click();
    await expect(ben.page).toHaveURL(/#\/doc\/[0-9A-Za-z_-]+\/comment\/[0-9A-Za-z_-]+$/);
    const thread = ben.page.getByRole('dialog', { name: 'Comment thread' });
    await expect(thread.getByRole('list', { name: 'Comments' })).toContainText('please look at the rectangle');

    // His reply reaches Ada's open thread.
    await thread.getByRole('textbox', { name: 'Reply' }).fill('On it');
    await thread.getByRole('textbox', { name: 'Reply' }).press('Enter');
    await expect(thread.getByRole('list', { name: 'Comments' })).toContainText('On it');
    await pin(ada.page).click();
    await expect(ada.page.getByRole('dialog', { name: 'Comment thread' }).getByRole('list', { name: 'Comments' })).toContainText('On it');
    await ada.page.getByRole('dialog', { name: 'Comment thread' }).getByRole('button', { name: 'Close comment' }).click();
    await ben.page.getByRole('dialog', { name: 'Comment thread' }).getByRole('button', { name: 'Close comment' }).click();
    await ben.page.goto(fileUrl);
    await expect(status(ben.page)).toHaveText('Synced');
  });

  test('changes made offline are sent when the connection comes back', async () => {
    const { ada, ben } = people;
    // While offline the connection is tried again now and then, and the browser logs each failed attempt.
    expected.set(ben, [/WebSocket connection to .* failed: .*ERR_INTERNET_DISCONNECTED/]);
    await ben.context.setOffline(true);
    await expect(status(ben.page)).toHaveText(/^Offline/);

    // Ben draws and renames while offline; it waits on his device.
    await ben.page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Star', exact: true }).click();
    await drag(ben.page, [560, 560], [640, 640]);
    await expect(layer(ben.page, 'Star 1')).toBeVisible();
    await layer(ben.page, 'Ellipse 1').dblclick();
    await ben.page.keyboard.type('Sun');
    await ben.page.keyboard.press('Enter');
    await expect(layer(ben.page, 'Sun')).toBeVisible();
    await expect(status(ben.page)).toHaveText(/^Offline — \d+ changes? waiting$/);

    // Meanwhile Ada draws a line; neither sees the other's change yet.
    await canvas(ada.page).focus();
    await ada.page.keyboard.press('l');
    await drag(ada.page, [500, 100], [640, 140]);
    await expect(layer(ada.page, 'Line 1')).toBeVisible();
    await expect(layer(ada.page, 'Star 1')).toHaveCount(0);
    await expect(layer(ben.page, 'Line 1')).toHaveCount(0);

    // Back online: both have everything.
    await ben.context.setOffline(false);
    await expect(status(ben.page)).toHaveText('Synced', { timeout: 15_000 });
    for (const person of [ada, ben]) {
      await expect(layer(person.page, 'Star 1')).toBeVisible();
      await expect(layer(person.page, 'Sun')).toBeVisible();
      await expect(layer(person.page, 'Line 1')).toBeVisible();
    }
    expect((await sameLayers(ada.page, ben.page)).sort()).toEqual(['Alpha one', 'Beta two', 'Line 1', 'Rectangle 1', 'Star 1', 'Sun']);
  });

  test('a viewer can look and comment but cannot change the file, and the server refuses it too', async () => {
    const { ada, cleo } = people;
    await signUp(cleo);

    // Ada shares the file with Cleo, to view.
    await ada.page.getByRole('button', { name: 'Share', exact: true }).click();
    const share = ada.page.getByRole('dialog', { name: 'Share “Untitled”' });
    await share.getByRole('textbox', { name: 'Email address to invite' }).fill(cleo.email);
    await share.getByRole('combobox', { name: 'Role for the invited person' }).selectOption('viewer');
    await share.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(share.getByRole('list', { name: 'People with access' })).toContainText('Cleo');
    await expect(share.getByRole('combobox', { name: 'Role of Cleo' })).toHaveValue('viewer');
    await share.getByRole('button', { name: 'Close' }).click();

    // Cleo finds it under "Shared with me".
    await cleo.page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Shared with me' }).click();
    await cleo.page.getByRole('button', { name: 'Open Untitled' }).click();
    await expect(status(cleo.page)).toHaveText('Synced');
    await expect(cleo.page.getByText('View only', { exact: true })).toBeVisible();
    const before = await sameLayers(ada.page, cleo.page);
    expect(before).toHaveLength(6);
    await expect(cleo.page.getByRole('button', { name: 'Rectangle', exact: true })).toBeDisabled();
    await expect(cleo.page.getByRole('button', { name: /^File name: Untitled/ })).toBeDisabled();

    // Drawing, deleting and moving do nothing.
    await canvas(cleo.page).focus();
    await cleo.page.keyboard.press('r');
    await drag(cleo.page, [100, 650], [200, 720]);
    await layer(cleo.page, 'Sun').click();
    await canvas(cleo.page).focus();
    await cleo.page.keyboard.press('Delete');
    await cleo.page.keyboard.press('ArrowRight');
    await expect(layer(cleo.page, 'Sun')).toBeVisible();
    expect(await layerNames(cleo.page)).toEqual(before);
    await expect(status(cleo.page)).toHaveText('Synced');
    await layer(ada.page, 'Sun').click();
    const sun = await boxOf(ada.page);
    expect(await boxOf(cleo.page)).toEqual(sun);

    // The server refuses a change sent straight to it with Cleo's session, whatever the interface does.
    const answer = await cleo.page.evaluate(async (docId) => {
      const token = (JSON.parse(localStorage.getItem('evora:account') ?? '{}') as { token?: string }).token;
      const socket = new WebSocket(`ws://${location.host}/ws`);
      const messages: { t: string; registers?: { k: string; v: unknown }[]; reason?: string }[] = [];
      const next = (): Promise<(typeof messages)[number]> =>
        new Promise((resolve) => {
          const take = (): void => {
            const message = messages.shift();
            if (message) resolve(message);
            else setTimeout(take, 20);
          };
          take();
        });
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as (typeof messages)[number];
        if (message.t !== 'presence') messages.push(message);
      };
      await new Promise((resolve) => (socket.onopen = resolve));
      socket.send(JSON.stringify({ t: 'hello', docId, since: 0, clientId: 'viewertest1', token }));
      const welcome = await next();
      const sunKey = welcome.registers?.find((register) => register.k.endsWith(':name') && register.v === 'Sun')?.k;
      const node = sunKey?.split(':')[1];
      const clock = `${Date.now().toString(36).padStart(9, '0')}.0000.viewertest1`;
      socket.send(JSON.stringify({ t: 'ops', id: 'try', ops: [{ k: `n:${node}:@`, v: false, c: clock }] }));
      const reply = await next();
      socket.close();
      return { welcome: welcome.t, found: Boolean(node), reply: reply.t, reason: reply.reason };
    }, fileUrl.split('/').pop() as string);
    expect(answer).toEqual({ welcome: 'welcome', found: true, reply: 'rejected', reason: 'You can view and comment on this document, not change it' });
    await ada.page.waitForTimeout(500);
    await expect(layer(ada.page, 'Sun')).toBeVisible();

    // A viewer may comment, and the owner sees it.
    await comment(cleo.page, [60, 400], 'Looks good');
    await expect(ada.page.getByRole('button', { name: 'Comment by Cleo: Looks good' })).toBeVisible();
    expect(await layerNames(ada.page)).toEqual(before);
  });

  test("a guest can open the file by its link once its owner allows it, and only to view", async ({ browser }) => {
    const { ada } = people;
    const guest = await arrive(browser, 'Gil');
    try {
      // Without an account, the link asks for a name; the file is not open to its link yet.
      await guest.page.goto(fileUrl);
      await guest.page.getByRole('textbox', { name: 'Your name' }).fill('Gil');
      await guest.page.getByRole('button', { name: 'Continue as a guest' }).click();
      await expect(guest.page.getByRole('alert')).toContainText('This file cannot be opened with your account.');
      // The refused request is the one error expected here.
      expect(guest.errors.filter((error) => !/status of 403/.test(error))).toEqual([]);
      guest.errors.length = 0;

      // Ada lets anyone with the link view it.
      await ada.page.getByRole('button', { name: 'Share', exact: true }).click();
      const share = ada.page.getByRole('dialog', { name: 'Share “Untitled”' });
      await share.getByRole('radio', { name: /Anyone with the link can view/ }).click();
      await expect(share.getByRole('radio', { name: /Anyone with the link can view/ })).toHaveAttribute('aria-checked', 'true');
      await expect(share.getByRole('textbox', { name: 'Link to this file' })).toHaveValue(new RegExp(`${fileUrl.replace(/[/#]/g, '.')}$`));
      await share.getByRole('button', { name: 'Close' }).click();

      await guest.page.getByRole('button', { name: 'Try again' }).click();
      await expect(status(guest.page)).toHaveText('Synced');
      await expect(guest.page.getByText('View only', { exact: true })).toBeVisible();
      await sameLayers(ada.page, guest.page);
      await expect(guest.page.getByRole('button', { name: 'Comment by Ada: @Ben please look at the rectangle' })).toBeVisible();
      await expect(ada.page.getByRole('button', { name: 'Follow Gil' })).toBeVisible();
      await expect(guest.page.getByRole('button', { name: 'Guest: Gil' })).toBeVisible();
      expect(guest.errors).toEqual([]);
    } finally {
      await guest.context.close();
    }
  });

  test('an invite link brings a new person into the workspace', async ({ browser }) => {
    const { ada } = people;
    const dan = await arrive(browser, 'Dan');
    try {
      // Ada makes an invite link from her workspace's members, in another tab.
      const home = await ada.context.newPage();
      await home.goto('/');
      await workspaceEntry(home, "Ada's workspace").click();
      await home.getByRole('button', { name: 'Members', exact: true }).click();
      const members = home.getByRole('dialog', { name: "Members of Ada's workspace" });
      await members.getByRole('combobox', { name: 'Role given by the invite link' }).selectOption('editor');
      await members.getByRole('button', { name: 'Copy invite link' }).click();
      const link = await members.getByRole('textbox', { name: 'Invite link' }).inputValue();
      expect(link).toMatch(/#\/invite\/[0-9A-Za-z_-]+$/);
      await home.close();

      // Dan opens it, creates an account from it and is in the workspace, with its file.
      await dan.page.goto(`/${new URL(link).hash}`);
      await expect(dan.page.getByRole('region', { name: 'Invitation' })).toContainText("Ada invited you to the workspace Ada's workspace.");
      await dan.page.getByRole('button', { name: 'Create an account' }).click();
      await fillAccountForm(dan.page, dan, true);
      await expect(dan.page).toHaveURL(/#\/workspace\//);
      // Ada, Ben and now Dan (Cleo was given the file only).
      await expect(workspaceEntry(dan.page, "Ada's workspace")).toContainText('3 members');
      await dan.page.getByRole('button', { name: 'Open Untitled' }).click();
      await expect(status(dan.page)).toHaveText('Synced');
      await expect(dan.page.getByText('View only', { exact: true })).toHaveCount(0);
      await expect(dan.page.getByRole('button', { name: 'Rectangle', exact: true })).toBeEnabled();
      expect(dan.errors).toEqual([]);
    } finally {
      await dan.context.close();
    }
  });

  test('the file is kept on the server: a reload and a sign-in on another device find all of it', async ({ browser }) => {
    const { ada, ben } = people;
    const all = await sameLayers(ada.page, ben.page);
    expect(all.sort()).toEqual(['Alpha one', 'Beta two', 'Line 1', 'Rectangle 1', 'Star 1', 'Sun']);
    await layer(ada.page, 'Rectangle 1').click();
    const rectangle = await boxOf(ada.page);

    await ada.page.reload();
    await expect(status(ada.page)).toHaveText('Synced');
    expect((await layerNames(ada.page)).sort()).toEqual(all);
    await layer(ada.page, 'Rectangle 1').click();
    expect(await boxOf(ada.page)).toEqual(rectangle);
    await expect(ada.page.getByRole('button', { name: 'Comment by Ada: @Ben please look at the rectangle' })).toBeVisible();

    // Another device: nothing of the file is kept there, so all of it comes from the server.
    const elsewhere = await arrive(browser, 'Ada');
    try {
      elsewhere.email = ada.email;
      await elsewhere.page.goto('/');
      await elsewhere.page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await fillAccountForm(elsewhere.page, elsewhere, false);
      await elsewhere.page.goto(fileUrl);
      await expect(status(elsewhere.page)).toHaveText('Synced');
      expect((await layerNames(elsewhere.page)).sort()).toEqual(all);
      await layer(elsewhere.page, 'Rectangle 1').click();
      expect(await boxOf(elsewhere.page)).toEqual(rectangle);
      await expect(elsewhere.page.getByRole('button', { name: 'Comment by Cleo: Looks good' })).toBeVisible();
      await expect(elsewhere.page.getByRole('button', { name: 'Comment by Ada: @Ben please look at the rectangle' })).toBeVisible();
      expect(elsewhere.errors).toEqual([]);
    } finally {
      await elsewhere.context.close();
    }
  });

  test('a file on this device is shared with its image, and an image added live reaches the other person', async () => {
    const { ada, ben } = people;
    // Ada makes a file on her device with a picture in it: the left half red, the right half blue.
    await ada.page.goto('/');
    await ada.page.getByRole('button', { name: 'New design file' }).click();
    await expect(canvas(ada.page)).toBeVisible();
    await expect(status(ada.page)).toHaveText('Saved');
    await placeImage(ada.page, { name: 'two halves.png', mimeType: 'image/png', buffer: png(200, 100, (x) => (x < 100 ? RED : BLUE)) });
    await expect(layer(ada.page, 'two halves')).toBeVisible();
    const localUrl = ada.page.url();

    // Sharing it puts a copy in her workspace and opens that.
    await ada.page.getByRole('button', { name: 'Share', exact: true }).click();
    const share = ada.page.getByRole('dialog', { name: 'Share “Untitled”' });
    await expect(share.getByRole('combobox', { name: 'Workspace' })).toHaveValue(/.+/);
    await expect(share.getByRole('combobox', { name: 'Workspace' }).locator('option:checked')).toHaveText("Ada's workspace");
    await share.getByRole('button', { name: 'Share this file' }).click();
    await expect(ada.page).toHaveURL(/#\/doc\/[0-9A-Za-z_-]+$/);
    await expect(status(ada.page)).toHaveText('Synced');
    await expect(layer(ada.page, 'two halves')).toBeVisible();
    const sharedUrl = `/${new URL(ada.page.url()).hash}`;
    expect(sharedUrl).not.toBe(fileUrl);

    // Ben opens it: the picture's bytes come from the server, as his device has never had them.
    await ben.page.goto(sharedUrl);
    await expect(status(ben.page)).toHaveText('Synced');
    await expect(layer(ben.page, 'two halves')).toBeVisible();
    const box = await canvas(ben.page).boundingBox();
    if (!box) throw new Error('canvas not visible');
    const middle: [number, number] = [Math.floor(box.width) / 2, Math.floor(box.height) / 2];
    await expect.poll(() => pixel(ben.page, [middle[0] - 60, middle[1]])).toEqual(RED);
    await expect.poll(() => pixel(ben.page, [middle[0] + 60, middle[1]])).toEqual(BLUE);

    // Ben places a green picture while Ada has the file open: it reaches her canvas, bytes and all.
    await placeImage(ben.page, { name: 'green.png', mimeType: 'image/png', buffer: png(60, 40, () => GREEN) });
    await expect(layer(ada.page, 'green')).toBeVisible();
    await expect.poll(() => pixel(ada.page, middle)).toEqual(GREEN);
    expect(await pixel(ada.page, [middle[0] - 60, middle[1]])).toEqual(RED);
    await expect(status(ben.page)).toHaveText('Synced');

    // The file on Ada's device is left as it was.
    await ada.page.goto(localUrl);
    await expect(status(ada.page)).toHaveText('Saved');
    expect(await layerNames(ada.page)).toEqual(['two halves']);
  });
});
