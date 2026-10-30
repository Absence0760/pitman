import { expect, test, type Page } from '@playwright/test';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';

// The app shell: one page title in every state, the step rail, Save in the
// bar, and no sideways scroll on a phone. Synthetic data only (rule 2).

async function load(page: Page) {
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip()) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
}

async function expectNoSidewaysScroll(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

test('the landing page has one title, the promises and the load panel', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(page.getByText('Your files stay in your browser.').first()).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Load a network' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Steps' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Save as WRSM2000 zip' })).toHaveCount(0);
});

test('a loaded network replaces the landing page with the steps, and its name is the title', async ({ page }) => {
	await load(page);
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Network SY');
	await expect(page.getByRole('banner').getByRole('button', { name: 'Save as WRSM2000 zip' })).toBeVisible();
	const steps = page.getByRole('navigation', { name: 'Steps' }).getByRole('listitem');
	await expect(steps).toHaveText([/Network/, /Extend rainfall/, /Calibrate/, /Not run yet/, /Run the network first/]);
});

test('the rail follows the run and its links reach their sections', async ({ page }) => {
	await load(page);
	await page.locator('#mode-natural').check();
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
	const rail = page.getByRole('navigation', { name: 'Steps' });
	await expect(rail.getByRole('listitem').nth(3)).toContainText('modes run');
	await expect(page.getByRole('banner')).toContainText('modes run');
	await rail.getByRole('link', { name: /Results/ }).click();
	await expect(page).toHaveURL(/#results-output$/);
	await expect(page.getByRole('region', { name: 'Results' })).toBeInViewport({ ratio: 0.05 });
});

test('another network can be loaded from a loaded one', async ({ page }) => {
	await load(page);
	await page.getByText('Load a different network').click();
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip()) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
});

test('no sideways scroll on a phone, before or after loading', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await expectNoSidewaysScroll(page);
	await load(page);
	await expectNoSidewaysScroll(page);
});

test('the self-hosted font loads under the page\'s content security policy', async ({ page }) => {
	const blocked: string[] = [];
	page.on('console', (m) => {
		if (/content security policy/i.test(m.text())) blocked.push(m.text());
	});
	await page.goto('/');
	await page.evaluate(() => document.fonts.ready);
	expect(await page.evaluate(() => document.fonts.check('16px "Inter Variable"'))).toBe(true);
	expect(blocked).toEqual([]);
});

test('every step is on screen on a phone, with Extend still in reach', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await load(page);
	const steps = page.getByRole('navigation', { name: 'Steps' }).getByRole('listitem');
	for (const i of [0, 1, 2, 3, 4]) await expect(steps.nth(i)).toBeInViewport({ ratio: 1 });
	const extend = page.getByRole('region', { name: 'Extend rainfall with CHIRPS' }).getByRole('button', { name: /^Extend / }).first();
	await extend.scrollIntoViewIfNeeded();
	const box = await extend.boundingBox();
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
});

test('the file pickers answer the keyboard', async ({ page }) => {
	await page.goto('/');
	await page.locator('#load-zip').focus();
	await expect(page.locator('#load-zip')).toBeFocused();
	const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Space')]);
	expect(chooser.isMultiple()).toBe(false);
});

test('a table head in the dark theme is not white', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	await load(page);
	const head = page.getByRole('table', { name: 'Rainfall files' }).locator('thead th').first();
	const channels = (await head.evaluate((el) => getComputedStyle(el).backgroundColor)).match(/\d+/g)?.map(Number) ?? [];
	expect(Math.max(...channels.slice(0, 3))).toBeLessThan(60);
});
