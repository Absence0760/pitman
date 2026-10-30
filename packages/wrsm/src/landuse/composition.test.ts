import { describe, expect, it } from 'vitest';
import { readBundle, writeBundle } from '../io/bundle.js';
import { readRunoff, writeRunoff } from '../io/runoff.js';
import { syntheticBundle } from '../network/synthetic-bundle.js';
import type { NetworkBundle, RunoffModule, ValueSource } from '../types.js';
import { alienReductionTargets } from './alien.js';
import { applyCompositionEdits, COMPOSITION_FIELDS, compositionField, compositionHistory, compositionLock, compositionProblem, compositionShareSum, compositionSumProblem, compositionValueProblem, isSfrChild, type CompositionEdit } from './composition.js';
import { forestChildTargets } from './forest.js';

// Invented values only (issue #3 rule 2).

const DATE = '2026-10-30T08:00:00.000Z';
const source = (note = 'Plantation survey 2024'): ValueSource => ({ kind: 'manual', note, date: DATE });
const runoff = (bundle: NetworkBundle, number: number) => bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === number)!;

function network(change: (m: RunoffModule) => RunoffModule = (m) => m): NetworkBundle {
	const bundle = syntheticBundle();
	const m = runoff(bundle, 1);
	const next: RunoffModule = {
		...m,
		afforestation: {
			...m.afforestation,
			algorithm: 2,
			areaKm2: [{ year: 1990, value: 4.5 }],
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
		}
	};
	return { ...bundle, modules: bundle.modules.map((x) => (x === m ? change(next) : x)) };
}

/** RU 1 as an SFR child of RU 2. */
function childOf2(change: (m: RunoffModule) => RunoffModule = (m) => m): NetworkBundle {
	const bundle = network(change);
	return { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'RU' && m.number === 2 ? { ...m, sfrChildren: [1] } : m)) };
}

const edit = (field: string, value: number, note?: string): CompositionEdit => ({ module: { type: 'RU', number: 1 }, field, value, source: source(note) });
const field = (path: string) => compositionField(path)!;
const PINE = 'afforestation.species.pine.percent';
const EUC = 'afforestation.species.eucalyptus.percent';
const TALL = 'alienVegetation.composition.tallTrees.percent';
const MEDIUM = 'alienVegetation.composition.mediumTrees.percent';

/** The file's lines, trimmed of the line ends. */
const lines = (m: RunoffModule) => writeRunoff(m).split(/\r?\n/);

describe('the fields', () => {
	it('cover L.009, L.010, L.011 v3, L.014 and L.015', () => {
		expect(COMPOSITION_FIELDS.afforestation.map((f) => f.field)).toEqual([
			'afforestation.species.pine.percent',
			'afforestation.species.eucalyptus.percent',
			'afforestation.species.wattle.percent',
			'afforestation.species.pine.rotationYears',
			'afforestation.species.eucalyptus.rotationYears',
			'afforestation.species.wattle.rotationYears',
			'afforestation.optimalPercent',
			'afforestation.userDefinedReduction.marPercent',
			'afforestation.userDefinedReduction.lowFlowPercent'
		]);
		expect(COMPOSITION_FIELDS.alienVegetation.map((f) => f.field)).toEqual([
			'alienVegetation.composition.tallTrees.percent',
			'alienVegetation.composition.mediumTrees.percent',
			'alienVegetation.composition.tallShrubs.percent',
			'alienVegetation.composition.tallTrees.ageYears',
			'alienVegetation.composition.mediumTrees.ageYears',
			'alienVegetation.composition.tallShrubs.ageYears',
			'alienVegetation.optimalPercent',
			'alienVegetation.riparianArea'
		]);
	});

	it('read and write the module they name, and nothing else', () => {
		const m = runoff(network(), 1);
		for (const f of [...COMPOSITION_FIELDS.afforestation, ...COMPOSITION_FIELDS.alienVegetation]) {
			const changed = f.write(m, 1.5);
			expect(f.read(changed), f.field).toBe(1.5);
			for (const other of [...COMPOSITION_FIELDS.afforestation, ...COMPOSITION_FIELDS.alienVegetation]) if (other !== f) expect(other.read(changed), `${f.field} moved ${other.field}`).toBe(other.read(m));
		}
	});
});

