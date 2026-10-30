// A synthetic DEM for local development (CLAUDE.md Local-first), over the same invented block as the
// synthetic CHIRPS copy and MAP grid (21–22° E, 34.5–33.5° S). **Invented terrain only**, drawn from a
// formula, no real place's elevations; IC-WBT's valleyFixture.ts (an elevation function behind the `Dem`
// interface) is what it started from. Read like the real DEM: Terrarium PNG tiles in a PMTiles archive,
// zoom 11, 512 px, about 32 m a cell, so the windows, memory and timings are the real ones.
//
// The terrain is laid out on the synthetic quaternaries (backend/fixtures/geo/quaternaries.synthetic.geojson),
// so each thing the tool must do has a place to click (the SYNTHETIC_CLICKS below):
//   - each 0.25° column is a valley draining south, its ridges on the column's edges;
//   - low sills across the valley at the row boundaries (33.75° S, 34° S), cut by the river, so a quaternary
//     is nearly a basin of its own and the river of Z01A enters Z02A from upstream;
//   - a named tributary in Z01A, and noise on the slopes so the rest of the network branches.
// Deterministic: no randomness, only a hash of the lattice.
import type { Position } from '../geo/geojson.js';
import { TARGET_ZOOM, toLonLat, toPx, worldPx } from './delineate.js';
import type { Dem, DemInfo } from './dem.js';
import { writePmtiles } from './pmtiles.js';
import { encodePng } from './png.js';

export const SYNTHETIC_DEM = {
	bounds: [21, -34.5, 22, -33.5] as [number, number, number, number],
	zoom: TARGET_ZOOM,
	tile: 512,
	name: 'Synthetic DEM (invented terrain, local development)',
	version: '1',
	attribution: 'Synthetic test data'
} as const;

/** Heights are stored to 1/8 m: the block's tiles stay a few MB (Terrarium could hold 1/256 m). */
const STEP_M = 1 / 8;
const COLUMN_DEG = 0.25;
const WEST = 20.75;
/** The northern divide: the valleys' heads, and the terrain is mirrored north of it. */
const DIVIDE_LAT = -33.5;
const SILLS = [-33.75, -34];
const SILL_M = 70;
const SILL_DEG = 0.012;

const smooth = (a: number, b: number, v: number) => {
	const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** A value in [0, 1) from a lattice point: integer hashing only, so every platform draws the same terrain. */
function lattice(i: number, j: number, seed: number): number {
	let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 1274126177);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

function valueNoise(x: number, y: number, seed: number): number {
	const i = Math.floor(x);
	const j = Math.floor(y);
	const fx = smooth(0, 1, x - i);
	const fy = smooth(0, 1, y - j);
	const a = lattice(i, j, seed);
	const b = lattice(i + 1, j, seed);
	const c = lattice(i, j + 1, seed);
	const d = lattice(i + 1, j + 1, seed);
	return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy - 0.5;
}

/** Noise of about 60 m, from 13 km hills to 800 m gullies. */
function roughness(lon: number, lat: number): number {
	let z = 0;
	let amplitude = 60;
	let cells = 8;
	for (let octave = 0; octave < 5; octave++) {
		z += amplitude * valueNoise(lon * cells, lat * cells, octave + 1);
		amplitude /= 2;
		cells *= 2;
	}
	return z;
}

/** The tributary carved into Z01A's western slope, head to confluence. */
const TRIBUTARY: readonly Position[] = [
	[21.03, -33.56],
	[21.07, -33.61],
	[21.115, -33.66]
];
const TRIBUTARY_DEG = 0.02;
const TRIBUTARY_M = 55;

function tributaryCut(lon: number, lat: number): number {
	if (lon < 20.97 || lon > 21.17 || lat > -33.5 || lat < -33.72) return 0;
	let best = Infinity;
	let along = 0;
	for (let k = 0; k + 1 < TRIBUTARY.length; k++) {
		const [ax, ay] = TRIBUTARY[k]!;
		const [bx, by] = TRIBUTARY[k + 1]!;
		const vx = bx - ax;
		const vy = by - ay;
		const t = Math.min(1, Math.max(0, ((lon - ax) * vx + (lat - ay) * vy) / (vx * vx + vy * vy)));
		const d = Math.hypot(ax + t * vx - lon, ay + t * vy - lat);
		if (d < best) {
			best = d;
			along = (k + t) / (TRIBUTARY.length - 1);
		}
	}
	return TRIBUTARY_M * Math.sin(Math.PI * Math.min(1, along * 0.98 + 0.02)) ** 0.5 * Math.exp(-((best / TRIBUTARY_DEG) ** 2));
}

/** The invented elevation (m) at a point. Falls from about 900 m at the heads to 20 m on the southern edge. */
export function syntheticElevation(lon: number, lat0: number): number {
	const lat = lat0 > DIVIDE_LAT ? 2 * DIVIDE_LAT - lat0 : lat0;
	const column = Math.floor((lon - WEST) / COLUMN_DEG);
	const left = WEST + column * COLUMN_DEG;
	const right = left + COLUMN_DEG;
	const river = left + COLUMN_DEG / 2 + 0.02 * Math.sin((lat + column) * 11);
	const u = lon < river ? (river - lon) / (river - left) : (lon - river) / (right - river);
	const t = (lat + 34.6) / 1.1;
	const floor = 20 + 500 * t + 250 * t * t;
	let z = floor + 340 * u ** 1.1;
	let bell = 0;
	for (const sill of SILLS) bell = Math.max(bell, Math.exp(-(((lat - sill) / SILL_DEG) ** 2)));
	z += SILL_M * bell * smooth(0.03, 0.2, u);
	z += roughness(lon, lat) * smooth(0.02, 0.14, u) * (1 - smooth(0.82, 1, u)) * (1 - 0.8 * bell);
	return z - tributaryCut(lon, lat);
}

/** The tiles (zoom 11) that hold the block. */
export function syntheticTileRange() {
	const { bounds, zoom } = SYNTHETIC_DEM;
	const [w, s, e, n] = bounds;
	const [x0, y0] = toPx(w, n, 2 ** zoom);
	const [x1, y1] = toPx(e, s, 2 ** zoom);
	return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.floor(x1), y1: Math.floor(y1) };
}

