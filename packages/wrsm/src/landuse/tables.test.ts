import { describe, expect, it } from 'vitest';
import { readBundle, writeBundle } from '../io/bundle.js';
import { syntheticBundle } from '../network/synthetic-bundle.js';
import { yearTableValue } from '../runoff/pitman.js';
import type { NetworkBundle, RunoffModule, Sidecar, ValueSource } from '../types.js';
import type { TableEdit } from './round7-contract.js';
import { applyTableEdits, LAND_USE_TABLES, tableCellHistory, tableCellLog, tableEditNote, tableKeepsLastRow, tableLoggedYears, tableOrderProblem, tableValueProblem, tableYearProblem, withYearTable, yearTableOf, type LandUseTable } from './tables.js';

const DATE = '2026-10-30T08:00:00.000Z';
const source = (note = 'Aerial photos 2025'): ValueSource => ({ kind: 'manual', note, date: DATE });

const runoff = (bundle: NetworkBundle, number: number) => bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === number)!;

/** Module 1 of the synthetic network with invented rows in every table. */
function withRows(): NetworkBundle {
	const bundle = syntheticBundle();
	const m = runoff(bundle, 1);
	const next: RunoffModule = {
		...m,
		areaKm2: 100,
		afforestation: {
			...m.afforestation,
			algorithm: 2,
			areaKm2: [{ year: 1990, value: 4.5 }, { year: 2004, value: 10 }],
			species: { pine: { percent: 60, rotationYears: 20 }, eucalyptus: { percent: 40, rotationYears: 10 }, wattle: { percent: 0, rotationYears: 0 } },
			optimalPercent: 80,
			userDefinedReduction: { marPercent: 0, lowFlowPercent: 0 }
		},
		alienVegetation: {
			algorithm: 1,
			riparianArea: 20,
			areaKm2: [{ year: 1995, value: 2 }],
			composition: { tallTrees: { percent: 50, ageYears: 15 }, mediumTrees: { percent: 30, ageYears: 10 }, tallShrubs: { percent: 20, ageYears: 8 } },
			optimalPercent: 70
		},
		paved: { fraction: [{ year: 2000, value: 0.012 }] }
	};
	return { ...bundle, modules: bundle.modules.map((x) => (x === m ? next : x)) };
}

const edit = (table: LandUseTable, year: number, value: number | null, number = 1, note?: string): TableEdit => ({
	target: { module: { type: 'RU', number }, table, row: LAND_USE_TABLES[table].row },
	year,
	value,
	source: source(note)
});

/** The lines this file changes: the synthetic module is built in code, so other fields gain their file defaults on a read. */
const landUse = (m: RunoffModule) => ({ afforestation: m.afforestation, alienVegetation: m.alienVegetation, paved: m.paved });

function roundTrip(bundle: NetworkBundle) {
	const result = readBundle(writeBundle(bundle));
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.bundle;
}

describe('tableValueProblem', () => {
	it('takes what the file holds exactly', () => {
		expect(tableValueProblem('afforestation', 12.3)).toBeNull();
		expect(tableValueProblem('alienVegetation', 0)).toBeNull();
		expect(tableValueProblem('paved', 0.125)).toBeNull();
		expect(tableValueProblem('paved', 1)).toBeNull();
		expect(tableValueProblem('afforestation', 99999.9)).toBeNull();
	});

	it('refuses more decimals than the line keeps and offers the two nearest', () => {
		expect(tableValueProblem('afforestation', 1.25)).toBe('The file keeps 1 decimal place here (L.008), so this can’t be saved exactly. Use 1.2 or 1.3.');
		expect(tableValueProblem('alienVegetation', 0.04)).toContain('L.013');
		expect(tableValueProblem('paved', 0.1234)).toBe('The file keeps 3 decimal places here (L.018), so this can’t be saved exactly. Use 0.123 or 0.124.');
	});

	it('refuses what float32 can’t carry, as the writer rounds through it', () => {
		expect(tableValueProblem('afforestation', 123456789.1)).toContain('can’t be saved exactly');
	});

	it('refuses a negative area and a paved fraction outside 0–1', () => {
		expect(tableValueProblem('afforestation', -1)).toBe('An area can’t be negative.');
		expect(tableValueProblem('paved', 1.2)).toContain('from 0 to 1');
		expect(tableValueProblem('paved', -0.1)).toContain('from 0 to 1');
	});

	it('agrees with the writer: an accepted value reads back the same', () => {
		for (const [table, value] of [['afforestation', 1234.5], ['alienVegetation', 0.1], ['paved', 0.007]] as const) {
			expect(tableValueProblem(table, value)).toBeNull();
			const bundle = applyTableEdits(withRows(), [edit(table, 2025, value)]);
			const row = yearTableOf(runoff(roundTrip(bundle), 1), table).find((r) => r.year === 2025);
			expect(row?.value).toBe(value);
		}
	});
});

