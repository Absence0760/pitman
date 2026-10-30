/**
 * What a split does to `sidecar.values` (issue #3 rule 8; docs/theory/subdivide.md
 * § Provenance, R7-C14). Every note on a module that was split follows the
 * value: to each module that now holds it, saying how it got there, or, when
 * the split replaced the value, retired with the reason. The original entry's
 * `source` is never changed, so a note reads as it did when it was written.
 */

import { moduleType } from '../network/modules.js';
import type { HydroYear, Module, ModuleRef, Network, ValueEntry, ValueSplit } from '../types.js';

/** A module's place in the split, which decides what each of its fields became. An SFR child's Sami and Hughes blocks are copied, unlike its parent's. */
export type SplitModuleKind = 'runoff' | 'child' | 'reservoir' | 'irrigation';

/** A module the split divided, and the modules it became (itself among them when it survives). */
export interface SplitLineage {
	readonly kind: SplitModuleKind;
	readonly from: ModuleRef;
	readonly pieces: readonly ModuleRef[];
}

export interface ValueCarry {
	readonly quaternary: string;
	readonly before: readonly Module[];
	readonly after: { readonly network: Network; readonly modules: readonly Module[] };
	readonly lineage: readonly SplitLineage[];
	/** Modules not split whose MAP the calibration rescaled: the quaternary's other pieces and their children (R5-E7). */
	readonly rescaled: readonly ModuleRef[];
}

/** Extensive fields, each piece holding a share (subdivide.md § Fields, § Routes, § SFR parent and children). A name covers the paths below it. */
const DIVIDED: Readonly<Record<SplitModuleKind, readonly string[]>> = {
	runoff: ['areaKm2', 'afforestation.areaKm2', 'alienVegetation.areaKm2', 'sami.abstractions', 'sami.gwEvaporationArea', 'hughes.upperAbstraction.annual', 'hughes.riparianAbstraction.annual'],
	child: ['areaKm2', 'afforestation.areaKm2', 'alienVegetation.areaKm2'],
	reservoir: ['capacity', 'initialStorageMm3'],
	irrigation: ['areaKm2', 'maxAllocationMm3PerYear', 'allocation.values']
};

/** Fields whose value is the split's own: the MAP comes from the grid and the factor, and the wiring is rebuilt. */
const REPLACED: Readonly<Record<SplitModuleKind, readonly string[]>> = {
	runoff: ['mapMm', 'name', 'outflows', 'inflowRoute', 'sfrChildren'],
	child: ['mapMm', 'name', 'outflows'],
	reservoir: ['name', 'spillRoute', 'inflows', 'outflows'],
	irrigation: ['name', 'abstractionRoute', 'returnFlowRoute', 'runoffModule']
};

const SCALED = 'sami.maxHydraulicGradient';
const MAP_REPLACED = 'the sub-division set a new MAP';
const WIRING_REPLACED = 'the sub-division set a new value on each piece';
const MODULE_GONE = 'its module is no longer in the network';

const within = (fields: readonly string[], field: string) => fields.some((f) => field === f || field.startsWith(`${f}.`));
const refKey = (ref: ModuleRef) => `${ref.type}${ref.number}`;
const sameRef = (a: ModuleRef, b: ModuleRef) => a.type === b.type && a.number === b.number;
const findModule = (modules: readonly Module[], ref: ModuleRef) => modules.find((m) => moduleType(m) === ref.type && m.number === ref.number);

/** The number a field holds in a module, in `year` for a table; `null` when there is none, as for a year the table doesn't list. */
function heldValue(module: Module | undefined, field: string, year: HydroYear | undefined): number | null {
	const row = (rows: readonly { readonly year: HydroYear }[]) => rows.find((r) => r.year === year);
	let value: unknown = module;
	for (const part of field.split('.')) {
		if (Array.isArray(value)) value = row(value);
		value = (value as Record<string, unknown> | undefined)?.[part];
	}
	if (Array.isArray(value)) value = (row(value) as { value?: unknown } | undefined)?.value;
	return typeof value === 'number' ? value : null;
}

