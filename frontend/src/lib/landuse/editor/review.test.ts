import { applyTableEdits, readBundle, writeBundle, yearTableOf, type NetworkBundle, type RunoffModule } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { landUseBundle, runoff, withRunoff } from './fixtures.test-helper.js';
import { addYearProblem, canRemove, changeLine, fillNotes, formatCell, putBack, refusedRows, removeRow, resetRow, reviewModule, suggestedYear, tableRows, targetTable, toEdits, type ModuleDraft, type RowView } from './review.js';

const bundle = landUseBundle();
const free = runoff(bundle, 1);
const DATE = '2026-10-30T08:00:00.000Z';
const row = (rows: readonly RowView[], year: number) => rows.find((r) => r.year === year)!;

function applied(b: NetworkBundle, module: RunoffModule, draft: ModuleDraft): NetworkBundle {
	return applyTableEdits(b, toEdits(module, reviewModule(b, module, draft).changes, DATE));
}

describe('formatCell', () => {
	it('shows the file’s precision, or all a file held beyond it', () => {
		expect(formatCell('afforestation', 10)).toBe('10.0');
		expect(formatCell('paved', 0.012)).toBe('0.012');
		expect(formatCell('afforestation', 0.25)).toBe('0.25');
	});
});

describe('tableRows', () => {
	it('shows the working copy’s rows as they are', () => {
		const rows = tableRows(free, 'afforestation', undefined, undefined);
		expect(rows.map((r) => [r.year, r.text, r.state, r.file])).toEqual([[1990, '4.5', 'same', 4.5], [2004, '10.0', 'same', 10]]);
		expect(rows.some((r) => r.changed)).toBe(false);
	});

	it('marks an edit, keeping the file’s value beside it', () => {
		const r = row(tableRows(free, 'afforestation', { 2004: { text: '11', note: '' } }, undefined), 2004);
		expect(r).toMatchObject({ state: 'edited', current: 10, file: 10, target: 11, changed: true, needsNote: true, error: null });
	});

	it('takes a decimal comma, as the other screens do', () => {
		expect(row(tableRows(free, 'afforestation', { 2004: { text: '11,5', note: '' } }, undefined), 2004).target).toBe(11.5);
	});

	it('treats a value typed back as no change', () => {
		expect(row(tableRows(free, 'afforestation', { 2004: { text: '10', note: '' } }, undefined), 2004)).toMatchObject({ state: 'same', changed: false, needsNote: false });
	});

	it('refuses what the file can’t hold, keeps the working copy’s value in the preview', () => {
		const r = row(tableRows(free, 'afforestation', { 2004: { text: '1.25', note: '' } }, undefined), 2004);
		expect(r).toMatchObject({ state: 'edited', target: 10, changed: false });
		expect(r.error).toContain('Use 1.2 or 1.3');
		expect(row(tableRows(free, 'paved', { 2000: { text: '1.5', note: '' } }, undefined), 2000).error).toContain('from 0 to 1');
		expect(row(tableRows(free, 'afforestation', { 2004: { text: 'lots', note: '' } }, undefined), 2004).error).toBe('2004’s value must be a number.');
	});

	it('doesn’t judge a value in the file that nobody touched', () => {
		const fine = { ...free, afforestation: { ...free.afforestation, areaKm2: [{ year: 2000, value: 0.25 }] } };
		expect(row(tableRows(fine, 'afforestation', { 2000: { text: '0.25', note: '' } }, undefined), 2000).error).toBeNull();
	});

	it('adds a year in order, asking for its value', () => {
		const rows = tableRows(free, 'afforestation', { 2025: { text: '', note: '' }, 1980: { text: '1', note: '' } }, undefined);
		expect(rows.map((r) => r.year)).toEqual([1980, 1990, 2004, 2025]);
		expect(row(rows, 2025)).toMatchObject({ state: 'new', file: null, target: null, changed: false, error: 'Enter the value for 2025, or remove the year.' });
		expect(row(rows, 1980)).toMatchObject({ state: 'new', target: 1, changed: true, needsNote: true });
	});

	it('shows a pending removal with its value, needing a reason', () => {
		const rows = tableRows(free, 'afforestation', { 1990: { text: '4.5', note: '', removed: true } }, undefined);
		expect(row(rows, 1990)).toMatchObject({ state: 'removing', target: null, changed: true, needsNote: true });
		expect(targetTable(rows)).toEqual([{ year: 2004, value: 10 }]);
	});

	it('shows a table with a repeated year row by row, with nothing to edit', () => {
		const twice = { ...free, paved: { fraction: [{ year: 2000, value: 0.1 }, { year: 2000, value: 0.2 }] } };
		expect(tableRows(twice, 'paved', undefined, undefined).map((r) => r.text)).toEqual(['0.100', '0.200']);
	});
});

