// Copied from IC-WBT backend/src/delineation/channels.ts at f888e4461 (MIT, same author).
// The DEM's own channels, drawn on the Map while Delineate or Sub-catchments
// is on (issue #374 item 3, docs/maps.md § The elevation model's channels).
// River lines sit off the channel the DEM routes along (a median 150–260 m,
// docs/design/delineation-snapping.md), so the editor clicks the line the
// DEM agrees with instead. Each tile is a fixed CHANNEL_TILE_DEG square,
// routed in a CHANNEL_WINDOW-cell window centred on it with the same fill,
// D8 and accumulation as Delineate (so a click on a drawn channel snaps onto
// it), and every cell with at least CHANNEL_MIN_KM2 draining through it is
// traced into lines: from each stream head or confluence down to the next
// confluence, each carrying the upstream area at its lower end. A tile keeps
// the steps that start inside it, so neighbouring tiles meet without
// overlapping. Pure but for the DEM reads; tiles are cached by the caller.
import type { Position } from '../geo/geojson.js';
import type { Dem, DemInfo } from './dem.js';
import { DelineationRefused, EARTH_RADIUS_M, readWindow, TARGET_ZOOM, toLonLat, toPx, worldPx } from './delineate.js';
import { accumulate, d8, DX, DY, edgeMask, fill, OUT } from './flow.js';
import { simplifyLine, type Pt } from './outline.js';

/** A tile's side (degrees): about 22 km, so a view of a few rivers is one to four tiles. */
export const CHANNEL_TILE_DEG = 0.2;
/**
 * The window each tile is routed in (cells): ~34 km at zoom 11, ~6 km of
 * margin around the tile, Delineate's first window. The routing is
 * synchronous: 2 048 cells held the API's event loop for seconds (other
 * requests timed out in e2e), and the margin only changes the areas the lines
 * carry, not where the channels run.
 */
export const CHANNEL_WINDOW = 1024;
/** The least upstream area a drawn channel has (km²): below it, cells are hillside, not channel. */
export const CHANNEL_MIN_KM2 = 1;

export interface ChannelLine {
	coordinates: Position[];
	/** Upstream area at its lower end (km², within the routed window: a lower bound for a river entering from beyond it). */
	km2: number;
}

export interface ChannelTile {
	/** The tile's index: floor(lon / CHANNEL_TILE_DEG), floor(lat / CHANNEL_TILE_DEG). */
	tile: [number, number];
	bounds: [number, number, number, number];
	minKm2: number;
	lines: ChannelLine[];
	cellSizeM: number;
	dataset: { label: string; fingerprint: string };
}

/** The tile's bounds, west, south, east, north. */
export const tileBounds = ([i, j]: [number, number]): [number, number, number, number] => {
	const r = (v: number) => Math.round(v * 1e9) / 1e9;
	return [r(i * CHANNEL_TILE_DEG), r(j * CHANNEL_TILE_DEG), r((i + 1) * CHANNEL_TILE_DEG), r((j + 1) * CHANNEL_TILE_DEG)];
};

/**
 * The channel lines of a routed grid, in grid coordinates (cell centres),
 * keeping only the steps whose upper cell `inside` accepts. `minCells`: the
 * least accumulation a channel cell has. Pure, so vitest checks it.
 */
