/**
 * The values behind a land-use table's area, as the screen edits them: the genus
 * split and rotations (L.009–L.010), the alien classes and ages (L.014–L.015),
 * and the riparian share (L.011). Like the year rows in `review.ts`, nothing here
 * changes the working copy, and refusals are the engine's, so screen and write
 * agree. A value that wasn't edited is never judged, and shares that came with
 * the file are shown as they are, unless an edit moves them.
 *
 * What a change does is said, not left to be found: which values an algorithm
 * reads, the reduction targets before and after, and the values this screen can't
 * change safely (`compositionLock`, R7-T10), which stay in view with the reason.
 */

import {
	alienReductionTargets,
	COMPOSITION_FIELDS,
	COMPOSITION_LINES,
	COMPOSITION_SHARE_TOLERANCE,
	compositionHistory,
	sfrKind,
	compositionLock,
	compositionProblem,
	compositionSumProblem,
	compositionValueProblem,
	forestChildTargets,
	isSfrChild,
	type CompositionEdit,
	type CompositionField,
	type CompositionTable,
	type NetworkBundle,
	type RunoffModule,
	type ValueSource
} from '@pitman/wrsm';
import { parseNumber } from '#lib/calibrate/validate.js';
import { moduleRole, pieceOrigin, TABLE_TITLE, type ModuleRole } from './offers.js';

export const COMPOSITION_ORDER: readonly CompositionTable[] = ['afforestation', 'alienVegetation'];

const BLOCK_TITLE: Readonly<Record<CompositionTable, string>> = { afforestation: 'Species split and rotations', alienVegetation: 'Composition and ages' };

/** What the user has done to one value. A value left alone has no entry. */
export interface CompositionCell {
	readonly text: string;
	readonly note: string;
}

/** By `CompositionField.field`. */
export type CompositionDraft = Readonly<Record<string, CompositionCell>>;

export interface CompositionRow {
	readonly field: CompositionField;
	/** In the working copy; `null` when the file has no such value. */
	readonly current: number | null;
	readonly file: number | null;
	readonly text: string;
	readonly note: string;
	readonly state: 'same' | 'edited';
	readonly target: number | null;
	readonly changed: boolean;
	readonly backToFile: boolean;
	readonly needsNote: boolean;
	readonly error: string | null;
	readonly hint: string | null;
	/** The source of a value applied earlier. */
	readonly applied: string | null;
	/** The value can't be changed here. */
	readonly locked: boolean;
}

export interface CompositionView {
	readonly table: CompositionTable;
	readonly title: string;
	/** Where the values came from, when a row doesn't say otherwise. */
	readonly origin: string;
	readonly shares: readonly CompositionRow[];
	readonly others: readonly CompositionRow[];
	/** What the shares come to as typed. */
	readonly sum: { readonly text: string; readonly ok: boolean };
	/** Stops Apply: the shares don't add up. */
	readonly sumProblem: string | null;
	/** Why values here are read-only and a change would be unsafe. */
	readonly locks: readonly string[];
	readonly notes: readonly string[];
	/** The reductions these values give. */
	readonly targets: string | null;
}

export function formatValue(field: CompositionField, value: number): string {
	const fixed = value.toFixed(field.decimals);
	return Number(fixed) === value ? fixed : String(value);
}

const withUnit = (field: CompositionField, value: number | null) => (value === null ? 'none' : `${formatValue(field, value)} ${field.unit === '%' ? '%' : 'years'}`);

function rowHint(field: CompositionField, target: number | null, child: boolean): string | null {
	if (!child || target === null) return null;
	if (field.field.endsWith('.ageYears') && target < 10) return 'Under 10 years the SFR iteration may not close (TT 691 p.211), and a run warns.';
	return field.field === 'alienVegetation.optimalPercent' ? 'Every reference child sits at 50 %, so Pitman’s reading of this value away from 50 % is untested (R6-V1).' : null;
}

function rowFor(field: CompositionField, module: RunoffModule, sidecar: NetworkBundle['sidecar'], child: boolean, cell: CompositionCell | undefined): CompositionRow {
	const current = field.read(module);
	const { file, edits } = compositionHistory(sidecar, module.number, field, current);
	const latest = edits.at(-1);
	const applied = latest && latest.kind !== 'networkFile' ? `Applied ${latest.date.slice(0, 10)}: ${latest.note}` : null;
	const locked = compositionLock(module, field, child) !== null;
	const shown = current === null ? '' : formatValue(field, current);
	const base = { field, current, file, note: cell?.note ?? '', hint: null, error: null, applied, locked };
	if (cell === undefined || locked) return { ...base, note: '', text: shown, state: 'same', target: current, changed: false, backToFile: false, needsNote: false };

	const n = parseNumber(cell.text);
	const moved = n !== null && n !== current;
	const error = n === null ? (cell.text.trim() === '' ? `Enter a value for ${field.label.toLowerCase()}, or reset it.` : `${field.label} must be a number.`) : moved ? compositionValueProblem(field, n) : null;
	const target = n !== null && error === null ? n : current;
	const changed = target !== current;
	const backToFile = changed && target === file;
	return { ...base, text: cell.text, error, hint: changed ? rowHint(field, target, child) : null, state: changed || error !== null ? 'edited' : 'same', target, changed, backToFile, needsNote: changed && !backToFile };
}

