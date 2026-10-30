import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';

// The page as one product: the cards that start closed, the rail that follows you, and what one card's change
// does to the others. Synthetic data only (rule 2). SwiftShader draws the WebGL, as in map.spec.ts.
test.use({ viewport: { width: 1440, height: 960 }, launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

const fixture = JSON.parse(readFileSync(new URL('../../backend/fixtures/geo/quaternaries.synthetic.geojson', import.meta.url), 'utf8')) as { features: { properties: { code: string }; geometry: unknown }[] };
const QUATERNARIES = { type: 'FeatureCollection', source: 'Invented boundaries for the test', features: fixture.features.map((f) => ({ type: 'Feature', properties: { code: f.properties.code }, geometry: f.geometry })) };

async function load(page: Page) {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: QUATERNARIES }));
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip({ startYear: 1980, years: 30 })) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
}

const show = (page: Page, name: string) => page.getByRole('button', { name: `Show ${name}` }).click();
const rail = (page: Page) => page.getByRole('navigation', { name: 'Steps' });
const mapsStarted = (page: Page) => page.locator('canvas.maplibregl-canvas');

/** A new demand on RV 5, applied. */
async function applyDemand(page: Page) {
	await show(page, 'Demands');
	const panel = page.getByRole('region', { name: 'Demands' });
	await panel.getByRole('button', { name: 'New demand' }).click();
	await panel.getByLabel('Reservoir or channel reach').selectOption('RV5');
	await panel.getByLabel('Volume in that year').fill('1.2');
	await panel.getByRole('button', { name: 'Apply to the working copy' }).click();
	await expect(page.locator('#demand-applied')).toBeFocused();
}

test('the optional cards start closed, saying where they stand, and only the page’s map starts', async ({ page }) => {
	await load(page);
	for (const name of ['Extend rainfall with CHIRPS', 'Sub-divide a quaternary', 'Crop fields and farm dams', 'Land-use tables', 'Demands', 'Calibrate']) {
		await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: `Show ${name}` })).toHaveAttribute('aria-expanded', 'false');
	}
	await expect(page.locator('[data-fold="extend-h"]')).toContainText('Optional: 2 files');
	await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
	await page.locator('section[aria-labelledby="map-h"] .map-wrap').scrollIntoViewIfNeeded();
	await expect(page.locator('section[aria-labelledby="map-h"] .map-wrap')).toHaveAttribute('data-status', 'ready');
	// Scrolling past the closed cards makes no WebGL context.
	await page.locator('#results-output').scrollIntoViewIfNeeded();
	await expect(mapsStarted(page)).toHaveCount(1);
	await show(page, 'Sub-divide a quaternary');
	await page.locator('section[aria-labelledby="subdivide-h"] .map-wrap').scrollIntoViewIfNeeded();
	await expect(page.locator('section[aria-labelledby="subdivide-h"] .map-wrap')).toHaveAttribute('data-status', 'ready');
	await expect(mapsStarted(page)).toHaveCount(2);
});

test('closing a card keeps what was typed in it, and a map draws again when it reopens', async ({ page }) => {
	await load(page);
	await show(page, 'Land-use tables');
	const tables = page.getByRole('region', { name: 'Land-use tables' });
	await tables.getByLabel('Runoff module', { exact: true }).selectOption('1');
	await tables.getByRole('button', { name: 'Add 2025' }).first().click();
	await tables.getByLabel('Afforested area, km² in 2025').fill('3.5');
	await page.getByRole('button', { name: 'Hide Land-use tables' }).click();
	await expect(tables.getByLabel('Afforested area, km² in 2025')).toBeHidden();
	await show(page, 'Land-use tables');
	await expect(tables.getByLabel('Afforested area, km² in 2025')).toHaveValue('3.5');

	await show(page, 'Sub-divide a quaternary');
	const map = page.locator('section[aria-labelledby="subdivide-h"] .map-wrap');
	await map.scrollIntoViewIfNeeded();
	await expect(map).toHaveAttribute('data-status', 'ready');
	await page.getByRole('button', { name: 'Hide Sub-divide a quaternary' }).click();
	await show(page, 'Sub-divide a quaternary');
	await expect.poll(() => map.locator('canvas').evaluate((c) => c.getBoundingClientRect().height)).toBeGreaterThan(200);
});

test('a rail link opens its card, and the rail marks the section you are in', async ({ page }) => {
	await load(page);
	await expect(rail(page).getByRole('link', { name: /Network/ })).toHaveAttribute('aria-current', 'location');
	await rail(page).getByRole('link', { name: /Demands/ }).click();
	await expect(page).toHaveURL(/#demand-h$/);
	await expect(page.getByRole('button', { name: 'Hide Demands' })).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('button', { name: 'New demand' })).toBeVisible();
	await expect(rail(page).getByRole('link', { name: /Demands/ })).toHaveAttribute('aria-current', 'location');
	await expect(rail(page).locator('[aria-current]')).toHaveCount(1);

	// Scrolling on your own moves the mark.
	await page.mouse.move(800, 500);
	await page.mouse.wheel(0, -100_000);
	await expect(rail(page).getByRole('link', { name: /Network/ })).toHaveAttribute('aria-current', 'location');
	await page.locator('section[aria-labelledby="map-h"]').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 70));
	await expect(rail(page).getByRole('link', { name: /^Map/ })).toHaveAttribute('aria-current', 'location');
	// The last cards are too short to reach the line: the end of the page is the last step.
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	await expect(rail(page).getByRole('link', { name: /^Results/ })).toHaveAttribute('aria-current', 'location');
});