export function traceChannels(
	nx: number,
	ny: number,
	dir: Uint8Array,
	acc: Int32Array,
	edge: Uint8Array,
	minCells: number,
	inside: (x: number, y: number) => boolean
): { cells: number[]; acc: number }[] {
	const n = nx * ny;
	const channel = (c: number) => c >= 0 && acc[c]! >= minCells && !edge[c];
	const down = (c: number) => {
		const d = dir[c]!;
		if (d === OUT) return -1;
		const x = (c % nx) + DX[d]!;
		const y = Math.floor(c / nx) + DY[d]!;
		return x < 0 || y < 0 || x >= nx || y >= ny ? -1 : y * nx + x;
	};
	const indeg = new Uint8Array(n);
	for (let c = 0; c < n; c++) {
		if (!channel(c)) continue;
		const k = down(c);
		if (k >= 0 && channel(k)) indeg[k]!++;
	}
	const out: { cells: number[]; acc: number }[] = [];
	for (let s = 0; s < n; s++) {
		if (!channel(s) || indeg[s] === 1) continue;
		// From a head (no channel above) or a confluence (two or more) down to the next confluence.
		let run: number[] = [];
		const flush = () => {
			if (run.length >= 2) out.push({ cells: run, acc: acc[run[run.length - 1]!]! });
			run = [];
		};
		let c = s;
		for (let guard = 0; guard < n; guard++) {
			const k = down(c);
			if (k < 0 || !channel(k)) break;
			const cx = c % nx;
			if (inside(cx, (c - cx) / nx)) {
				if (!run.length) run.push(c);
				run.push(k);
			} else flush();
			if (indeg[k]! !== 1) break;
			c = k;
		}
		flush();
	}
	return out;
}

/** Route the tile's window and trace its channels. Throws DelineationRefused outside the DEM or with no data. */
export async function channelTile(dem: Dem, tile: [number, number], opts: { window?: number; minKm2?: number } = {}): Promise<ChannelTile> {
	const info: DemInfo = await dem.info();
	const nCells = opts.window ?? CHANNEL_WINDOW;
	const minKm2 = opts.minKm2 ?? CHANNEL_MIN_KM2;
	const bounds = tileBounds(tile);
	const [w, s, e, n] = bounds;
	const [dw, ds, de, dn] = info.bounds;
	if (e < dw || w > de || n < ds || s > dn) throw new DelineationRefused('outside', `That part of the map is outside the elevation model (${info.label}).`);
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	const cLon = (w + e) / 2;
	const cLat = (s + n) / 2;
	const probe = toPx(Math.min(Math.max(cLon, dw), de), Math.min(Math.max(cLat, ds), dn), 2 ** z);
	const here = await dem.tile(z, Math.floor(probe[0]), Math.floor(probe[1]));
	if (!here) throw new DelineationRefused('no_data', 'The elevation model has no data there.');
	const W = worldPx(z, here.size);
	const [gx, gy] = toPx(cLon, cLat, W);
	const x0 = Math.floor(gx) - nCells / 2;
	const y0 = Math.floor(gy) - nCells / 2;
	const grid = await readWindow(dem, z, here.size, x0, y0, nCells);
	const edge = edgeMask(grid);
	fill(grid, edge);
	const dir = d8(grid, edge);
	const acc = accumulate(nCells, nCells, dir);
	const cellSizeM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((cLat * Math.PI) / 180)) / W;
	const cellKm2 = (cellSizeM * cellSizeM) / 1e6;
	const [bx0, by0] = toPx(w, n, W);
	const [bx1, by1] = toPx(e, s, W);
	const inside = (x: number, y: number) => {
		const px = x0 + x + 0.5;
		const py = y0 + y + 0.5;
		return px >= bx0 && px < bx1 && py >= by0 && py < by1;
	};
	const runs = traceChannels(nCells, nCells, dir, acc, edge, Math.max(1, Math.ceil(minKm2 / cellKm2)), inside);
	const lines: ChannelLine[] = runs.map((r) => {
		const pts: Pt[] = r.cells.map((c) => [(c % nCells) + 0.5, Math.floor(c / nCells) + 0.5]);
		return { coordinates: simplifyLine(pts, 0.5).map(([x, y]) => toLonLat(x0 + x, y0 + y, W)), km2: Math.round(r.acc * cellKm2 * 100) / 100 };
	});
	return { tile, bounds, minKm2, lines, cellSizeM, dataset: { label: info.label, fingerprint: info.fingerprint } };
}
