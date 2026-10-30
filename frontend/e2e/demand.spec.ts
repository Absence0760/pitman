import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';
import { unpackZip } from '../src/lib/network/zip.js';

// The demand form on the real page: a new demand on RV 5, on its way into the saved zip. Synthetic data only (rule 2).

async function start(page: Page) {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: { type: 'FeatureCollection', features: [], source: 'none' } }));
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip({ startYear: 1980, years: 30 })) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await page.getByRole('button', { name: 'Show Demands' }).click();
	return page.getByRole('region', { name: 'Demands' });
}

/** The form open on a new demand on RV 5's new route, 1.2 million m³/a from a typed source. */
async function fill(page: Page) {
	const panel = await start(page);
	await panel.getByRole('button', { name: 'New demand' }).click();
	await expect(panel.getByRole('heading', { name: 'New demand' })).toBeFocused();
	await panel.getByLabel('Reservoir or channel reach').selectOption('RV5');
	await expect(panel.getByLabel('Route', { exact: true })).toHaveValue('new');
	await panel.getByLabel('Volume in that year').fill('1.2');
	await panel.locator('#demand-annual-note').fill('Municipal abstraction licence');
	return panel;
}

const apply = (panel: ReturnType<Page['getByRole']>) => panel.getByRole('button', { name: 'Apply to the working copy' });

test('a new demand on RV 5 previews its file, applies, and focus moves to what happened', async ({ page }) => {
	const panel = await fill(page);
	await expect(panel.locator('[data-fact="file"]')).toHaveText('SYRQ10.abs');
	await expect(panel.locator('[data-fact="years"]')).toHaveText('1980/81 to 2009/10');
	await expect(panel.locator('[data-source="annual"]')).toContainText('Typed in on');
	await apply(panel).click();
	await expect(page.locator('#demand-applied')).toBeFocused();
	await expect(page.locator('#demand-applied')).toContainText('SYRQ10.abs on RV 5 route 10');
	await expect(panel.getByRole('table', { name: 'Demand files' }).locator('tr[data-file="SYRQ10.ABS"]')).toContainText('1.20');
});

test('a reload keeps the volume and where it came from', async ({ page }) => {
	const panel = await fill(page);
	await apply(panel).click();
	await expect(page.locator('#demand-applied')).toBeFocused();
	await expect(page.locator('[data-working-copy]')).toHaveAttribute('data-working-copy', 'stored');
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await page.getByRole('button', { name: 'Show Demands' }).click();
	const after = page.getByRole('region', { name: 'Demands' });
	await after.getByRole('button', { name: 'Edit SYRQ10.abs' }).click();
	await expect(after.getByRole('heading', { name: 'Edit SYRQ10.abs' })).toBeFocused();
	await expect(after.getByLabel('Volume in that year')).toHaveValue('1.2');
	await expect(after.locator('#demand-annual-note')).toHaveValue('Municipal abstraction licence');
	await expect(after.locator('[data-source="annual"]')).toContainText('Municipal abstraction licence');
});

test('shares that miss 100 stop Apply and Scale puts them right', async ({ page }) => {
	const panel = await fill(page);
	await expect(apply(panel)).toBeEnabled();
	await panel.getByLabel('October share, %').fill('20');
	await expect(panel.locator('[data-sum-ok]')).toHaveText('Sum: 111.67 %, 11.67 over 100');
	await expect(panel.locator('[data-sum-ok]')).toHaveAttribute('data-sum-ok', 'false');
	await expect(panel.locator('[data-preview="paused"]')).toContainText('The 12 shares must add up to 100 %');
	await expect(apply(panel)).toBeDisabled();
	await panel.getByRole('button', { name: 'Scale to 100 %' }).click();
	await expect(panel.locator('[data-sum-ok]')).toHaveText('Sum: 100.00 %');
	await expect(panel.locator('[data-sum-ok]')).toHaveAttribute('data-sum-ok', 'true');
	await expect(apply(panel)).toBeEnabled();
});

test('Cancel changes nothing and returns the focus to the button that opened the form', async ({ page }) => {
	const panel = await fill(page);
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(panel.getByRole('button', { name: 'New demand' })).toBeFocused();
	await expect(panel.getByRole('table', { name: 'Demand files' }).locator('tr[data-file="SYRQ10.ABS"]')).toHaveCount(0);
});

test('the saved zip holds the file and RV 5 reads it on its new route', async ({ page }) => {
	const panel = await fill(page);
	await apply(panel).click();
	await expect(page.locator('#demand-applied')).toBeFocused();
	const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save as WRSM2000 zip' }).click()]);
	const files = unpackZip(new Uint8Array(await readFile((await saved.path())!)));
	const reservoir = files[Object.keys(files).find((name) => /SYRV5\.DAT$/i.test(name))!]!;
	expect(reservoir).toContain(`10 'SYRQ10.abs'`);
	const demand = files[Object.keys(files).find((name) => /SYRQ10\.abs$/i.test(name))!]!;
	expect(demand.trim().split('\n')).toHaveLength(30);
});

test('no sideways scroll on a phone with the form open', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await fill(page);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
