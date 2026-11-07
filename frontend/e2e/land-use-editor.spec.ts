import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from './fixtures.js';
import { writeBundle } from '../src/lib/network/engine.js';
import { syntheticBundle } from '../src/lib/network/synthetic.js';
import { packZip, unpackZip } from '../src/lib/network/zip.js';

// The land-use tables on the real page: edit, refuse, note, apply, reset, and what a save keeps. The
// engine's synthetic network has empty tables, so RU 1 gets invented rows here. Synthetic data only (rule 2).

const YEARS = { startYear: 1980, years: 30 };

/** RU 1 with an afforestation table of two years, written as a zip through the app's own writer. */
function networkWithTables(): Buffer {
	const bundle = syntheticBundle(YEARS);
	const modules = bundle.modules.map((m) => (m.kind === 'RU' && m.number === 1 ? { ...m, afforestation: { ...m.afforestation, areaKm2: [{ year: 1990, value: 2 }, { year: 2005, value: 4.5 }] } } : m));
	return Buffer.from(packZip(writeBundle({ ...bundle, modules }), { mtime: new Date('2025-01-01T00:00:00Z') }));
}

/** RU 2 a parent of RU 3, an afforested child, with `algorithm`, and RU 1 a free module with alien vegetation. */
function networkWithComposition(algorithm: 1 | 2 = 2): Buffer {
	const bundle = syntheticBundle(YEARS);
	const species = { pine: { percent: 60, rotationYears: 20 }, eucalyptus: { percent: 40, rotationYears: 10 }, wattle: { percent: 0, rotationYears: 0 } };
	const modules = bundle.modules.map((m) => {
		if (m.kind !== 'RU') return m;
		if (m.number === 1) return { ...m, alienVegetation: { algorithm: 1 as const, riparianArea: 20, areaKm2: [{ year: 1995, value: 2 }], composition: { tallTrees: { percent: 50, ageYears: 15 }, mediumTrees: { percent: 30, ageYears: 10 }, tallShrubs: { percent: 20, ageYears: 12 } }, optimalPercent: 50 } };
		if (m.number === 2) return { ...m, sfrChildren: [3] };
		if (m.number === 3) return { ...m, afforestation: { ...m.afforestation, algorithm, areaKm2: [{ year: 1990, value: 3 }], species, optimalPercent: 50 } };
		return m;
	});
	return Buffer.from(packZip(writeBundle({ ...bundle, modules }), { mtime: new Date('2025-01-01T00:00:00Z') }));
}

async function load(page: Page, buffer: Buffer) {
	await page.getByLabel('Network zip', { exact: true }).setInputFiles({ name: 'SY.zip', mimeType: 'application/zip', buffer });
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
}

const panelOf = (page: Page) => page.getByRole('region', { name: 'Land-use tables' });

async function open(page: Page, module = '1') {
	await page.getByRole('button', { name: 'Show Land-use tables' }).click();
	const panel = panelOf(page);
	await panel.getByLabel('Runoff module', { exact: true }).selectOption(module);
	return panel;
}

const applyButton = (panel: ReturnType<typeof panelOf>) => panel.getByRole('button', { name: 'Apply to the working copy' });

async function savedFiles(page: Page) {
	const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save as WRSM2000 zip' }).click()]);
	return unpackZip(new Uint8Array(await readFile((await saved.path())!)));
}

test.beforeEach(async ({ page }) => {
	await page.route('**/quaternaries', (route) => route.fulfill({ json: { type: 'FeatureCollection', features: [], source: 'none' } }));
	await page.goto('/');
});

test('a value the file can’t hold is refused with the two nearest, and said again at Apply', async ({ page }) => {
	await load(page, networkWithTables());
	const panel = await open(page);
	await expect(panel.getByRole('heading', { name: 'Afforestation', exact: true })).toBeVisible();
	const value = panel.getByLabel('Afforested area, km² in 2005');
	await expect(value).toHaveValue('4.5');
	await value.fill('4.55');
	const refusal = 'The file keeps 1 decimal place here (L.008), so this can’t be saved exactly. Use 4.5 or 4.6.';
	await expect(panel.locator('[data-for="2005"]')).toContainText(refusal);
	await expect(value).toHaveAttribute('aria-invalid', 'true');
	await expect(panel.locator('.pending')).toContainText(`Afforestation 2005: ${refusal}`);
	await expect(applyButton(panel)).toBeDisabled();
});

