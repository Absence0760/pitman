/**
 * The parameters the calibration screen edits: what each one means, its unit,
 * where it sits in the runoff file and how the file writes it. Meanings and
 * units are docs/theory/pitman.md § 1.2 and docs/theory/sami.md § 2; widths
 * and decimals are the writer's (docs/formats.md § 5.1, `writeRunoff`), so a
 * value the screen accepts is the value the saved file holds.
 *
 * The active set follows the groundwater model: a classic module runs the
 * L.003 set, a Sami module the L.035 set (TT 689 p.38 § 6.1.7.1). L.003 of a
 * Sami module is left alone.
 */

import type { PitmanParameters, RunoffModule, SamiParameters } from '@pitman/wrsm';

/** Which values a field accepts, before the checks between fields. */
export type FieldRule = 'any' | 'nonNegative' | 'positive' | 'fraction' | 'wholeFromOne';

export interface ParameterField {
	/** The property path in the engine's contract, also the sidecar's `ValueTarget.field`. */
	readonly path: string;
	/** The symbol the manuals use. */
	readonly symbol: string;
	/** What it is, in words. */
	readonly name: string;
	/** Its unit; `no unit` for a pure number. */
	readonly unit: string;
	/** The file's line and value, e.g. `L.035 v3`. */
	readonly line: string;
	/** Decimals the file keeps (`Fw.d`; 0 for an integer field). */
	readonly decimals: number;
	/** Characters the file has for it (`w`). */
	readonly width: number;
	readonly rule: FieldRule;
	/** Why this field needs care in this module (a Sami module ignores GW and GL). */
	readonly caution?: string;
}

export type PitmanKey = Exclude<keyof PitmanParameters, 'FF'>;
export type SamiKey = Exclude<keyof SamiParameters, 'pitman' | 'abstractions' | 'abstractionMode' | 'outflowAreaKm2'>;

export const NO_UNIT = 'no unit';

interface PitmanRow {
	readonly key: PitmanKey;
	readonly name: string;
	readonly samiName?: string;
	readonly unit: string;
	readonly decimals: number;
	readonly rule: FieldRule;
}

/** L.003 and L.035, in file order: `F6.1,I6,I6,F6.1,F6.1,I6,I6,F6.1,F6.2,F6.2,F6.1,F8.2` (FF, the last, isn't edited here). */
const PITMAN_ROWS: readonly PitmanRow[] = [
	{ key: 'POW', name: 'Power of the soil moisture–subsurface flow curve', samiName: 'Power of the soil moisture–interflow curve', unit: NO_UNIT, decimals: 1, rule: 'positive' },
	{ key: 'SL', name: 'Soil moisture below which there is no subsurface flow', samiName: 'Soil moisture below which there is no interflow', unit: 'mm', decimals: 0, rule: 'nonNegative' },
	{ key: 'ST', name: 'Soil moisture capacity', unit: 'mm', decimals: 0, rule: 'positive' },
	{ key: 'FT', name: 'Subsurface flow at full soil moisture (S = ST)', samiName: 'Interflow at full soil moisture (S = ST)', unit: 'mm/month', decimals: 1, rule: 'nonNegative' },
	{ key: 'GW', name: 'Maximum baseflow rate', unit: 'mm/month', decimals: 1, rule: 'nonNegative' },
	{ key: 'ZMIN', name: 'Minimum catchment absorption rate', unit: 'mm/month', decimals: 0, rule: 'nonNegative' },
	{ key: 'ZMAX', name: 'Maximum catchment absorption rate', unit: 'mm/month', decimals: 0, rule: 'nonNegative' },
	{ key: 'PI', name: 'Interception storage', unit: 'mm', decimals: 1, rule: 'nonNegative' },
	{ key: 'TL', name: 'Lag of surface runoff and subsurface flow above GW', samiName: 'Lag of the runoff', unit: 'months', decimals: 2, rule: 'nonNegative' },
	{ key: 'GL', name: 'Lag of baseflow', unit: 'months', decimals: 2, rule: 'nonNegative' },
	{ key: 'R', name: 'Evaporation–soil moisture coefficient', unit: NO_UNIT, decimals: 1, rule: 'fraction' }
];

const PITMAN_WIDTH = 6;

