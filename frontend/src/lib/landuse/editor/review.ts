/**
 * The drafts on the screen, row by row, and what they would do. Nothing here
 * changes the working copy: `reviewModule` gives the module as it would be,
 * which is the preview the charts draw, and the changes `toEdits` hands to
 * `applyTableEdits`. Row refusals are the engine's (`tableValueProblem`), so
 * screen and write agree; the area rules are `specialAreaMessages`, the check
 * a run makes (TT 689 pp.127–128, 139–140).
 *
 * Like Calibrate, a value that wasn't edited is never judged: a file that
 * loaded isn't the user's mistake. An area over the limit blocks only when an
 * edit raised it.
 */

import {
	activeAreaTable,
	describeValueSplit,
	LAND_USE_TABLES,
	readRunoff,
	sfrKind,
	specialAreaMessages,
	tableCellHistory,
	tableKeepsLastRow,
	tableLoggedYears,
	tableOrderProblem,
	tableValueProblem,
	tableYearProblem,
	withYearTable,
	writeRunoff,
	yearTableOf,
	yearTableValue,
	type LandUseTable,
	type NetworkBundle,
	type RunoffModule,
	type TableEdit,
	type ValueSource,
	type YearTable
} from '@pitman/wrsm';
import { saveCheck } from '#lib/calibrate/apply.js';
import { parameterFields } from '#lib/calibrate/parameters.js';
import { parseNumber } from '#lib/calibrate/validate.js';
import { moduleRole, TABLE_ORDER, TABLE_TITLE, TARGET_YEAR, type ModuleRole } from './offers.js';

/** What the user has done to one cell. A cell left alone has no entry. */
export interface CellDraft {
	/** What's in the box; `''` for a new year not yet given a value. */
	readonly text: string;
	readonly note: string;
	/** The row is to go. */
	readonly removed?: true;
}

export type TableDraft = Readonly<Record<number, CellDraft>>;
export type ModuleDraft = Readonly<Partial<Record<LandUseTable, TableDraft>>>;

export type RowState =
	| 'same' // as the working copy has it
	| 'edited' // a new value, not applied
	| 'new' // a new year, not applied
	| 'removing' // to go when applied
	| 'removed'; // went in an earlier apply; can be put back

export interface RowView {
	readonly year: number;
	/** In the working copy, `null` when the year isn't in the table. */
	readonly current: number | null;
	/** In the network file, `null` when it didn't list the year. */
	readonly file: number | null;
	readonly text: string;
	readonly note: string;
	readonly state: RowState;
	/** What the row would hold: the typed value if it's good, else the working copy's. */
	readonly target: number | null;
	readonly changed: boolean;
	/** The change goes back to the file's value, which needs no source of its own. */
	readonly backToFile: boolean;
	readonly needsNote: boolean;
	/** Why the typed value is refused. */
	readonly error: string | null;
	/** How the run's reading changes, for a new year. */
	readonly hint: string | null;
	/** The source of a value applied earlier. */
	readonly applied: string | null;
}

/** A value on screen: the file's precision, unless the file held more. */
export function formatCell(table: LandUseTable, value: number): string {
	const fixed = value.toFixed(LAND_USE_TABLES[table].decimals);
	return Number(fixed) === value ? fixed : String(value);
}

function rowError(table: LandUseTable, year: number, text: string, n: number | null, moved: boolean): string | null {
	if (n === null) return text.trim() === '' ? `Enter the value for ${year}, or remove the year.` : `${year}’s value must be a number.`;
	return moved ? tableValueProblem(table, n) : null;
}

function rowFor(module: RunoffModule, table: LandUseTable, year: number, current: number | null, draft: CellDraft | undefined, sidecar: NetworkBundle['sidecar']): RowView {
	const { file, edits, divided } = tableCellHistory(sidecar, module.number, table, year, current);
	const latest = edits.at(-1) ?? divided;
	const how = latest?.division ? `; ${describeValueSplit(latest.division)}` : '';
	const applied = latest && latest.kind !== 'networkFile' ? `Applied ${latest.date.slice(0, 10)}: ${latest.note}${how}` : null;
	const base = { year, current, file, note: draft?.note ?? '', hint: null, error: null, applied };
	const shown = current === null ? '' : formatCell(table, current);

	if (draft === undefined) return { ...base, text: shown, state: current === null ? 'removed' : 'same', target: current, changed: false, backToFile: false, needsNote: false };
	if (draft.removed) {
		const backToFile = file === null;
		return { ...base, text: draft.text || shown, state: 'removing', target: null, changed: true, backToFile, needsNote: !backToFile };
	}
	const n = parseNumber(draft.text);
	const error = rowError(table, year, draft.text, n, n !== current);
	const target = n !== null && error === null ? n : current;
	const changed = target !== current;
	const backToFile = changed && target === file;
	return { ...base, text: draft.text, error, state: current === null ? 'new' : changed || error !== null ? 'edited' : 'same', target, changed, backToFile, needsNote: changed && !backToFile };
}

