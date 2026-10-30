/**
 * Editing what a land-use table's area is made of, each edit with its source
 * (issue #3 rule 8): the genus split, rotations, % optimal and required
 * reductions of afforestation (L.009–L.010), and the class split, ages, % optimal
 * and riparian % of alien vegetation (L.011 v3, L.014–L.015).
 *
 * These are single values, not year tables, so the file holds one of each for
 * the whole run (R6-V3). What the file can hold is decided here, so the screen
 * and `applyCompositionEdits` refuse the same values in the same words.
 *
 * The sidecar log is the year tables' (`tables.ts`, R7-T2): one `values` entry
 * per edit, `{ target: { module, field }, source }`, the note carrying the change.
 *
 * **What a run does with them** (docs/theory/afforestation.md §1, alien.md §2):
 * an SFR child's targets are worked out from these on every run and the child is
 * calibrated to them there and then, so no stored calibration goes stale. One
 * thing can't be checked here: on a CSIR child WRSM2000 reads rotations and
 * % optimal through tables the manuals don't publish, Pitman runs Smoothed Gush
 * instead (R6-F2), and WRSM2000's log points to rotations when that iteration
 * doesn't close. Those are read-only there (`compositionLock`, R7-T10).
 */

import { readRunoff, writeRunoff } from '../io/runoff.js';
import type { ModuleRef, NetworkBundle, RunoffModule, Sidecar, ValueSource } from '../types.js';
import { fieldHistory, fieldLog, tableEditNote, yearTableOf, type TableCellHistory } from './tables.js';

export type CompositionTable = 'afforestation' | 'alienVegetation';

/** Which part of the block a value belongs to: the shares add up to 100 %. */
export type CompositionGroup = 'share' | 'other';

export interface CompositionField {
	/** `ValueTarget.field`, the property path, and the value's name here. */
	readonly field: string;
	readonly table: CompositionTable;
	readonly group: CompositionGroup;
	/** The file's line. */
	readonly line: string;
	/** What the row is called, without its unit. */
	readonly label: string;
	readonly unit: '%' | 'years';
	/** Decimals the file keeps; 0 is `I4`. */
	readonly decimals: number;
	readonly max: number;
	read(module: RunoffModule): number | null;
	write(module: RunoffModule, value: number): RunoffModule;
}

const GENERA = [
	['pine', 'Pine'],
	['eucalyptus', 'Eucalyptus'],
	['wattle', 'Wattle']
] as const;
const CLASSES = [
	['tallTrees', 'Tall trees'],
	['mediumTrees', 'Medium trees'],
	['tallShrubs', 'Tall shrubs']
] as const;
type Genus = (typeof GENERA)[number][0];
type AlienClass = (typeof CLASSES)[number][0];

const NO_PLANTATION = { percent: 0, rotationYears: 0 };
const NO_CLASS = { percent: 0, ageYears: 0 };

function withGenus(module: RunoffModule, genus: Genus, part: 'percent' | 'rotationYears', value: number): RunoffModule {
	const was = module.afforestation.species ?? { pine: NO_PLANTATION, eucalyptus: NO_PLANTATION, wattle: NO_PLANTATION };
	return { ...module, afforestation: { ...module.afforestation, species: { ...was, [genus]: { ...was[genus], [part]: value } } } };
}

function withClass(module: RunoffModule, cls: AlienClass, part: 'percent' | 'ageYears', value: number): RunoffModule {
	const alien = module.alienVegetation;
	if (alien === undefined) throw new Error(`RU ${module.number} has no alien vegetation lines`);
	const was = alien.composition ?? { tallTrees: NO_CLASS, mediumTrees: NO_CLASS, tallShrubs: NO_CLASS };
	return { ...module, alienVegetation: { ...alien, composition: { ...was, [cls]: { ...was[cls], [part]: value } } } };
}

function withReduction(module: RunoffModule, part: 'marPercent' | 'lowFlowPercent', value: number): RunoffModule {
	const was = module.afforestation.userDefinedReduction ?? { marPercent: 0, lowFlowPercent: 0 };
	return { ...module, afforestation: { ...module.afforestation, userDefinedReduction: { ...was, [part]: value } } };
}

function withAlien(module: RunoffModule, change: Partial<Pick<NonNullable<RunoffModule['alienVegetation']>, 'optimalPercent' | 'riparianArea'>>): RunoffModule {
	const alien = module.alienVegetation;
	if (alien === undefined) throw new Error(`RU ${module.number} has no alien vegetation lines`);
	return { ...module, alienVegetation: { ...alien, ...change } };
}

