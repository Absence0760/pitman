// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/mirror/manifest.ts at f888e4461,
// stripped (docs/data.md § Code to copy): readManifest, parseManifest and finalsCoverage (the
// contiguous-months rule) for the CHIRPS finals products only. IC-WBT validates with zod, which Pitman's
// backend doesn't depend on, so parseManifest is rewritten by hand with the same rules for `rnl` / `sat`
// (unknown keys are ignored rather than refused: Pitman reads someone else's bucket). Dropped: the
// era5l / imerg / ET₀ coverage rules, writeManifest and manifestHash (the synthetic copy's writer has
// its own, ./writers.ts).
//
// A mirror product's manifest, `<product>/manifest.json` beside its array (IC-WBT issue #604):
//
//   { product, revision, region {w,s,e,n}, grid {origin {lat,lon}, step},
//     years {first,last} (both null while nothing is held), finalThrough, prelimThrough,
//     files [{ url, etag, lastModified, size, valuesSha256, revision, fetchedAt }],
//     changes [{ revision, days [from,to], cellsChanged, maxAbsDiff }] }
//
// `revision` counts from 1 and moves only on a real change of values. Each file is one of CHC's byMonth
// files, its URL naming its month, and `finalThrough` may not run past the contiguous run of months from
// the first one copied (finalsCoverage): a month missing in between is not held, and reading its days as
// final would read NaN as final no-data. A manifest that claims more is refused here.
import type { AbsolutePath } from '@zarrita/storage';
import { FeedFormatError } from '../errors.js';
import { isIsoDate } from './calendar.js';
import { gridOf, MIRROR_STEP, type MirrorGrid, type Region } from './grid.js';
import type { MirrorStore } from './store.js';

export type FinalsManifestProduct = 'rnl' | 'sat';

export interface ManifestFile {
	url: string;
	etag: string | null;
	lastModified: string | null;
	size: number | null;
	valuesSha256: string;
	revision: number;
	fetchedAt: string;
}

export interface Manifest {
	product: FinalsManifestProduct;
	revision: number;
	region: Region;
	grid: MirrorGrid;
	years: { first: number | null; last: number | null };
	finalThrough: string | null;
	prelimThrough: string | null;
	files: ManifestFile[];
	changes: { revision: number; days: [string, string]; cellsChanged: number; maxAbsDiff: number }[];
}

/** The manifest is missing a field, has one wrong, or isn't JSON. */
export class MirrorManifestError extends FeedFormatError {}

/** A CHC byMonth file's URL ends `.YYYY.MM.days_p05.nc`. */
export const FILE_MONTH = /\.(\d{4})\.(0[1-9]|1[0-2])\.days_p05\.nc$/;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * The days a finals product's files hold: the first day of the earliest month through the last day of
 * the contiguous run of months from it (null when no file names a month). A later month after a gap
 * doesn't extend it.
 */
export function finalsCoverage(files: readonly { url: string }[]): { from: string; through: string } | null {
	const months = new Set<number>();
	for (const f of files) {
		const m = FILE_MONTH.exec(f.url);
		if (m) months.add(Number(m[1]) * 12 + Number(m[2]) - 1);
	}
	if (months.size === 0) return null;
	const first = Math.min(...months);
	let last = first;
	while (months.has(last + 1)) last++;
	const [ly, lm] = [Math.floor(last / 12), (last % 12) + 1];
	const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
	return { from: `${Math.floor(first / 12)}-${pad2((first % 12) + 1)}-01`, through: `${ly}-${pad2(lm)}-${pad2(lastDay)}` };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = -Infinity, max = Infinity): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNullable = <T>(v: unknown, ok: (x: unknown) => x is T): v is T | null => v === null || ok(v);
const isStr = (max: number) => (v: unknown): v is string => typeof v === 'string' && v.length <= max;
const isDay = (v: unknown): v is string => typeof v === 'string' && isIsoDate(v);
const isInstant = (v: unknown): v is string =>
	typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && !Number.isNaN(Date.parse(v));

