import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';

// The page in its fullest state, for the accessibility specs. Synthetic data only (rule 2).

const fixture = JSON.parse(readFileSync(new URL('../../backend/fixtures/geo/quaternaries.synthetic.geojson', import.meta.url), 'utf8')) as { features: { properties: { code: string }; geometry: { coordinates: number[][][] } }[] };
export const QUATERNARIES = { type: 'FeatureCollection', source: 'Invented boundaries for the test', features: fixture.features.map((f) => ({ type: 'Feature', properties: { code: f.properties.code }, geometry: f.geometry })) };
const ring = fixture.features[0]!.geometry.coordinates[0]!;
const [west, south] = [Math.min(...ring.map((p) => p[0]!)), Math.min(...ring.map((p) => p[1]!))];
const box = (w: number, s: number) => ({ type: 'Polygon', coordinates: [[[w, s], [w + 0.02, s], [w + 0.02, s + 0.02], [w, s + 0.02], [w, s]]] });
export const ANSWER = {
	fields: [{ id: '1', crop: 'Lucerne', areaHa: 120, irrigated: true, geometry: box(west + 0.02, south + 0.02) }, { id: '2', crop: 'Wheat', areaHa: 80, irrigated: null, geometry: box(west + 0.05, south + 0.02) }],
	dams: [{ id: 'syn-1', source: 'register', lon: west + 0.05, lat: south + 0.05, capacityMm3: 0.5, name: 'Synthetic dam 1' }],
	dataset: 'Synthetic crop census',
	surveyYear: 2023,
	fetchedOn: '2026-10-30',
	source: 'local'
};

/** The page with the network loaded, every optional card open, and each with something in it. */
export async function everythingOpen(page: Page) {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: QUATERNARIES }));
	await page.route('**/cfm/land-use', (route) => route.fulfill({ json: ANSWER }));
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip({ startYear: 1980, years: 30 })) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	for (const name of ['Extend rainfall with CHIRPS', 'Sub-divide a quaternary', 'Crop fields and farm dams', 'Land-use tables', 'Demands', 'Calibrate']) await page.getByRole('button', { name: `Show ${name}` }).click();

	await page.locator('section[aria-labelledby="map-h"]').getByLabel('Quaternary', { exact: true }).selectOption('Z01A');
	const fields = page.getByRole('region', { name: 'Crop fields and farm dams' });
	await fields.getByRole('button', { name: 'Fetch the fields and dams' }).click();
	await expect(fields.getByRole('heading', { name: 'What came back' })).toBeFocused();
	const tables = page.getByRole('region', { name: 'Land-use tables' });
	await tables.getByLabel('Runoff module', { exact: true }).selectOption('1');
	await tables.getByRole('button', { name: 'Add 2025' }).first().click();
	const demands = page.getByRole('region', { name: 'Demands' });
	await demands.getByRole('button', { name: 'New demand' }).click();
	await demands.getByRole('button', { name: 'View SYRQ9.ABS' }).click();
	await demands.getByRole('button', { name: 'Remove SYRQ9.ABS' }).click();
	const calibrate = page.getByRole('region', { name: 'Calibrate' });
	await calibrate.getByLabel('Runoff module', { exact: true }).selectOption('1');
	await calibrate.getByLabel(/^ST /).fill('420');
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
}