describe('compositionValueProblem', () => {
	it('takes what the file holds exactly', () => {
		expect(compositionValueProblem(field(PINE), 33.33)).toBeNull();
		expect(compositionValueProblem(field(PINE), 100)).toBeNull();
		expect(compositionValueProblem(field(PINE), 0)).toBeNull();
		expect(compositionValueProblem(field('afforestation.species.pine.rotationYears'), 25)).toBeNull();
		expect(compositionValueProblem(field('alienVegetation.composition.tallTrees.ageYears'), 12.5)).toBeNull();
	});

	it('refuses in the screen’s words', () => {
		expect(compositionValueProblem(field(PINE), -1)).toBe('A percentage can’t be negative.');
		expect(compositionValueProblem(field(PINE), 100.5)).toBe('A percentage runs from 0 to 100.');
		expect(compositionValueProblem(field(PINE), 33.333)).toBe('The file keeps 2 decimal places here (L.009), so this can’t be saved exactly. Use 33.33 or 33.34.');
		expect(compositionValueProblem(field('afforestation.species.pine.rotationYears'), 12.5)).toBe('The file keeps whole years here (L.009).');
		expect(compositionValueProblem(field('afforestation.species.pine.rotationYears'), 10000)).toBe('The file’s column stops at 9999 (L.009).');
		expect(compositionValueProblem(field('alienVegetation.composition.tallTrees.ageYears'), -2)).toBe('Years can’t be negative.');
		expect(compositionValueProblem(field(PINE), Number.NaN)).toBe('This must be a number.');
	});
});

describe('compositionSumProblem', () => {
	it('takes 100 to the file’s two decimals', () => {
		expect(compositionSumProblem('afforestation', 100)).toBeNull();
		expect(compositionSumProblem('afforestation', 33.33 + 33.33 + 33.34)).toBeNull();
	});

	it('refuses a gap of one last place, and says how far off', () => {
		expect(compositionSumProblem('afforestation', 99.99)).toBe('The three genus shares (L.009) must add up to 100 %. They come to 99.99 %, 0.01 short of 100.');
		expect(compositionSumProblem('alienVegetation', 110)).toBe('The three class shares (L.014, TT 689 p.128) must add up to 100 %. They come to 110.00 %, 10.00 over 100.');
	});
});

describe('compositionProblem', () => {
	it('needs a row in the table, because the lines exist only with one (R7-T4)', () => {
		const m = runoff(network(), 1);
		expect(compositionProblem(m, 'afforestation')).toBeNull();
		const empty = { ...m, afforestation: { ...m.afforestation, areaKm2: [] } };
		expect(compositionProblem(empty, 'afforestation')).toBe('The file holds these lines only while the table has a row (L.009–L.010).');
	});

	it('has no lines to edit in a version 0 file', () => {
		const m = { ...runoff(network(), 1), fileVersion: 0 };
		expect(compositionProblem(m, 'afforestation')).toContain('version 0');
	});
});

describe('compositionLock', () => {
	const rotation = field('afforestation.species.pine.rotationYears');
	const optimal = field('afforestation.optimalPercent');
	const reduction = field('afforestation.userDefinedReduction.marPercent');
	const csir = (m: RunoffModule): RunoffModule => ({ ...m, afforestation: { ...m.afforestation, algorithm: 1 } });

	it('keeps rotations and % optimal read-only on a CSIR child, because a run here can’t show them', () => {
		const m = csir(runoff(network(), 1));
		expect(compositionLock(m, rotation, true)).toContain('Read-only on a CSIR child');
		expect(compositionLock(m, optimal, true)).toContain('Read-only on a CSIR child');
		expect(compositionLock(m, field(PINE), true)).toBeNull();
	});

	it('leaves them open elsewhere: nothing calibrates to them', () => {
		expect(compositionLock(csir(runoff(network(), 1)), rotation, false)).toBeNull();
		expect(compositionLock(runoff(network(), 1), rotation, true)).toBeNull();
	});

	it('opens the required reductions only under the algorithm that reads them', () => {
		const m = runoff(network(), 1);
		expect(compositionLock(m, reduction, true)).toContain('only the User-defined algorithm reads this');
		expect(compositionLock({ ...m, afforestation: { ...m.afforestation, algorithm: 4 } }, reduction, true)).toBeNull();
	});

	it('never locks the alien vegetation', () => {
		const m = csir(runoff(network(), 1));
		for (const f of COMPOSITION_FIELDS.alienVegetation) expect(compositionLock(m, f, true)).toBeNull();
	});
});

