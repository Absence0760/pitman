import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';
import { unpackZip } from '../src/lib/network/zip.js';

// The Land use panel on the real page, with the real engine and `/cfm/land-use` stubbed: invented fields and dams
// over the committed synthetic region, no real farm or dam (rule 2). SwiftShader draws the WebGL, as in subdivide.spec.ts.
test.use({ viewport: { width: 1440, height: 960 }, launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

const fixture = JSON.parse(readFileSync(new URL('../../backend/fixtures/geo/quaternaries.synthetic.geojson', import.meta.url), 'utf8')) as { features: { properties: { code: string }; geometry: { coordinates: number[][][] } }[] };
const QUATERNARIES = { type: 'FeatureCollection', source: 'Invented boundaries for the test', features: fixture.features.map((f) => ({ type: 'Feature', properties: { code: f.properties.code }, geometry: f.geometry })) };
const Z01A = fixture.features.find((f) => f.properties.code === 'Z01A')!.geometry;

const ring = Z01A.coordinates[0]!;
const west = Math.min(...ring.map((p) => p[0]!));
const south = Math.min(...ring.map((p) => p[1]!));
const box = (w: number, s: number, size: number) => ({ type: 'Polygon', coordinates: [[[w, s], [w + size, s], [w + size, s + size], [w, s + size], [w, s]]] });
const field = (id: string, crop: string, areaHa: number, irrigated: boolean | null, n: number) => ({ id, crop, areaHa, irrigated, geometry: box(west + 0.02 + n * 0.03, south + 0.02, 0.02) });

const ANSWER = {
	fields: [field('1', 'Wine grapes', 120, true, 0), field('2', 'Wine grapes', 30, false, 1), field('3', 'Lucerne', 80, null, 2), field('4', 'Wheat', 400, false, 3)],
	dams: [
		{ id: 'syn-reg-1', source: 'register', lon: west + 0.05, lat: south + 0.05, capacityMm3: 0.5, name: 'Synthetic dam 1' },
		{ id: 'syn-cfm-1', source: 'capeFarmMapper', lon: west + 0.0501, lat: south + 0.05, capacityMm3: 0.4, name: 'Synthetic dam 1 (CFM)' }
	],
	dataset: 'Synthetic crop census',
	surveyYear: 2023,
	fetchedOn: '2026-10-30',
	source: 'local'
};

async function start(page: Page, answer: (route: Route) => Promise<void> | void) {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: QUATERNARIES }));
	await page.route('**/cfm/land-use', answer);
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip({ startYear: 1980, years: 30 })) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	const panel = page.getByRole('region', { name: 'Land use', exact: true });
	await panel.scrollIntoViewIfNeeded();
	await panel.getByLabel('Quaternary', { exact: true }).selectOption('Z01A');
	return panel;
}

const fetchButton = (panel: ReturnType<Page['getByRole']>) => panel.getByRole('button', { name: 'Fetch the fields and dams' });

test('fetch, confirm the crops, write both rows, and the saved zip says where they came from', async ({ page }) => {
	const bodies: unknown[] = [];
	const panel = await start(page, (route) => {
		bodies.push(route.request().postDataJSON());
		return route.fulfill({ json: ANSWER });
	});
	await fetchButton(panel).click();
	await expect(panel.getByRole('heading', { name: 'What came back' })).toBeFocused();
	// Only the shape is sent (rule 7), and invented data says so.
	expect(bodies).toHaveLength(1);
	expect(Object.keys(bodies[0] as object)).toEqual(['area']);
	await expect(panel.locator('[data-synthetic]')).toContainText('Synthetic data.');
	await expect(panel.locator('[data-value="dataset"]')).toHaveText('Synthetic crop census');
	await expect(panel.locator('[data-value="found"]')).toHaveText('4 fields, 630.0 ha; 1 dam');

	// The layer's word stands: 120 ha of the grapes count, the wheat doesn't, and Lucerne waits for a tick.
	const crops = panel.getByRole('table', { name: 'Fields by crop' });
	await expect(crops.locator('tr[data-crop="Wine grapes"]')).toContainText('120.0 irrigated');
	await expect(crops.locator('tr[data-crop="Wheat"]')).toContainText('not counted');
	await expect(panel.locator('[data-value="irrigated-km2"]')).toHaveText('1.20 km²');
	await crops.getByLabel('Lucerne is irrigated').check();
	await expect(panel.locator('[data-value="irrigated-km2"]')).toHaveText('2.00 km²');
	await panel.getByRole('button', { name: 'Write the row to RR 6' }).click();
	await expect(panel.locator('.applied').first()).toContainText('RR 6: 2.00 km² irrigated in 2025/26.');

	// A dam's own figure needs its note; the row follows it.
	const dams = panel.getByRole('table', { name: 'Matched dams' });
	await expect(dams.locator('[data-value="capacity"]')).toHaveText('0.500');
	await expect(dams).toContainText('0.400, Cape Farm Mapper');
	await dams.getByLabel('Your capacity for Synthetic dam 1, million m³').fill('0.7');
	await expect(dams.getByRole('alert')).toHaveText('Say where this figure came from.');
	await expect(panel.getByRole('button', { name: 'Write the row to RV 5' })).toBeDisabled();
	await dams.getByLabel('Where the figure for Synthetic dam 1 came from').fill('Site visit');
	await expect(panel.locator('[data-value="dams-mm3"]')).toContainText('0.70 million m³');
	await panel.getByRole('button', { name: 'Write the row to RV 5' }).click();
	await expect(panel.locator('.applied').last()).toContainText('RV 5: 0.70 million m³ from 1 dam in 2025/26.');

	const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save as WRSM2000 zip' }).click()]);
	const files = unpackZip(new Uint8Array(await readFile((await saved.path())!)));
	const sidecar = JSON.parse(files['pitman.json']!) as { capeFarmMapper: { dataset: string; cropMapping: Record<string, unknown> }; dams: { id: string; capacityMm3: number; source: { note: string } }[] };
	expect(sidecar.capeFarmMapper.dataset).toBe('Synthetic crop census');
	expect(Object.keys(sidecar.capeFarmMapper.cropMapping).sort()).toEqual(['Lucerne', 'Wine grapes']);
	expect(sidecar.dams).toMatchObject([{ capacityMm3: 0.7, source: { note: 'Site visit' } }]);
});

