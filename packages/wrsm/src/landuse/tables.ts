/**
 * Editing a runoff module's land-use year tables by hand: afforestation
 * (L.006–L.008), alien vegetation (L.011–L.013) and paved area (L.016–L.018),
 * each edit with its source (issue #3 rule 8, Round 7 row 7.4).
 *
 * What the file can hold is decided here, so the screen and `applyTableEdits`
 * refuse the same values in the same words: L.008 and L.013 are `F0.1`, L.018
 * is `F5.3`, and the writer rounds through float32 (docs/formats.md §2, §5.1).
 *
 * The sidecar's `values` list is a log, oldest first, one entry per edit:
 * `{ target: { module, field: 'afforestation.areaKm2', year }, source }`. As
 * in Calibrate the note carries the change, `Land use: 5.2 → 6; 2024 survey`,
 * with `none` for a year that wasn't or no longer is in the table, because
 * `ValueSource` has no structured from and to. `tableCellHistory` reads it
 * back. A log entry says what the cell held then, not what it holds now: a
 * sub-division scales the table under it (R5-E16 leaves `values` alone), so
 * only the run of entries that ends at the cell's value counts (R7-T3).
 */

import { readRunoff, writeRunoff } from '../io/runoff.js';
import type { HydroYear, NetworkBundle, RunoffModule, Sidecar, ValueSourceKind, YearTable } from '../types.js';
import type { ApplyTableEdits, TableEdit } from './round7-contract.js';

export type LandUseTable = TableEdit['target']['table'];

/** Where a table lives in the module and the file. */
export interface LandUseTableFormat {
	/** `TableEdit.target.row`: the property holding the rows, the only series each table has (R7-T1). */
	readonly row: string;
	/** `ValueTarget.field`, the property path. */
	readonly field: string;
	readonly yearsLine: string;
	readonly valuesLine: string;
	/** Decimals the value line keeps. */
	readonly decimals: number;
	readonly unit: string;
}

export const LAND_USE_TABLES: Readonly<Record<LandUseTable, LandUseTableFormat>> = {
	afforestation: { row: 'areaKm2', field: 'afforestation.areaKm2', yearsLine: 'L.007', valuesLine: 'L.008', decimals: 1, unit: 'km²' },
	alienVegetation: { row: 'areaKm2', field: 'alienVegetation.areaKm2', yearsLine: 'L.012', valuesLine: 'L.013', decimals: 1, unit: 'km²' },
	paved: { row: 'fraction', field: 'paved.fraction', yearsLine: 'L.017', valuesLine: 'L.018', decimals: 3, unit: 'fraction of the catchment' }
};

/** The table's rows; an absent table has none. */
export function yearTableOf(module: RunoffModule, table: LandUseTable): YearTable {
	switch (table) {
		case 'afforestation':
			return module.afforestation.areaKm2;
		case 'alienVegetation':
			return module.alienVegetation?.areaKm2 ?? [];
		case 'paved':
			return module.paved?.fraction ?? [];
	}
}

/**
 * Why `value` can't go in the table, in the screen's words, or `null`. Rows
 * already in a file aren't judged: a file that loaded isn't the user's mistake.
 */
export function tableValueProblem(table: LandUseTable, value: number): string | null {
	const { decimals, valuesLine } = LAND_USE_TABLES[table];
	if (!Number.isFinite(value)) return 'This must be a number.';
	if (table === 'paved' && (value < 0 || value > 1)) return 'Paved area is a fraction of the catchment, from 0 to 1 (TT 691 p.40): enter 0.200 for 20 %.';
	if (value < 0) return 'An area can’t be negative.';
	if (Number(Math.fround(value).toFixed(decimals)) === value) return null;
	const step = 10 ** decimals;
	const low = (Math.floor(value * step) / step).toFixed(decimals);
	const high = (Math.ceil(value * step) / step).toFixed(decimals);
	const keeps = decimals === 1 ? '1 decimal place' : `${decimals} decimal places`;
	return `The file keeps ${keeps} here (${valuesLine}), so this can’t be saved exactly. Use ${low} or ${high}.`;
}

/** Why `year` can't be a row of a year table: the year line is `I4`. */
export function tableYearProblem(year: HydroYear): string | null {
	return Number.isInteger(year) && year >= 1000 && year <= 9999 ? null : 'Enter a whole four-digit year.';
}

/** Why a table can't be edited year by year: its years must ascend for a lookup to mean anything (docs/formats.md §5.3). */
export function tableOrderProblem(rows: YearTable): string | null {
	for (let k = 1; k < rows.length; k++) {
		const here = rows[k]!.year;
		if (here === rows[k - 1]!.year) return `The file lists ${here} twice.`;
		if (here < rows[k - 1]!.year) return `The file’s years are out of order at ${here}.`;
	}
	return null;
}

/**
 * Whether the table must keep a row. L.009–L.010 and L.014–L.015 exist only
 * when their table has rows (docs/formats.md §5.3), so an emptied table would
 * lose the species split or the composition from the saved file (R7-T4).
 */