/** Retired entries lose `target.module`, so nothing reads them as a note on a value in use; `retired.from` says where they were. */
function retire(entry: ValueEntry, from: ModuleRef, quaternary: string, reason: string): ValueEntry {
	const { module: _gone, ...target } = entry.target;
	return { ...entry, target, retired: { quaternary, from, reason } };
}

function carryEntry(entry: ValueEntry, line: SplitLineage, carry: ValueCarry): ValueEntry[] {
	const { field, year } = entry.target;
	const { quaternary, before, after } = carry;
	if (within(REPLACED[line.kind], field)) return [retire(entry, line.from, quaternary, field === 'mapMm' ? MAP_REPLACED : WIRING_REPLACED)];
	const whole = heldValue(findModule(before, line.from), field, year);
	const part = (piece: ModuleRef) => heldValue(findModule(after.modules, piece), field, year);
	// A negative initial storage means 50 % of full supply, and is copied (R5-E4).
	const divided = within(DIVIDED[line.kind], field) && !(field === 'initialStorageMm3' && whole !== null && whole < 0);
	const scaled = line.kind === 'runoff' && field === SCALED;
	// A piece that got none of a value holds nothing to give a source for.
	const sharing = divided ? line.pieces.filter((p) => (part(p) ?? 0) !== 0) : line.pieces;
	const holders = sharing.length > 0 ? sharing : line.pieces;
	if (holders.length === 1 && sameRef(holders[0]!, line.from)) return [entry];
	const how: ValueSplit['how'] = holders.length === 1 ? 'moved' : divided ? 'divided' : scaled ? 'scaled' : 'copied';
	return holders.map((piece) => {
		const split: ValueSplit = { quaternary, from: line.from, how, pieces: holders, ...(how === 'divided' || how === 'scaled' ? { whole, part: part(piece) } : {}) };
		return { ...entry, target: { ...entry.target, module: piece }, splits: [...(entry.splits ?? []), split] };
	});
}

/** The `values` log after a split, in the same order, each entry where its value now is. No entry is lost. */
export function carryValues(values: readonly ValueEntry[], carry: ValueCarry): ValueEntry[] {
	const lines = new Map(carry.lineage.map((line) => [refKey(line.from), line]));
	const rescaled = new Set(carry.rescaled.map(refKey));
	const remaining = new Set(carry.after.network.modules.map((e) => `${e.type}${e.number}`));
	return values.flatMap((entry) => {
		const ref = entry.target.module;
		if (!ref) return [entry];
		const line = lines.get(refKey(ref));
		if (line) return carryEntry(entry, line, carry);
		if (rescaled.has(refKey(ref)) && entry.target.field === 'mapMm') return [retire(entry, ref, carry.quaternary, MAP_REPLACED)];
		// A sidecar written before splits carried `values` can hold a note on a module an earlier split took out.
		return remaining.has(refKey(ref)) ? [entry] : [retire(entry, ref, carry.quaternary, MODULE_GONE)];
	});
}

/**
 * The log with each recorded value once: a split leaves one copy per piece,
 * of one note. For counting what was done, never for reading a module's log.
 */
export function distinctValues(values: readonly ValueEntry[]): ValueEntry[] {
	const seen = new Set<string>();
	return values.filter((entry) => {
		const first = entry.splits?.[0];
		if (!first) return true;
		const key = JSON.stringify([refKey(first.from), entry.target.field, entry.target.year, entry.target.month, entry.source]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function listModules(refs: readonly ModuleRef[]): string {
	const names = refs.map((r) => `${r.type} ${r.number}`);
	return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/** One split's effect on a value, in the screen's words. */
export function describeValueSplit(split: ValueSplit): string {
	const pieces = listModules(split.pieces);
	const when = `when ${split.quaternary} was sub-divided`;
	const figures = split.part !== undefined && split.part !== null && split.whole !== undefined && split.whole !== null;
	switch (split.how) {
		case 'copied':
			return `copied to ${pieces} ${when}`;
		case 'moved':
			return `moved from ${split.from.type} ${split.from.number} to ${pieces} ${when}`;
		case 'divided':
			return `divided among ${pieces} ${when}${figures ? `: ${split.part} here of ${split.whole}` : ''}`;
		case 'scaled':
			return `scaled for ${pieces} ${when}${figures ? `: ${split.part} here from ${split.whole}` : ''}`;
	}
}