test('a changed value needs a source before it can be applied, and Reset takes it back', async ({ page }) => {
	await load(page, networkWithTables());
	const panel = await open(page);
	await panel.getByLabel('Afforested area, km² in 2005').fill('6');
	await expect(panel.locator('tr[data-year="2005"]')).toHaveAttribute('data-state', 'edited');
	await expect(panel.locator('.pending')).toContainText('Afforestation 2005: 4.5 km² → 6.0 km²');
	await expect(panel.locator('.pending')).toContainText('1 value still needs a source.');
	await expect(applyButton(panel)).toBeDisabled();

	await panel.getByLabel('Same source for all of them').fill('Aerial photos 2005');
	await panel.getByRole('button', { name: 'Use for 1 value' }).click();
	await expect(panel.getByLabel('Where 2005’s value came from (required)')).toHaveValue('Aerial photos 2005');
	await expect(applyButton(panel)).toBeEnabled();

	await panel.getByRole('button', { name: 'Reset 2005 to 4.5' }).click();
	await expect(panel.locator('tr[data-year="2005"]')).toHaveAttribute('data-state', 'same');
	await expect(panel.locator('.pending')).toHaveCount(0);
});

test('apply clears the results, logs the source, and a save and reload keeps the file’s value', async ({ page }) => {
	await load(page, networkWithTables());
	await page.locator('#mode-natural').check();
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-ready', 'true');

	const panel = await open(page);
	await panel.getByLabel('Afforested area, km² in 2005').fill('6');
	await panel.getByLabel('Where 2005’s value came from (required)').fill('Aerial photos 2005');
	await applyButton(panel).click();
	const applied = page.locator('#tables-applied');
	await expect(applied).toBeFocused();
	await expect(applied).toContainText('Applied 1 change to RU 1: Afforestation 2005: 4.5 km² → 6.0 km²');
	await expect(page.locator('[data-run-state]')).toHaveAttribute('data-run-state', 'idle');
	await expect(page.getByRole('region', { name: 'Results' })).toHaveCount(0);

	const files = await savedFiles(page);
	const sidecar = JSON.parse(files['pitman.json']!) as { values: { target: unknown; source: { kind: string; note: string } }[] };
	expect(sidecar.values).toHaveLength(1);
	expect(sidecar.values[0]!.target).toEqual({ module: { type: 'RU', number: 1 }, field: 'afforestation.areaKm2', year: 2005 });
	expect(sidecar.values[0]!.source).toMatchObject({ kind: 'manual', note: 'Land use: 4.5 → 6; Aerial photos 2005' });

	// The browser's working copy: the new value in the box, the file's beside it.
	await expect(page.locator('[data-working-copy]')).toHaveAttribute('data-working-copy', 'stored');
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	let reopened = await open(page);
	await expect(reopened.getByLabel('Afforested area, km² in 2005')).toHaveValue('6.0');
	await expect(reopened.locator('tr[data-year="2005"] .file')).toHaveText('4.5');

	// The saved zip, from an empty browser: the same, and Reset still reaches the file's value with no source asked.
	await page.getByRole('button', { name: 'Forget the working copy' }).click();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toHaveCount(0);
	await load(page, Buffer.from(packZip(files)));
	reopened = await open(page);
	await expect(reopened.getByLabel('Afforested area, km² in 2005')).toHaveValue('6.0');
	await expect(reopened.locator('tr[data-year="2005"] .file')).toHaveText('4.5');
	await reopened.getByRole('button', { name: 'Reset 2005 to 4.5' }).click();
	await expect(reopened.locator('[data-for="2005"]')).toContainText('Back to the network file’s value, so no source is needed.');
	await expect(applyButton(reopened)).toBeEnabled();
});