export function tableKeepsLastRow(table: LandUseTable): boolean {
	return table !== 'paved';
}

/**
 * The module with `rows` as the table. The first row of an empty table brings
 * L.009–L.010 or L.014–L.015 into the file, which `writeRunoff` fills with
 * zeros: they go into the module too, so what is run is what is saved.
 */
export function withYearTable(module: RunoffModule, table: LandUseTable, rows: YearTable): RunoffModule {
	switch (table) {
		case 'afforestation': {
			const was = module.afforestation;
			const opened = was.areaKm2.length === 0 && rows.length > 0 && module.fileVersion >= 1;
			const none = { percent: 0, rotationYears: 0 };
			return {
				...module,
				afforestation: {
					...was,
					areaKm2: rows,
					...(opened && {
						species: was.species ?? { pine: none, eucalyptus: none, wattle: none },
						optimalPercent: was.optimalPercent ?? 0,
						...((was.userDefinedReduction !== undefined || module.fileVersion === 7) && { userDefinedReduction: was.userDefinedReduction ?? { marPercent: 0, lowFlowPercent: 0 } })
					})
				}
			};
		}
		case 'alienVegetation': {
			const was = module.alienVegetation ?? { algorithm: 0 as const, riparianArea: 0, areaKm2: [] };
			const opened = was.areaKm2.length === 0 && rows.length > 0;
			const none = { percent: 0, ageYears: 0 };
			return {
				...module,
				alienVegetation: {
					...was,
					areaKm2: rows,
					...(opened && { composition: was.composition ?? { tallTrees: none, mediumTrees: none, tallShrubs: none }, optimalPercent: was.optimalPercent ?? 0 })
				}
			};
		}
		case 'paved':
			return { ...module, paved: { fraction: rows } };
	}
}

const NOTE = /^Land use: (\S+) → (\S+)(?:; ([\s\S]*))?$/;
const NONE = 'none';

const noteValue = (value: number | null): string => (value === null ? NONE : String(value));
const readValue = (text: string): number | null => (text === NONE ? null : Number(text));

/** The sidecar note of one edit. */
export function tableEditNote(from: number | null, to: number | null, note: string): string {
	return `Land use: ${noteValue(from)} → ${noteValue(to)}; ${note.trim()}`;
}

/** One logged edit of a cell. */
export interface TableLogEntry {
	readonly from: number | null;
	readonly to: number | null;
	/** The source note as it was entered. */
	readonly note: string;
	readonly kind: ValueSourceKind;
	readonly date: string;
	readonly by?: string;
}

/** Every edit this module's sidecar holds for the cell, oldest first. Entries of another kind are skipped. */
export function tableCellLog(sidecar: Sidecar | undefined, moduleNumber: number, table: LandUseTable, year: HydroYear): TableLogEntry[] {
	return fieldLog(sidecar, moduleNumber, LAND_USE_TABLES[table].field, year);
}

/** Every edit logged for one value of a module, a year table's cell or a value with no year, oldest first. */
export function fieldLog(sidecar: Sidecar | undefined, moduleNumber: number, field: string, year?: HydroYear): TableLogEntry[] {
	const entries: TableLogEntry[] = [];
	for (const { target, source } of sidecar?.values ?? []) {
		if (target.field !== field || target.year !== year || target.module?.type !== 'RU' || target.module.number !== moduleNumber) continue;
		const match = NOTE.exec(source.note ?? '');
		if (match === null) continue;
		entries.push({ from: readValue(match[1]!), to: readValue(match[2]!), note: match[3] ?? '', kind: source.kind, date: source.date ?? '', ...(source.by !== undefined && { by: source.by }) });
	}
	return entries;
}

/** The years the log names for this table, in any order: a year removed earlier has no row left to show it. */
export function tableLoggedYears(sidecar: Sidecar | undefined, moduleNumber: number, table: LandUseTable): HydroYear[] {
	const { field } = LAND_USE_TABLES[table];
	const years = (sidecar?.values ?? []).flatMap(({ target }) => (target.field === field && target.year !== undefined && target.module?.type === 'RU' && target.module.number === moduleNumber ? [target.year] : []));
	return [...new Set(years)];
}

export interface TableCellHistory {
	/** What the network file had, `null` for a year it didn't list. */
	readonly file: number | null;
	/** The edits that led from `file` to the working copy, oldest first. */
	readonly edits: readonly TableLogEntry[];
}

/**
 * Where a cell's value came from. Only the entries that chain from the file to
 * `current` count: if the last one doesn't end at `current`, something else
 * has changed the cell since (a sub-division, a hand-edited file) and the value
 * in use is the file's, for all this log can say.
 */
export function tableCellHistory(sidecar: Sidecar | undefined, moduleNumber: number, table: LandUseTable, year: HydroYear, current: number | null): TableCellHistory {
	return fieldHistory(tableCellLog(sidecar, moduleNumber, table, year), current);
}

