// A deterministic synthetic CHIRPS copy for local development (CLAUDE.md Local-first): the same Zarr v3
// finals layout and manifest as IC-WBT's real copy (docs/data.md § CHIRPS), 1981-01-01 to `through`, so
// the extension screen has a full record to fit against with no AWS account. **Invented values only:**
// a seeded weather generator over one 20 × 20 chunk (21–22° E, 34.5–33.5° S, around IC-WBT's synthetic
// "region Z" quaternaries), never a real place's rain. The rest of the D1 region is unwritten (NaN), and
// the chunk's five southern rows are an invented coast (NaN throughout), so a coastal area exercises the
// sea-cell rule.
//
// The same (seed, through) always writes the same values: each day's value is a hash of (seed, cell,
// day), never Math.random.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import FileSystemStore from '@zarrita/storage/fs';
import type { Block } from './mirror/arrays.js';
import { daysInMonth, fromEpochDay, isIsoDate, toEpochDay } from './mirror/calendar.js';
import { dateOfDoy, MIRROR_REGION } from './mirror/grid.js';
import type { Manifest } from './mirror/manifest.js';
import { registerNodeGzip } from './mirror/store.js';
import { ensureFinals, manifestHash, writeFinalsYear, writeManifest } from './mirror/writers.js';

/** The chunk written: mirror rows 20–39, columns 220–239 (21–22° E, 34.5–33.5° S). */
export const SYNTHETIC_BLOCK: Block = { y0: 20, x0: 220, h: 20, w: 20 };
/** Rows of the block that are invented sea (NaN every day): its five southernmost (south of 34.25° S). */
export const SYNTHETIC_SEA_ROWS = 5;
export const SYNTHETIC_FIRST_YEAR = 1981;
export const DEFAULT_SEED = 20_261_029;

/** Wet-day probability and mean wet-day rain (mm) by calendar month: an invented winter-rainfall climate. */
const WET = [0.12, 0.12, 0.18, 0.28, 0.38, 0.45, 0.45, 0.42, 0.32, 0.24, 0.16, 0.12];
const MEAN_MM = [2.5, 2.5, 3, 4, 5, 6, 6, 5.5, 4, 3.5, 3, 2.5];

/** A 32-bit integer hash of several integers, as a number in [0, 1). */
function unit(...xs: number[]): number {
	let h = 0x9e3779b9;
	for (const x of xs) {
		h = Math.imul(h ^ (x | 0), 0x85ebca6b);
		h ^= h >>> 13;
		h = Math.imul(h, 0xc2b2ae35);
		h ^= h >>> 16;
	}
	return (h >>> 0) / 4_294_967_296;
}

/** One cell-day of invented rain, mm (float32-representable to 0.1 mm). */
export function syntheticRain(seed: number, y: number, x: number, epochDay: number, month: number, year: number): number {
	// Wetter to the north-west of the block, a year factor shared by every cell, and day-to-day weather.
	const place = 0.7 + 0.03 * (y - SYNTHETIC_BLOCK.y0) + 0.015 * (SYNTHETIC_BLOCK.x0 + SYNTHETIC_BLOCK.w - 1 - x);
	const yearFactor = 0.6 + 0.8 * unit(seed, year, 1);
	// Most of a wet day is shared across the block (one weather system), with a little local variation.
	const storm = unit(seed, epochDay, 2);
	if (storm > WET[month - 1]! * Math.min(1.3, yearFactor)) return 0;
	const depth = -Math.log(1 - unit(seed, epochDay, 3)) * MEAN_MM[month - 1]! * place * (0.85 + 0.3 * unit(seed, y, x, epochDay));
	return Math.round(depth * 10) / 10;
}

/** The last day of the month before `today` (UTC): the newest complete month a fresh copy holds. */
export function lastCompleteMonthEnd(today = new Date()): string {
	return fromEpochDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) / 86_400_000 - 1);
}

export interface SyntheticChirpsOptions {
	/** The copy's root directory (its `rnl/` and `zarr.json` are replaced). */
	dir: string;
	/** The last final day, the last day of a month (`YYYY-MM-DD`). */
	through: string;
	seed?: number;
}

const byMonthUrl = (y: number, m: number) =>
	`https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/rnl/netcdf/byMonth/chirps-v3.0.${y}.${String(m).padStart(2, '0')}.days_p05.nc`;

/** Write the synthetic copy. Returns its manifest. */
export async function writeSyntheticChirps(opts: SyntheticChirpsOptions): Promise<Manifest> {
	const { dir, through } = opts;
	const seed = opts.seed ?? DEFAULT_SEED;
	if (!isIsoDate(through)) throw new RangeError(`through must be an ISO date, not ${through}`);
	const ty = Number(through.slice(0, 4));
	const tm = Number(through.slice(5, 7));
	if (Number(through.slice(8, 10)) !== daysInMonth(ty, tm)) throw new RangeError(`through must be the last day of a month (the copy holds whole months), not ${through}`);
	if (ty < SYNTHETIC_FIRST_YEAR) throw new RangeError(`through must be in ${SYNTHETIC_FIRST_YEAR} or later`);
	rmSync(join(dir, 'rnl'), { recursive: true, force: true });
	rmSync(join(dir, 'zarr.json'), { force: true });
	mkdirSync(dir, { recursive: true });
	registerNodeGzip();
	const store = new FileSystemStore(dir);
	const arr = await ensureFinals(store, 'rnl', ty, { firstYear: SYNTHETIC_FIRST_YEAR, region: MIRROR_REGION });
	const b = SYNTHETIC_BLOCK;
	const n = b.h * b.w;
	const throughDay = toEpochDay(through);
	const files: Manifest['files'] = [];
	for (let year = SYNTHETIC_FIRST_YEAR; year <= ty; year++) {
		const values = new Float32Array(366 * n).fill(Number.NaN);
		const monthDays = new Map<number, Float32Array[]>();
		for (let doy = 0; doy < 366; doy++) {
			const date = dateOfDoy(year, doy);
			if (date === null) continue;
			const day = toEpochDay(date);
			if (day > throughDay) break;
			const month = Number(date.slice(5, 7));
			for (let j = 0; j < b.h; j++) {
				if (j < SYNTHETIC_SEA_ROWS) continue;
				for (let i = 0; i < b.w; i++) values[doy * n + j * b.w + i] = syntheticRain(seed, b.y0 + j, b.x0 + i, day, month, year);
			}
			const list = monthDays.get(month) ?? monthDays.set(month, []).get(month)!;
			list.push(values.subarray(doy * n, (doy + 1) * n));
		}
		await writeFinalsYear(arr, year, b, values);
		for (const [month, days] of [...monthDays].sort((p, q) => p[0] - q[0])) {
			files.push({ url: byMonthUrl(year, month), etag: null, lastModified: null, size: null, valuesSha256: manifestHash(days), revision: 1, fetchedAt: `${through}T00:00:00Z` });
		}
	}
	const manifest: Manifest = {
		product: 'rnl',
		revision: 1,
		region: { ...MIRROR_REGION },
		grid: arr.grid,
		years: { first: SYNTHETIC_FIRST_YEAR, last: ty },
		finalThrough: through,
		prelimThrough: null,
		files,
		changes: []
	};
	await writeManifest(store, manifest);
	return manifest;
}