/** Every row of a table, ascending by year: the working copy's, the drafts, and what earlier applies removed. */
export function tableRows(module: RunoffModule, table: LandUseTable, draft: TableDraft | undefined, sidecar: NetworkBundle['sidecar']): RowView[] {
	const rows = yearTableOf(module, table);
	if (tableOrderProblem(rows) !== null) return rows.map((r) => rowFor(module, table, r.year, r.value, undefined, undefined));
	const current = new Map(rows.map((r) => [r.year, r.value]));
	const drafted = Object.keys(draft ?? {}).map(Number);
	const years = new Set([...current.keys(), ...drafted, ...tableLoggedYears(sidecar, module.number, table)]);
	return [...years]
		.sort((a, b) => a - b)
		.map((year) => rowFor(module, table, year, current.get(year) ?? null, draft?.[year], sidecar))
		.filter((row) => row.state !== 'removed' || row.file !== null);
}

/** The rows as a table, as it would be saved. */
export function targetTable(rows: readonly RowView[]): YearTable {
	return rows.flatMap((r) => (r.target === null ? [] : [{ year: r.year, value: r.target }]));
}

/** What a new year does to the run: a last year turns the flat tail into a line, which reaches back to the row before it. */
function withHints(table: LandUseTable, rows: readonly RowView[], endYear: number): RowView[] {
	const present = rows.filter((r) => r.target !== null);
	return rows.map((row) => {
		if (row.state !== 'new' || row.target === null) return row;
		const before = present.filter((r) => r.year < row.year).at(-1);
		const line =
			present.at(-1) === row && before?.target != null
				? `A run now reads a straight line from ${before.year} (${formatCell(table, before.target)}) to ${row.year} (${formatCell(table, row.target)}); until now it held ${formatCell(table, before.target)} flat after ${before.year}.`
				: null;
		const late = row.year > endYear ? `${row.year} is after the run’s last year (${endYear}), so a run won’t read it until the run period is extended.` : null;
		const hint = [line, late].filter((t) => t !== null).join(' ');
		return hint === '' ? row : { ...row, hint };
	});
}

function without(draft: TableDraft, year: number): TableDraft {
	const { [year]: _dropped, ...rest } = draft;
	return rest;
}

/** Back to the network file's value, whatever the working copy holds. */
export function resetRow(draft: TableDraft, table: LandUseTable, row: RowView): TableDraft {
	const rest = without(draft, row.year);
	if (row.file === row.current) return rest;
	if (row.file === null) return { ...rest, [row.year]: { text: '', note: '', removed: true } };
	return { ...rest, [row.year]: { text: formatCell(table, row.file), note: '' } };
}

export function removeRow(draft: TableDraft, row: RowView): TableDraft {
	const rest = without(draft, row.year);
	return row.current === null ? rest : { ...rest, [row.year]: { text: row.text, note: row.note, removed: true } };
}

/** Undo a pending removal, or bring back a year an earlier apply removed. */
export function putBack(draft: TableDraft, table: LandUseTable, row: RowView): TableDraft {
	return row.state === 'removing' ? without(draft, row.year) : resetRow(draft, table, row);
}

/** Whether a row may go: a table with lines of its own keeps a row (R7-T4). */
export function canRemove(table: LandUseTable, rows: readonly RowView[]): boolean {
	return !tableKeepsLastRow(table) || rows.filter((r) => r.target !== null).length > 1;
}

/** The year to offer: the target year, then the one after the table's last. */
export function suggestedYear(rows: readonly RowView[]): number {
	return rows.some((r) => r.year === TARGET_YEAR) ? Math.max(...rows.map((r) => r.year)) + 1 : TARGET_YEAR;
}

/** Why a year can't be added, or `null`. */
export function addYearProblem(rows: readonly RowView[], text: string): string | null {
	if (text.trim() === '') return 'Enter a year.';
	const year = Number(text.trim());
	return tableYearProblem(year) ?? (rows.some((r) => r.year === year) ? `${year} is already in this table.` : null);
}