/** The run of `log` that ends at `current`: `tableCellHistory`'s rule, for any logged value. */
export function fieldHistory(log: readonly TableLogEntry[], current: number | null): TableCellHistory {
	const chain: TableLogEntry[] = [];
	let expected = current;
	for (let k = log.length - 1; k >= 0; k--) {
		const entry = log[k]!;
		if (entry.to !== expected) break;
		chain.unshift(entry);
		expected = entry.from;
	}
	return { file: expected, edits: chain };
}

function editProblem(module: RunoffModule, edit: TableEdit): string | null {
	const { table, row } = edit.target;
	const format = LAND_USE_TABLES[table];
	if (format === undefined) return `there is no table ${String(table)}`;
	if (row !== format.row) return `${table} has no row ${row}`;
	if (table === 'alienVegetation' && module.fileVersion < 1) return 'a version 0 file has no alien vegetation lines (L.011–L.015)';
	if ((edit.source.note ?? '').trim() === '') return `${edit.year} has no source note (rule 8)`;
	return tableYearProblem(edit.year) ?? (edit.value === null ? null : tableValueProblem(table, edit.value));
}

/**
 * The module with one table's edits in it, ascending by year. Throws on what
 * the screen refuses, so a value that wasn't checked can't reach a file.
 */
function editedTable(module: RunoffModule, table: LandUseTable, edits: readonly TableEdit[]): YearTable {
	const was = yearTableOf(module, table);
	const order = tableOrderProblem(was);
	if (order !== null) throw new Error(`RU ${module.number} ${table}: ${order}`);
	const rows = new Map(was.map((row) => [row.year, row.value]));
	for (const edit of edits) {
		if (edit.value !== null) rows.set(edit.year, edit.value);
		else if (!rows.delete(edit.year)) throw new Error(`RU ${module.number} ${table}: no row for ${edit.year} to remove`);
	}
	if (rows.size === 0 && was.length > 0 && tableKeepsLastRow(table)) throw new Error(`RU ${module.number} ${table}: keep one year, at 0 if the area has gone, or its other lines are lost (R7-T4)`);
	return [...rows].map(([year, value]) => ({ year, value })).sort((a, b) => a.year - b.year);
}

/** The bundle with the edits written and each recorded in `sidecar.values` (R7-T2). */
export function applyTableEdits<B extends NetworkBundle>(bundle: B, edits: readonly TableEdit[]): B {
	const base: Sidecar = bundle.sidecar ?? { schema: 'pitman-sidecar', schemaVersion: 1 };
	const modules = new Map(bundle.modules.flatMap((m) => (m.kind === 'RU' ? [[m.number, m] as const] : [])));
	const seen = new Set<string>();
	const logged: NonNullable<Sidecar['values']>[number][] = [];

	for (const edit of edits) {
		const { module: ref, table } = edit.target;
		const module = ref.type === 'RU' ? modules.get(ref.number) : undefined;
		if (module === undefined) throw new Error(`no runoff module for ${ref.type} ${ref.number}`);
		const problem = editProblem(module, edit);
		if (problem !== null) throw new Error(`RU ${ref.number} ${String(table)}: ${problem}`);
		const cell = `${ref.number}/${table}/${edit.year}`;
		if (seen.has(cell)) throw new Error(`RU ${ref.number} ${table}: ${edit.year} is edited twice`);
		seen.add(cell);
		const from = yearTableOf(module, table).find((row) => row.year === edit.year)?.value ?? null;
		logged.push({
			target: { module: { type: 'RU', number: ref.number }, field: LAND_USE_TABLES[table].field, year: edit.year },
			source: { ...edit.source, note: tableEditNote(from, edit.value, edit.source.note ?? '') }
		});
	}

	const next = new Map<number, RunoffModule>();
	for (const number of new Set(edits.map((e) => e.target.module.number))) {
		let module = modules.get(number)!;
		for (const table of Object.keys(LAND_USE_TABLES) as LandUseTable[]) {
			const own = edits.filter((e) => e.target.module.number === number && e.target.table === table);
			if (own.length === 0) continue;
			module = withYearTable(module, table, editedTable(module, table, own));
			// R7-T8: as R7-X1, the working copy holds what the file holds, so a run equals a run of the saved zip.
			// A hand-made file can hold an untouched row the format can't keep; it moves here, and the move is logged.
			const rows = yearTableOf(module, table);
			const saved = yearTableOf(readRunoff(writeRunoff(module), 'land-use tables'), table);
			rows.forEach((row, k) => {
				const value = saved[k]?.value;
				if (value === undefined || value === row.value) return;
				const { source } = own[0]!;
				logged.push({
					target: { module: { type: 'RU', number }, field: LAND_USE_TABLES[table].field, year: row.year },
					source: { ...source, note: tableEditNote(row.value, value, 'rounded to what the file can hold') }
				});
			});
			module = withYearTable(module, table, saved);
		}
		next.set(number, module);
	}
	return {
		...bundle,
		modules: bundle.modules.map((m) => (m.kind === 'RU' ? (next.get(m.number) ?? m) : m)),
		sidecar: { ...base, values: [...(base.values ?? []), ...logged] }
	};
}

applyTableEdits satisfies ApplyTableEdits;
