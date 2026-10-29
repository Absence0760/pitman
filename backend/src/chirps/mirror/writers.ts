// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/mirror/arrays.ts (ensureGroups,
// growOuter, ensureFinals, writeFinalsYear) and backend/src/mirror/manifest.ts (writeManifest,
// manifestHash) at f888e4461, for the finals layout only.
//
// Writers for the **synthetic** local copy only (../synthetic.ts, `backend/scripts/gen-synthetic-data.ts`).
// Nothing on the API's request path imports this module: Pitman never writes to IC-WBT's copy.
import { createHash } from 'node:crypto';
import type { AbsolutePath, AsyncMutable } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { CODECS, FINALS_CHUNK, FINALS_DIMS, FINALS_FIRST_YEAR, type Block, checkBlock, type ChcFinalsProduct, type FinalsArray, openFinals } from './arrays.js';
import { gridOf, isLeapYear, MIRROR_REGION, MIRROR_STEP, type Region, regionSize } from './grid.js';
import { type Manifest, parseManifest } from './manifest.js';
import { registerNodeGzip } from './store.js';

const enc = new TextEncoder();
const path = (p: string) => `/${p}` as AbsolutePath;

/** Make sure the group metadata of the root and of each parent of `product` exists (Zarr v3 has no implicit groups). */
async function ensureGroups(store: AsyncMutable, product: string): Promise<void> {
	const parts = product.split('/').slice(0, -1);
	for (let i = 0; i <= parts.length; i++) {
		const dir = parts.slice(0, i).join('/');
		const key = dir ? `${dir}/zarr.json` : 'zarr.json';
		if ((await store.get(path(key))) === undefined) await zarr.create(dir ? zarr.root(store).resolve(dir) : zarr.root(store), { attributes: {} });
	}
}

/** Grow an array's outer axis to `length` by rewriting its zarr.json shape (safe: the outer axis is chunked by 1). */
async function growOuter(store: AsyncMutable, product: string, length: number): Promise<void> {
	const bytes = await store.get(path(`${product}/zarr.json`));
	const meta = JSON.parse(new TextDecoder().decode(bytes)) as { shape: number[] };
	if (meta.shape[0]! >= length) return;
	meta.shape = [length, ...meta.shape.slice(1)];
	await store.set(path(`${product}/zarr.json`), enc.encode(JSON.stringify(meta, null, 2)));
}

/** The finals array of `product` holding years up to `lastYear`: created with the D2 metadata when missing, its year axis grown when shorter. */
export async function ensureFinals(
	store: AsyncMutable,
	product: ChcFinalsProduct,
	lastYear: number,
	opts: { firstYear?: number; region?: Region } = {}
): Promise<FinalsArray> {
	registerNodeGzip();
	const existing = await openFinals(store, product);
	if (existing) {
		await growOuter(store, product, lastYear - existing.firstYear + 1);
		return (await openFinals(store, product))!;
	}
	const firstYear = opts.firstYear ?? FINALS_FIRST_YEAR;
	const region = opts.region ?? MIRROR_REGION;
	const { rows, cols } = regionSize(region, MIRROR_STEP);
	await ensureGroups(store, product);
	await zarr.create(zarr.root(store).resolve(product), {
		shape: [lastYear - firstYear + 1, 366, rows, cols],
		chunkShape: [...FINALS_CHUNK],
		dtype: 'float32',
		fillValue: Number.NaN,
		codecs: CODECS,
		dimensionNames: FINALS_DIMS,
		attributes: { firstYear, region: { ...region }, grid: gridOf(region, MIRROR_STEP) }
	});
	return (await openFinals(store, product))!;
}

/** Write one year of a block of cells into a finals array: `values` in (doy, y, x) C order, 366 days (index 365 must be NaN in a non-leap year). */
export async function writeFinalsYear(f: FinalsArray, year: number, block: Block, values: Float32Array): Promise<void> {
	const yi = year - f.firstYear;
	if (yi < 0 || yi >= f.arr.shape[0]!) throw new RangeError(`year ${year} is outside the array (grow it first)`);
	checkBlock(block, f.arr.shape[2]!, f.arr.shape[3]!);
	if (values.length !== 366 * block.h * block.w) throw new RangeError('one value per day of year per cell');
	if (!isLeapYear(year) && !values.subarray(365 * block.h * block.w).every(Number.isNaN)) {
		throw new RangeError(`${year} has no 29 February, so its day-of-year index 365 must stay NaN`);
	}
	await zarr.set(f.arr as unknown as zarr.Array<'float32', AsyncMutable>, [yi, null, zarr.slice(block.y0, block.y0 + block.h), zarr.slice(block.x0, block.x0 + block.w)], {
		data: values,
		shape: [366, block.h, block.w],
		stride: [block.h * block.w, block.w, 1]
	});
}

/** Validate and write `m` as its product's manifest (2-space JSON, trailing newline). */
export async function writeManifest(store: AsyncMutable, m: Manifest): Promise<void> {
	const ok = parseManifest(m);
	await store.set(path(`${ok.product}/manifest.json`), enc.encode(`${JSON.stringify(ok, null, 2)}\n`));
}

/**
 * A manifest file's `valuesSha256` over the float32 values given, little-endian, every NaN canonicalised
 * to 0x7FC00000. IC-WBT hashes the whole region's days; the synthetic copy hashes the block it writes
 * (the region is 340 000 cells a day, almost all unwritten), which is enough for a manifest that only
 * has to be well formed.
 */
export function manifestHash(days: Iterable<Float32Array>): string {
	const h = createHash('sha256');
	for (const day of days) {
		const out = new Uint32Array(day.length);
		out.set(new Uint32Array(day.buffer, day.byteOffset, day.length));
		for (let i = 0; i < out.length; i++) {
			const u = out[i]!;
			if ((u & 0x7f800000) === 0x7f800000 && (u & 0x007fffff) !== 0) out[i] = 0x7fc00000;
		}
		h.update(new Uint8Array(out.buffer));
	}
	return h.digest('hex');
}