describe('tableYearProblem and tableOrderProblem', () => {
	it('holds a year to the I4 of the year line', () => {
		expect(tableYearProblem(2025)).toBeNull();
		expect(tableYearProblem(999)).not.toBeNull();
		expect(tableYearProblem(20250)).not.toBeNull();
		expect(tableYearProblem(2025.5)).not.toBeNull();
	});

	it('names a repeated or out-of-order year', () => {
		expect(tableOrderProblem([{ year: 2000, value: 1 }, { year: 2001, value: 2 }])).toBeNull();
		expect(tableOrderProblem([{ year: 2000, value: 1 }, { year: 2000, value: 2 }])).toBe('The file lists 2000 twice.');
		expect(tableOrderProblem([{ year: 2000, value: 1 }, { year: 1999, value: 2 }])).toContain('out of order at 1999');
	});
});

describe('applyTableEdits', () => {
	const bundle = withRows();

	it('changes a row, adds one in year order, removes one, and touches nothing else', () => {
		const next = applyTableEdits(bundle, [edit('afforestation', 2004, 11), edit('afforestation', 2025, 14.5), edit('afforestation', 1990, null), edit('paved', 2025, 0.03)]);
		const m = runoff(next, 1);
		expect(m.afforestation.areaKm2).toEqual([{ year: 2004, value: 11 }, { year: 2025, value: 14.5 }]);
		expect(m.paved?.fraction).toEqual([{ year: 2000, value: 0.012 }, { year: 2025, value: 0.03 }]);
		expect(m.alienVegetation).toBe(runoff(bundle, 1).alienVegetation);
		expect(next.modules.filter((x) => x !== m)).toEqual(bundle.modules.filter((x) => x !== runoff(bundle, 1)));
		expect(runoff(bundle, 1).afforestation.areaKm2).toHaveLength(2);
	});

	it('keeps the rows ascending, so the engine’s lookup reads them', () => {
		const m = runoff(applyTableEdits(bundle, [edit('afforestation', 2000, 8), edit('afforestation', 1980, 1)]), 1);
		expect(m.afforestation.areaKm2.map((r) => r.year)).toEqual([1980, 1990, 2000, 2004]);
		expect(yearTableValue(m.afforestation.areaKm2, 2002)).toBeCloseTo(9, 12);
	});

	it('records each edit in the sidecar: target, source, and the change in the note', () => {
		const next = applyTableEdits(bundle, [edit('afforestation', 2004, 11), edit('paved', 2025, 0.03), edit('afforestation', 1990, null)]);
		expect(next.sidecar?.values).toEqual([
			{ target: { module: { type: 'RU', number: 1 }, field: 'afforestation.areaKm2', year: 2004 }, source: { kind: 'manual', note: 'Land use: 10 → 11; Aerial photos 2025', date: DATE } },
			{ target: { module: { type: 'RU', number: 1 }, field: 'paved.fraction', year: 2025 }, source: { kind: 'manual', note: 'Land use: none → 0.03; Aerial photos 2025', date: DATE } },
			{ target: { module: { type: 'RU', number: 1 }, field: 'afforestation.areaKm2', year: 1990 }, source: { kind: 'manual', note: 'Land use: 4.5 → none; Aerial photos 2025', date: DATE } }
		]);
	});

	it('adds to what the sidecar already held, and starts one when there is none', () => {
		const sidecar: Sidecar = { schema: 'pitman-sidecar', schemaVersion: 1, writtenBy: 'earlier', values: [{ target: { field: 'other' }, source: { kind: 'manual' } }] };
		const kept = applyTableEdits({ ...bundle, sidecar }, [edit('paved', 2025, 0.03)]);
		expect(kept.sidecar?.writtenBy).toBe('earlier');
		expect(kept.sidecar?.values).toHaveLength(2);
		const { sidecar: _none, ...rest } = bundle;
		const bare: NetworkBundle = rest;
		expect(applyTableEdits(bare, [edit('paved', 2025, 0.03)]).sidecar?.schema).toBe('pitman-sidecar');
	});

	it('edits several modules at once', () => {
		const next = applyTableEdits(bundle, [edit('paved', 2025, 0.03, 1), edit('paved', 2025, 0.05, 2)]);
		expect(runoff(next, 1).paved?.fraction.at(-1)?.value).toBe(0.03);
		expect(runoff(next, 2).paved?.fraction).toEqual([{ year: 2025, value: 0.05 }]);
	});

	it('refuses what can’t be saved, whatever the screen did', () => {
		expect(() => applyTableEdits(bundle, [edit('afforestation', 2025, 1.25)])).toThrow(/can’t be saved exactly/);
		expect(() => applyTableEdits(bundle, [edit('paved', 2025, 2)])).toThrow(/from 0 to 1/);
		expect(() => applyTableEdits(bundle, [edit('paved', 20250, 0.1)])).toThrow(/four-digit year/);
	});

	it('refuses an edit with no source note (rule 8)', () => {
		expect(() => applyTableEdits(bundle, [edit('paved', 2025, 0.1, 1, '  ')])).toThrow(/no source note/);
	});

	it('refuses a row name the table doesn’t have, and a module that isn’t there', () => {
		const wrong = { ...edit('paved', 2025, 0.1), target: { module: { type: 'RU' as const, number: 1 }, table: 'paved' as const, row: 'areaKm2' } };
		expect(() => applyTableEdits(bundle, [wrong])).toThrow(/no row areaKm2/);
		expect(() => applyTableEdits(bundle, [edit('paved', 2025, 0.1, 999)])).toThrow(/no runoff module/);
		const channel = { ...edit('paved', 2025, 0.1), target: { module: { type: 'CR' as const, number: 1 }, table: 'paved' as const, row: 'fraction' } };
		expect(() => applyTableEdits(bundle, [channel])).toThrow(/no runoff module/);
	});

	it('refuses removing a year the table doesn’t have, and editing one cell twice', () => {
		expect(() => applyTableEdits(bundle, [edit('paved', 1800, null)])).toThrow(/no row for 1800/);
		expect(() => applyTableEdits(bundle, [edit('paved', 2025, 0.1), edit('paved', 2025, 0.2)])).toThrow(/edited twice/);
	});

	it('refuses a table whose years are out of order or repeated, rather than guessing the row', () => {
		const m = runoff(bundle, 1);
		const twice = { ...bundle, modules: bundle.modules.map((x) => (x === m ? { ...m, paved: { fraction: [{ year: 2000, value: 0.1 }, { year: 2000, value: 0.2 }] } } : x)) };
		expect(() => applyTableEdits(twice, [edit('paved', 2000, 0.3)])).toThrow(/lists 2000 twice/);
	});

	it('keeps the last row of a table with lines of its own (R7-T4)', () => {
		expect(tableKeepsLastRow('afforestation')).toBe(true);
		expect(() => applyTableEdits(bundle, [edit('alienVegetation', 1995, null)])).toThrow(/keep one year/);
		expect(runoff(applyTableEdits(bundle, [edit('paved', 2000, null)]), 1).paved?.fraction).toEqual([]);
	});

	it('refuses alien vegetation on a version 0 file, which has no lines for it', () => {
		const m = runoff(bundle, 1);
		const old: NetworkBundle = { ...bundle, modules: bundle.modules.map((x) => (x === m ? { ...m, fileVersion: 0 as const } : x)) };
		expect(() => applyTableEdits(old, [edit('alienVegetation', 2025, 1)])).toThrow(/version 0/);
	});
});

