import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures.js';
import { writeBundle } from '../src/lib/network/engine.js';
import { syntheticBundle, syntheticNetworkZip } from '../src/lib/network/synthetic.js';
import { packZip } from '../src/lib/network/zip.js';

// The sub-division wizard on the real page, with the real engine, map and tools, and the data API
// answered from the committed synthetic region. Synthetic data only (rule 2). Headless Chromium has no
// GPU, so SwiftShader draws the WebGL.
test.use({ viewport: { width: 1440, height: 960 }, launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

const fixture = JSON.parse(readFileSync(new URL('../../backend/fixtures/geo/quaternaries.synthetic.geojson', import.meta.url), 'utf8')) as { features: { properties: { code: string }; geometry: { coordinates: number[][][] } }[] };
const Z01A = fixture.features.find((f) => f.properties.code === 'Z01A')!;
const QUATERNARIES = { type: 'FeatureCollection', source: 'Invented boundaries for the test', features: fixture.features.map((f) => ({ type: 'Feature', properties: { code: f.properties.code }, geometry: f.geometry })) };

const ring = Z01A.geometry.coordinates[0]!;
const [west, east] = [Math.min(...ring.map((p) => p[0]!)), Math.max(...ring.map((p) => p[0]!))];
const [south, north] = [Math.min(...ring.map((p) => p[1]!)), Math.max(...ring.map((p) => p[1]!))];
const box = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const middle = (west + east) / 2;

/** A west half under 500 mm and an east half over 700 mm, so the threshold's zone is the east half. */
function cells() {
	const cellDeg = 0.01;
	const cols = Math.ceil((east - west) / cellDeg) + 2;
	const rows = Math.ceil((north - south) / cellDeg) + 2;
	const originLon = west - cellDeg / 2;
	const values = Array.from({ length: rows * cols }, (_, i) => (originLon + (i % cols) * cellDeg < middle ? 450 : 750));
	return { dataset: 'synthetic', source: 'Invented grid for the test', cellDeg, originLon, originLat: north + cellDeg / 2, cols, rows, values };
}

async function stubApi(page: Page) {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: QUATERNARIES }));
	await page.route('**/map-grid/cells', (route) => route.fulfill({ json: cells() }));
	await page.route('**/map-grid/mean', (route) =>
		route.fulfill({ json: { grid: 'synthetic', cellSizeM: 1000, cellCount: 100, meanMapMm: 600, fetchedOn: '2026-10-30', cellDeg: 0.01, coveragePct: 100, version: '1', attribution: 'Invented', source: 'local' } })
	);
	await page.route('**/channels?*', (route) => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
}

async function startWizard(page: Page) {
	await stubApi(page);
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip()) });
	await page.getByRole('button', { name: 'Show Sub-divide a quaternary' }).click();
	const panel = page.getByRole('region', { name: 'Sub-divide a quaternary' });
	await panel.scrollIntoViewIfNeeded();
	await panel.getByLabel('Quaternary', { exact: true }).selectOption('Z01A');
	await panel.getByLabel('Runoff module to split').selectOption({ index: 1 });
	await panel.locator('#subdivide-continue').click();
	return panel;
}

async function readyMap(panel: ReturnType<Page['getByRole']>) {
	const map = panel.locator('.map-wrap');
	await map.scrollIntoViewIfNeeded();
	await expect(map).toHaveAttribute('data-status', 'ready');
	// Settled (MapLibre's `idle`): the frame has landed and the outlines are drawn, so a click hits what it aims at.
	await expect(map).toHaveAttribute('data-settled', 'true');
	return map;
}

async function calibrateAndApply(page: Page, panel: ReturnType<Page['getByRole']>) {
	await panel.getByRole('button', { name: 'Continue to calibrate the MAPs' }).click();
	await panel.getByRole('button', { name: 'Calibrate the MAPs', exact: true }).click();
	await panel.getByRole('button', { name: 'Continue to apply' }).click();
	await panel.getByRole('button', { name: /^Apply: split/ }).click();
	await expect(page.getByRole('navigation', { name: 'Steps' })).toContainText('1 quaternary split');
}