function shareSum(table: CompositionTable, rows: readonly CompositionRow[]): CompositionView['sum'] & { readonly value: number | null } {
	const values = rows.map((r) => parseNumber(r.text));
	if (values.some((v) => v === null)) return { value: null, text: 'Sum: fix the boxes above', ok: false };
	const value = values.reduce<number>((a, b) => a + (b ?? 0), 0);
	if (compositionSumProblem(table, value) === null) return { value, text: 'Sum: 100.00 %', ok: true };
	const gap = 100 - value;
	return { value, text: `Sum: ${value.toFixed(2)} %, ${Math.abs(gap).toFixed(2)} ${gap > 0 ? 'short of' : 'over'} 100`, ok: Math.abs(gap) < COMPOSITION_SHARE_TOLERANCE };
}

const afforestationNote: Readonly<Record<RunoffModule['afforestation']['algorithm'], string>> = {
	0: 'Van der Zel’s curves aren’t published, so a run here takes no reduction from these values (R6-F3).',
	1: 'CSIR’s tables aren’t published. A child runs here on Smoothed Gush targets from the genus shares (R6-F2); a free module takes no reduction here (R6-F3).',
	2: 'Smoothed Gush reads the genus shares only: rotations and optimal growth stay in the file and change nothing in a run (TT 689 p.127).',
	3: 'LUT Gush was never implemented in WRSM2000, so a run takes no reduction from these values (TT 689 p.136).',
	4: 'User-defined reads only the two required reductions: the split, rotations and optimal growth stay in the file and change nothing in a run (TT 689 p.137).'
};

function blockNotes(table: CompositionTable, module: RunoffModule, role: ModuleRole): string[] {
	const notes: string[] = [];
	if (role.kind === 'child') {
		notes.push(`A run works out this child’s targets from these values and calibrates it to them every time, so nothing stored goes stale. A fit of RU ${role.parent.number} to a gauge was made with the old targets: check it after the next run.`);
	}
	if (table === 'afforestation') notes.push(afforestationNote[module.afforestation.algorithm]);
	else if (role.kind === 'child') notes.push('The riparian share is taken off after the calibration, so it doesn’t move the targets (R6-V8).');
	notes.push(`The algorithm (${table === 'afforestation' ? 'L.006' : 'L.011'}) isn’t edited here: it decides how a run treats this area${role.kind === 'child' ? ' and how the child is calibrated' : ''}, so change it in WRSM2000.`);
	return notes;
}

interface Reductions {
	readonly mar: number;
	readonly low: number;
	readonly label: string;
}

function reductions(table: CompositionTable, module: RunoffModule, role: ModuleRole): Reductions | null {
	if (table === 'afforestation') {
		if (role.kind !== 'child') return null;
		const { targets, label } = forestChildTargets({ ...module, mapMm: role.parent.mapMm });
		const method = module.afforestation.algorithm === 1 ? 'Smoothed Gush, standing in for CSIR' : label;
		return targets && { mar: targets.marPercent, low: targets.lowFlowPercent, label: `${method}, at RU ${role.parent.number}’s MAP of ${role.parent.mapMm} mm` };
	}
	const alien = module.alienVegetation;
	if (!alien || alien.algorithm === 0) return null;
	if (role.kind === 'child' && sfrKind(module) === 'forest') return null; // a run ignores the alien block of a child with afforestation (R6-F11)
	const { tprm, tprl } = alienReductionTargets(alien);
	return { mar: tprm, low: tprl, label: 'CSIR alien vegetation' };
}

function targetsLine(table: CompositionTable, before: RunoffModule, after: RunoffModule, role: ModuleRole, blocked: boolean): string | null {
	const was = reductions(table, before, role);
	if (was === null) return null;
	const lead = role.kind === 'child' ? 'Targets a run calibrates this child to' : 'Reductions a run takes';
	if (blocked) return `${lead}: put the shares right to see them.`;
	const now = reductions(table, after, role) ?? was;
	const part = (name: string, a: number, b: number) => `${name} ${a.toFixed(1)} %${a.toFixed(1) === b.toFixed(1) ? '' : ` → ${b.toFixed(1)} %`}`;
	return `${lead}: ${part('MAR', was.mar, now.mar)}, ${part('low flow', was.low, now.low)} (${now.label}).`;
}

/**
 * One block as it would be. `module` is the working copy with the table drafts in
 * it, so a first year's zeros can be set in the same Apply. `null` when the file
 * has nowhere to hold the block.
 */
