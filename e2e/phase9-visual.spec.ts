import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A guard for the Phase 9 screens in the light theme on a phone (375 px wide):
 * the version history panel, the plugin manager, the Community and a file page
 * fit the screen (no sideways scrolling, nothing past its edges), and their
 * key headings and buttons can be read: the colour of their text differs from
 * what is behind it by a contrast ratio of at least 3:1.
 *
 * What is made for it (an account, a shared file with a version, a published
 * resource, a file in the trash) is made at the usual desktop width first; the
 * editor's main menu opens its submenus off a phone's screen, so the plugin
 * manager is opened wide and the window narrowed after.
 */

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
const RUN = Date.now().toString(36);

type RGBA = [number, number, number, number];

/** The WCAG contrast ratio of two opaque colours. */
function contrastRatio(a: RGBA, b: RGBA): number {
  const luminance = ([r, g, b]: RGBA): number => {
    const [R, G, B] = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The colour of an element's text and the colour behind it, both opaque: the
 * backgrounds of the element and its ancestors laid over one another (a
 * gradient counts as the average of its stops), over white at the bottom.
 */
async function colours(locator: Locator): Promise<{ text: RGBA; background: RGBA }> {
  return locator.evaluate((element) => {
    const parse = (value: string): [number, number, number, number][] =>
      [...value.matchAll(/rgba?\(([^)]+)\)/g)].map((match) => {
        const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
      });
    const over = (top: number[], bottom: number[]): [number, number, number, number] => {
      const a = top[3];
      return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
    };
    // The layers of background from the element outwards, until an opaque one.
    const layers: number[][] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const stops = style.backgroundImage.includes('gradient') ? parse(style.backgroundImage) : [];
      if (stops.length > 0) {
        const mean = [0, 1, 2, 3].map((i) => stops.reduce((sum, stop) => sum + stop[i], 0) / stops.length);
        layers.push(mean);
        if (mean[3] >= 1) break;
      }
      const [colour] = parse(style.backgroundColor);
      if (colour && colour[3] > 0) {
        layers.push(colour);
        if (colour[3] >= 1) break;
      }
    }
    let background = [255, 255, 255, 1];
    for (const layer of layers.reverse()) background = over(layer, background);
    const [text] = parse(getComputedStyle(element).color);
    return { text: over(text, background) as RGBA, background: background as RGBA };
  });
}

async function expectReadable(locator: Locator, minimum = 3): Promise<void> {
  await expect(locator).toBeVisible();
  const { text, background } = await colours(locator);
  const ratio = contrastRatio(text, background);
  expect(ratio, `contrast of ${await locator.evaluate((element) => element.textContent?.trim() || element.getAttribute('aria-label'))}: text ${text.join(',')} on ${background.join(',')}`).toBeGreaterThanOrEqual(minimum);
}

/** No sideways scrolling of the page. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.scrollingElement?.scrollWidth ?? 0, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

/** An element lies wholly within the width of the screen. */
async function expectWithinScreen(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) throw new Error('not visible');
  const width = await locator.page().evaluate(() => window.innerWidth);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

const canvas = (page: Page): Locator => page.getByRole('application', { name: 'Design canvas' });
const status = (page: Page): Locator => page.getByRole('navigation', { name: 'Pages and layers' }).getByRole('status');
const rail = (page: Page): Locator => page.getByRole('navigation', { name: 'Workspaces' });

