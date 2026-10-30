/**
 * Edits becoming the working copy, and where a value came from (issue #3,
 * rule 8). Each apply adds one entry per changed field to the sidecar's
 * `values` list, oldest first: `{ target: { module, field }, source: { kind:
 * 'manual', note, date } }`. The note carries the change: `Calibration: 150 →
 * 180`, then the user's reason after `; `. The list is a log, so nothing is
 * overwritten: its first entry for a field holds what the network file had,
 * even after the working copy is restored or the saved zip is reloaded (both
 * read the edited file back as if it were the original).
 *
 * A structured `from` and `to` on `ValueSource` would beat parsing a note; the
 * note is what `Sidecar` holds today.
 */

import type { NetworkBundle, RunoffModule, Sidecar } from '@pitman/wrsm';
import { describeValueSplit, readRunoff, writeRunoff } from '@pitman/wrsm';
import { fieldValue, formatValue, withValues, type ParameterField } from './parameters.js';

export interface ParameterChange {
	readonly field: ParameterField;
	readonly from: number;
	readonly to: number;
}

/** The fields whose value differs from the module's, in field order. */
export function parameterChanges(module: RunoffModule, fields: readonly ParameterField[], values: Readonly<Record<string, number>>): ParameterChange[] {
	const changes: ParameterChange[] = [];
	for (const field of fields) {
		const from = fieldValue(module, field.path);
		const to = values[field.path];
		if (to !== undefined && to !== from) changes.push({ field, from, to });
	}
	return changes;
}

/** The module with the changes in it. */
export function withChanges(module: RunoffModule, changes: readonly ParameterChange[]): RunoffModule {
	return withValues(module, Object.fromEntries(changes.map((c) => [c.field.path, c.to])));
}

/** The bundle with one runoff module replaced. */
export function withModule<B extends NetworkBundle>(bundle: B, module: RunoffModule): B {
	return { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'RU' && m.number === module.number ? module : m)) };
}

const NOTE = /^Calibration: (\S+) → ([^\s;]+)(?:; ([\s\S]*))?$/;

/** The sidecar note of one change. */
export function changeNote(change: ParameterChange, reason = ''): string {
	const why = reason.trim();
	return `Calibration: ${formatValue(change.field, change.from)} → ${formatValue(change.field, change.to)}${why === '' ? '' : `; ${why}`}`;
}

export interface CalibrationEntry {
	readonly from: number;
	readonly to: number;
	readonly reason: string;
	readonly date: string;
	/** Set when a sub-division divided or scaled the value afterwards, in the screen's words: `from` and `to` are the whole module's, not this one's. */
	readonly reshaped?: string;
}

/** What the sidecar records for one field of one module, oldest first. Entries this screen didn't write are skipped. */
export function calibrationLog(sidecar: Sidecar | undefined, moduleNumber: number, path: string): CalibrationEntry[] {
	const entries: CalibrationEntry[] = [];
	for (const { target, source, splits } of sidecar?.values ?? []) {
		if (target.field !== path || target.module?.type !== 'RU' || target.module.number !== moduleNumber) continue;
		const match = NOTE.exec(source.note ?? '');
		if (match === null) continue;
		const reshaped = splits?.filter((s) => s.how === 'divided' || s.how === 'scaled').at(-1);
		entries.push({ from: Number(match[1]), to: Number(match[2]), reason: match[3] ?? '', date: source.date ?? '', ...(reshaped && { reshaped: describeValueSplit(reshaped) }) });
	}
	return entries;
}

/**
 * The value the network file had: what the first logged change started from,
 * else the value in use. A change made before a sub-division divided or scaled
 * the value started from the whole module's, which this module never held.
 */
export function fileValue(sidecar: Sidecar | undefined, module: RunoffModule, path: string): number {
	return calibrationLog(sidecar, module.number, path).find((e) => e.reshaped === undefined)?.from ?? fieldValue(module, path);
}

/**
 * The bundle with the changes applied to its working copy and recorded in the
 * sidecar. Nothing else moves: the caller stores it and clears old results.
 */
export function withCalibration<B extends NetworkBundle>(bundle: B, module: RunoffModule, changes: readonly ParameterChange[], options: { readonly reason?: string; readonly now?: Date } = {}): B {
	const base: Sidecar = bundle.sidecar ?? { schema: 'pitman-sidecar', schemaVersion: 1 };
	const date = (options.now ?? new Date()).toISOString();
	const added = changes.map((change) => ({
		target: { module: { type: 'RU' as const, number: module.number }, field: change.field.path },
		source: { kind: 'manual' as const, note: changeNote(change, options.reason), date }
	}));
	return { ...withModule(bundle, withChanges(module, changes)), sidecar: { ...base, values: [...(base.values ?? []), ...added] } };
}

export interface SaveCheck {
	/** Symbols of the fields the saved file would hold differently from the run. */
	readonly rounded: readonly string[];
	/** Why the module can't be written at all, in the writer's words. */
	readonly problem: string | null;
}

/**
 * What saving would do to the module. Editing one field rewrites the file, so
 * a value the loaded file held with more decimals than WRSM2000's format
 * keeps gets rounded; the screen says so rather than letting the run and the
 * saved file differ quietly.
 */
export function saveCheck(next: RunoffModule, fields: readonly ParameterField[]): SaveCheck {
	try {
		const saved = readRunoff(writeRunoff(next), 'runoff module');
		return { rounded: fields.filter((f) => fieldValue(saved, f.path) !== fieldValue(next, f.path)).map((f) => f.symbol), problem: null };
	} catch (error) {
		return { rounded: [], problem: (error as Error).message };
	}
}
