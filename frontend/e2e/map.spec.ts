import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';

// The map, against the real MapLibre and its worker under the site's real CSP
// (infra/csp.json, the one place these are tested together), with the API
// answered from the committed synthetic region. No tiles: this is what a laptop
// with no cloud sees (local-first). Headless Chromium has no GPU, so SwiftShader
// draws the WebGL. The map's point and draw tools are tested in the wizard that
// uses them (e2e/subdivide.spec.ts).
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

const geo = (file: string) => new URL(`../../backend/fixtures/geo/${file}`, import.meta.url);
const fixture = JSON.parse(readFileSync(geo('quaternaries.synthetic.geojson'), 'utf8')) as { features: { properties: { code: string; areaKm2: number; mapMm: number }; geometry: unknown }[] };
const QUATERNARIES = {
	type: 'FeatureCollection',
	source: 'Invented boundaries for the test',
	features: fixture.features.map((f) => ({ type: 'Feature', properties: { code: f.properties.code, areaKm2: f.properties.areaKm2, mapMm: f.properties.mapMm }, geometry: f.geometry }))
};
const CELLS = { dataset: 'synthetic', source: 'Invented MAP grid for the test', cellDeg: 0.25, originLon: 21.125, originLat: -33.625, cols: 4, rows: 3, values: [300, 500, 700, 900, 400, null, 800, 1000, 450, 650, 850, 1050] };

/** The header CloudFront sends, minus upgrade-insecure-requests: preview is http. */
function cspHeader() {
	const { site } = JSON.parse(readFileSync(new URL('../../infra/csp.json', import.meta.url), 'utf8')) as { site: string[][] };
	return site.filter(([name]) => name !== 'upgrade-insecure-requests').map((d) => d.join(' ')).join('; ');
}

/** The console's errors: a CSP violation shows there. */
function watch(page: Page) {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	page.on('pageerror', (e) => errors.push(e.message));
	return errors;
}

const panel = (page: Page) => page.locator('section[aria-labelledby="map-h"]');

async function open(page: Page, quaternaries: (route: Route) => Promise<void> = (route) => route.fulfill({ json: QUATERNARIES })) {
	await page.route('/', async (route) => {
		if (route.request().resourceType() !== 'document') return route.fallback();
		const response = await route.fetch();
		await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': cspHeader() } });
	});
	await page.route('**/quaternaries', quaternaries);
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip()) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await panel(page).scrollIntoViewIfNeeded();
	await expect(panel(page).locator('[data-status]')).toHaveAttribute('data-status', 'ready');
}

/** A settled map: the frame's move has ended and the view has stopped changing. */
async function settled(page: Page) {
	const box = panel(page).locator('[data-status]');
	await expect(box).toHaveAttribute('data-view', /./);
	await expect
		.poll(async () => {
			const before = await box.getAttribute('data-view');
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
			return before === (await box.getAttribute('data-view'));
		})
		.toBe(true);
}

test('with no tiles the map draws the boundaries on a plain background, under the CSP, and says so quietly', async ({ page }) => {
	const errors = watch(page);
	await open(page);
	await expect(page.getByTestId('map-basemap-note')).toHaveText('No basemap here: everything is drawn on a plain background.');
	await expect(page.getByRole('heading', { name: 'Map', exact: true })).toHaveId('map-h');
	await expect(page.getByTestId('map-source-boundaries')).toContainText('Invented boundaries for the test');
	await expect(panel(page).locator('.q-label').first()).toBeAttached();
	await expect(panel(page).locator('.q-label')).toHaveCount(QUATERNARIES.features.length);
	expect(errors).toEqual([]);
});

test('choosing a code selects, frames and gives the source of its numbers', async ({ page }) => {
	await open(page);
	const code = QUATERNARIES.features[1]!.properties.code;
	await panel(page).getByLabel('Quaternary', { exact: true }).selectOption(code);
	await expect(panel(page).getByLabel('Quaternary', { exact: true })).toHaveValue(code);
	const facts = page.getByTestId('map-selected-facts');
	await expect(facts).toContainText(code);
	await expect(facts).toContainText('from the boundary file');
	await expect(page.getByTestId('map-chip')).toHaveText(`Selected: ${code}`);
});

