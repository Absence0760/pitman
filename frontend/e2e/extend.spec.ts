import { expect, test, type Page, type Route } from '@playwright/test';
import { syntheticChirpsMonthly } from '@pitman/wrsm';
import { syntheticNetworkZip } from '../src/lib/network/synthetic.js';

// The CHIRPS extension (method A) end to end on synthetic data (rule 2): the
// rainfall service is routed with page.route (no backend), the method is the
// engine's own. Network 1980/81–2009/10, CHIRPS to September 2026, so each
// file gains 2010/11–2025/26.

const AREA = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			properties: { name: 'synthetic area' },
			geometry: {
				type: 'Polygon',
				coordinates: [
					[
						[22, -33.5],
						[22.3, -33.5],
						[22.3, -33.2],
						[22, -33.2],
						[22, -33.5]
					]
				]
			}
		}
	]
});

const CHIRPS = syntheticChirpsMonthly();

async function loadNetwork(page: Page) {
	await page.goto('/');
	await page
		.getByLabel('Network zip', { exact: true })
		.setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer: Buffer.from(syntheticNetworkZip({ startYear: 1980, years: 30 })) });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await page.getByRole('button', { name: 'Show Extend rainfall with CHIRPS' }).click();
}

async function uploadArea(page: Page, file: string, text: string) {
	await page.locator('[id^="extend-"][type=file]').setInputFiles({ name: file, mimeType: 'application/geo+json', buffer: Buffer.from(text) });
}

/** Extend one file with the computed factors. */
async function extendFile(page: Page, name: string) {
	const panel = page.getByRole('region', { name: 'Extend rainfall with CHIRPS' });
	await panel.getByRole('button', { name: `Extend ${name}` }).click();
	const file = page.getByRole('region', { name: `Extend ${name}` });
	await expect(file.getByRole('heading', { name: `Extend ${name}` })).toBeFocused();
	await uploadArea(page, 'area.geojson', AREA);
	await file.getByRole('button', { name: 'Fetch CHIRPS for this area' }).click();
	await expect(file.locator('[data-provenance="chirps"]')).toContainText('CHIRPS v3 rnl');
	await expect(file.getByRole('group', { name: 'October' })).toBeVisible();
	await file.getByRole('button', { name: /^Apply: append 16 years to / }).click();
	await expect(page.locator('#extend-applied')).toBeFocused();
}