test('a server with no data says so and how to go on, and another try works', async ({ page }) => {
	let down = true;
	const panel = await start(page, (route) => (down ? route.fulfill({ status: 503, json: { error: 'Cape Farm Mapper is not configured here.' } }) : route.fulfill({ json: ANSWER })));
	await fetchButton(panel).click();
	const alert = panel.getByRole('alert');
	await expect(alert).toContainText('The land-use data isn’t available.');
	await expect(alert).toContainText('Cape Farm Mapper is not configured here.');
	await expect(alert).toContainText('everything else in Pitman works');
	down = false;
	await fetchButton(panel).click();
	await expect(panel.getByRole('heading', { name: 'What came back' })).toBeFocused();
	await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('a refused area comes through in the service’s own words', async ({ page }) => {
	const panel = await start(page, (route) => route.fulfill({ status: 422, json: { error: 'The area is larger than 10 000 km².' } }));
	await fetchButton(panel).click();
	await expect(panel.getByRole('alert')).toHaveText('The area is larger than 10 000 km².');
});

test('Cancel stops the fetch, and changing the area drops an answer for the old one', async ({ page }) => {
	let release: () => void = () => {};
	let held = true;
	const panel = await start(page, async (route) => {
		if (held) await new Promise<void>((resolve) => (release = resolve));
		await route.fulfill({ json: ANSWER }).catch(() => {});
	});
	await fetchButton(panel).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Fetching…' })).toBeVisible();
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(fetchButton(panel)).toBeEnabled();
	await expect(panel.getByRole('heading', { name: 'What came back' })).toHaveCount(0);
	release();

	held = false;
	await fetchButton(panel).click();
	await expect(panel.getByRole('heading', { name: 'What came back' })).toBeFocused();
	await panel.getByLabel('Quaternary', { exact: true }).selectOption('Z01B');
	await expect(panel.getByRole('heading', { name: 'What came back' })).toHaveCount(0);
	await expect(fetchButton(panel)).toBeVisible();
});

test('without the list of quaternaries an uploaded boundary still reaches the fetch', async ({ page }) => {
	await page.route('**/quaternaries', (route) => route.fulfill({ status: 503, json: { error: 'No boundaries here.' } }));
	await page.route('**/cfm/land-use', (route) => route.fulfill({ json: ANSWER }));
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip()) });
	const panel = page.getByRole('region', { name: 'Land use', exact: true });
	await expect(panel).toContainText('Upload a boundary instead.');
	await panel.locator('#landuse-file').setInputFiles({ name: 'point.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify({ type: 'Point', coordinates: [22, -33] })) });
	await expect(panel.getByRole('alert')).toContainText('point.geojson');
	await panel.locator('#landuse-file').setInputFiles({ name: 'area.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(box(21, -33.7, 0.1))) });
	await expect(panel).toContainText('Area: area.geojson');
	await fetchButton(panel).click();
	await expect(panel.getByRole('heading', { name: 'What came back' })).toBeFocused();
});