test('a click on the map selects the quaternary under it', async ({ page }) => {
	await open(page);
	await settled(page);
	const box = (await panel(page).getByTestId('map').boundingBox())!;
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await expect(panel(page).getByLabel('Quaternary', { exact: true })).toHaveValue(/^Z/);
});

test('the keyboard reaches the map: a crosshair, and Enter selects under it', async ({ page }) => {
	await open(page);
	await settled(page);
	await panel(page).locator('canvas').focus();
	await page.keyboard.press('ArrowLeft');
	await expect(page.getByTestId('map-crosshair')).toBeVisible();
	await settled(page);
	await page.keyboard.press('Enter');
	await expect(panel(page).getByLabel('Quaternary', { exact: true })).toHaveValue(/^Z/);
});

test('the MAP-grid tick loads the box in view and shows where it came from', async ({ page }) => {
	const errors = watch(page);
	const boxes: unknown[] = [];
	await page.route('**/map-grid/cells', async (route) => {
		boxes.push(route.request().postDataJSON());
		await route.fulfill({ json: CELLS });
	});
	await open(page);
	await settled(page);
	await panel(page).getByRole('checkbox', { name: 'MAP grid' }).check();
	await expect(page.getByTestId('map-source-grid')).toContainText('synthetic, 0.25° cells: Invented MAP grid for the test');
	await expect(page.getByRole('img', { name: /MAP grid colours/ })).toBeVisible();
	expect(boxes).toHaveLength(1);
	expect(boxes[0]).toEqual({ bbox: expect.any(Array) });
	await panel(page).getByRole('checkbox', { name: 'MAP grid' }).uncheck();
	await expect(page.getByTestId('map-source-grid')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('a view too wide for the grid asks to zoom in, and asks the server for nothing', async ({ page }) => {
	const asked: unknown[] = [];
	await page.route('**/map-grid/cells', async (route) => {
		asked.push(route.request().postDataJSON());
		await route.fulfill({ json: CELLS });
	});
	await open(page, (route) => route.fulfill({ status: 503, json: { error: 'not configured' } }));
	await settled(page);
	await panel(page).getByRole('checkbox', { name: 'MAP grid' }).check();
	await expect(page.getByTestId('map-grid-status')).toContainText('Zoom in to see the MAP grid');
	expect(asked).toEqual([]);
});

test('a box with no grid says what to do instead', async ({ page }) => {
	await page.route('**/map-grid/cells', (route) => route.fulfill({ status: 422, json: { error: 'no MAP grid has a value in this box', code: 'no_coverage' } }));
	await open(page);
	await settled(page);
	await panel(page).getByRole('checkbox', { name: 'MAP grid' }).check();
	await expect(page.getByTestId('map-grid-status')).toHaveText('No MAP grid covers this view. Sub-dividing here takes a typed MAP.');
});

test('with no boundaries the panel says so plainly, how to go on, and the map still works', async ({ page }) => {
	const answer = { status: 503, json: { error: 'quaternary boundaries are not configured: QUATERNARIES_SOURCE is not set' } };
	await open(page, (route) => route.fulfill(answer));
	const note = page.getByTestId('map-no-boundaries');
	await expect(note).toContainText('Quaternary boundaries aren’t available here.');
	await expect(note).toContainText('extend its rainfall from a boundary you upload');
	await expect(panel(page).getByLabel('Quaternary', { exact: true })).toHaveCount(0);
	await expect(panel(page).locator('.maplibregl-canvas')).toBeVisible();
});

test('the map redraws when the theme flips', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await open(page);
	const box = panel(page).locator('[data-status]');
	await expect(box).toHaveAttribute('data-theme-drawn', 'light');
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(box).toHaveAttribute('data-theme-drawn', 'dark');
	await expect(panel(page).locator('.q-label')).toHaveCount(QUATERNARIES.features.length);
});