describe('isSfrChild', () => {
	it('reads the parents’ lists', () => {
		expect(isSfrChild(childOf2(), 1)).toBe(true);
		expect(isSfrChild(network(), 1)).toBe(false);
	});
});

describe('applyCompositionEdits', () => {
	it('writes each value, logs it with its source, and leaves the rest', () => {
		const next = applyCompositionEdits(network(), [edit(PINE, 55), edit(EUC, 45), edit('afforestation.species.pine.rotationYears', 25)]);
		const m = runoff(next, 1);
		expect(m.afforestation.species).toEqual({ pine: { percent: 55, rotationYears: 25 }, eucalyptus: { percent: 45, rotationYears: 10 }, wattle: { percent: 0, rotationYears: 0 } });
		expect(m.alienVegetation).toEqual(runoff(network(), 1).alienVegetation);
		expect(next.sidecar?.values).toEqual([
			{ target: { module: { type: 'RU', number: 1 }, field: PINE }, source: { kind: 'manual', date: DATE, note: 'Land use: 60 → 55; Plantation survey 2024' } },
			{ target: { module: { type: 'RU', number: 1 }, field: EUC }, source: { kind: 'manual', date: DATE, note: 'Land use: 40 → 45; Plantation survey 2024' } },
			{ target: { module: { type: 'RU', number: 1 }, field: 'afforestation.species.pine.rotationYears' }, source: { kind: 'manual', date: DATE, note: 'Land use: 20 → 25; Plantation survey 2024' } }
		]);
	});

	it('refuses shares that no longer add up, whichever value moved them', () => {
		expect(() => applyCompositionEdits(network(), [edit(PINE, 55)])).toThrow('The three genus shares (L.009) must add up to 100 %. They come to 95.00 %, 5.00 short of 100.');
		expect(() => applyCompositionEdits(network(), [edit(TALL, 60)])).toThrow('They come to 110.00 %');
	});

	it('doesn’t judge shares nobody edited: a file that loaded isn’t the user’s mistake', () => {
		const off = network((m) => ({ ...m, afforestation: { ...m.afforestation, species: { ...m.afforestation.species!, pine: { percent: 50, rotationYears: 20 } } } }));
		expect(() => applyCompositionEdits(off, [edit('afforestation.species.pine.rotationYears', 25)])).not.toThrow();
		expect(() => applyCompositionEdits(off, [edit(TALL, 40), edit(MEDIUM, 40)])).not.toThrow();
	});

	it('refuses what the screen refuses', () => {
		expect(() => applyCompositionEdits(network(), [edit(PINE, 33.333)])).toThrow('2 decimal places');
		expect(() => applyCompositionEdits(network(), [edit(PINE, 60, '  ')])).toThrow('no source note (rule 8)');
		expect(() => applyCompositionEdits(network(), [edit('afforestation.nothing', 1)])).toThrow('there is no value');
		expect(() => applyCompositionEdits(network(), [edit(PINE, 60), edit(PINE, 60)])).toThrow('edited twice');
		expect(() => applyCompositionEdits(childOf2((m) => ({ ...m, afforestation: { ...m.afforestation, algorithm: 1 } })), [edit('afforestation.optimalPercent', 50)])).toThrow('Read-only on a CSIR child');
		expect(() => applyCompositionEdits(network(), [edit('afforestation.userDefinedReduction.marPercent', 10)])).toThrow('only the User-defined algorithm');
		expect(() => applyCompositionEdits(network((m) => ({ ...m, afforestation: { ...m.afforestation, areaKm2: [] } })), [edit(PINE, 60)])).toThrow('only while the table has a row');
	});

	it('writes the lines in the file’s columns', () => {
		const next = applyCompositionEdits(network(), [edit(PINE, 33.33), edit(EUC, 33.33), edit('afforestation.species.wattle.percent', 33.34), edit('afforestation.species.wattle.rotationYears', 8), edit('afforestation.optimalPercent', 75.5)]);
		const text = lines(runoff(next, 1));
		expect(text).toContain(' 33.33  20  33.33  10  33.34   8');
		expect(text).toContain('  75.50    0.00    0.00');
		const alien = applyCompositionEdits(network(), [edit(TALL, 40), edit(MEDIUM, 40), edit('alienVegetation.composition.tallTrees.ageYears', 12.5), edit('alienVegetation.optimalPercent', 45), edit('alienVegetation.riparianArea', 2.2)]);
		const alienText = lines(runoff(alien, 1));
		expect(alienText).toContain(' 40.00  12.50  40.00  10.00  20.00   8.00');
		expect(alienText).toContain(' 45.00');
		expect(alienText).toContain('   1   1   2.20');
	});

	it('round-trips through a save with the same values and provenance', () => {
		const next = applyCompositionEdits(network(), [edit(PINE, 55), edit(EUC, 45), edit('alienVegetation.riparianArea', 2.2), edit('alienVegetation.composition.tallShrubs.ageYears', 11.25)]);
		const read = readBundle(writeBundle(next));
		if (!read.ok) throw new Error(JSON.stringify(read.errors));
		const m = runoff(read.bundle, 1);
		expect(m.afforestation.species?.pine.percent).toBe(55);
		expect(m.alienVegetation?.riparianArea).toBe(2.2);
		expect(m.alienVegetation?.composition?.tallShrubs.ageYears).toBe(11.25);
		expect(read.bundle.sidecar?.values).toEqual(next.sidecar?.values);
	});

	it('holds what the file holds, so a run of the working copy equals a run of the zip (R7-T8)', () => {
		const loose = network((m) => ({ ...m, afforestation: { ...m.afforestation, optimalPercent: 33.333 } }));
		const next = applyCompositionEdits(loose, [edit('afforestation.species.pine.rotationYears', 25)]);
		const m = runoff(next, 1);
		expect(m.afforestation.optimalPercent).toBe(33.33);
		expect(m).toMatchObject({ afforestation: readRunoff(writeRunoff(m), 'x').afforestation });
		expect(next.sidecar?.values?.at(-1)).toMatchObject({ target: { field: 'afforestation.optimalPercent' }, source: { note: 'Land use: 33.333 → 33.33; rounded to what the file can hold' } });
	});

	it('moves the targets a run calibrates a child to', () => {
		const next = applyCompositionEdits(network(), [edit(PINE, 40), edit(EUC, 60), edit(TALL, 30), edit('alienVegetation.composition.tallShrubs.percent', 40)]);
		const before = runoff(network(), 1);
		const after = runoff(next, 1);
		expect(forestChildTargets(after).targets).not.toEqual(forestChildTargets(before).targets);
		expect(alienReductionTargets(after.alienVegetation!).tprm).not.toBe(alienReductionTargets(before.alienVegetation!).tprm);
	});

	it('gives a share sum, and an empty table has none', () => {
		const m = runoff(network(), 1);
		expect(compositionShareSum(m, 'afforestation')).toBe(100);
		const bare = { ...m, afforestation: { algorithm: 2 as const, algorithmInFile: true, areaKm2: [] } };
		expect(compositionShareSum(bare, 'afforestation')).toBeNull();
	});
});

