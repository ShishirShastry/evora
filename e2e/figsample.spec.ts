import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * A real Figma file, opened in the browser as a designer opens it. The file
 * ("EXPATS final.fig", supplied by the owner) is the owner's own design and
 * is kept outside the repository, in `.tools/fig-samples/`; without it this
 * test is skipped.
 */

const SAMPLE = '.tools/fig-samples/EXPATS final.fig';
test.skip(!existsSync(SAMPLE), 'The sample Figma file is not on this machine: put "EXPATS final.fig" in .tools/fig-samples/.');

test('a real Figma file opened from the file browser: everything in it converts, so it opens at once', async ({ page }) => {
  test.setTimeout(420000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import file…' }).click()]);
  await chooser.setFiles({ name: 'EXPATS final.fig', mimeType: 'application/octet-stream', buffer: readFileSync(SAMPLE) });

  // Nothing was left out, so there is no list of what was: the file opens straight away.
  const canvas = page.getByRole('application', { name: 'Design canvas' });
  await expect(canvas).toBeVisible({ timeout: 240000 });
  await expect(page.getByRole('dialog', { name: 'Figma file opened' })).toHaveCount(0);

  // The file: its pages, its components, and no repairs needed when it is opened.
  await expect(page.getByRole('button', { name: /^File name: EXPATS final/ })).toBeVisible();
  const sidebar = page.getByRole('navigation', { name: 'Pages and layers' });
  for (const name of ['Design system', 'App screens', 'Cover & decisions']) await expect(sidebar.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Components' }).getByRole('button', { name: /^Go to component / }).first()).toBeVisible();
  await expect(page.getByText('This file had problems that were repaired')).toHaveCount(0);

  // The design is drawn: zoomed to fit, the page is not empty canvas.
  await canvas.focus();
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(1500);
  const colours = await page.evaluate(() => {
    const element = document.querySelector('canvas') as HTMLCanvasElement;
    const data = (element.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, element.width, element.height).data;
    const seen = new Set<string>();
    for (let i = 0; i < data.length; i += 4 * 97) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return seen.size;
  });
  expect(colours).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});