describe('after an apply', () => {
	const next = applied(bundle, free, { afforestation: { 2004: { text: '12', note: 'Survey' }, 2025: { text: '14.5', note: 'Survey' }, 1990: { text: '4.5', note: 'Gone', removed: true } } });
	const module = runoff(next, 1);
	const rows = tableRows(module, 'afforestation', undefined, next.sidecar);

	it('a changed row keeps the file’s value and says its source', () => {
		expect(row(rows, 2004)).toMatchObject({ state: 'same', current: 12, file: 10, applied: 'Applied 2026-10-30: Survey' });
	});

	it('a new year has no file value', () => {
		expect(row(rows, 2025)).toMatchObject({ current: 14.5, file: null });
	});

	it('a removed year stays in view, to be put back', () => {
		expect(row(rows, 1990)).toMatchObject({ state: 'removed', current: null, file: 4.5, target: null });
	});

	it('reset goes back to the file’s value with no note needed, and records that', () => {
		const draft = { afforestation: resetRow({}, 'afforestation', row(rows, 2004)) };
		expect(draft.afforestation[2004]).toEqual({ text: '10.0', note: '' });
		const review = reviewModule(next, module, draft);
		expect(review.changes).toEqual([{ table: 'afforestation', year: 2004, from: 12, to: 10, note: '', backToFile: true }]);
		expect(review.missingNotes).toBe(0);
		const back = applyTableEdits(next, toEdits(module, review.changes, DATE));
		expect(back.sidecar?.values?.at(-1)?.source).toEqual({ kind: 'networkFile', note: 'Land use: 12 → 10; Back to the network file’s value', date: DATE });
		expect(row(tableRows(runoff(back, 1), 'afforestation', undefined, back.sidecar), 2004)).toMatchObject({ applied: null, current: 10, file: 10 });
	});

	it('reset on a year the file didn’t list removes it, with no note', () => {
		const draft = resetRow({}, 'afforestation', row(rows, 2025));
		expect(reviewModule(next, module, { afforestation: draft }).changes[0]).toMatchObject({ year: 2025, to: null, backToFile: true });
	});

	it('put back restores a removed year', () => {
		const draft = putBack({}, 'afforestation', row(rows, 1990));
		expect(reviewModule(next, module, { afforestation: draft }).changes[0]).toMatchObject({ year: 1990, from: null, to: 4.5, backToFile: true });
	});

	it('survives a save and reload', () => {
		const read = readBundle(writeBundle(next));
		if (!read.ok) throw new Error(JSON.stringify(read.errors));
		const again = tableRows(runoff(read.bundle, 1), 'afforestation', undefined, read.bundle.sidecar);
		expect(row(again, 2004)).toMatchObject({ file: 10, current: 12 });
		expect(row(again, 1990)).toMatchObject({ state: 'removed', file: 4.5 });
	});
});

describe('resetRow, removeRow, putBack', () => {
	const rows = tableRows(free, 'afforestation', { 2004: { text: '11', note: 'x' }, 2025: { text: '3', note: '' } }, undefined);

	it('reset drops an unapplied edit', () => {
		expect(resetRow({ 2004: { text: '11', note: 'x' } }, 'afforestation', row(rows, 2004))).toEqual({});
	});

	it('remove keeps what was typed for a row in the table, and drops a pending new year', () => {
		expect(removeRow({ 2004: { text: '11', note: 'x' } }, row(rows, 2004))).toEqual({ 2004: { text: '11', note: 'x', removed: true } });
		expect(removeRow({ 2025: { text: '3', note: '' } }, row(rows, 2025))).toEqual({});
	});

	it('put back undoes a pending removal', () => {
		const removing = tableRows(free, 'afforestation', { 1990: { text: '4.5', note: '', removed: true } }, undefined);
		expect(putBack({ 1990: { text: '4.5', note: '', removed: true } }, 'afforestation', row(removing, 1990))).toEqual({});
	});
});

