// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/mirror/arrays.ts at f888e4461,
// stripped (docs/data.md § Code to copy): the finals layout's reader only (openFinals, checkLayout,
// readFinalsBlock and the constants), for the CHIRPS products. Dropped: the daily layout, the 0.1°
// products and their attribution, and every writer (the synthetic copy's writers are in ./writers.ts,
// which nothing on the API's path imports).
//
// The mirror's finals array, read with zarrita. Zarr v3, float32, fill NaN (sea or no data; CHC's -9999
// becomes NaN), codecs bytes (little-endian) then gzip 6, default chunk keys with "/". A chunk never
// written is all fill: zarr-python skips writing all-NaN chunks, so a reader treats a missing chunk as
// NaN (zarrita does).
//
//   finals (`rnl`, `sat`): (year, doy[366], lat, lon), chunk (1, 366, 20, 20). year index = year −
//     attrs.firstYear; doy index = days since 1 January, so index 365 stays NaN in a year with no
//     29 February.
//
// The array carries attrs.region {w,s,e,n} and attrs.grid {origin {lat, lon}, step}; an array on another
// grid is refused.
import type { AbsolutePath } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { FeedFormatError } from '../errors.js';
import { gridOf, MIRROR_STEP, type MirrorGrid, type Region, regionSize } from './grid.js';
import { type MirrorStore, registerNodeGzip } from './store.js';

export const FINALS_CHUNK = [1, 366, 20, 20] as const;
export const FINALS_DIMS = ['year', 'doy', 'lat', 'lon'];
export const CODECS = [
	{ name: 'bytes', configuration: { endian: 'little' } },
	{ name: 'gzip', configuration: { level: 6 } }
];
/** The CHIRPS finals' first year: rnl's, 1981 (sat's year axis starts there too, its years before 1998 unwritten). */
export const FINALS_FIRST_YEAR = 1981;

/** The products the finals layout holds on CHC's grid, as the store's paths name them. Pitman reads `rnl` only (extend.md A6). */
export type ChcFinalsProduct = 'rnl' | 'sat';

/** The mirror's array is missing or isn't laid out as D2 says. */
export class MirrorFormatError extends FeedFormatError {}

export type MirrorArray = zarr.Array<'float32', MirrorStore>;

export interface FinalsArray {
	kind: 'finals';
	arr: MirrorArray;
	firstYear: number;
	region: Region;
	grid: MirrorGrid;
}

const dec = new TextDecoder();
const path = (p: string) => `/${p}` as AbsolutePath;

async function readJson(store: MirrorStore, key: string): Promise<unknown> {
	const bytes = await store.get(path(key));
	if (bytes === undefined) return undefined;
	try {
		return JSON.parse(dec.decode(bytes));
	} catch {
		throw new MirrorFormatError(`the rain data copy's ${key} is not valid JSON`);
	}
}

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Check an opened array against D2: dtype, chunks, dims, codecs, region and grid. */
function checkLayout(arr: MirrorArray, product: string, meta: Record<string, unknown>): { region: Region; grid: MirrorGrid } {
	const bad = (what: string) => new MirrorFormatError(`the rain data copy's ${product} array is not laid out as expected (${what})`);
	if (arr.dtype !== 'float32') throw bad(`data type ${arr.dtype}`);
	if (!same(arr.chunks, FINALS_CHUNK)) throw bad(`chunks ${arr.chunks.join('×')}`);
	if (!same(arr.dimensionNames ?? [], FINALS_DIMS)) throw bad('dimension names');
	if (JSON.stringify(meta.codecs) !== JSON.stringify(CODECS)) throw bad('codecs');
	const fill = arr.fillValue;
	if (typeof fill !== 'number' || !Number.isNaN(fill)) throw bad('fill value');
	const a = arr.attrs as { region?: Region; grid?: MirrorGrid; attribution?: unknown };
	if ('attribution' in a) throw bad('attribution');
	const r = a.region;
	if (!r || ![r.w, r.s, r.e, r.n].every(Number.isFinite) || r.w >= r.e || r.s >= r.n) throw bad('region');
	const g = gridOf(r, MIRROR_STEP);
	if (!a.grid || a.grid.step !== g.step || a.grid.origin?.lat !== g.origin.lat || a.grid.origin?.lon !== g.origin.lon) throw bad('grid');
	const { rows, cols } = regionSize(r, MIRROR_STEP);
	const shape = arr.shape;
	if (shape.at(-2) !== rows || shape.at(-1) !== cols) throw bad(`shape ${shape.join('×')}`);
	if (shape[1] !== 366) throw bad('day-of-year axis');
	return { region: { w: r.w, s: r.s, e: r.e, n: r.n }, grid: g };
}

