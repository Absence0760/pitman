import { expect, test, type Locator, type Page } from '@playwright/test';
import { syntheticChirpsMonthly } from '@pitman/wrsm';
import { writeBundle } from '../src/lib/network/engine.js';
import { syntheticBundle } from '../src/lib/network/synthetic.js';
import { packZip } from '../src/lib/network/zip.js';

// What every uPlot chart on the page does, whichever screen draws it: drawn once, as wide as its box; a resize follows
// the box and keeps the chart, crossing the narrow width rebuilds it, a theme flip redraws it, a new spec replaces it,
// and going away leaves nothing behind. Results, the extension's fit and the land-use series. Synthetic data only (rule 2).

const AREA = JSON.stringify({ type: 'Polygon', coordinates: [[[22, -33.5], [22.3, -33.5], [22.3, -33.2], [22, -33.2], [22, -33.5]]] });

async function load(page: Page) {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: { type: 'FeatureCollection', features: [], source: 'none' } }));
	await page.route('**/chirps/monthly', (route) => route.fulfill({ json: syntheticChirpsMonthly() }));
	await page.goto('/');
	const bundle = syntheticBundle({ startYear: 1980, years: 30 });
	const modules = bundle.modules.map((m) => (m.kind === 'RU' && m.number === 1 ? { ...m, afforestation: { ...m.afforestation, areaKm2: [{ year: 1990, value: 2 }, { year: 2005, value: 4.5 }] } } : m));
	const zip = Buffer.from(packZip(writeBundle({ ...bundle, modules })));
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: zip });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
}

/** Each screen's chart, opened; the locator is the action's own node. */
const SCREENS: Record<string, (page: Page) => Promise<Locator>> = {
	results: async (page) => {
		await page.getByRole('button', { name: 'Run', exact: true }).click();
		await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
		return page.locator('figure[data-chart="monthly"] .canvas');
	},
	extend: async (page) => {
		await page.getByRole('button', { name: 'Extend SYA.RAN' }).click();
		await page.locator('[id^="extend-"][type=file]').setInputFiles({ name: 'area.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(AREA) });
		await page.getByRole('button', { name: 'Fetch CHIRPS for this area' }).click();
		return page.locator('figure[data-chart="extend-means"] .canvas');
	},
	'land-use': async (page) => {
		await page.getByRole('region', { name: 'Land-use tables' }).getByLabel('Runoff module', { exact: true }).selectOption('1');
		return page.locator('figure[data-chart="tables-afforestation-chart"] .canvas');
	}
};

/** Tag the drawn chart, so a test can tell the same chart resized from a new one. */
const tag = (chart: Locator) => chart.locator('.uplot').evaluate((el) => el.setAttribute('data-test-tag', 'kept'));
const widthOf = (chart: Locator) => chart.locator('canvas').evaluate((el) => el.getBoundingClientRect().width);

for (const [screen, open] of Object.entries(SCREENS)) {
	test(`${screen}: drawn once, as wide as its box`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 960 });
		await load(page);
		const chart = await open(page);
		await expect(chart).toHaveAttribute('data-ready', 'true');
		await expect(chart.locator('.uplot')).toHaveCount(1);
		const box = await chart.evaluate((el) => el.clientWidth);
		expect(await widthOf(chart)).toBeGreaterThan(box - 2);
		expect(await widthOf(chart)).toBeLessThanOrEqual(box);
	});

	test(`${screen}: a resize follows the box, and crossing the narrow width rebuilds it`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 960 });
		await load(page);
		const chart = await open(page);
		await expect(chart).toHaveAttribute('data-ready', 'true');
		// Each width in turn: the same chart while it stays on one side of 480 px, a new one (axis titles gone or back) when it crosses.
		let before = await widthOf(chart);
		for (const width of [1100, 800, 390]) {
			await tag(chart);
			await page.setViewportSize({ width, height: 844 });
			await expect.poll(async () => Math.abs((await widthOf(chart)) - (await chart.evaluate((el) => el.clientWidth)))).toBeLessThan(2);
			const now = await widthOf(chart);
			await expect(chart.locator('[data-test-tag]')).toHaveCount(before < 480 !== now < 480 ? 0 : 1);
			await expect(chart.locator('.uplot')).toHaveCount(1);
			await expect(chart).toHaveAttribute('data-ready', 'true');
			before = now;
		}
		expect(before).toBeLessThan(480);
	});

	test(`${screen}: a theme flip redraws it`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: 'light' });
		await load(page);
		const chart = await open(page);
		await expect(chart).toHaveAttribute('data-ready', 'true');
		await tag(chart);
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(chart.locator('[data-test-tag]')).toHaveCount(0);
		await expect(chart.locator('.uplot')).toHaveCount(1);
	});
}

test('a new spec replaces the chart in place', async ({ page }) => {
	await load(page);
	const chart = await SCREENS['land-use']!(page);
	await expect(chart).toHaveAttribute('data-ready', 'true');
	await tag(chart);
	await page.getByLabel('Afforested area, km² in 2005').fill('6');
	await expect(chart.locator('[data-test-tag]')).toHaveCount(0);
	await expect(chart.locator('.uplot')).toHaveCount(1);
	await expect(page.locator('figure[data-chart="tables-afforestation-chart"]')).toContainText('With your edits');
});

test('a chart that goes away leaves nothing behind, and a theme flip after it logs no error', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await load(page);
	const chart = await SCREENS['land-use']!(page);
	await expect(chart).toHaveAttribute('data-ready', 'true');
	await page.getByRole('region', { name: 'Land-use tables' }).getByLabel('Runoff module', { exact: true }).selectOption('');
	await expect(chart).toHaveCount(0);
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.setViewportSize({ width: 800, height: 600 });
	await expect(page.getByRole('heading', { name: 'Land-use tables' })).toBeVisible();
	expect(errors).toEqual([]);
});