/** A Sami run forces GW and GL to zero (TT 691 p.123 § 11.2; docs/theory/sami.md § 1). */
const SAMI_IGNORES = 'A Sami run sets this to 0, so changing it has no effect (TT 691 p.123).';

interface SamiRow {
	readonly key: SamiKey;
	readonly symbol: string;
	readonly name: string;
	readonly unit: string;
	readonly line: string;
	readonly width: number;
	readonly decimals: number;
	readonly rule: FieldRule;
}

/** L.031–L.034 (`F6.2,F7.4,3F8.2`; `F7.2,6F8.2`; `F10.8,3F9.2`; `F7.2,2F8.2,I5`). L.031's last three are 7 wide in some files, so 7 is what every file can hold. */
const SAMI_ROWS: readonly SamiRow[] = [
	{ key: 'aquiferThicknessM', symbol: 'THICK', name: 'Aquifer thickness', unit: 'm', line: 'L.031 v1', width: 6, decimals: 2, rule: 'positive' },
	{ key: 'storativity', symbol: 'Sy', name: 'Storativity', unit: NO_UNIT, line: 'L.031 v2', width: 7, decimals: 4, rule: 'positive' },
	{ key: 'initialAquiferStorage', symbol: 'STORE₀', name: 'Initial aquifer storage', unit: 'mm', line: 'L.031 v3', width: 7, decimals: 2, rule: 'nonNegative' },
	{ key: 'staticWaterLevelMm', symbol: 'SWL', name: 'Storage at which baseflow, evaporation and outflow stop', unit: 'mm', line: 'L.031 v4', width: 7, decimals: 2, rule: 'nonNegative' },
	{ key: 'unsaturatedStorage', symbol: 'PMAX', name: 'Unsaturated (percolating) storage capacity', unit: 'mm', line: 'L.031 v5', width: 7, decimals: 2, rule: 'nonNegative' },
	{ key: 'initialUnsaturatedStorage', symbol: 'P₀', name: 'Initial unsaturated storage', unit: 'mm', line: 'L.032 v1', width: 7, decimals: 2, rule: 'nonNegative' },
	{ key: 'PPOW', symbol: 'PPOW', name: 'Percolation power', unit: NO_UNIT, line: 'L.032 v2', width: 8, decimals: 2, rule: 'nonNegative' },
	{ key: 'GPOW', symbol: 'GPOW', name: 'Recharge power', unit: NO_UNIT, line: 'L.032 v3', width: 8, decimals: 2, rule: 'nonNegative' },
	{ key: 'maxDischarge', symbol: 'BFMAX', name: 'Maximum groundwater discharge rate', unit: 'mm/month', line: 'L.032 v4', width: 8, decimals: 2, rule: 'nonNegative' },
	{ key: 'gwSwPower', symbol: 'BPOW', name: 'Groundwater–surface water interaction power', unit: '1/mm', line: 'L.032 v5', width: 8, decimals: 2, rule: 'any' },
	{ key: 'HGSL', symbol: 'HGSL', name: 'Soil moisture below which there is no recharge', unit: 'mm', line: 'L.032 v6', width: 8, decimals: 2, rule: 'nonNegative' },
	{ key: 'HGGW', symbol: 'HGGW', name: 'Recharge at full soil moisture (S = ST)', unit: 'mm/month', line: 'L.032 v7', width: 8, decimals: 2, rule: 'nonNegative' },
	{ key: 'maxHydraulicGradient', symbol: 'HGRAD', name: 'Maximum hydraulic gradient out of the catchment', unit: NO_UNIT, line: 'L.033 v1', width: 10, decimals: 8, rule: 'nonNegative' },
	{ key: 'transmissivity', symbol: 'T', name: 'Transmissivity', unit: 'm²/day', line: 'L.033 v2', width: 9, decimals: 2, rule: 'nonNegative' },
	{ key: 'boreholeDistanceToRiver', symbol: 'x', name: 'Weighted borehole distance to the river', unit: 'm', line: 'L.033 v3', width: 9, decimals: 2, rule: 'positive' },
	{ key: 'gwEvaporationArea', symbol: 'EVAREA', name: 'Groundwater evaporation (riparian) area', unit: 'km²', line: 'L.033 v4', width: 9, decimals: 2, rule: 'nonNegative' },
	{ key: 'K2', symbol: 'k2', name: 'Abstraction curve parameter', unit: NO_UNIT, line: 'L.034 v1', width: 7, decimals: 2, rule: 'any' },
	{ key: 'K3', symbol: 'k3', name: 'Abstraction curve parameter', unit: NO_UNIT, line: 'L.034 v2', width: 8, decimals: 2, rule: 'any' },
	{ key: 'interflowLag', symbol: 'LAG', name: 'Interflow lag', unit: 'months', line: 'L.034 v3', width: 8, decimals: 2, rule: 'nonNegative' },
	{ key: 'rechargeAveragingMonths', symbol: 'MMA', name: 'Months over which recharge is averaged', unit: 'months', line: 'L.034 v4', width: 5, decimals: 0, rule: 'wholeFromOne' }
];