test('the first year of an empty table takes the focus, and the file’s value stays none', async ({ page }) => {
	await load(page, Buffer.from(packZip(writeBundle(syntheticBundle(YEARS)))));
	const panel = await open(page, '2');
	const block = panel.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Afforestation', exact: true }) });
	await expect(block).toContainText('No years in this table. Add one below.');
	await block.getByRole('button', { name: 'Add 2025' }).click();
	await expect(block.getByLabel('Afforested area, km² in 2025')).toBeFocused();
	await expect(block.locator('[data-for="2025"]')).toContainText('Enter the value for 2025, or remove the year.');
	await block.getByLabel('Afforested area, km² in 2025').fill('3.5');
	await expect(block.locator('[data-for="2025"]')).toContainText('2025 is after the run’s last year (2009)');
	await block.getByLabel('Where 2025’s value came from (required)').fill('Plantation register');
	await applyButton(panel).click();
	await expect(page.locator('#tables-applied')).toBeFocused();
	await expect(block.locator('tr[data-year="2025"] .file')).toHaveText('none');
	await expect(block.locator('[data-for="2025"]')).toContainText('Plantation register');

	const files = await savedFiles(page);
	expect(JSON.parse(files['pitman.json']!)).toMatchObject({ values: [{ target: { module: { type: 'RU', number: 2 }, year: 2025 }, source: { note: 'Land use: none → 3.5; Plantation register' } }] });
});

test('a share that breaks the sum stops Apply, in words, until the shares add up', async ({ page }) => {
	await load(page, networkWithComposition());
	const panel = await open(page, '3');
	const block = panel.locator('[data-composition="afforestation"]');
	await expect(block.getByRole('heading', { name: 'Species split and rotations' })).toBeVisible();
	await expect(block.locator('[data-sum-ok]')).toHaveText('Sum: 100.00 %');
	await expect(block.locator('[data-targets]')).toContainText('Targets a run calibrates this child to: MAR ');
	const before = await block.locator('[data-targets]').textContent();

	await block.getByLabel('Pine share, %').fill('50');
	await expect(block.locator('[data-sum-ok]')).toHaveText('Sum: 90.00 %, 10.00 short of 100');
	await expect(block.locator('[data-sum-ok]')).toHaveAttribute('data-sum-ok', 'false');
	await expect(block.locator('[data-targets]')).toContainText('put the shares right to see them');
	const stop = 'The three genus shares (L.009) must add up to 100 %. They come to 90.00 %, 10.00 short of 100.';
	await expect(panel.locator('.pending')).toContainText(stop);
	await expect(panel.locator('[data-live]')).toHaveText(stop);
	await expect(applyButton(panel)).toBeDisabled();

	await block.getByLabel('Eucalyptus share, %').fill('50');
	await expect(block.locator('[data-sum-ok]')).toHaveText('Sum: 100.00 %');
	await expect(block.locator('[data-targets]')).toContainText('→');
	await expect(block.locator('[data-targets]')).not.toHaveText(before!);
	await expect(panel.locator('.pending')).toContainText('2 values still need a source.');
	await expect(applyButton(panel)).toBeDisabled();
	await panel.getByLabel('Same source for all of them').fill('Forestry records 2024');
	await panel.getByRole('button', { name: 'Use for 2 values' }).click();
	await expect(applyButton(panel)).toBeEnabled();
});

test('an applied split reaches the file and the sidecar, keeps its source through a reload, and Reset needs none', async ({ page }) => {
	await load(page, networkWithComposition());
	const panel = await open(page, '3');
	const block = panel.locator('[data-composition="afforestation"]');
	await block.getByLabel('Pine share, %').fill('33.33');
	await block.getByLabel('Eucalyptus share, %').fill('33.33');
	await block.getByLabel('Wattle share, %').fill('33.34');
	await block.getByLabel('Pine rotation, years').fill('25');
	await panel.getByLabel('Same source for all of them').fill('Forestry records 2024');
	await panel.getByRole('button', { name: 'Use for 4 values' }).click();
	await applyButton(panel).click();
	await expect(page.locator('#tables-applied')).toBeFocused();
	await expect(page.locator('#tables-applied')).toContainText('Applied 4 changes to RU 3: Afforestation, pine share: 60.00 % → 33.33 %');

	const files = await savedFiles(page);
	const module = files[Object.keys(files).find((name) => /SYRU3\.DAT$/i.test(name))!]!;
	expect(module).toContain(' 33.33  25  33.33  10  33.34   0');
	const sidecar = JSON.parse(files['pitman.json']!) as { values: { target: { field: string }; source: { note: string } }[] };
	expect(sidecar.values.find((v) => v.target.field === 'afforestation.species.pine.rotationYears')?.source.note).toBe('Land use: 20 → 25; Forestry records 2024');

	await expect(page.locator('[data-working-copy]')).toHaveAttribute('data-working-copy', 'stored');
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Network SY' })).toBeVisible();
	const reopened = await open(page, '3');
	const again = reopened.locator('[data-composition="afforestation"]');
	await expect(again.getByLabel('Pine rotation, years')).toHaveValue('25');
	const row = again.locator('[data-field="afforestation.species.pine.rotationYears"]');
	await expect(row.locator('.file')).toHaveText('20');
	await expect(again.locator('[data-for="afforestation.species.pine.rotationYears"]')).toContainText('Forestry records 2024');

	await again.getByRole('button', { name: 'Reset pine rotation to 20' }).click();
	await expect(again.getByLabel('Pine rotation, years')).toBeFocused();
	await expect(again.getByLabel('Pine rotation, years')).toHaveValue('20');
	await expect(again.locator('[data-for="afforestation.species.pine.rotationYears"]')).toContainText('Back to the network file’s value, so no source is needed.');
	await expect(applyButton(reopened)).toBeEnabled();
});

