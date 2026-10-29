import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';

// Round 3 exit test (issue #3): load a synthetic network zip → run in each
// mode → results render → save → reload the saved zip → identical results.
// Synthetic data only (rule 2).

async function loadZip(page: Page, name: string, buffer: Buffer) {
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name, mimeType: 'application/zip', buffer });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
}

async function runAllModes(page: Page) {
	for (const id of ['#mode-present', '#mode-natural', '#mode-historical']) await page.locator(id).check();
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByRole('list', { name: 'Modes that failed' })).toHaveCount(0);
}

/** The CSV of every run (and observed flow) at the gauged route the results open on. */
async function resultsCsv(page: Page): Promise<string> {
	const results = page.getByRole('region', { name: 'Results' });
	await expect(results).toBeVisible();
	await expect(results.getByLabel('Route or reservoir')).toBeVisible();
	await expect(results.locator('figure[data-chart="monthly"] [data-ready="true"]')).toBeVisible();
	await expect(results.locator('tr[data-statistic="marMm3"]')).toBeVisible();
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		results.getByRole('button', { name: /^Download CSV/ }).click()
	]);
	return readFile((await download.path())!, 'latin1');
}

test('load → run every mode → save → reload the saved zip → identical results', async ({ page }) => {
	await page.goto('/');
	await loadZip(page, 'SY.zip', Buffer.from(syntheticNetworkZip()));
	await runAllModes(page);
	const before = await resultsCsv(page);
	expect(before.split('\n').length).toBeGreaterThan(12);

	const [saved] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('button', { name: 'Save as WRSM2000 zip' }).click()
	]);
	const savedZip = await readFile((await saved.path())!);

	await page.getByRole('button', { name: 'Forget the working copy' }).click();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toHaveCount(0);

	await loadZip(page, saved.suggestedFilename(), savedZip);
	await runAllModes(page);
	expect(await resultsCsv(page)).toBe(before);
});

test('the working copy survives a page reload', async ({ page }) => {
	await page.goto('/');
	await loadZip(page, 'SY.zip', Buffer.from(syntheticNetworkZip()));
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
});
