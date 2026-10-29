/**
 * Applying an extension to the working copy (extend.md §§ Steps 7–8): the
 * engine's extended series replaces the `.RAN` in the bundle, and its
 * sidecar entry goes into `pitman.json` under the file's key. The page then
 * stores the bundle in IndexedDB and offers to rerun; nothing is written
 * anywhere else.
 */

import type { ExtensionResult, HydroYear, NetworkBundle, Sidecar } from '@pitman/wrsm';
import { rainfallFiles } from './files.js';

/** Most years a network may simulate (TT 691 §12.6, L.012). */
export const MAX_RUN_YEARS = 150;

/** The bundle with `key`'s series replaced and the extension recorded in the sidecar, stamped `createdAt` (the engine reads no clock). */
export function withExtension<B extends NetworkBundle>(bundle: B, key: string, result: ExtensionResult, now: Date = new Date()): B {
	const base: Sidecar = bundle.sidecar ?? { schema: 'pitman-sidecar', schemaVersion: 1 };
	const extension = { ...result.extension, createdAt: now.toISOString() };
	const sidecar: Sidecar = { ...base, rainfallExtensions: { ...(base.rainfallExtensions ?? {}), [key]: extension } };
	return { ...bundle, rainfall: { ...bundle.rainfall, [key]: result.series }, sidecar };
}

export interface RunPeriodOffer {
	readonly currentEndYear: HydroYear;
	/** The last year every rainfall file a module reads now reaches. */
	readonly reachableEndYear: HydroYear;
	/** The files that stop it going further (the shortest ones). */
	readonly limitedBy: readonly string[];
	/** True when `reachableEndYear` is past the network's last year and within the 150-year limit. */
	readonly canExtend: boolean;
	/** Why it can't, in words ('' when it can). */
	readonly reason: string;
}

/**
 * Whether the network's run period (L.012) can now reach further. A rerun
 * only uses the appended years once the `.NET`'s last year moves; every
 * rainfall file in use must reach the new last year.
 */
export function runPeriodOffer(bundle: NetworkBundle): RunPeriodOffer {
	const used = rainfallFiles(bundle).filter((f) => f.users.length > 0);
	const { startYear, endYear } = bundle.network;
	if (used.length === 0) return { currentEndYear: endYear, reachableEndYear: endYear, limitedBy: [], canExtend: false, reason: 'No module reads a rainfall file.' };
	const reachable = Math.min(...used.map((f) => f.lastYear));
	const limitedBy = used.filter((f) => f.lastYear === reachable).map((f) => f.name);
	const cap = startYear + MAX_RUN_YEARS - 1;
	const end = Math.min(reachable, cap);
	let reason = '';
	if (reachable <= endYear) reason = `The run already ends at or after the last year every rainfall file reaches (limited by ${limitedBy.join(', ')}).`;
	else if (end <= endYear) reason = `The run is already ${MAX_RUN_YEARS} years long, WRSM2000’s limit.`;
	return { currentEndYear: endYear, reachableEndYear: end, limitedBy, canExtend: reason === '', reason };
}

/** The bundle with the network's last simulated year set to `endYear`. */
export function withEndYear<B extends NetworkBundle>(bundle: B, endYear: HydroYear): B {
	return { ...bundle, network: { ...bundle.network, endYear } };
}

/** A date as `YYYY-MM-DD` in the user's own time zone (the sidecar's `accessed`: the day they fetched it). */
export function isoDate(now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
