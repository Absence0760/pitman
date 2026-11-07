import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from './fixtures.js';
import { writeBundle } from '../src/lib/network/engine.js';
import { syntheticBundle, syntheticNetworkZip } from '../src/lib/network/synthetic.js';
import { packZip, unpackZip } from '../src/lib/network/zip.js';

// The demand form on the real page: a new demand on RV 5, on its way into the saved zip. Synthetic data only (rule 2).

async function start(page: Page, buffer: Buffer = Buffer.from(syntheticNetworkZip({ startYear: 1980, years: 30 }))) {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: { type: 'FeatureCollection', features: [], source: 'none' } }));
	await page.goto('/');
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await page.getByRole('button', { name: 'Show Demands' }).click();
	return page.getByRole('region', { name: 'Demands' });
}

/** The form open on a new demand on RV 5's new route, 1.2 million m³/a from a typed source. */
async function fill(page: Page) {
	const panel = await start(page);
	await panel.getByRole('button', { name: 'New demand' }).click();
	await expect(panel.getByRole('heading', { name: 'New demand' })).toBeFocused();
	await panel.getByLabel('Reservoir or channel reach').selectOption('RV5');
	await expect(panel.getByLabel('Route', { exact: true })).toHaveValue('new');
	await panel.getByLabel('Volume in that year').fill('1.2');
	await panel.locator('#demand-annual-note').fill('Municipal abstraction licence');
	return panel;
}

const apply = (panel: ReturnType<Page['getByRole']>) => panel.getByRole('button', { name: 'Apply to the working copy' });

/** The synthetic network with RV 5 reading CR 4's demand file too, on a route of its own to the zero sink. */
function sharedFileZip(): Buffer {
	const bundle = syntheticBundle({ startYear: 1980, years: 30 });
	const position = bundle.network.modules.findIndex((e) => e.type === 'RV') + 1;
	const shared = {
		...bundle,
		network: { ...bundle.network, routes: [...bundle.network.routes, { number: 12, upstreamPosition: position, downstreamPosition: 0, cost: 0 }] },
		modules: bundle.modules.map((m) => (m.kind === 'RV' ? { ...m, outflows: [...m.outflows, { route: 12, definedFlowFile: 'SYRQ9.ABS' }] } : m))
	};
	return Buffer.from(packZip(writeBundle(shared), { mtime: new Date('2025-01-01T00:00:00Z') }));
}

async function savedFiles(page: Page) {
	const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save as WRSM2000 zip' }).click()]);
	return unpackZip(new Uint8Array(await readFile((await saved.path())!)));
}

const fileNamed = (files: Record<string, string>, name: RegExp) => Object.keys(files).find((path) => name.test(path));

test('a new demand on RV 5 previews its file, applies, and focus moves to what happened', async ({ page }) => {
	const panel = await fill(page);
	await expect(panel.locator('[data-fact="file"]')).toHaveText('SYRQ10.abs');
	await expect(panel.locator('[data-fact="years"]')).toHaveText('1980/81 to 2009/10');
	await expect(panel.locator('[data-source="annual"]')).toContainText('Typed in on');
	await apply(panel).click();
	await expect(page.locator('#demand-applied')).toBeFocused();
	await expect(page.locator('#demand-applied')).toContainText('SYRQ10.abs on RV 5 route 10');
	await expect(panel.getByRole('table', { name: 'Demand files' }).locator('tr[data-file="SYRQ10.ABS"]')).toContainText('1.20');
});

