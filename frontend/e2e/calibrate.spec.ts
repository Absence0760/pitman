import { expect, test, type Page } from '@playwright/test';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';

// Calibration end to end on the synthetic network (rule 2), with the real worker.
// Add once CalibratePanel is wired into +page.svelte; it needs no other fixture.

async function open(page: Page) {
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip({ startYear: 1980, years: 30 })) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await page.getByLabel('Runoff module', { exact: true }).selectOption('1');
	await expect(page.getByRole('table', { name: /WR2012 flow statistics/ })).toBeVisible();
}

test('an edit previews against the gauge and changes nothing until applied', async ({ page }) => {
	await open(page);
	const fit = page.getByRole('table', { name: /WR2012 flow statistics/ });
	await expect(fit.getByRole('columnheader')).toHaveText(['Statistic', 'Observed', 'Current values']);
	await page.getByLabel(/^ST /).fill('420');
	await expect(page.getByText('Preview of 1 edit.')).toBeVisible();
	await expect(fit.getByRole('columnheader')).toHaveText(['Statistic', 'Observed', 'Before', 'With edits']);
	await page.getByRole('button', { name: /Reset ST/ }).click();
	await expect(page.getByText('Change a value to see what it does.')).toBeVisible();
	await expect(fit.getByRole('columnheader')).toHaveText(['Statistic', 'Observed', 'Current values']);
});

test('a bad value says why, stops the preview and blocks apply', async ({ page }) => {
	await open(page);
	await page.getByLabel(/^R /).fill('2');
	await expect(page.getByText('R must be between 0 and 1 (TT 690 p.5).')).toBeVisible();
	await expect(page.getByText(/Preview paused/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Apply to the working copy' })).toBeDisabled();
});

test('apply writes the value and the sidecar, clears results, and survives a save and reload', async ({ page }) => {
	await open(page);
	await page.getByLabel(/^ST /).fill('420');
	await expect(page.getByText('Preview of 1 edit.')).toBeVisible();
	await page.getByLabel(/^Reason/).fill('deeper soils');
	await page.getByRole('button', { name: 'Apply to the working copy' }).click();
	await expect(page.locator('#calibrate-applied')).toBeFocused();
	await expect(page.locator('#calibrate-applied')).toContainText('pitman.json');
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await page.getByLabel('Runoff module', { exact: true }).selectOption('1');
	await expect(page.getByLabel(/^ST /)).toHaveValue('420');
	await expect(page.getByRole('button', { name: /Reset ST to/ })).toBeEnabled();
});

test('no sideways scroll on a phone with the panel open', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await open(page);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