describe('the saved network', () => {
	it('holds what the file holds: an untouched row off the format is rounded and logged (R7-T8)', () => {
		const bundle = withRows();
		const m = runoff(bundle, 1);
		const hand = { ...bundle, modules: bundle.modules.map((x) => (x === m ? { ...m, afforestation: { ...m.afforestation, areaKm2: [{ year: 1990, value: 4.25 }, { year: 2004, value: 10 }] } } : x)) };
		const next = applyTableEdits(hand, [edit('afforestation', 2004, 12)]);
		const rows = runoff(next, 1).afforestation.areaKm2;
		expect(rows.map((r) => r.year)).toEqual([1990, 2004]);
		expect(rows[1]?.value).toBe(12);
		expect(rows[0]?.value).not.toBe(4.25);
		expect(next.sidecar?.values?.some((v) => v.target.year === 1990 && /rounded to what the file can hold/.test(v.source.note ?? ''))).toBe(true);
	});

	const bundle = withRows();
	const edits = [edit('afforestation', 2004, 11.5), edit('afforestation', 2025, 14.5), edit('alienVegetation', 2025, 3.2), edit('paved', 2025, 0.031), edit('paved', 2000, null)];
	const next = applyTableEdits(bundle, edits);

	it('reads back with every table and every other line as applied', () => {
		const back = roundTrip(next);
		expect(landUse(runoff(back, 1))).toEqual(landUse(runoff(next, 1)));
		expect(back.sidecar?.values).toEqual(next.sidecar?.values);
	});

	it('writes the rows in the file’s formats', () => {
		const text = Object.entries(writeBundle(next)).find(([p]) => /RU1\.DAT$/i.test(p))?.[1];
		expect(text).toContain(' 1990 2004 2025\r\n 4.5 11.5 14.5\r\n');
		expect(text).toContain(' 1995 2025\r\n 2.0 3.2\r\n');
		expect(text).toContain('   1\r\n 2025\r\n 0.031\r\n');
	});

	it('leaves a module no edit touched as it was', () => {
		expect(landUse(runoff(roundTrip(next), 2))).toEqual(landUse(runoff(next, 2)));
	});

	it('keeps the history through a save and reload', () => {
		const back = roundTrip(next);
		const m = runoff(back, 1);
		const history = tableCellHistory(back.sidecar, 1, 'afforestation', 2004, yearTableOf(m, 'afforestation').find((r) => r.year === 2004)?.value ?? null);
		expect(history.file).toBe(10);
		expect(history.edits.map((e) => e.note)).toEqual(['Aerial photos 2025']);
	});

	it('the first row of an empty table holds in memory what the file gets', () => {
		const first = applyTableEdits(syntheticBundle(), [edit('afforestation', 2025, 1.5), edit('alienVegetation', 2025, 0.5)]);
		const m = runoff(first, 1);
		expect(m.afforestation.species?.pine).toEqual({ percent: 0, rotationYears: 0 });
		expect(m.alienVegetation?.composition?.tallShrubs).toEqual({ percent: 0, ageYears: 0 });
		expect(landUse(runoff(roundTrip(first), 1))).toEqual(landUse(m));
	});

	it('keeps a species split the module already holds', () => {
		const m = runoff(bundle, 1);
		const emptied = withYearTable(m, 'afforestation', []);
		expect(withYearTable(emptied, 'afforestation', [{ year: 2025, value: 1 }]).afforestation.species).toEqual(m.afforestation.species);
	});
});