test('a reload keeps the volume and where it came from', async ({ page }) => {
	const panel = await fill(page);
	await apply(panel).click();
	await expect(page.locator('#demand-applied')).toBeFocused();
	await expect(page.locator('[data-working-copy]')).toHaveAttribute('data-working-copy', 'stored');
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await page.getByRole('button', { name: 'Show Demands' }).click();
	const after = page.getByRole('region', { name: 'Demands' });
	await after.getByRole('button', { name: 'Edit SYRQ10.abs' }).click();
	await expect(after.getByRole('heading', { name: 'Edit SYRQ10.abs' })).toBeFocused();
	await expect(after.getByLabel('Volume in that year')).toHaveValue('1.2');
	await expect(after.locator('#demand-annual-note')).toHaveValue('Municipal abstraction licence');
	await expect(after.locator('[data-source="annual"]')).toContainText('Municipal abstraction licence');
});

test('shares that miss 100 stop Apply and Scale puts them right', async ({ page }) => {
	const panel = await fill(page);
	await expect(apply(panel)).toBeEnabled();
	await panel.getByLabel('October share, %').fill('20');
	await expect(panel.locator('[data-sum-ok]')).toHaveText('Sum: 111.67 %, 11.67 over 100');
	await expect(panel.locator('[data-sum-ok]')).toHaveAttribute('data-sum-ok', 'false');
	await expect(panel.locator('[data-preview="paused"]')).toContainText('The 12 shares must add up to 100 %');
	await expect(apply(panel)).toBeDisabled();
	await panel.getByRole('button', { name: 'Scale to 100 %' }).click();
	await expect(panel.locator('[data-sum-ok]')).toHaveText('Sum: 100.00 %');
	await expect(panel.locator('[data-sum-ok]')).toHaveAttribute('data-sum-ok', 'true');
	await expect(apply(panel)).toBeEnabled();
});

test('Cancel changes nothing and returns the focus to the button that opened the form', async ({ page }) => {
	const panel = await fill(page);
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(panel.getByRole('button', { name: 'New demand' })).toBeFocused();
	await expect(panel.getByRole('table', { name: 'Demand files' }).locator('tr[data-file="SYRQ10.ABS"]')).toHaveCount(0);
});

test('the saved zip holds the file and RV 5 reads it on its new route', async ({ page }) => {
	const panel = await fill(page);
	await apply(panel).click();
	await expect(page.locator('#demand-applied')).toBeFocused();
	const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save as WRSM2000 zip' }).click()]);
	const files = unpackZip(new Uint8Array(await readFile((await saved.path())!)));
	const reservoir = files[Object.keys(files).find((name) => /SYRV5\.DAT$/i.test(name))!]!;
	expect(reservoir).toContain(`10 'SYRQ10.abs'`);
	const demand = files[Object.keys(files).find((name) => /SYRQ10\.abs$/i.test(name))!]!;
	expect(demand.trim().split('\n')).toHaveLength(30);
});

test('a demand Pitman made goes after a confirmation, Keep it hands the focus back, and Undo restores it', async ({ page }) => {
	const panel = await fill(page);
	await apply(panel).click();
	await expect(page.locator('#demand-applied')).toBeFocused();
	const row = panel.locator('tr[data-file="SYRQ10.ABS"]');

	await panel.getByRole('button', { name: 'Remove SYRQ10.abs' }).click();
	const ask = panel.locator('[data-removing="SYRQ10.ABS"]');
	await expect(ask).toContainText('Remove SYRQ10.abs?');
	await expect(ask).toContainText('Route 10 stays on RV 5 and carries nothing. A new demand can use it.');
	await expect(ask).toContainText('Its spec and sources leave pitman.json.');
	await expect(panel.getByRole('button', { name: 'Keep it' })).toBeFocused();
	await expect(panel.getByLabel('Why it goes (required)')).toHaveCount(0);

	await panel.getByRole('button', { name: 'Keep it' }).click();
	await expect(ask).toHaveCount(0);
	await expect(panel.getByRole('button', { name: 'Remove SYRQ10.abs' })).toBeFocused();
	await expect(row).toHaveCount(1);

	await panel.getByRole('button', { name: 'Remove SYRQ10.abs' }).click();
	await ask.getByRole('button', { name: 'Remove SYRQ10.abs' }).click();
	const notice = page.locator('#demand-removed');
	await expect(notice).toBeFocused();
	await expect(notice).toContainText('SYRQ10.abs off RV 5 route 10');
	await expect(row).toHaveCount(0);
	const noSpec = await savedFiles(page);
	expect(fileNamed(noSpec, /SYRQ10\.abs$/i)).toBeUndefined();
	expect(JSON.parse(noSpec['pitman.json']!)).not.toHaveProperty('demands');
	expect(noSpec['pitman.json']).not.toContain('SYRQ10');

	await notice.getByRole('button', { name: 'Undo the removal' }).click();
	await expect(notice).toBeFocused();
	await expect(notice).toContainText('Put back.');
	await expect(notice.getByRole('button', { name: 'Undo the removal' })).toHaveCount(0);
	await expect(row).toContainText('1.20');
	const back = await savedFiles(page);
	expect(fileNamed(back, /SYRQ10\.abs$/i)).toBeDefined();
	expect(JSON.parse(back['pitman.json']!).demands).toHaveProperty(['SYRQ10.ABS']);
});