function reviewBlock(bundle: NetworkBundle, module: RunoffModule, table: CompositionTable, draft: CompositionDraft, fileName: string): { view: CompositionView; next: RunoffModule } | null {
	if (compositionProblem(module, table) !== null) return null;
	const role = moduleRole(bundle, module);
	const child = isSfrChild(bundle, module.number);
	const rows = COMPOSITION_FIELDS[table].map((f) => rowFor(f, module, bundle.sidecar, child, draft[f.field]));
	const shares = rows.filter((r) => r.field.group === 'share');
	const others = rows.filter((r) => r.field.group === 'other');
	const sum = shareSum(table, shares);
	const judged = shares.some((r) => r.changed) && !shares.some((r) => r.error !== null) && !shares.every((r) => r.target === r.file);
	const sumProblem = judged && sum.value !== null ? compositionSumProblem(table, sum.value) : null;
	const next = rows.reduce((m, r) => (r.changed && r.target !== null ? r.field.write(m, r.target) : m), module);
	// The required reductions are simply not in use: the rows say so, and a warning on every module would be noise.
	const reasons = [...new Set(rows.flatMap((r) => (r.locked ? [compositionLock(module, r.field, child)!] : [])))];
	const locks = reasons.filter((text) => !text.startsWith('Read-only: only the User-defined'));
	const piece = pieceOrigin(bundle.sidecar, module.number);
	const lines = COMPOSITION_LINES[table];
	return {
		next,
		view: {
			table,
			title: BLOCK_TITLE[table],
			origin: piece ? `Copied from RU ${piece.original}’s ${lines} to each piece in the ${piece.quaternary} sub-division` : `From ${fileName}, ${lines}`,
			shares,
			others,
			sum: { text: sum.text, ok: sum.ok },
			sumProblem,
			locks,
			notes: [...blockNotes(table, module, role), ...reasons.filter((text) => !locks.includes(text))],
			targets: targetsLine(table, module, next, role, sumProblem !== null || shares.some((r) => r.error !== null))
		}
	};
}

/** One pending change, as the list above Apply says it. */
export interface CompositionChange {
	readonly field: CompositionField;
	readonly from: number | null;
	readonly to: number | null;
	readonly note: string;
	readonly backToFile: boolean;
}

export interface CompositionReview {
	readonly views: readonly CompositionView[];
	readonly next: RunoffModule;
	readonly changes: readonly CompositionChange[];
	/** Each refused value, named. */
	readonly refused: readonly string[];
	readonly errors: readonly string[];
}

export function reviewComposition(bundle: NetworkBundle, module: RunoffModule, draft: CompositionDraft, fileName: string): CompositionReview {
	const views: CompositionView[] = [];
	let next = module;
	for (const table of COMPOSITION_ORDER) {
		const block = reviewBlock(bundle, next, table, draft, fileName);
		if (block === null) continue;
		views.push(block.view);
		next = block.next;
	}
	const rows = views.flatMap((v) => [...v.shares, ...v.others]);
	return {
		views,
		next,
		changes: rows.filter((r) => r.changed).map((r) => ({ field: r.field, from: r.current, to: r.target, note: r.note.trim(), backToFile: r.backToFile })),
		refused: rows.flatMap((r) => (r.error === null ? [] : [`${TABLE_TITLE[r.field.table]}, ${r.field.label.toLowerCase()}: ${r.error}`])),
		errors: views.flatMap((v) => v.sumProblem ?? [])
	};
}

export function compositionChangeLine({ field, from, to }: CompositionChange): string {
	return `${TABLE_TITLE[field.table]}, ${field.label.toLowerCase()}: ${withUnit(field, from)} → ${withUnit(field, to)}`;
}

/** Back to the network file's value, whatever the working copy holds. */
export function resetValue(draft: CompositionDraft, row: CompositionRow): CompositionDraft {
	const { [row.field.field]: _dropped, ...rest } = draft;
	if (row.file === row.current || row.file === null) return rest;
	return { ...rest, [row.field.field]: { text: formatValue(row.field, row.file), note: '' } };
}

/** `note` on every changed value that has none yet. */
export function fillCompositionNotes(draft: CompositionDraft, changes: readonly CompositionChange[], note: string): CompositionDraft {
	const next: Record<string, CompositionCell> = { ...draft };
	for (const change of changes) {
		const cell = next[change.field.field];
		if (cell && !change.backToFile && change.note === '') next[change.field.field] = { ...cell, note };
	}
	return next;
}

/** The changes as `applyCompositionEdits` takes them. `date` is stamped by the caller: the engine doesn't read the clock. */
export function toCompositionEdits(module: RunoffModule, changes: readonly CompositionChange[], date: string): CompositionEdit[] {
	return changes.flatMap((c) => {
		if (c.to === null) return [];
		const source: ValueSource = c.backToFile ? { kind: 'networkFile', note: 'Back to the network file’s value', date } : { kind: 'manual', note: c.note, date };
		return [{ module: { type: 'RU', number: module.number }, field: c.field.field, value: c.to, source }];
	});
}