test('split by a MAP zone, calibrate, apply, run, and the save reopens with the new module', async ({ page }) => {
	const panel = await startWizard(page);
	await page.locator('#subdivide-kind-zone').check();
	await panel.locator('#zone-threshold-mm').fill('600');
	await panel.locator('#zone-threshold-mm').blur();
	await expect(panel.locator('[data-zone-proposal="ready"]')).toBeVisible();
	await panel.getByRole('button', { name: 'Accept this zone' }).click();
	await expect(panel.getByRole('heading', { name: '3. Review the pieces' })).toBeVisible();
	// The same sentence once: above the pieces, not again above the changes.
	await expect(panel.locator('[data-warning="scale"]').first()).toBeVisible();
	await expect(panel.getByRole('list', { name: 'Changes to the network' })).toContainText('New runoff module');

	await calibrateAndApply(page, panel);
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByRole('list', { name: 'Modes that failed' })).toHaveCount(0);

	const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save as WRSM2000 zip' }).click()]);
	const zip = await readFile((await saved.path())!);
	await page.getByRole('button', { name: 'Forget the working copy' }).click();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toHaveCount(0);
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'saved.zip', mimeType: 'application/zip', buffer: zip });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Steps' })).toContainText('1 quaternary split');
});

test('a second module under a quaternary already split is stopped at the first step', async ({ page }) => {
	const panel = await startWizard(page);
	await page.locator('#subdivide-kind-zone').check();
	await panel.locator('#zone-threshold-mm').fill('600');
	await panel.locator('#zone-threshold-mm').blur();
	await panel.getByRole('button', { name: 'Accept this zone' }).click();
	await calibrateAndApply(page, panel);
	await expect(panel.locator('#subdivide-applied')).toBeFocused();

	await panel.getByLabel('Quaternary', { exact: true }).selectOption('Z01A');
	await panel.getByLabel('Runoff module to split').selectOption({ label: 'RU 3 Synthetic 3' });
	await expect(panel).toContainText('Z01A is already sub-divided, and RU 3 is not one of its pieces.');
	await expect(panel.locator('#subdivide-continue')).toBeDisabled();
});

test('a plan the engine refuses stops the wizard at the review, and says the way out', async ({ page }) => {
	// RU 1 drains into RU 2, which takes one inflow route; so the pieces must join through RU 1's own inflow route,
	// a line its file version (2) doesn't have (docs/formats.md § 5.2). A network as an old WRSM2000 wrote it.
	await stubApi(page);
	const bundle = syntheticBundle();
	const old = { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'RU' && m.number === 1 ? { ...m, fileVersion: 2 as const } : m)) };
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(packZip(writeBundle(old))) });
	await page.getByRole('button', { name: 'Show Sub-divide a quaternary' }).click();
	const panel = page.getByRole('region', { name: 'Sub-divide a quaternary' });
	await panel.scrollIntoViewIfNeeded();
	await panel.getByLabel('Quaternary', { exact: true }).selectOption('Z01A');
	await panel.getByLabel('Runoff module to split').selectOption({ label: 'RU 1 Synthetic 1' });
	await panel.locator('#subdivide-continue').click();
	await page.locator('#subdivide-kind-zone').check();
	await panel.locator('#zone-threshold-mm').fill('600');
	await panel.locator('#zone-threshold-mm').blur();
	await panel.getByRole('button', { name: 'Accept this zone' }).click();
	await expect(panel.getByRole('heading', { name: '3. Review the pieces' })).toBeVisible();

	const refused = panel.locator('#subdivide-refused');
	await expect(refused).toContainText("This split can’t be applied: RU 1's water goes where no second route can join it");
	await expect(refused).toContainText('Undo the last split');
	await expect(panel.getByRole('list', { name: 'Changes to the network' })).toHaveCount(0);
	await panel.getByRole('button', { name: 'Continue to calibrate the MAPs' }).click();
	await expect(refused).toBeFocused();
	await expect(panel.getByRole('heading', { name: '4. Calibrate the MAPs' })).toHaveCount(0);
	await panel.getByRole('button', { name: 'Undo the last split' }).click();
	await expect(panel.getByRole('heading', { name: '2. Choose the split' })).toBeFocused();
});