/** How the module's run takes its parameters. */
export type GroundwaterKind = 'classic' | 'sami' | 'hughes';

export function groundwaterKind(module: RunoffModule): GroundwaterKind {
	const model = module.groundwaterModel ?? 0;
	return model === 0 ? 'classic' : model === 2 ? 'sami' : 'hughes';
}

export function groundwaterLabel(kind: GroundwaterKind): string {
	return kind === 'classic' ? 'Classic Pitman' : kind === 'sami' ? 'Sami' : 'Hughes (not modelled yet)';
}

/** The Pitman set the module runs on, for a classic or Sami module. */
function pitmanFields(kind: 'classic' | 'sami'): ParameterField[] {
	const prefix = kind === 'sami' ? 'sami.pitman' : 'pitman';
	const line = kind === 'sami' ? 'L.035' : 'L.003';
	return PITMAN_ROWS.map((row, i) => ({
		path: `${prefix}.${row.key}`,
		symbol: row.key,
		name: kind === 'sami' ? (row.samiName ?? row.name) : row.name,
		unit: row.unit,
		line: `${line} v${i + 1}`,
		decimals: row.decimals,
		width: PITMAN_WIDTH,
		rule: row.rule,
		...(kind === 'sami' && (row.key === 'GW' || row.key === 'GL') ? { caution: SAMI_IGNORES } : {})
	}));
}

function samiFields(): ParameterField[] {
	return SAMI_ROWS.map(({ key, ...row }) => ({ ...row, path: `sami.${key}` }));
}

/** The fields of a module, the Pitman set then (for a Sami module) the Sami set. Empty for Hughes, which can't run. */
export function parameterFields(module: RunoffModule): readonly ParameterField[] {
	const kind = groundwaterKind(module);
	if (kind === 'classic') return pitmanFields('classic');
	if (kind === 'sami' && module.sami) return [...pitmanFields('sami'), ...samiFields()];
	return [];
}

/** The value a field holds in a module; NaN for a path that isn't a number. */
export function fieldValue(module: RunoffModule, path: string): number {
	let value: unknown = module;
	for (const part of path.split('.')) value = (value as Record<string, unknown> | undefined)?.[part];
	return typeof value === 'number' ? value : NaN;
}

/** The module with `values` (path → number) written into it; `pitman.X`, `sami.pitman.X` and `sami.X` paths only. */
export function withValues(module: RunoffModule, values: Readonly<Record<string, number>>): RunoffModule {
	const pitman: Record<string, number> = {};
	const samiPitman: Record<string, number> = {};
	const sami: Record<string, number> = {};
	for (const [path, value] of Object.entries(values)) {
		const parts = path.split('.');
		const key = parts.at(-1) as string;
		(parts[0] === 'pitman' ? pitman : parts[1] === 'pitman' ? samiPitman : sami)[key] = value;
	}
	return {
		...module,
		pitman: { ...module.pitman, ...pitman },
		...(module.sami && { sami: { ...module.sami, ...sami, pitman: { ...module.sami.pitman, ...samiPitman } } })
	};
}

/** A value as the file writes it (POW 3 → `3.0`), or in full when it holds more decimals than the file's format. */
export function formatValue(field: Pick<ParameterField, 'decimals'>, value: number): string {
	if (!Number.isFinite(value)) return '—';
	const fixed = value.toFixed(field.decimals);
	return Number(fixed) === value ? fixed : String(value);
}