/** One tile's elevations, rounded as stored. */
export function syntheticTile(x: number, y: number): Float32Array {
	const { tile, zoom } = SYNTHETIC_DEM;
	const W = worldPx(zoom, tile);
	const out = new Float32Array(tile * tile);
	for (let py = 0; py < tile; py++) {
		const lat = toLonLat(0, y * tile + py + 0.5, W)[1];
		for (let px = 0; px < tile; px++) {
			const lon = ((x * tile + px + 0.5) / W) * 360 - 180;
			out[py * tile + px] = Math.round(syntheticElevation(lon, lat) / STEP_M) * STEP_M;
		}
	}
	return out;
}

/**
 * The same terrain read straight from the function (no archive): what the tests delineate against, so
 * `pnpm test` needs no generated file. Tiles outside the block's range are absent, as in the archive.
 */
export function syntheticDem(): Dem {
	const { x0, y0, x1, y1 } = syntheticTileRange();
	const cache = new Map<string, Float32Array>();
	const info: DemInfo = {
		label: `${SYNTHETIC_DEM.name} ${SYNTHETIC_DEM.version}`,
		attribution: SYNTHETIC_DEM.attribution,
		fingerprint: 'synthetic0000000',
		tileType: 'png',
		maxZoom: SYNTHETIC_DEM.zoom,
		bounds: SYNTHETIC_DEM.bounds
	};
	return {
		info: async () => info,
		tile: async (z, x, y) => {
			if (z !== SYNTHETIC_DEM.zoom || x < x0 || x > x1 || y < y0 || y > y1) return null;
			const key = `${x}/${y}`;
			let t = cache.get(key);
			if (!t) cache.set(key, (t = syntheticTile(x, y)));
			return { size: SYNTHETIC_DEM.tile, z: t };
		}
	};
}

/** Terrarium: v + 32768 = R·256 + G + B/256. */
function terrariumPixel(v: number): number {
	const t = Math.round((v + 32768) * 256);
	return (0xff000000 | (((t >> 16) & 255) << 16) | (((t >> 8) & 255) << 8) | (t & 255)) >>> 0;
}

/** The archive `pnpm dev:data:synthetic` writes. `range` narrows it, for tests. */
export function syntheticDemArchive(range = syntheticTileRange()): Buffer {
	const { tile, zoom, bounds, name, version, attribution } = SYNTHETIC_DEM;
	const tiles = [];
	for (let y = range.y0; y <= range.y1; y++) {
		for (let x = range.x0; x <= range.x1; x++) {
			const z = syntheticTile(x, y);
			const argb = new Uint32Array(tile * tile);
			for (let i = 0; i < argb.length; i++) argb[i] = terrariumPixel(z[i]!);
			tiles.push({ z: zoom, x, y, data: encodePng({ width: tile, height: tile, argb }) });
		}
	}
	return writePmtiles(tiles, { tileType: 2, bounds, metadata: { name, version, attribution } });
}