describe('compositionHistory', () => {
	const pine = field(PINE);

	it('traces a value back to the file through its edits, oldest first', () => {
		const once = applyCompositionEdits(network(), [edit(PINE, 55), edit(EUC, 45)]);
		const twice = applyCompositionEdits(once, [edit(PINE, 50, 'Second survey'), edit(EUC, 50, 'Second survey')]);
		const { file, edits } = compositionHistory(twice.sidecar, 1, pine, 50);
		expect(file).toBe(60);
		expect(edits.map((e) => e.note)).toEqual(['Plantation survey 2024', 'Second survey']);
	});

	it('doesn’t read a year table’s log as its own', () => {
		const sidecar = { schema: 'pitman-sidecar', schemaVersion: 1, values: [{ target: { module: { type: 'RU', number: 1 }, field: PINE, year: 2000 }, source: { kind: 'manual', note: 'Land use: 1 → 2; other' } }] } as const;
		expect(compositionHistory(sidecar as never, 1, pine, 2).edits).toEqual([]);
	});

	it('treats a value changed behind the log as the file’s (R7-T3)', () => {
		const next = applyCompositionEdits(network(), [edit(PINE, 55), edit(EUC, 45)]);
		expect(compositionHistory(next.sidecar, 1, pine, 70)).toEqual({ file: 70, edits: [] });
	});
});