test('a link to a closed card, from outside the rail, opens it', async ({ page }) => {
	await load(page);
	await page.goto('/#calibrate-h');
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Hide Calibrate' })).toHaveAttribute('aria-expanded', 'true');
});

test('applying in one card keeps what is typed in the others', async ({ page }) => {
	await load(page);
	await show(page, 'Land-use tables');
	const tables = page.getByRole('region', { name: 'Land-use tables' });
	await tables.getByLabel('Runoff module', { exact: true }).selectOption('1');
	await tables.getByRole('button', { name: 'Add 2025' }).first().click();
	await tables.getByLabel('Afforested area, km² in 2025').fill('3.5');
	await show(page, 'Calibrate');
	const calibrate = page.getByRole('region', { name: 'Calibrate' });
	await calibrate.getByLabel('Runoff module', { exact: true }).selectOption('1');
	await calibrate.getByLabel(/^ST /).fill('420');

	await applyDemand(page);

	await expect(tables.getByLabel('Afforested area, km² in 2025')).toHaveValue('3.5');
	await expect(calibrate.getByLabel(/^ST /)).toHaveValue('420');
});

test('results cleared by a change say why, and the rail and bar say to run again', async ({ page }) => {
	await load(page);
	await expect(page.getByRole('banner')).toContainText('Not run yet');
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
	await applyDemand(page);
	await expect(page.getByRole('banner')).toContainText('Run again: the network changed');
	await expect(rail(page)).toContainText('1 demand');
	await expect(page.locator('[data-results="cleared"]')).toContainText('The last results were cleared because the network changed.');

	await page.locator('#demand-applied').getByRole('button', { name: 'Rerun the network' }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByRole('banner')).not.toContainText('Run again');
	await expect(page.locator('[data-results="cleared"]')).toHaveCount(0);
});

test('a quaternary picked on the map follows into the cards until one is chosen there', async ({ page }) => {
	await load(page);
	const map = page.locator('section[aria-labelledby="map-h"]');
	await map.getByLabel('Quaternary', { exact: true }).selectOption('Z01A');
	await show(page, 'Sub-divide a quaternary');
	await show(page, 'Crop fields and farm dams');
	const split = page.getByRole('region', { name: 'Sub-divide a quaternary' }).getByLabel('Quaternary', { exact: true });
	const fields = page.getByRole('region', { name: 'Crop fields and farm dams' }).getByLabel('Quaternary', { exact: true });
	await expect(split).toHaveValue('Z01A');
	await expect(fields).toHaveValue('Z01A');

	await map.getByLabel('Quaternary', { exact: true }).selectOption('Z01B');
	await expect(split).toHaveValue('Z01B');
	await expect(fields).toHaveValue('Z01B');

	await split.selectOption('Z02A');
	await fields.selectOption('Z02B');
	await map.getByLabel('Quaternary', { exact: true }).selectOption('Z01C');
	await expect(split).toHaveValue('Z02A');
	await expect(fields).toHaveValue('Z02B');
});

test('forgetting a working copy with unsaved changes asks first, and a save means it needn’t', async ({ page }) => {
	await load(page);
	await applyDemand(page);
	await expect(page.locator('[data-unsaved]')).toHaveAttribute('data-unsaved', 'true');
	await page.getByRole('button', { name: 'Forget the working copy' }).click();
	await expect(page.getByRole('alert')).toContainText('holds changes that aren’t in a saved zip');
	await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused();
	await page.getByRole('button', { name: 'Keep it' }).click();
	await expect(page.getByRole('button', { name: 'Forget the working copy' })).toBeFocused();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();

	// A reload doesn't lose the fact: the browser still holds the only copy.
	await expect(page.locator('[data-working-copy]')).toHaveAttribute('data-working-copy', 'stored');
	await page.reload();
	await expect(page.locator('[data-unsaved]')).toHaveAttribute('data-unsaved', 'true');
	await page.getByText('Load a different network').click();
	await expect(page.locator('details.another')).toContainText('replaces the working copy');

	const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save as WRSM2000 zip' }).click()]);
	expect(download.suggestedFilename()).toMatch(/\.zip$/);
	await expect(page.locator('[data-unsaved]')).toHaveAttribute('data-unsaved', 'false');
	await page.getByRole('button', { name: 'Forget the working copy' }).click();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toHaveCount(0);
});

test('a year added by mistake can be removed, even from an empty table', async ({ page }) => {
	await load(page);
	await show(page, 'Land-use tables');
	const tables = page.getByRole('region', { name: 'Land-use tables' });
	await tables.getByLabel('Runoff module', { exact: true }).selectOption('1');
	const block = tables.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Afforestation', exact: true }) });
	await block.getByRole('button', { name: 'Add 2025' }).click();
	await block.getByRole('button', { name: 'Remove 2025' }).click();
	await expect(block).toContainText('No years in this table.');
	await expect(block.getByLabel('Add a year')).toBeFocused();
});