const AFFORESTATION_FIELDS: readonly CompositionField[] = [
	...GENERA.map(([genus, label]): CompositionField => ({
		field: `afforestation.species.${genus}.percent`,
		table: 'afforestation',
		group: 'share',
		line: 'L.009',
		label: `${label} share`,
		unit: '%',
		decimals: 2,
		max: 100,
		read: (m) => m.afforestation.species?.[genus].percent ?? null,
		write: (m, v) => withGenus(m, genus, 'percent', v)
	})),
	...GENERA.map(([genus, label]): CompositionField => ({
		field: `afforestation.species.${genus}.rotationYears`,
		table: 'afforestation',
		group: 'other',
		line: 'L.009',
		label: `${label} rotation`,
		unit: 'years',
		decimals: 0,
		max: 999, // free format needs a blank between values, so a value can't fill its field
		read: (m) => m.afforestation.species?.[genus].rotationYears ?? null,
		write: (m, v) => withGenus(m, genus, 'rotationYears', v)
	})),
	{
		field: 'afforestation.optimalPercent',
		table: 'afforestation',
		group: 'other',
		line: 'L.010',
		label: 'Optimal growth area',
		unit: '%',
		decimals: 2,
		max: 100,
		read: (m) => m.afforestation.optimalPercent ?? null,
		write: (m, v) => ({ ...m, afforestation: { ...m.afforestation, optimalPercent: v } })
	},
	{
		field: 'afforestation.userDefinedReduction.marPercent',
		table: 'afforestation',
		group: 'other',
		line: 'L.010',
		label: 'Required reduction of MAR',
		unit: '%',
		decimals: 2,
		max: 100,
		read: (m) => m.afforestation.userDefinedReduction?.marPercent ?? null,
		write: (m, v) => withReduction(m, 'marPercent', v)
	},
	{
		field: 'afforestation.userDefinedReduction.lowFlowPercent',
		table: 'afforestation',
		group: 'other',
		line: 'L.010',
		label: 'Required reduction of low flow',
		unit: '%',
		decimals: 2,
		max: 100,
		read: (m) => m.afforestation.userDefinedReduction?.lowFlowPercent ?? null,
		write: (m, v) => withReduction(m, 'lowFlowPercent', v)
	}
];

const ALIEN_FIELDS: readonly CompositionField[] = [
	...CLASSES.map(([cls, label]): CompositionField => ({
		field: `alienVegetation.composition.${cls}.percent`,
		table: 'alienVegetation',
		group: 'share',
		line: 'L.014',
		label: `${label} share`,
		unit: '%',
		decimals: 2,
		max: 100,
		read: (m) => m.alienVegetation?.composition?.[cls].percent ?? null,
		write: (m, v) => withClass(m, cls, 'percent', v)
	})),
	...CLASSES.map(([cls, label]): CompositionField => ({
		field: `alienVegetation.composition.${cls}.ageYears`,
		table: 'alienVegetation',
		group: 'other',
		line: 'L.014',
		label: `${label} age`,
		unit: 'years',
		decimals: 2,
		max: 999.99, // free format needs a blank between values, so a value can't fill its field
		read: (m) => m.alienVegetation?.composition?.[cls].ageYears ?? null,
		write: (m, v) => withClass(m, cls, 'ageYears', v)
	})),
	{
		field: 'alienVegetation.optimalPercent',
		table: 'alienVegetation',
		group: 'other',
		line: 'L.015',
		label: 'Optimal area',
		unit: '%',
		decimals: 2,
		max: 100,
		read: (m) => m.alienVegetation?.optimalPercent ?? null,
		write: (m, v) => withAlien(m, { optimalPercent: v })
	},
	{
		field: 'alienVegetation.riparianArea',
		table: 'alienVegetation',
		group: 'other',
		line: 'L.011',
		label: 'Riparian share',
		unit: '%',
		decimals: 2,
		max: 100,
		read: (m) => m.alienVegetation?.riparianArea ?? null,
		write: (m, v) => withAlien(m, { riparianArea: v })
	}
];

export const COMPOSITION_FIELDS: Readonly<Record<CompositionTable, readonly CompositionField[]>> = { afforestation: AFFORESTATION_FIELDS, alienVegetation: ALIEN_FIELDS };

/** The file's lines for the block. */
export const COMPOSITION_LINES: Readonly<Record<CompositionTable, string>> = { afforestation: 'L.009–L.010', alienVegetation: 'L.011, L.014–L.015' };