test('upload an area, fetch CHIRPS, check the fit, edit a factor, apply, extend the run and rerun', async ({ page }) => {
	// A CSP violation (R4-I1: connect-src 'self', no inline styles) shows as a console error.
	const consoleErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	// The page's map asks for boundaries too, and no backend runs here.
	await page.route('**/quaternaries', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [], source: 'none' }) }));
	const bodies: unknown[] = [];
	let fail = true;
	await page.route('**/chirps/monthly', async (route: Route) => {
		bodies.push(route.request().postDataJSON());
		if (fail) {
			fail = false;
			await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'The area touches 2 431 cells; the limit is 2 000.' }) });
			return;
		}
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CHIRPS) });
	});
	await loadNetwork(page);

	const panel = page.getByRole('region', { name: 'Extend rainfall with CHIRPS' });
	const files = panel.getByRole('table', { name: 'Rainfall files' });
	await expect(files.locator('tr[data-file="SYA.RAN"]')).toContainText('RU 1 (Synthetic 1)');
	await panel.getByRole('button', { name: 'Extend SYA.RAN' }).click();
	const file = page.getByRole('region', { name: 'Extend SYA.RAN' });

	// A boundary that isn't one: refused, focus on the input.
	await uploadArea(page, 'point.geojson', JSON.stringify({ type: 'Point', coordinates: [22, -33] }));
	await expect(file.getByRole('alert')).toContainText('the area must be a Polygon or MultiPolygon');
	await expect(page.locator('[id^="extend-"][type=file]')).toBeFocused();

	await uploadArea(page, 'area.geojson', AREA);
	await expect(file.locator('[data-value="area-km2"]')).toContainText('km²');

	// The backend's refusal comes through in its own words; then a retry works.
	await file.getByRole('button', { name: 'Fetch CHIRPS for this area' }).click();
	await expect(file.getByRole('alert')).toContainText('The area touches 2 431 cells; the limit is 2 000.');
	await file.getByRole('button', { name: 'Fetch CHIRPS for this area' }).click();
	await expect(file.locator('[data-provenance="chirps"]')).toContainText('revision');
	// Only the geometry was sent (rule 7).
	expect(bodies).toHaveLength(2);
	expect(Object.keys(bodies[1] as object)).toEqual(['area']);
	expect(JSON.stringify(bodies[1])).not.toContain('synthetic area');

	// The fit: every chart drawn, with its data table.
	for (const id of ['scatter', 'means', 'annual']) {
		await expect(file.locator(`figure[data-chart="extend-${id}"] [data-ready="true"]`)).toBeVisible();
	}
	await file.getByText('Data table: Annual totals').click();
	await expect(file.getByRole('table', { name: 'Annual totals' }).getByRole('row', { name: /2025\/26/ })).toContainText('yes');
	await file.getByLabel('Show corrected CHIRPS (f × p) instead of p').check();
	await expect(file.getByRole('heading', { name: /corrected CHIRPS/ })).toBeVisible();

	// A refused factor blocks the apply and takes the focus; reset restores it.
	const october = file.getByLabel('October factor', { exact: true });
	const computed = await october.inputValue();
	await october.fill('6');
	await expect(file.getByRole('group', { name: 'October' })).toContainText('Not allowed: a factor must be from 0 to 5.');
	await file.getByRole('button', { name: /^Apply: append 16 years/ }).click();
	await expect(file.getByRole('alert').filter({ hasText: 'Fix these before applying' })).toContainText('October');
	await expect(october).toBeFocused();
	await file.getByRole('button', { name: 'Reset October to the computed factor' }).click();
	await expect(october).toHaveValue(computed);

	// An edited factor (a decimal comma) with a note; the numbers table gains the "in use" column.
	await file.getByLabel('November factor', { exact: true }).fill('0,9');
	await file.getByLabel('Why you changed it (kept in pitman.json)').fill('checked against the gauge');
	await expect(file.locator('[data-table="fit-statistics"]')).toContainText('With the factors in use');
	await expect(file.locator('[data-table="preview"] tbody tr')).toHaveCount(16);

	await file.getByRole('button', { name: 'Apply: append 16 years to SYA.RAN' }).click();
	await expect(page.locator('#extend-applied')).toContainText('SYA.RAN now runs to 2025/26');
	await expect(files.locator('tr[data-file="SYA.RAN"]')).toContainText('Extended to 2025/26');

	// SYB.RAN still ends 2009/10, so the run can't reach further yet; extend it too.
	await expect(panel.getByRole('button', { name: /^Run to / })).toHaveCount(0);
	await extendFile(page, 'SYB.RAN');
	await panel.getByRole('button', { name: 'Run to 2025/26' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'The run now ends 2025/26' }).first()).toBeVisible();

	await panel.getByRole('button', { name: 'Rerun the network' }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByRole('list', { name: 'Modes that failed' })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Network SY' }).locator('..')).toContainText('2025/26');

	// The 422 above is the only error the page logged.
	expect(consoleErrors.filter((text) => !/status of 422/.test(text))).toEqual([]);

	// The working copy keeps the extension across a reload.
	await expect(page.locator('[data-working-copy]')).toHaveAttribute('data-working-copy', 'stored');
	await page.reload();
	await page.getByRole('button', { name: 'Show Extend rainfall with CHIRPS' }).click();
	await expect(page.getByRole('table', { name: 'Rainfall files' }).locator('tr[data-file="SYA.RAN"]')).toContainText('Extended to 2025/26');
});
