import { expect, test, type Page } from './fixtures.js';
import { writeBundle } from '@pitman/wrsm';
import { syntheticBundle, syntheticNetworkZip } from '../src/lib/network/synthetic.js';
import { packZip } from '../src/lib/network/zip.js';

// A run's warnings reach the page: results aren't to be read without them.

async function run(page: Page, zip: Uint8Array, modes: readonly string[] = []) {
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	for (const id of modes) await page.locator(id).check();
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
	return page.getByRole('region', { name: 'Results' }).locator('[data-run-messages]');
}

test('a warning from the engine stands above the results, and the status names it', async ({ page }) => {
	const bundle = syntheticBundle();
	const first = bundle.network.startYear + 1;
	const late = { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'RR' ? { ...m, areaKm2: [{ year: first, value: m.areaKm2[0]!.value }] } : m)) };
	const panel = await run(page, packZip(writeBundle(late)), ['#mode-historical']);
	await expect(panel.getByRole('heading', { name: 'Read before using these results: 1 warning' })).toBeVisible();
	await expect(panel.locator('li[data-level="warning"]')).toContainText(`don't cover the run`);
	await expect(page.getByText('The run finished with 1 warning: see Results.')).toBeVisible();
});

test('a run with only notes keeps them folded', async ({ page }) => {
	const panel = await run(page, syntheticNetworkZip());
	await expect(panel.getByRole('heading', { name: 'Notes on this run' })).toBeVisible();
	await expect(panel.locator('li').first()).toBeHidden();
	await panel.getByText(/notes? from the run/).click();
	await expect(panel.locator('li').first()).toBeVisible();
	await expect(page.getByText('The run finished.', { exact: true })).toBeVisible();
});