describe('canRemove', () => {
	it('keeps the last row where other lines depend on it, not on paved (R7-T4)', () => {
		expect(canRemove('afforestation', tableRows(free, 'afforestation', undefined, undefined))).toBe(true);
		expect(canRemove('alienVegetation', tableRows(free, 'alienVegetation', undefined, undefined))).toBe(false);
		expect(canRemove('paved', tableRows(free, 'paved', undefined, undefined))).toBe(true);
	});
});

describe('suggestedYear and addYearProblem', () => {
	it('offers 2025 first, then the year after the last', () => {
		const rows = tableRows(free, 'paved', undefined, undefined);
		expect(suggestedYear(rows)).toBe(2025);
		expect(suggestedYear(tableRows(free, 'paved', { 2025: { text: '', note: '' } }, undefined))).toBe(2026);
	});

	it('refuses a year in plain words', () => {
		const rows = tableRows(free, 'paved', undefined, undefined);
		expect(addYearProblem(rows, '2025')).toBeNull();
		expect(addYearProblem(rows, '2000')).toBe('2000 is already in this table.');
		expect(addYearProblem(rows, '')).toBe('Enter a year.');
		expect(addYearProblem(rows, '25')).toBe('Enter a whole four-digit year.');
		expect(addYearProblem(rows, '20x5')).toBe('Enter a whole four-digit year.');
	});
});

describe('reviewModule', () => {
	it('changes nothing with no drafts', () => {
		const review = reviewModule(bundle, free, {});
		expect(review.next).toBe(free);
		expect(review).toMatchObject({ changes: [], errors: [], valid: true, missingNotes: 0 });
	});

	it('the preview module has the edits, and the working copy doesn’t', () => {
		const review = reviewModule(bundle, free, { paved: { 2025: { text: '0.03', note: 'x' } } });
		expect(yearTableOf(review.next, 'paved').at(-1)).toEqual({ year: 2025, value: 0.03 });
		expect(yearTableOf(free, 'paved')).toHaveLength(1);
	});

	it('counts values with no source, and doesn’t count a blank note as one', () => {
		expect(reviewModule(bundle, free, { paved: { 2025: { text: '0.03', note: '  ' } } }).missingNotes).toBe(1);
		expect(reviewModule(bundle, free, { paved: { 2025: { text: '0.03', note: ' Survey ' } } }).changes[0]?.note).toBe('Survey');
	});

	it('says how a new last year changes the run, and when the run doesn’t reach it', () => {
		const rows = reviewModule(bundle, free, { afforestation: { 2025: { text: '14.5', note: '' } } }).tables.afforestation;
		expect(row(rows, 2025).hint).toBe('A run now reads a straight line from 2004 (10.0) to 2025 (14.5); until now it held 10.0 flat after 2004. 2025 is after the run’s last year (2009), so a run won’t read it until the run period is extended.');
	});

	it('has no hint for a year inside the table', () => {
		expect(row(reviewModule(bundle, free, { afforestation: { 2000: { text: '8', note: '' } } }).tables.afforestation, 2000).hint).toBeNull();
	});

	it('refuses alien vegetation over the module’s area (TT 689 p.128)', () => {
		const review = reviewModule(bundle, free, { alienVegetation: { 2025: { text: '101', note: 'x' } } });
		expect(review.errors[0]).toBe('Alien vegetation in 2025 can’t be more than the module’s 100.0 km² (TT 689 p.128).');
		expect(review.valid).toBe(false);
	});

	it('refuses special areas over the module’s area in any listed year (TT 689 p.127)', () => {
		const review = reviewModule(bundle, free, { afforestation: { 2004: { text: '98', note: 'x' } }, paved: { 2000: { text: '0.100', note: 'x' } } });
		expect(review.errors).toEqual(['In 2004, afforestation 98.0 km², alien vegetation 2.0 km², paved 10.0 km² add up to 110.0 km², more than RU 1’s 100.0 km² (TT 689 p.127).']);
		expect(review.valid).toBe(false);
	});

	it('agrees with the run’s own check at the boundary', () => {
		expect(reviewModule(bundle, free, { afforestation: { 2004: { text: '96.8', note: 'x' } } }).valid).toBe(true);
		expect(reviewModule(bundle, free, { afforestation: { 2004: { text: '96.9', note: 'x' } } }).valid).toBe(false);
	});

	it('counts a parent’s children against it', () => {
		const parent = runoff(bundle, 2);
		const review = reviewModule(bundle, parent, { paved: { 2004: { text: '0.900', note: 'x' } } });
		expect(review.errors[0]).toContain('paved 45.0 km², SFR children 8.0 km² add up to 53.0 km², more than RU 2’s 50.0 km²');
	});

	it('holds a child to its parent’s area, and only warns past its own L.002 (TT 689 pp.139–140)', () => {
		const child = runoff(bundle, 3);
		const past = reviewModule(bundle, child, { afforestation: { 2004: { text: '12', note: 'x' } } });
		expect(past.errors).toEqual([]);
		expect(past.valid).toBe(true);
		expect(past.warnings[0]).toContain('more than the 10.0 km² on its L.002');
		const over = reviewModule(bundle, child, { afforestation: { 2004: { text: '51', note: 'x' } } });
		expect(over.errors[0]).toContain('more than RU 2’s 50.0 km²');
	});

	it('doesn’t blame an edit for what the file already had', () => {
		const heavy = withRunoff(bundle, 1, (m) => ({ ...m, areaKm2: 10 }));
		const review = reviewModule(heavy, runoff(heavy, 1), { paved: { 2000: { text: '0.010', note: 'x' } } });
		expect(review.errors).toEqual([]);
		expect(review.warnings[0]).toContain('already over this area');
	});

	it('lists a refused row at Apply, by name', () => {
		const review = reviewModule(bundle, free, { paved: { 2000: { text: '1.5', note: '' } } });
		expect(review.valid).toBe(false);
		expect(refusedRows(review)[0]).toMatch(/^Paved area 2000: Paved area is a fraction/);
	});

	it('warns when saving rounds what the file held beyond its format', () => {
		const fine = withRunoff(bundle, 1, (m) => ({ ...m, afforestation: { ...m.afforestation, areaKm2: [{ year: 1990, value: 0.25 }, { year: 2004, value: 10 }] } }));
		const review = reviewModule(fine, runoff(fine, 1), { paved: { 2025: { text: '0.03', note: 'x' } } });
		expect(review.saved).toEqual({ rounded: ['afforestation 1990'], problem: null });
	});
});