/** Open `product`'s finals array, or null when the copy doesn't hold it yet. */
export async function openFinals(store: MirrorStore, product: ChcFinalsProduct): Promise<FinalsArray | null> {
	registerNodeGzip();
	const meta = (await readJson(store, `${product}/zarr.json`)) as Record<string, unknown> | undefined;
	if (meta === undefined) return null;
	const arr = (await zarr.open.v3(zarr.root(store).resolve(product), { kind: 'array' })) as MirrorArray;
	const { region, grid } = checkLayout(arr, product, meta);
	const firstYear = (arr.attrs as { firstYear?: unknown }).firstYear;
	if (!Number.isInteger(firstYear)) throw new MirrorFormatError(`the rain data copy's ${product} array has no firstYear`);
	return { kind: 'finals', arr, firstYear: firstYear as number, region, grid };
}

/** A block of cells: rows y0… (northwards) and columns x0… (eastwards), h × w. */
export interface Block {
	y0: number;
	x0: number;
	h: number;
	w: number;
}

export const checkBlock = (b: Block, rows: number, cols: number) => {
	if (b.h < 1 || b.w < 1 || b.y0 < 0 || b.x0 < 0 || b.y0 + b.h > rows || b.x0 + b.w > cols) throw new RangeError('the block is outside the region');
};

/** A block read back: values in (day, y, x) C order, NaN for no data or an unwritten chunk. */
export interface BlockRead {
	days: number;
	block: Block;
	values: Float32Array;
}

/** Days [doy0, doy1] (inclusive) of `year` for a block of a finals array; all NaN for a year outside the array. */
export async function readFinalsBlock(f: FinalsArray, year: number, doy0: number, doy1: number, block: Block): Promise<BlockRead> {
	const days = doy1 - doy0 + 1;
	if (doy0 < 0 || doy1 > 365 || days < 1) throw new RangeError('day-of-year indices 0–365');
	checkBlock(block, f.arr.shape[2]!, f.arr.shape[3]!);
	const yi = year - f.firstYear;
	if (yi < 0 || yi >= f.arr.shape[0]!) return { days, block, values: new Float32Array(days * block.h * block.w).fill(Number.NaN) };
	const got = await zarr.get(f.arr, [yi, zarr.slice(doy0, doy1 + 1), zarr.slice(block.y0, block.y0 + block.h), zarr.slice(block.x0, block.x0 + block.w)]);
	return { days, block, values: contiguous(got, [days, block.h, block.w]) };
}

/** zarrita's chunk as a C-ordered Float32Array (it may hand back other strides). */
function contiguous(chunk: zarr.Chunk<'float32'>, shape: [number, number, number]): Float32Array {
	const [a, b, c] = shape;
	const [s0, s1, s2] = chunk.stride as [number, number, number];
	const data = chunk.data as Float32Array;
	if (s0 === b * c && s1 === c && s2 === 1 && data.length === a * b * c) return data;
	const out = new Float32Array(a * b * c);
	for (let i = 0; i < a; i++) for (let j = 0; j < b; j++) for (let k = 0; k < c; k++) out[(i * b + j) * c + k] = data[i * s0 + j * s1 + k * s2]!;
	return out;
}