test('a value the file can’t hold is refused beside its box and at Apply', async ({ page }) => {
	await load(page, networkWithComposition());
	const panel = await open(page, '1');
	const block = panel.locator('[data-composition="alienVegetation"]');
	const box = block.getByLabel('Tall trees share, %');
	await box.fill('33.333');
	await expect(box).toHaveAttribute('aria-invalid', 'true');
	const refusal = 'The file keeps 2 decimal places here (L.014), so this can’t be saved exactly. Use 33.33 or 33.34.';
	await expect(block.locator('[data-for="alienVegetation.composition.tallTrees.percent"]')).toContainText(refusal);
	await expect(panel.locator('.pending')).toContainText(`Alien vegetation, tall trees share: ${refusal}`);
	await expect(applyButton(panel)).toBeDisabled();
	await expect(block.getByLabel('Riparian share, %')).toHaveValue('20.00');
	await expect(block.getByLabel('Optimal area, %')).toHaveValue('50.00');
	await expect(block.getByLabel('Tall shrubs age, years')).toHaveValue('12.00');
});

test('a CSIR child keeps rotations and optimal growth in view, read-only, and says why', async ({ page }) => {
	await load(page, networkWithComposition(1));
	const panel = await open(page, '3');
	const block = panel.locator('[data-composition="afforestation"]');
	await expect(block.locator('[data-lock]').first()).toContainText('Read-only on a CSIR child');
	await expect(block.locator('[data-lock]').first()).toContainText('when the SFR calibration doesn’t close');
	const rotation = block.locator('[data-field="afforestation.species.pine.rotationYears"]');
	await expect(rotation).toContainText('read-only');
	await expect(rotation).toContainText('20');
	await expect(rotation.getByRole('textbox')).toHaveCount(0);
	await expect(block.locator('[data-field="afforestation.optimalPercent"]').getByRole('textbox')).toHaveCount(0);
	await expect(block.getByLabel('Pine share, %')).toBeEnabled();
	await expect(block).toContainText('The algorithm (L.006) isn’t edited here');
});

test('a first year opens the split in the same Apply', async ({ page }) => {
	await load(page, Buffer.from(packZip(writeBundle(syntheticBundle(YEARS)))));
	const panel = await open(page, '2');
	await expect(panel.locator('[data-composition="afforestation"]')).toHaveCount(0);
	const table = panel.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Afforestation', exact: true }) });
	await table.getByRole('button', { name: 'Add 2025' }).click();
	await table.getByLabel('Afforested area, km² in 2025').fill('3.5');
	await table.getByLabel('Where 2025’s value came from (required)').fill('Plantation register');
	const block = panel.locator('[data-composition="afforestation"]');
	await block.getByLabel('Pine share, %').fill('100');
	await block.locator('[data-for="afforestation.species.pine.percent"]').getByRole('textbox').fill('Plantation register');
	await applyButton(panel).click();
	await expect(page.locator('#tables-applied')).toBeFocused();
	const files = await savedFiles(page);
	expect(files[Object.keys(files).find((name) => /SYRU2\.DAT$/i.test(name))!]).toContain('100.00');
});

test('no sideways scroll on a phone with the composition open and edited', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await load(page, networkWithComposition());
	const panel = await open(page, '3');
	await panel.getByLabel('Pine share, %').fill('50');
	await expect(panel.locator('.pending')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test('no sideways scroll on a phone with a table open', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await load(page, networkWithTables());
	await open(page);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
