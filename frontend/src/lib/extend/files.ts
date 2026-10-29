/**
 * The `.RAN` files of a loaded network, as the extension screen lists them:
 * each file's years, which modules use it, and whether Pitman has extended
 * it before (the sidecar's `rainfallExtensions`, rule 8).
 */

import { lookupFile, type HydroYear, type NetworkBundle, type RainfallExtension, type RainfallSeries } from '@pitman/wrsm';

export interface RainfallUser {
	/** `RU`, `RV`, `RR` or `CR` (a channel reach's wetland). */
	readonly type: string;
	readonly number: number;
	/** The module's name (L.001), when it isn't blank. */
	readonly name?: string;
}

export interface RainfallFileEntry {
	/** Key in `bundle.rainfall` (upper-cased name). */
	readonly key: string;
	/** The name as the first module using it spells it (else the key). */
	readonly name: string;
	readonly code: string;
	readonly firstYear: HydroYear;
	readonly lastYear: HydroYear;
	readonly users: readonly RainfallUser[];
	/** The sidecar's entry when Pitman extended this file before. */
	readonly extension?: RainfallExtension;
	/** Last year of the original record (before any Pitman extension). */
	readonly originalEndYear: HydroYear;
}

const ORDER: Readonly<Record<string, number>> = { RU: 0, RR: 1, RV: 2, CR: 3 };

/** Every `.RAN` in the bundle, in key order, with the modules that read it. */
export function rainfallFiles(bundle: NetworkBundle): RainfallFileEntry[] {
	const users = new Map<string, { users: RainfallUser[]; name?: string }>();
	const keyOf = (fileName: string): string | undefined => {
		const series = lookupFile(bundle.rainfall, fileName);
		return series === undefined ? undefined : Object.keys(bundle.rainfall).find((k) => bundle.rainfall[k] === series);
	};
	const add = (fileName: string | null, user: RainfallUser) => {
		if (!fileName) return;
		const key = keyOf(fileName);
		if (key === undefined) return;
		const entry = users.get(key) ?? { users: [] };
		entry.users.push(user);
		entry.name ??= fileName.trim();
		users.set(key, entry);
	};
	for (const m of bundle.modules) {
		if (m.kind === 'unparsed') continue;
		const user: RainfallUser = { type: m.kind, number: m.number, ...(m.name.trim() && { name: m.name.trim() }) };
		if (m.kind === 'RU' || m.kind === 'RR' || m.kind === 'RV') add(m.rainfallFile, user);
		else if (m.kind === 'CR' && m.wetlandType !== 0) add(m.wetlandRainfallFile, user);
	}
	return Object.keys(bundle.rainfall)
		.sort()
		.map((key) => {
			const series = bundle.rainfall[key] as RainfallSeries;
			const used = users.get(key);
			const extension = bundle.sidecar?.rainfallExtensions?.[key];
			const firstYear = series.rows[0]?.year ?? NaN;
			const lastYear = series.rows[series.rows.length - 1]?.year ?? NaN;
			return {
				key,
				name: used?.name ?? key,
				code: series.code,
				firstYear,
				lastYear,
				users: [...(used?.users ?? [])].sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || a.number - b.number),
				...(extension !== undefined && { extension }),
				originalEndYear: extension?.originalEndYear ?? lastYear
			};
		});
}

/** `RU 3 (Upper), RR 7`: the users as one line. */
export function usersLabel(users: readonly RainfallUser[]): string {
	if (users.length === 0) return 'no module';
	return users.map((u) => `${u.type} ${u.number}${u.name ? ` (${u.name})` : ''}`).join(', ');
}