/** Check a manifest, with a message naming the first problem. */
export function parseManifest(raw: unknown, product?: FinalsManifestProduct): Manifest {
	const fail = (what: string): never => {
		throw new MirrorManifestError(`the rain data copy's manifest${product ? ` for ${product}` : ''} is invalid: ${what}`);
	};
	if (!isObj(raw)) return fail('(root) is not an object');
	const m = raw;
	if (m.product !== 'rnl' && m.product !== 'sat') return fail('product is not a CHIRPS finals product (rnl or sat)');
	if (!isInt(m.revision, 1)) fail('revision is not a whole number from 1');
	const r = m.region;
	if (!isObj(r) || ![r.w, r.s, r.e, r.n].every(isNum)) return fail('region is not {w, s, e, n}');
	const region = { w: r.w as number, s: r.s as number, e: r.e as number, n: r.n as number };
	if (!(region.w < region.e && region.s < region.n && region.w >= -180 && region.e <= 180 && region.s >= -90 && region.n <= 90)) fail('region needs w < e and s < n');
	const g = m.grid;
	if (!isObj(g) || !isObj(g.origin) || !isNum(g.origin.lat) || !isNum(g.origin.lon) || !isNum(g.step)) return fail('grid is not {origin {lat, lon}, step}');
	if (g.step !== MIRROR_STEP) fail(`grid.step must be ${MIRROR_STEP}° for ${String(m.product)}`);
	const want = gridOf(region);
	if (g.origin.lat !== want.origin.lat || g.origin.lon !== want.origin.lon) fail('grid origin is not the centre of the region’s south-west cell');
	const y = m.years;
	if (!isObj(y) || !isNullable(y.first, (v): v is number => isInt(v, 1900, 2200)) || !isNullable(y.last, (v): v is number => isInt(v, 1900, 2200))) {
		return fail('years is not {first, last}');
	}
	if ((y.first === null) !== (y.last === null) || (y.first !== null && (y.first as number) > (y.last as number))) fail('years both null, or first ≤ last');
	if (!isNullable(m.finalThrough, isDay)) fail('finalThrough is not an ISO date (YYYY-MM-DD) or null');
	if (!isNullable(m.prelimThrough, isDay)) fail('prelimThrough is not an ISO date (YYYY-MM-DD) or null');
	if (m.product === 'rnl' && m.prelimThrough !== null) fail('rnl has no preliminary days');
	for (const k of ['finalThrough', 'prelimThrough'] as const) {
		const d = m[k] as string | null;
		if (d !== null && (y.first === null || Number(d.slice(0, 4)) < (y.first as number) || Number(d.slice(0, 4)) > (y.last as number))) fail(`${k} is outside years`);
	}
	if (!Array.isArray(m.files)) return fail('files is not a list');
	const files: ManifestFile[] = m.files.map((f, i) => {
		if (
			!isObj(f) ||
			!isStr(2048)(f.url) ||
			!f.url ||
			!isNullable(f.etag, isStr(256)) ||
			!isNullable(f.lastModified, isStr(64)) ||
			!isNullable(f.size, (v): v is number => isInt(v, 0)) ||
			typeof f.valuesSha256 !== 'string' ||
			!/^[0-9a-f]{64}$/.test(f.valuesSha256) ||
			!isInt(f.revision, 1) ||
			!isInstant(f.fetchedAt)
		) {
			return fail(`files.${i} is not {url, etag, lastModified, size, valuesSha256, revision, fetchedAt}`);
		}
		if (f.revision > (m.revision as number)) fail('a file from a later revision than the manifest’s');
		if (!FILE_MONTH.test(f.url)) fail('a finals file whose url names no month (….YYYY.MM.days_p05.nc)');
		return { url: f.url, etag: f.etag, lastModified: f.lastModified, size: f.size, valuesSha256: f.valuesSha256, revision: f.revision, fetchedAt: f.fetchedAt };
	});
	if (new Set(files.map((f) => f.url)).size !== files.length) fail('a file is listed twice');
	if (!Array.isArray(m.changes)) return fail('changes is not a list');
	const changes = m.changes.map((c, i) => {
		if (!isObj(c) || !isInt(c.revision, 1) || !Array.isArray(c.days) || c.days.length !== 2 || !c.days.every(isDay) || !isInt(c.cellsChanged, 0) || !isNum(c.maxAbsDiff) || c.maxAbsDiff < 0) {
			return fail(`changes.${i} is not {revision, days [from, to], cellsChanged, maxAbsDiff}`);
		}
		const [from, to] = c.days as [string, string];
		if (from > to) fail('days from ≤ to');
		if (c.revision > (m.revision as number)) fail('a change from a later revision than the manifest’s');
		return { revision: c.revision, days: [from, to] as [string, string], cellsChanged: c.cellsChanged, maxAbsDiff: c.maxAbsDiff };
	});
	if (changes.some((c, i) => i > 0 && c.revision < changes[i - 1]!.revision)) fail('changes in revision order');
	const held = finalsCoverage(files);
	if (m.finalThrough !== null && (held === null || (m.finalThrough as string) > held.through)) {
		fail(`finalThrough runs past the months the files hold contiguously (through ${held?.through ?? 'none'})`);
	}
	if (product !== undefined && m.product !== product) throw new MirrorManifestError(`the rain data copy's manifest at ${product} names product ${m.product}`);
	return {
		product: m.product,
		revision: m.revision as number,
		region,
		grid: { origin: { lat: g.origin.lat, lon: g.origin.lon }, step: g.step },
		years: { first: y.first as number | null, last: y.last as number | null },
		finalThrough: m.finalThrough as string | null,
		prelimThrough: m.prelimThrough as string | null,
		files,
		changes
	};
}

const key = (product: string) => `/${product}/manifest.json` as AbsolutePath;

/** `product`'s manifest, or null when the copy doesn't hold it yet. */
export async function readManifest(store: MirrorStore, product: FinalsManifestProduct): Promise<Manifest | null> {
	const bytes = await store.get(key(product));
	if (bytes === undefined) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new MirrorManifestError(`the rain data copy's manifest for ${product} is not valid JSON`);
	}
	return parseManifest(raw, product);
}
