// A synthetic crop census for local development (CLAUDE.md Local-first), computed on request, so `pnpm dev` needs no
// generated file. **Invented values only:** fields over the same invented block as the other local data (21–22° E,
// 34.5–33.5° S, north of its invented coast at 34.25° S), each from a hash of its grid cell, so the same area always
// answers the same. Nothing here is a real field, farm or crop census.
import type { AreaGeometry } from '@pitman/wrsm';
import type { LayerField } from './adapter.js';

export const SYNTHETIC_LAND_USE = {
	dataset: 'Synthetic crop census, invented for local development (not Cape Farm Mapper data)',
	surveyYear: 2023,
	west: 21,
	east: 22,
	south: -34.25,
	north: -33.5,
	/** One field at most per cell of this size, about 700 m. */
	cellDeg: 0.0075
} as const;

/** The layer's three ways of speaking of irrigation, each crop with its usual one: yes, no and nothing said. */
const CROPS: readonly { crop: string; irrigated: boolean | null; weight: number }[] = [
	{ crop: 'Wine grapes', irrigated: true, weight: 5 },
	{ crop: 'Apples', irrigated: true, weight: 3 },
	{ crop: 'Pears', irrigated: true, weight: 2 },
	{ crop: 'Citrus', irrigated: null, weight: 2 },
	{ crop: 'Lucerne', irrigated: null, weight: 3 },
	{ crop: 'Vegetables', irrigated: null, weight: 1 },
	{ crop: 'Planted pasture', irrigated: null, weight: 2 },
	{ crop: 'Wheat', irrigated: false, weight: 5 },
	{ crop: 'Canola', irrigated: false, weight: 2 }
];
const TOTAL_WEIGHT = CROPS.reduce((sum, c) => sum + c.weight, 0);
/** The share of cells with a field. */
const FIELD_CHANCE = 0.3;

/** Four numbers in [0, 1) from a cell: a small integer hash, so there is no state to seed. */
export function cellNoise(x: number, y: number, salt: number): readonly [number, number, number, number] {
	let h = Math.imul(x + 1, 73_856_093) ^ Math.imul(y + 1, 19_349_663) ^ Math.imul(salt + 1, 83_492_791);
	const next = () => {
		h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
		h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
		h ^= h >>> 15;
		return (h >>> 0) / 2 ** 32;
	};
	return [next(), next(), next(), next()];
}

function fieldAt(x: number, y: number): LayerField | null {
	const g = SYNTHETIC_LAND_USE;
	const [chance, pick, width, height] = cellNoise(x, y, 1);
	if (chance >= FIELD_CHANCE) return null;
	let left = pick * TOTAL_WEIGHT;
	const crop = CROPS.find((c) => (left -= c.weight) < 0) ?? CROPS[0]!;
	const west = g.west + x * g.cellDeg;
	const south = g.south + y * g.cellDeg;
	const [e, n] = [west + g.cellDeg * (0.35 + 0.55 * width), south + g.cellDeg * (0.35 + 0.55 * height)];
	const r = (v: number) => Math.round(v * 1e6) / 1e6;
	// Every so often the layer says otherwise of a crop, so a crop can hold irrigated and dryland fields.
	const irrigated = crop.irrigated === true && chance < FIELD_CHANCE / 6 ? false : crop.irrigated;
	const geometry: AreaGeometry = { type: 'Polygon', coordinates: [[[r(west), r(south)], [r(e), r(south)], [r(e), r(n)], [r(west), r(n)], [r(west), r(south)]]] };
	return { id: `syn-field-${x}-${y}`, crop: crop.crop, irrigated, geometry };
}

/** The invented fields whose cells meet the box `[west, south, east, north]`; off the block, none. */
export function syntheticFields(box: readonly [number, number, number, number]): LayerField[] {
	const g = SYNTHETIC_LAND_USE;
	const cols = Math.round((g.east - g.west) / g.cellDeg);
	const rows = Math.round((g.north - g.south) / g.cellDeg);
	const [x0, x1] = [Math.max(0, Math.floor((box[0] - g.west) / g.cellDeg)), Math.min(cols - 1, Math.floor((box[2] - g.west) / g.cellDeg))];
	const [y0, y1] = [Math.max(0, Math.floor((box[1] - g.south) / g.cellDeg)), Math.min(rows - 1, Math.floor((box[3] - g.south) / g.cellDeg))];
	const out: LayerField[] = [];
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const field = fieldAt(x, y);
			if (field) out.push(field);
		}
	}
	return out;
}