describe('tableCellHistory', () => {
	const first = applyTableEdits(withRows(), [edit('afforestation', 2004, 11, 1, 'one')]);
	const second = applyTableEdits(first, [edit('afforestation', 2004, 12, 1, 'two'), edit('afforestation', 2025, 3, 1, 'new')]);

	it('keeps the file’s value through later edits', () => {
		const history = tableCellHistory(second.sidecar, 1, 'afforestation', 2004, 12);
		expect(history.file).toBe(10);
		expect(history.edits.map((e) => [e.from, e.to, e.note])).toEqual([[10, 11, 'one'], [11, 12, 'two']]);
		expect(history.edits[0]?.date).toBe(DATE);
	});

	it('says a year the file didn’t list had no value', () => {
		expect(tableCellHistory(second.sidecar, 1, 'afforestation', 2025, 3).file).toBeNull();
	});

	it('finds a removed year’s value, and lists it', () => {
		const gone = applyTableEdits(second, [edit('afforestation', 1990, null, 1, 'gone')]);
		expect(tableCellHistory(gone.sidecar, 1, 'afforestation', 1990, null).file).toBe(4.5);
		expect(tableLoggedYears(gone.sidecar, 1, 'afforestation').sort()).toEqual([1990, 2004, 2025]);
	});

	it('is empty for a cell nobody edited', () => {
		expect(tableCellHistory(second.sidecar, 1, 'paved', 2000, 0.012)).toEqual({ file: 0.012, edits: [] });
		expect(tableCellHistory(undefined, 1, 'paved', 2000, 0.012)).toEqual({ file: 0.012, edits: [] });
	});

	it('ignores a log something else has overtaken: a sub-division scaled the table under it (R7-T3)', () => {
		expect(tableCellHistory(second.sidecar, 1, 'afforestation', 2004, 6)).toEqual({ file: 6, edits: [] });
		const after = applyTableEdits(
			{ ...second, modules: second.modules.map((m) => (m.kind === 'RU' && m.number === 1 ? withYearTable(m, 'afforestation', [{ year: 2004, value: 6 }]) : m)) },
			[edit('afforestation', 2004, 7, 1, 'after the split')]
		);
		const history = tableCellHistory(after.sidecar, 1, 'afforestation', 2004, 7);
		expect(history.file).toBe(6);
		expect(history.edits.map((e) => e.note)).toEqual(['after the split']);
	});

	it('reads only its own cell, and skips entries of another kind', () => {
		const sidecar: Sidecar = {
			schema: 'pitman-sidecar',
			schemaVersion: 1,
			values: [
				{ target: { module: { type: 'RU', number: 1 }, field: 'afforestation.areaKm2', year: 2004 }, source: { kind: 'manual', note: 'typed by hand' } },
				{ target: { module: { type: 'RU', number: 2 }, field: 'afforestation.areaKm2', year: 2004 }, source: { kind: 'manual', note: tableEditNote(1, 2, 'other module') } },
				{ target: { module: { type: 'RU', number: 1 }, field: 'paved.fraction', year: 2004 }, source: { kind: 'manual', note: tableEditNote(0.1, 0.2, 'other table') } },
				{ target: { module: { type: 'RU', number: 1 }, field: 'afforestation.areaKm2', year: 2004 }, source: { kind: 'manual', by: 'A. Hydrologist', note: tableEditNote(1, 2, 'mine') } }
			]
		};
		expect(tableCellLog(sidecar, 1, 'afforestation', 2004)).toEqual([{ from: 1, to: 2, note: 'mine', kind: 'manual', date: '', by: 'A. Hydrologist' }]);
	});
});