/** One pending change, as the list above Apply says it and the sidecar records it. */
export interface PendingChange {
	readonly table: LandUseTable;
	readonly year: number;
	readonly from: number | null;
	readonly to: number | null;
	readonly note: string;
	readonly backToFile: boolean;
}

export function changeLine({ table, year, from, to }: PendingChange): string {
	const unit = LAND_USE_TABLES[table].unit === 'km²' ? ' km²' : '';
	const value = (v: number | null) => (v === null ? 'none' : `${formatCell(table, v)}${unit}`);
	return `${TABLE_TITLE[table]} ${year}: ${value(from)} → ${value(to)}`;
}

const km2 = (x: number) => `${x.toFixed(1)} km²`;

/** A module's tables and its children's, as the special-area rule reads them. */
interface Reading {
	readonly module: RunoffModule;
	readonly children: readonly RunoffModule[];
}

function specialAreas({ module, children }: Reading, year: number) {
	const forest = yearTableValue(module.afforestation.areaKm2, year);
	const alien = module.alienVegetation ? yearTableValue(module.alienVegetation.areaKm2, year) : 0;
	const paved = (module.paved ? yearTableValue(module.paved.fraction, year) : 0) * module.areaKm2;
	const childAreas = children.map((c) => Math.max(0, yearTableValue(activeAreaTable(c, sfrKind(c)), year)));
	const child = childAreas.reduce((a, b) => a + b, 0);
	return { forest, alien, paved, child, total: forest + alien + paved + child, over: specialAreaMessages(module, year, childAreas).length > 0 };
}

function listedYears({ module, children }: Reading): number[] {
	return [...TABLE_ORDER.map((t) => yearTableOf(module, t)), ...children.map((c) => activeAreaTable(c, sfrKind(c)))].flat().map((r) => r.year);
}

function overSentence(reading: Reading, year: number, more: number): string {
	const { forest, alien, paved, child, total } = specialAreas(reading, year);
	const parts = [forest > 0 && `afforestation ${km2(forest)}`, alien > 0 && `alien vegetation ${km2(alien)}`, paved > 0 && `paved ${km2(paved)}`, child > 0 && `SFR children ${km2(child)}`].filter(Boolean).join(', ');
	const also = more === 0 ? '' : more === 1 ? ' One more listed year is over too.' : ` ${more} more listed years are over too.`;
	return `In ${year}, ${parts} add up to ${km2(total)}, more than RU ${reading.module.number}’s ${km2(reading.module.areaKm2)} (TT 689 p.127).${also}`;
}

/** The special-area rule at every listed year: the total is a straight line between them, so its peak falls on one. */
function areaCheck(before: Reading, after: Reading): { errors: string[]; warnings: string[] } {
	const years = [...new Set([...listedYears(before), ...listedYears(after)])].sort((a, b) => a - b);
	const over = years.filter((y) => specialAreas(after, y).over);
	const raised = over.filter((y) => specialAreas(after, y).total > specialAreas(before, y).total + 1e-9);
	const first = raised[0];
	if (first !== undefined) return { errors: [overSentence(after, first, raised.length - 1)], warnings: [] };
	const standing = over[0];
	return { errors: [], warnings: standing === undefined ? [] : [`The network is already over this area: ${overSentence(after, standing, over.length - 1)}`] };
}

function checkAreas(bundle: NetworkBundle, role: ModuleRole, module: RunoffModule, next: RunoffModule, rows: readonly RowView[]): { errors: string[]; warnings: string[] } {
	if (role.kind === 'child') {
		// A child's L.002 is a check only (TT 689 p.139); the limit that binds is the parent's area.
		const active = activeAreaTable(next, sfrKind(next)).reduce((max, r) => Math.max(max, r.value), 0);
		const warnings = active > next.areaKm2 ? [`This child’s area reaches ${km2(active)}, more than the ${km2(next.areaKm2)} on its L.002, which is the most it should cover (TT 689 p.139).`] : [];
		const siblings = (role.parent.sfrChildren ?? []).flatMap((n) => bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === n) ?? []);
		const parent = areaCheck({ module: role.parent, children: siblings }, { module: role.parent, children: siblings.map((c) => (c.number === next.number ? next : c)) });
		return { errors: parent.errors, warnings: [...warnings, ...parent.warnings] };
	}
	const result = areaCheck({ module, children: role.kind === 'parent' ? role.children : [] }, { module: next, children: role.kind === 'parent' ? role.children : [] });
	const alien = rows.find((r) => r.changed && r.target !== null && r.target > module.areaKm2);
	if (alien) result.errors.unshift(`Alien vegetation in ${alien.year} can’t be more than the module’s ${km2(module.areaKm2)} (TT 689 p.128).`);
	return result;
}