async function rename(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /^File name:/ }).click();
  await page.getByRole('textbox', { name: 'File name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'File name', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: new RegExp(`^File name: ${name}`) })).toBeVisible();
}

test.describe.serial('Phase 9 screens in the light theme on a phone', () => {
  let page: Page;
  let fileUrl = '';
  const errors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    await context.addInitScript(() => {
      const key = 'evora:preferences';
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...saved, theme: 'light' }));
    });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));

    // An account.
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('dialog', { name: 'Sign in' }).getByRole('tab', { name: 'Create account' }).click();
    const account = page.getByRole('dialog', { name: 'Create an account' });
    await account.getByLabel('Name').fill('Vera');
    await account.getByLabel('Email').fill(`vera-${RUN}@example.test`);
    await account.getByLabel('Password').fill('a long enough password');
    await account.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Account: Vera' })).toBeVisible();

    // A shared file with a rectangle, and a second one that goes to the trash.
    const workspace = rail(page).getByRole('button', { name: /^Vera's workspace/ });
    for (const name of ['Throwaway', 'Visual check']) {
      await workspace.click();
      await page.getByRole('button', { name: 'New shared file' }).click();
      await expect(status(page)).toHaveText('Synced');
      await rename(page, name);
      await expect(status(page)).toHaveText('Synced');
      if (name === 'Throwaway') await page.goto('/');
    }
    fileUrl = `/${new URL(page.url()).hash}`;
    await canvas(page).focus();
    await page.keyboard.press('r');
    const box = await canvas(page).boundingBox();
    if (!box) throw new Error('canvas not visible');
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 200, { steps: 6 });
    await page.mouse.up();
    await expect(status(page)).toHaveText('Synced');

    // Published to the Community, and the other file deleted.
    await page.goto('/');
    await workspace.click();
    await page.getByRole('button', { name: 'More actions for Visual check', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Publish to Community…', exact: true }).click();
    const publish = page.getByRole('dialog', { name: 'Publish to Community' });
    await publish.getByLabel('Title').fill(`Visual kit ${RUN}`);
    await publish.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.getByRole('dialog', { name: 'Published' }).getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'More actions for Throwaway', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete shared file' }).getByRole('button', { name: 'Delete file' }).click();
    await expect(page.getByRole('button', { name: 'Open Throwaway' })).toHaveCount(0);
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('the version history panel fits the phone and can be read and closed', async () => {
    await page.setViewportSize(DESKTOP);
    await page.goto(fileUrl);
    await expect(status(page)).toHaveText('Synced');
    await page.setViewportSize(PHONE);
    await page.getByRole('button', { name: 'Show version history' }).click();
    const panel = page.getByRole('complementary', { name: 'Version history' });
    await panel.getByRole('button', { name: 'Save to version history' }).click();
    const save = page.getByRole('dialog', { name: 'Save to version history' });
    await expectWithinScreen(save);
    await save.getByLabel('Title').fill('Phone check');
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    const named = panel.getByRole('list', { name: 'Versions' }).getByRole('button', { name: /^Phone check/ });
    await expect(named).toBeVisible();
    // The panel takes the screen's width, and no more.
    await expectWithinScreen(panel);
    expect((await panel.boundingBox())?.width).toBeGreaterThan(PHONE.width - 24);
    await expectReadable(panel.getByRole('heading', { name: 'Version history' }));
    await expectReadable(named.locator('span span').first());
    await expectReadable(panel.getByRole('button', { name: 'Compare…' }));

    // The version viewed: over the whole screen, its buttons in view.
    await named.click();
    const viewer = page.getByRole('dialog', { name: 'Viewing Phone check' });
    await expectWithinScreen(viewer);
    await expectWithinScreen(viewer.getByRole('button', { name: 'Restore this version' }));
    await expectWithinScreen(viewer.getByRole('button', { name: 'Back to current' }));
    await expectReadable(viewer.getByRole('button', { name: 'Back to current' }));
    await viewer.getByRole('button', { name: 'Back to current' }).click();
    await expect(viewer).toHaveCount(0);

    // Compared: the list of changes is on the screen, not squeezed off it.
    await panel.getByRole('button', { name: 'More actions for Phone check' }).click();
    await page.getByRole('menuitem', { name: 'Compare with current' }).click();
    const compare = page.getByRole('dialog', { name: 'Compare versions' });
    const changes = compare.getByRole('complementary', { name: 'Changes' });
    await expectWithinScreen(changes);
    expect((await changes.boundingBox())?.width).toBeGreaterThan(PHONE.width / 2);
    await expectReadable(compare.getByRole('button', { name: 'Done', exact: true }));
    await compare.getByRole('button', { name: 'Done', exact: true }).click();

    await panel.getByRole('button', { name: 'Close version history' }).click();
    await expect(panel).toHaveCount(0);
  });

  test('the plugin manager fits the phone and can be read', async () => {
    await page.setViewportSize(DESKTOP);
    await page.getByRole('button', { name: 'Main menu' }).click();
    await page.getByRole('menuitem', { name: 'Plugins', exact: true }).click();
    await page.getByRole('menu', { name: 'Plugins', exact: true }).getByRole('menuitem', { name: 'Manage plugins…' }).click();
    await page.setViewportSize(PHONE);
    const manager = page.getByRole('dialog', { name: 'Plugins and widgets' });
    await expectWithinScreen(manager);
    await expectReadable(manager.getByRole('heading', { name: 'Plugins and widgets' }));
    await expectReadable(manager.getByRole('tab', { name: 'Installed' }));
    await expectReadable(manager.getByRole('button', { name: 'Install from file…' }));
    await expectReadable(manager.getByText('Installed plugins and widgets are available in every file on this device.'));
    await expectWithinScreen(manager.getByRole('button', { name: 'Install from file…' }));
    await manager.getByRole('tab', { name: 'Browse' }).click();
    await expectWithinScreen(manager.getByRole('tablist', { name: 'Kind' }));
    await expectWithinScreen(manager.getByRole('searchbox', { name: 'Search plugins and widgets' }));
    await manager.getByRole('button', { name: 'Close' }).click();
    await expect(manager).toHaveCount(0);
  });

  test('the Community fits the phone and can be read', async () => {
    await page.goto('/');
    await rail(page).getByRole('button', { name: /^Community/ }).click();
    await expect(page.getByRole('list', { name: 'Resources' })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectReadable(page.getByRole('heading', { name: 'Explore the Community' }));
    const sections = page.getByRole('tablist', { name: 'Community sections' });
    await expectWithinScreen(sections);
    for (const name of ['Files & templates', 'Plugins & widgets', 'Your resources']) {
      await expectWithinScreen(sections.getByRole('tab', { name }));
      await expectReadable(sections.getByRole('tab', { name }));
    }
    await sections.getByRole('tab', { name: 'Your resources' }).click();
    const unpublish = page.getByRole('button', { name: 'Unpublish…' }).first();
    await expectReadable(unpublish);
    // It is in the danger colour, not the text's.
    const { text } = await colours(unpublish);
    expect(text[0]).toBeGreaterThan(text[2] + 60);
    await expectNoSidewaysScroll(page);
  });

  test('a file page and the trash fit the phone and can be read', async () => {
    await page.goto('/');
    await rail(page).getByRole('button', { name: /^Vera's workspace/ }).click();
    await expect(page.getByRole('button', { name: 'Open Visual check' })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectWithinScreen(page.getByRole('button', { name: 'New design file' }));
    await expectWithinScreen(page.getByRole('button', { name: 'New shared file' }));
    await expectReadable(page.getByRole('heading', { name: "Vera's workspace" }));
    await page.getByRole('radio', { name: 'List view' }).click();
    await expectNoSidewaysScroll(page);
    await page.getByRole('radio', { name: 'Grid view' }).click();

    await rail(page).getByRole('button', { name: /^Trash/ }).click();
    const trash = page.getByRole('list', { name: 'Deleted files' });
    await expect(trash).toContainText('Throwaway');
    await expectNoSidewaysScroll(page);
    await expectReadable(page.getByRole('heading', { name: 'Trash' }));
    const forever = trash.getByRole('button', { name: 'Delete Throwaway forever' });
    await expectWithinScreen(forever);
    await expectReadable(forever);
    await expectWithinScreen(trash.getByRole('button', { name: 'Restore Throwaway' }));
  });
});