describe('changeLine', () => {
	it('says the change with its unit', () => {
		expect(changeLine({ table: 'afforestation', year: 2025, from: null, to: 14.5, note: '', backToFile: false })).toBe('Afforestation 2025: none → 14.5 km²');
		expect(changeLine({ table: 'alienVegetation', year: 1995, from: 2, to: null, note: '', backToFile: false })).toBe('Alien vegetation 1995: 2.0 km² → none');
		expect(changeLine({ table: 'paved', year: 2000, from: 0.012, to: 0.02, note: '', backToFile: false })).toBe('Paved area 2000: 0.012 → 0.020');
	});
});

describe('fillNotes', () => {
	it('fills only the values that have no source', () => {
		const draft: ModuleDraft = { paved: { 2025: { text: '0.03', note: '' } }, afforestation: { 2004: { text: '11', note: 'Own' } } };
		const filled = fillNotes(draft, reviewModule(bundle, free, draft), 'Survey');
		expect(filled.paved?.[2025]?.note).toBe('Survey');
		expect(filled.afforestation?.[2004]?.note).toBe('Own');
	});

	it('leaves a removal’s flag alone', () => {
		const draft: ModuleDraft = { afforestation: { 1990: { text: '4.5', note: '', removed: true } } };
		expect(fillNotes(draft, reviewModule(bundle, free, draft), 'Cleared')?.afforestation?.[1990]).toEqual({ text: '4.5', note: 'Cleared', removed: true });
	});
});

describe('toEdits', () => {
	it('builds what applyTableEdits takes, with the note and date as the sidecar records them', () => {
		const review = reviewModule(bundle, free, { paved: { 2025: { text: '0.03', note: 'Survey' } } });
		expect(toEdits(free, review.changes, DATE)).toEqual([{ target: { module: { type: 'RU', number: 1 }, table: 'paved', row: 'fraction' }, year: 2025, value: 0.03, source: { kind: 'manual', note: 'Survey', date: DATE } }]);
	});

	it('the value on screen is the value saved', () => {
		const next = applied(bundle, free, { afforestation: { 2025: { text: '14.5', note: 'Survey' } }, paved: { 2025: { text: '0.031', note: 'Survey' } } });
		const read = readBundle(writeBundle(next));
		if (!read.ok) throw new Error(JSON.stringify(read.errors));
		const saved = runoff(read.bundle, 1);
		expect(yearTableOf(saved, 'afforestation').at(-1)).toEqual({ year: 2025, value: 14.5 });
		expect(yearTableOf(saved, 'paved').at(-1)).toEqual({ year: 2025, value: 0.031 });
	});
});