export interface ModuleReview {
	readonly tables: Readonly<Record<LandUseTable, readonly RowView[]>>;
	/** The module with every good draft in it: the preview. */
	readonly next: RunoffModule;
	readonly changes: readonly PendingChange[];
	/** Errors no single row owns: they stop Apply. */
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
	/** Values changed with no source yet. */
	readonly missingNotes: number;
	/** No row or area error; notes are counted apart. */
	readonly valid: boolean;
	/** What saving would round, and why the module can't be written. */
	readonly saved: { readonly rounded: readonly string[]; readonly problem: string | null };
}

/** The rows saving would round: the loaded file may hold more than the format keeps. */
function roundedRows(next: RunoffModule): string[] {
	const back = readRunoff(writeRunoff(next), 'runoff module');
	return TABLE_ORDER.flatMap((table) => {
		const saved = yearTableOf(back, table);
		return yearTableOf(next, table).flatMap((row, k) => (saved[k]?.value === row.value ? [] : [`${TABLE_TITLE[table].toLowerCase()} ${row.year}`]));
	});
}

function saveReview(next: RunoffModule): ModuleReview['saved'] {
	const fields = saveCheck(next, parameterFields(next));
	return fields.problem !== null ? fields : { rounded: [...fields.rounded, ...roundedRows(next)], problem: null };
}

export function reviewModule(bundle: NetworkBundle, module: RunoffModule, draft: ModuleDraft): ModuleReview {
	const tables = {} as Record<LandUseTable, readonly RowView[]>;
	const changes: PendingChange[] = [];
	let next = module;
	for (const table of TABLE_ORDER) {
		const rows = tableRows(module, table, draft[table], bundle.sidecar);
		tables[table] = withHints(table, rows, bundle.network.endYear);
		const moved = rows.filter((r) => r.changed);
		if (moved.length > 0) next = withYearTable(next, table, targetTable(rows));
		for (const row of moved) changes.push({ table, year: row.year, from: row.current, to: row.target, note: row.note.trim(), backToFile: row.backToFile });
	}
	const { errors, warnings } = changes.length > 0 ? checkAreas(bundle, moduleRole(bundle, module), module, next, tables.alienVegetation) : { errors: [], warnings: [] };
	return {
		tables,
		next,
		changes,
		errors,
		warnings,
		missingNotes: changes.filter((c) => !c.backToFile && c.note === '').length,
		valid: errors.length === 0 && !Object.values(tables).flat().some((r) => r.error !== null),
		saved: changes.length > 0 ? saveReview(next) : { rounded: [], problem: null }
	};
}

/** Each row's refusal, named, for the list at Apply. */
export function refusedRows(review: ModuleReview): string[] {
	return TABLE_ORDER.flatMap((table) => review.tables[table].flatMap((r) => (r.error === null ? [] : [`${TABLE_TITLE[table]} ${r.year}: ${r.error}`])));
}

/** The changes as `applyTableEdits` takes them. `date` is stamped by the caller: the engine doesn't read the clock. */
export function toEdits(module: RunoffModule, changes: readonly PendingChange[], date: string): TableEdit[] {
	return changes.map((c) => {
		const source: ValueSource = c.backToFile ? { kind: 'networkFile', note: 'Back to the network file’s value', date } : { kind: 'manual', note: c.note, date };
		return { target: { module: { type: 'RU', number: module.number }, table: c.table, row: LAND_USE_TABLES[c.table].row }, year: c.year, value: c.to, source };
	});
}

/** `note` on every changed value that has none yet: one survey often answers several cells. */
export function fillNotes(draft: ModuleDraft, review: ModuleReview, note: string): ModuleDraft {
	const next: Partial<Record<LandUseTable, TableDraft>> = { ...draft };
	for (const change of review.changes) {
		if (change.backToFile || change.note !== '') continue;
		const cell = next[change.table]?.[change.year];
		if (cell) next[change.table] = { ...next[change.table], [change.year]: { ...cell, note } };
	}
	return next;
}