/** Shares are written to 2 decimals, so their sum is judged to half the last place (`DEMAND_SHARE_TOLERANCE`'s reasoning). */
export const COMPOSITION_SHARE_TOLERANCE = 0.005;

/** Find a field by its path. */
export function compositionField(field: string): CompositionField | undefined {
	return [...AFFORESTATION_FIELDS, ...ALIEN_FIELDS].find((f) => f.field === field);
}

/**
 * Why the block can't be edited at all, or `null`. L.009–L.010 and L.014–L.015
 * exist only while the table has rows (docs/formats.md §5.3), and a version 0
 * file has no L.009 at all, so an edit there couldn't be saved.
 */
export function compositionProblem(module: RunoffModule, table: CompositionTable): string | null {
	if (module.fileVersion < 1) return `This module’s file is version 0, which has no ${table === 'afforestation' ? 'species lines (L.009–L.010)' : 'alien vegetation lines (L.011–L.015)'}.`;
	if (yearTableOf(module, table).length === 0) return `The file holds these lines only while the table has a row (${COMPOSITION_LINES[table]}).`;
	return null;
}

/** Whether the module is an SFR child of another in the network. */
export function isSfrChild(bundle: NetworkBundle, number: number): boolean {
	return bundle.modules.some((m) => m.kind === 'RU' && (m.sfrChildren ?? []).includes(number));
}

const usesCsirTables = (field: CompositionField) => field.field === 'afforestation.optimalPercent' || field.field.endsWith('.rotationYears');
const isRequiredReduction = (field: CompositionField) => field.field.startsWith('afforestation.userDefinedReduction.');

/**
 * Why this value stays read-only here, or `null` (R7-T10). Both are decided by
 * the algorithm, which this screen doesn't change.
 */
export function compositionLock(module: RunoffModule, field: CompositionField, sfrChild: boolean): string | null {
	const { algorithm } = module.afforestation;
	if (sfrChild && algorithm === 1 && usesCsirTables(field)) {
		return 'Read-only on a CSIR child. WRSM2000 reads this through tables the manuals don’t publish, so Pitman runs the child on Smoothed Gush targets (R6-F2) and can’t show what a change does, and WRSM2000’s own log points to rotations when the SFR calibration doesn’t close. Change it in WRSM2000.';
	}
	if (isRequiredReduction(field) && algorithm !== 4) return 'Read-only: only the User-defined algorithm reads this (L.010), and the algorithm is set in WRSM2000.';
	return null;
}

/** Why `value` can't go in the field, in the screen's words, or `null`. Values already in a file aren't judged. */
export function compositionValueProblem(field: CompositionField, value: number): string | null {
	const { decimals, line, max, unit } = field;
	if (!Number.isFinite(value)) return 'This must be a number.';
	if (value < 0) return unit === '%' ? 'A percentage can’t be negative.' : 'Years can’t be negative.';
	if (unit === '%' && value > 100) return 'A percentage runs from 0 to 100.';
	if (value > max) return `The file’s column stops at ${max} (${line}).`;
	if (decimals === 0) return Number.isInteger(value) ? null : `The file keeps whole years here (${line}).`;
	if (Number(Math.fround(value).toFixed(decimals)) === value) return null;
	const step = 10 ** decimals;
	const low = (Math.floor(value * step) / step).toFixed(decimals);
	const high = (Math.ceil(value * step) / step).toFixed(decimals);
	return `The file keeps ${decimals} decimal places here (${line}), so this can’t be saved exactly. Use ${low} or ${high}.`;
}

/** The sum of the block's shares; `null` while the file holds none. */
export function compositionShareSum(module: RunoffModule, table: CompositionTable): number | null {
	const values = COMPOSITION_FIELDS[table].filter((f) => f.group === 'share').map((f) => f.read(module));
	return values.some((v) => v === null) ? null : values.reduce<number>((a, b) => a + (b ?? 0), 0);
}

/** Why the shares can't stand, or `null`. The class shares' rule is TT 689 p.128's; the genus shares carry the same weight (R6-F1). */
export function compositionSumProblem(table: CompositionTable, sum: number): string | null {
	if (Math.abs(sum - 100) < COMPOSITION_SHARE_TOLERANCE) return null;
	const what = table === 'afforestation' ? 'The three genus shares (L.009)' : 'The three class shares (L.014, TT 689 p.128)';
	const gap = 100 - sum;
	return `${what} must add up to 100 %. They come to ${sum.toFixed(2)} %, ${Math.abs(gap).toFixed(2)} ${gap > 0 ? 'short of' : 'over'} 100.`;
}