test('a network’s own file needs a reason, says what happens, and leaves the saved zip with the removal on record', async ({ page }) => {
	const panel = await start(page);
	await panel.getByRole('button', { name: 'Remove SYRQ9.ABS' }).click();
	const ask = panel.locator('[data-removing="SYRQ9.ABS"]');
	await expect(ask).toContainText('one of the network’s own files');
	await expect(ask).toContainText('The file leaves the working copy and the next saved zip.');
	const confirm = ask.getByRole('button', { name: 'Remove SYRQ9.ABS' });
	await expect(confirm).toBeDisabled();
	await panel.getByLabel('Why it goes (required)').fill('Scheme closed in 2019');
	await confirm.click();
	await expect(page.locator('#demand-removed')).toBeFocused();
	await expect(panel.locator('tr[data-file="SYRQ9.ABS"]')).toHaveCount(0);
	await expect(panel.locator('.removals')).toContainText('Scheme closed in 2019');
	await expect(page.getByRole('link', { name: /Demands/ })).toContainText('1 removed');

	const files = await savedFiles(page);
	expect(fileNamed(files, /SYRQ9\.ABS$/i)).toBeUndefined();
	const channel = files[fileNamed(files, /SYCR4\.DAT$/i)!]!;
	expect(channel).not.toContain('SYRQ9');
	const sidecar = JSON.parse(files['pitman.json']!) as { values: { target: { file: string; field: string }; source: { note: string } }[] };
	expect(sidecar.values).toHaveLength(1);
	expect(sidecar.values[0]!.target).toEqual({ file: 'SYRQ9.ABS', field: 'demandRemoved' });
	expect(sidecar.values[0]!.source.note).toMatch(/^Demand removed: SYRQ9\.ABS, on CR 4 route 9 \(1980 to 2009, mean .* million m³\/a\); Scheme closed in 2019$/);

	await expect(page.locator('[data-working-copy]')).toHaveAttribute('data-working-copy', 'stored');
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	await page.getByRole('button', { name: 'Show Demands' }).click();
	const after = page.getByRole('region', { name: 'Demands' });
	await expect(after.locator('tr[data-file="SYRQ9.ABS"]')).toHaveCount(0);
	await expect(after.locator('.removals')).toContainText('Scheme closed in 2019');
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
});

test('a defined inflow takes its zero-source route with it, and the network still runs', async ({ page }) => {
	const panel = await start(page);
	await panel.getByRole('button', { name: 'Remove SYTRANS.ABS' }).click();
	const ask = panel.locator('[data-removing="SYTRANS.ABS"]');
	await expect(ask).toContainText('Route 6 goes too: a route from the zero source must have a file (TT 689 p.xv).');
	await panel.getByLabel('Why it goes (required)').fill('Transfer scheme stopped');
	await ask.getByRole('button', { name: 'Remove SYTRANS.ABS' }).click();
	await expect(page.locator('#demand-removed')).toBeFocused();
	await page.locator('#demand-removed').getByRole('button', { name: 'Rerun the network' }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByRole('region', { name: 'Results' })).toBeVisible();
	const net = await savedFiles(page);
	expect(net[fileNamed(net, /SYTRANS\.ABS$/i) ?? 'none']).toBeUndefined();
});