test('a click on the map delineates: it is not lost to the tool restarting', async ({ page }) => {
	let aborted = 0;
	page.on('requestfailed', (r) => {
		if (r.url().includes('/delineate')) aborted++;
	});
	await page.route('**/delineate', (route) =>
		route.fulfill({
			json: {
				tributary: box(west, south, middle, north),
				remainder: box(middle, south, east, north),
				tributaryKm2: 300,
				remainderKm2: 343,
				outsideKm2: 0,
				outsidePct: 0,
				warning: null,
				snapM: 40,
				pansKm2: 0,
				dem: { label: 'Invented DEM', fingerprint: 'abc', zoom: 11, attribution: 'Invented' }
			}
		})
	);
	const panel = await startWizard(page);
	await page.locator('#subdivide-kind-tributary').check();
	const map = await readyMap(panel);
	await expect(map).toHaveAttribute('data-tool', 'point');
	const area = (await map.boundingBox())!;
	await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
	await panel.getByRole('button', { name: 'Accept this tributary' }).click();
	expect(aborted).toBe(0);
	await expect(panel.getByRole('list', { name: 'Splits so far' })).toContainText('ributary');
	await calibrateAndApply(page, panel);
});

test('moving the map keeps a proposal and asks for nothing again', async ({ page }) => {
	let asked = 0;
	await page.route('**/delineate', (route) => {
		asked++;
		return route.fulfill({
			json: { tributary: box(west, south, middle, north), remainder: box(middle, south, east, north), tributaryKm2: 300, remainderKm2: 343, outsideKm2: 0, outsidePct: 0, warning: null, snapM: 40, pansKm2: 0, dem: { label: 'Invented DEM', fingerprint: 'abc', zoom: 11, attribution: 'Invented' } }
		});
	});
	const panel = await startWizard(page);
	await page.locator('#subdivide-kind-tributary').check();
	const map = await readyMap(panel);
	const area = (await map.boundingBox())!;
	await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
	await expect(panel.getByRole('button', { name: 'Accept this tributary' })).toBeVisible();
	const view = await map.getAttribute('data-view');
	await panel.getByRole('button', { name: /zoom in/i }).click();
	await expect(map).not.toHaveAttribute('data-view', view!);
	await expect(panel.getByRole('button', { name: 'Accept this tributary' })).toBeVisible();
	expect(asked).toBe(1);
});

test('a zone drawn on the map becomes a proposal', async ({ page }) => {
	const panel = await startWizard(page);
	await page.locator('#subdivide-kind-zone').check();
	await page.locator('#zone-way-draw').check();
	const map = await readyMap(panel);
	await expect(map).toHaveAttribute('data-tool', 'draw');
	const area = (await panel.getByTestId('map').boundingBox())!;
	const at = (x: number, y: number) => [area.x + area.width * x, area.y + area.height * y] as const;
	await panel.getByLabel('Snap to outlines').uncheck();
	const said = panel.getByTestId('map-draw-said');
	await page.mouse.click(...at(0.4, 0.4));
	await expect(said).toContainText('Corner 1');
	await page.mouse.click(...at(0.6, 0.4));
	await expect(said).toContainText('Corner 2');
	await page.mouse.click(...at(0.5, 0.6));
	await expect(said).toContainText('Corner 3');
	await page.mouse.click(...at(0.4, 0.4));
	await expect(panel.getByTestId('map-draw-said')).toContainText('Shape closed with 3 corners');
	await panel.getByRole('button', { name: 'Use this shape' }).click();
	await expect(panel.locator('[data-zone-proposal="ready"]')).toBeVisible();
});

test('a pasted shape needs no pointer', async ({ page }) => {
	const panel = await startWizard(page);
	await page.locator('#subdivide-kind-zone').check();
	await page.locator('#zone-way-paste').check();
	const field = panel.locator('#zone-paste');
	await field.fill('POINT(21 -33)');
	await panel.getByRole('button', { name: 'Use this polygon' }).click();
	await expect(panel.getByRole('alert')).toContainText('POLYGON');
	await field.fill(`POLYGON((${west + 0.02} ${south + 0.02}, ${middle} ${south + 0.02}, ${middle} ${north - 0.02}, ${west + 0.02} ${south + 0.02}))`);
	await panel.getByRole('button', { name: 'Use this polygon' }).click();
	await expect(panel.locator('[data-zone-proposal="ready"]')).toBeVisible();
});

test('a quaternary picked on the landing map carries into the loaded page and the wizard', async ({ page }) => {
	await stubApi(page);
	await page.goto('/');
	const map = page.locator('section[aria-labelledby="map-h"]');
	await map.getByLabel('Quaternary', { exact: true }).selectOption('Z01B');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip()) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await expect(map.getByLabel('Quaternary', { exact: true })).toHaveValue('Z01B');
	await page.getByRole('button', { name: 'Show Sub-divide a quaternary' }).click();
	await expect(page.getByRole('region', { name: 'Sub-divide a quaternary' }).getByLabel('Quaternary', { exact: true })).toHaveValue('Z01B');
});