/** Where a value came from: the log's run that ends at `current` (R7-T3). */
export function compositionHistory(sidecar: Sidecar | undefined, moduleNumber: number, field: CompositionField, current: number | null): TableCellHistory {
	return fieldHistory(fieldLog(sidecar, moduleNumber, field.field), current);
}

/** One edit of one value. */
export interface CompositionEdit {
	readonly module: ModuleRef;
	/** `CompositionField.field`. */
	readonly field: string;
	readonly value: number;
	readonly source: ValueSource;
}

/** The module as the file will hold it: an untouched value the format can't keep moves here (R7-T8). */
function savedValues(module: RunoffModule, fields: readonly CompositionField[]): RunoffModule {
	const saved = readRunoff(writeRunoff(module), 'land-use composition');
	return fields.reduce((m, f) => {
		const value = f.read(saved);
		return value === null || value === f.read(m) ? m : f.write(m, value);
	}, module);
}

/**
 * The bundle with the edits written and each recorded in `sidecar.values`.
 * Throws on what the screen refuses, so a value that wasn't checked can't reach
 * a file. Table edits that open a table go first (`applyTableEdits`).
 */
export function applyCompositionEdits<B extends NetworkBundle>(bundle: B, edits: readonly CompositionEdit[]): B {
	if (edits.length === 0) return bundle;
	const base: Sidecar = bundle.sidecar ?? { schema: 'pitman-sidecar', schemaVersion: 1 };
	const logged: NonNullable<Sidecar['values']>[number][] = [];
	const next = new Map<number, RunoffModule>();
	const seen = new Set<string>();

	for (const number of new Set(edits.map((e) => e.module.number))) {
		const was = bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === number);
		if (was === undefined) throw new Error(`no runoff module for RU ${number}`);
		const own = edits.filter((e) => e.module.number === number);
		let module = was;
		for (const edit of own) {
			const field = compositionField(edit.field);
			if (field === undefined) throw new Error(`RU ${number}: there is no value ${edit.field}`);
			const fail = (why: string): never => {
				throw new Error(`RU ${number} ${edit.field}: ${why}`);
			};
			const problem = compositionProblem(was, field.table);
			if (problem !== null) fail(problem);
			const lock = compositionLock(was, field, isSfrChild(bundle, number));
			if (lock !== null) fail(lock);
			if ((edit.source.note ?? '').trim() === '') fail('no source note (rule 8)');
			const valueProblem = compositionValueProblem(field, edit.value);
			if (valueProblem !== null) fail(valueProblem);
			if (seen.has(`${number}/${edit.field}`)) fail('edited twice');
			seen.add(`${number}/${edit.field}`);
			logged.push({ target: { module: { type: 'RU', number }, field: edit.field }, source: { ...edit.source, note: tableEditNote(field.read(was), edit.value, edit.source.note ?? '') } });
			module = field.write(module, edit.value);
		}
		const tables = new Set(own.map((e) => compositionField(e.field)!.table));
		const fields = [...tables].flatMap((t) => COMPOSITION_FIELDS[t]);
		const saved = savedValues(module, fields);
		for (const table of tables) {
			if (!own.some((e) => compositionField(e.field)!.group === 'share' && compositionField(e.field)!.table === table)) continue;
			// R7-T9: going back to the file's shares is always open, whatever they add up to.
			const backToFile = COMPOSITION_FIELDS[table].filter((f) => f.group === 'share').every((f) => f.read(saved) === compositionHistory(base, number, f, f.read(was)).file);
			if (backToFile) continue;
			const sumProblem = compositionSumProblem(table, compositionShareSum(saved, table) ?? 0);
			if (sumProblem !== null) throw new Error(`RU ${number}: ${sumProblem}`);
		}
		for (const f of fields) {
			if (f.read(saved) === f.read(module)) continue;
			logged.push({ target: { module: { type: 'RU', number }, field: f.field }, source: { ...own[0]!.source, note: tableEditNote(f.read(module), f.read(saved), 'rounded to what the file can hold') } });
		}
		next.set(number, saved);
	}
	return {
		...bundle,
		modules: bundle.modules.map((m) => (m.kind === 'RU' ? (next.get(m.number) ?? m) : m)),
		sidecar: { ...base, values: [...(base.values ?? []), ...logged] }
	};
}