test('a shared file can come off one route, and stays in the zip for the other', async ({ page }) => {
	const panel = await start(page, sharedFileZip());
	await panel.getByRole('button', { name: 'Remove SYRQ9.ABS' }).click();
	const ask = panel.locator('[data-removing="SYRQ9.ABS"]');
	await expect(ask.getByRole('group', { name: '2 routes read this file' })).toBeVisible();
	await expect(ask).toContainText('Route 12 stays on RV 5');
	await expect(ask).toContainText('Route 9 stays on CR 4');
	await ask.getByLabel(/Only CR 4 Synthetic river, route 9/).check();
	await expect(ask).toContainText('The file stays, on RV 5 Synthetic dam, route 12 to the zero sink.');
	await expect(ask).not.toContainText('Route 12 stays on RV 5');
	await panel.getByLabel('Why it goes (required)').fill('Abstraction moved to the dam');
	await ask.getByRole('button', { name: 'Take it off CR 4 route 9' }).click();
	await expect(page.locator('#demand-removed')).toBeFocused();
	await expect(page.locator('#demand-removed')).toContainText('The file stays on its other routes, and the next save keeps it for them.');
	const row = panel.locator('tr[data-file="SYRQ9.ABS"]');
	await expect(row).toContainText('RV 5 Synthetic dam, route 12');
	await expect(row).not.toContainText('route 9');
	const files = await savedFiles(page);
	expect(fileNamed(files, /SYRQ9\.ABS$/i)).toBeDefined();
	expect(files[fileNamed(files, /SYCR4\.DAT$/i)!]).not.toContain('SYRQ9');
	expect(files[fileNamed(files, /SYRV5\.DAT$/i)!]).toContain('SYRQ9');
});

test('removing a file while its row is open closes it, and Undo goes once the network moves on', async ({ page }) => {
	const panel = await start(page);
	await panel.getByRole('button', { name: 'View SYRQ9.ABS' }).click();
	await expect(panel.locator('[data-demand-view]')).toBeVisible();
	await panel.getByRole('button', { name: 'Remove SYRQ9.ABS' }).click();
	await panel.getByLabel('Why it goes (required)').fill('Closed');
	await panel.locator('[data-removing]').getByRole('button', { name: 'Remove SYRQ9.ABS' }).click();
	await expect(panel.locator('[data-demand-view]')).toHaveCount(0);

	await page.getByRole('button', { name: 'Show Land-use tables' }).click();
	const tables = page.getByRole('region', { name: 'Land-use tables' });
	await tables.getByLabel('Runoff module', { exact: true }).selectOption('2');
	const block = tables.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Paved area', exact: true }) });
	await block.getByRole('button', { name: 'Add 2025' }).click();
	await block.getByLabel(/Paved fraction/).fill('0.100');
	await block.getByLabel('Where 2025’s value came from (required)').fill('Town plan');
	await tables.getByRole('button', { name: 'Apply to the working copy' }).click();
	await expect(page.locator('#tables-applied')).toBeFocused();
	await expect(panel.locator('#demand-removed').getByRole('button', { name: 'Undo the removal' })).toHaveCount(0);
	await expect(panel.locator('#demand-removed')).toContainText('Undo has gone, because the network has changed since.');
});

test('no sideways scroll on a phone with a removal asked', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const panel = await start(page, sharedFileZip());
	await panel.getByRole('button', { name: 'Remove SYRQ9.ABS' }).click();
	await expect(panel.locator('[data-removing]')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test('no sideways scroll on a phone with the form open', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await fill(page);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
