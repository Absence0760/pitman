import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';

// The map, against the real MapLibre and its worker under the site's real CSP
// (infra/csp.json, the one place these are tested together), with the API
// answered from the committed synthetic region. No tiles: this is what a laptop
// with no cloud sees (local-first). Reaches the panel through /map-preview
// until it is on the main page. Headless Chromium has no GPU, so SwiftShader
// draws the WebGL.
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

async function open(page: Page, path = '/map-preview', quaternaries: (route: Route) => Promise<void> = (route) => route.fulfill({ json: QUATERNARIES })) {
	await page.route('**/map-preview*', async (route) => {
		if (route.request().resourceType() !== 'document') return route.fallback();
		const response = await route.fetch();
		await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': cspHeader() } });
	});
	await page.route('**/quaternaries', quaternaries);
	await page.goto(path);
	await expect(page.locator('[data-status]')).toHaveAttribute('data-status', 'ready');
}

/** A settled map: the frame's move has ended and the view has stopped changing. */
async function settled(page: Page) {
	const box = page.locator('[data-status]');
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
	await expect(page.locator('.q-label').first()).toBeAttached();
	await expect(page.locator('.q-label')).toHaveCount(QUATERNARIES.features.length);
	expect(errors).toEqual([]);
});

test('choosing a code selects, frames and gives the source of its numbers', async ({ page }) => {
	await open(page);
	const code = QUATERNARIES.features[1]!.properties.code;
	await page.getByLabel('Quaternary', { exact: true }).selectOption(code);
	await expect(page.getByTestId('map-preview-picked')).toHaveText(code);
	const facts = page.getByTestId('map-selected-facts');
	await expect(facts).toContainText(code);
	await expect(facts).toContainText('from the boundary file');
	await expect(page.getByTestId('map-chip')).toHaveText(`Selected: ${code}`);
});

test('a click on the map selects the quaternary under it', async ({ page }) => {
	await open(page);
	await settled(page);
	const box = (await page.getByTestId('map').boundingBox())!;
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await expect(page.getByTestId('map-preview-picked')).toHaveText(/^Z/);
	await expect(page.getByLabel('Quaternary', { exact: true })).toHaveValue(/^Z/);
});

test('the keyboard reaches the map: a crosshair, and Enter selects under it', async ({ page }) => {
	await open(page);
	await settled(page);
	await page.getByRole('region', { name: 'Map', exact: true }).locator('canvas').focus();
	await page.keyboard.press('ArrowLeft');
	await expect(page.getByTestId('map-crosshair')).toBeVisible();
	await settled(page);
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('map-preview-picked')).toHaveText(/^Z/);
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
	await page.getByRole('checkbox', { name: 'MAP grid' }).check();
	await expect(page.getByTestId('map-source-grid')).toContainText('synthetic, 0.25° cells: Invented MAP grid for the test');
	await expect(page.getByRole('img', { name: /MAP grid colours/ })).toBeVisible();
	expect(boxes).toHaveLength(1);
	expect(boxes[0]).toEqual({ bbox: expect.any(Array) });
	await page.getByRole('checkbox', { name: 'MAP grid' }).uncheck();
	await expect(page.getByTestId('map-source-grid')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('a view too wide for the grid asks to zoom in, and asks the server for nothing', async ({ page }) => {
	const asked: unknown[] = [];
	await page.route('**/map-grid/cells', async (route) => {
		asked.push(route.request().postDataJSON());
		await route.fulfill({ json: CELLS });
	});
	await open(page, '/map-preview', (route) => route.fulfill({ status: 503, json: { error: 'not configured' } }));
	await settled(page);
	await page.getByRole('checkbox', { name: 'MAP grid' }).check();
	await expect(page.getByTestId('map-grid-status')).toContainText('Zoom in to see the MAP grid');
	expect(asked).toEqual([]);
});

test('a box with no grid says what to do instead', async ({ page }) => {
	await page.route('**/map-grid/cells', (route) => route.fulfill({ status: 422, json: { error: 'no MAP grid has a value in this box', code: 'no_coverage' } }));
	await open(page);
	await settled(page);
	await page.getByRole('checkbox', { name: 'MAP grid' }).check();
	await expect(page.getByTestId('map-grid-status')).toHaveText('No MAP grid covers this view. Sub-dividing here takes a typed MAP.');
});

test('with no boundaries the panel says so plainly, how to go on, and the map still works', async ({ page }) => {
	const answer = { status: 503, json: { error: 'quaternary boundaries are not configured: QUATERNARIES_SOURCE is not set' } };
	await open(page, '/map-preview', (route) => route.fulfill(answer));
	const note = page.getByTestId('map-no-boundaries');
	await expect(note).toContainText('Quaternary boundaries aren’t available here.');
	await expect(note).toContainText('extend its rainfall from a boundary you upload');
	await expect(page.getByLabel('Quaternary', { exact: true })).toHaveCount(0);
	await expect(page.locator('.maplibregl-canvas')).toBeVisible();
});

test('the point tool hands back the click', async ({ page }) => {
	await open(page, '/map-preview?tool=point');
	await settled(page);
	const box = (await page.getByTestId('map').boundingBox())!;
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await expect(page.getByTestId('map-preview-picked')).toHaveText(/^\[\d+\.\d+,-\d+\.\d+\]$/);
});

test('the draw tool closes a polygon with the mouse and hands it over', async ({ page }) => {
	await open(page, '/map-preview?tool=draw');
	await settled(page);
	const box = (await page.getByTestId('map').boundingBox())!;
	const at = (x: number, y: number) => [box.x + box.width * x, box.y + box.height * y] as const;
	await page.getByLabel('Snap to outlines').uncheck();
	await page.mouse.click(...at(0.4, 0.4));
	await page.mouse.click(...at(0.6, 0.4));
	await page.mouse.click(...at(0.5, 0.6));
	await expect(page.getByTestId('map-draw-said')).toContainText('Corner 3');
	await page.mouse.click(...at(0.4, 0.4));
	await expect(page.getByTestId('map-draw-said')).toContainText('Shape closed with 3 corners');
	await page.getByRole('button', { name: 'Use this shape' }).click();
	const geometry = JSON.parse((await page.getByTestId('map-preview-picked').textContent()) ?? '') as { type: string; coordinates: unknown[][] };
	expect(geometry.type).toBe('Polygon');
	expect(geometry.coordinates[0]).toHaveLength(4);
});

test('a pasted shape needs no pointer', async ({ page }) => {
	await open(page, '/map-preview?tool=draw');
	await page.getByRole('button', { name: 'Paste a shape' }).click();
	const field = page.getByLabel('GeoJSON or WKT, in WGS84 longitude and latitude');
	await field.fill('POINT(21 -33)');
	await page.getByRole('button', { name: 'Use the pasted shape' }).click();
	await expect(page.getByRole('alert')).toContainText('the map takes a polygon');
	await field.fill('POLYGON((21 -34, 21.5 -34, 21.5 -33.5, 21 -34))');
	await page.getByRole('button', { name: 'Use the pasted shape' }).click();
	await page.getByRole('button', { name: 'Use this shape' }).click();
	await expect(page.getByTestId('map-preview-picked')).toContainText('"Polygon"');
});

test('the map redraws when the theme flips', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await open(page);
	const box = page.locator('[data-status]');
	await expect(box).toHaveAttribute('data-theme-drawn', 'light');
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(box).toHaveAttribute('data-theme-drawn', 'dark');
	await expect(page.locator('.q-label')).toHaveCount(QUATERNARIES.features.length);
});
