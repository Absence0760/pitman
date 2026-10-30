// Copied from IC-WBT backend/src/delineation/fixture.ts at f888e4461 (MIT, same author).
// The synthetic DEM committed for delineation's tests (backend/fixtures/dem/synthetic-dem.pmtiles, the
// bytes IC-WBT's backend/scripts/dem-fixture.ts wrote; the dev server's DEM is syntheticDem.ts).
// Invented terrain, no real place's elevations: a valley inside an elliptical
// ridge, its river running south along the axis to an outlet on the rim, with
// a dam (a wall across the river and its flat reservoir behind it) and a
// pan on a flank (a flat-floored closed depression, its own closed
// catchment above it), so depression filling, flats, pans and snapping are
// all exercised. Everything outside the ridge falls away from it.
//
// The tests and the e2e click the points below and know the areas to expect.
import { TARGET_ZOOM } from './delineate.js';

/** Zoom of the fixture's tiles; delineation reads min(TARGET_ZOOM, max zoom), so this one. */
export const FIXTURE_ZOOM = 10;
if (FIXTURE_ZOOM > TARGET_ZOOM) throw new Error('the fixture must not be finer than the zoom delineation reads');
/** 256 px tiles, 2 × 2 of them: 512 × 512 cells of about 128 m. */
export const FIXTURE_TILE = 256;
export const FIXTURE_TILES = 2;
/** The top-left tile (zoom 10): in the Western Cape's latitudes, nowhere in particular. */
export const FIXTURE_X0 = 570;
export const FIXTURE_Y0 = 612;
export const FIXTURE_CELLS = FIXTURE_TILE * FIXTURE_TILES;

const W = 2 ** FIXTURE_ZOOM * FIXTURE_TILE;
/** Longitude and latitude of a fixture-cell position (cells from the fixture's top-left corner; .5 = a cell's centre). */
export function fixtureLonLat(cx: number, cy: number): [number, number] {
	const x = FIXTURE_X0 * FIXTURE_TILE + cx;
	const y = FIXTURE_Y0 * FIXTURE_TILE + cy;
	return [Math.round(((x / W) * 360 - 180) * 1e7) / 1e7, Math.round(((Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / W))) * 180) / Math.PI) * 1e7) / 1e7];
}

/** The ridge: an ellipse centred (CX, CY), semi-axes A (east–west) and B (north–south), in cells. */
const CX = 256;
const CY = 230;
const A = 90;
const B = 120;
/** The outlet: where the river leaves the ellipse through its southern rim. */
export const OUTLET_CELL = { x: CX, y: CY + B } as const;
/** The dam wall across the river, and the reservoir's level behind it. */
export const DAM_CELL = { x: CX, y: CY + 20 } as const;
const DAM_WALL_M = 25;
/**
 * A pan on the eastern flank: a disc of `radius` cells whose flat floor lies `depthM` below the lowest point of its rim, so it
 * is closed (the flank above it drains into it) and the fill spills it towards the river (pans.ts: a pan, since it holds far
 * more than 100 mm over its catchment). It was a cone-shaped pit until delineate-9, which the 6 % flank never closed.
 */
export const PAN = { x: CX + 50, y: CY - 40, depthM: 3, radius: 6 } as const;

/** Cell size near the fixture (m): zoom 10, 256 px tiles, about 33.5° S. */
export const FIXTURE_CELL_M = (2 * Math.PI * 6378137 * Math.cos((fixtureLonLat(CX, CY)[1] * Math.PI) / 180)) / W;

/** The valley floor: rising 1 % up the river from the outlet and 6 % away from it. */
const valley = (x: number, y: number) => 300 + 0.01 * (OUTLET_CELL.y - y) * FIXTURE_CELL_M + 0.06 * Math.abs(x - CX) * FIXTURE_CELL_M;
const RIDGE_M = 20;

/**
 * Elevation (m) at cell (x, y) of the fixture: inside the ellipse the valley,
 * rising RIDGE_M over its outer tenth to the ridge (except where the river
 * leaves); outside, the ridge falling 15 % away from the ellipse, steeper
 * than the valley's slope along it, so nothing outside drains in. Rounded to
 * 1/256 m, as Terrarium stores it.
 */
export function fixtureElevation(x: number, y: number): number {
	const cell = FIXTURE_CELL_M;
	const px = x + 0.5;
	const py = y + 0.5;
	const s = Math.sqrt(((px - CX) / A) ** 2 + ((py - CY) / B) ** 2);
	let z: number;
	if (x === CX && y >= OUTLET_CELL.y) {
		// The river's channel south of the outlet, below everything beside it.
		z = valley(CX, OUTLET_CELL.y) - 2 - 0.01 * (y - OUTLET_CELL.y) * cell;
	} else if (s < 1) {
		z = valley(x, y);
		// The ridge's inner slope, cut by the river's gap in the south.
		const gap = y > CY && Math.abs(x - CX) <= 2;
		if (!gap && s > 0.9) z += (RIDGE_M * (s - 0.9)) / 0.1;
		// The valley is a plane, so the lowest cell beside the disc lies down its slope, at most radius + √2 cells out: the
		// floor sits depthM below the plane there, and so at least depthM below wherever the pan spills.
		if (Math.hypot(x - PAN.x, y - PAN.y) < PAN.radius) {
			const g = Math.hypot(0.06, 0.01);
			const out = PAN.radius + Math.SQRT2;
			z = valley(PAN.x - (out * 0.06) / g, PAN.y + (out * 0.01) / g) - PAN.depthM;
		}
		// The dam: a wall across the valley at DAM_CELL, the reservoir flat behind it at the crest less 5 m.
		const level = valley(CX, DAM_CELL.y) + DAM_WALL_M - 5;
		if (y === DAM_CELL.y && Math.abs(x - CX) <= 12) z += DAM_WALL_M;
		else if (y < DAM_CELL.y && y > DAM_CELL.y - 40 && z < level) z = level;
	} else {
		// The point of the ellipse on the way to the centre, and the distance to it (m).
		const qx = CX + (px - CX) / s;
		const qy = CY + (py - CY) / s;
		z = valley(qx, qy) + RIDGE_M - 0.15 * Math.hypot(px - qx, py - qy) * cell;
	}
	return Math.round(z * 256) / 256;
}

/** The ellipse's area (m²): what the outlet's catchment should come to, near enough. */
export const BASIN_AREA_M2 = Math.PI * A * B * FIXTURE_CELL_M * FIXTURE_CELL_M;
/** Bounds of the fixture (west, south, east, north). */
export const FIXTURE_BOUNDS = ((): [number, number, number, number] => {
	const [w, n] = fixtureLonLat(0, 0);
	const [e, s] = fixtureLonLat(FIXTURE_CELLS, FIXTURE_CELLS);
	return [w, s, e, n];
})();
export const FIXTURE_FILE = new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url);

/**
 * A unit's boundary in the valley (start-16, #523 C1): the stretch of the ellipse (grown by `pad` cells) between rows `fromY`
 * and `toY`, closed by straight cuts across it, as a lon/lat ring. Rows past the ellipse's top or bottom close it on its rim;
 * with the default pad, one reaching the bottom takes in the outlet's cell. `step`: rows between the ring's points (e2e/support/dem.ts
 * keeps a coarser copy, checked by delineate.test.ts).
 */
export function valleyUnitRing(fromY: number, toY: number, pad = 2, step = 2): [number, number][] {
	const a = A + pad;
	const b = B + pad;
	const top = Math.max(fromY, CY - b);
	const bottom = Math.min(toY, CY + b);
	const half = (y: number) => a * Math.sqrt(Math.max(0, 1 - ((y - CY) / b) ** 2));
	const ys: number[] = [];
	for (let y = top; y < bottom; y += step) ys.push(y);
	ys.push(bottom);
	const all = [...ys.map((y) => fixtureLonLat(CX + 0.5 + half(y), y)), ...[...ys].reverse().map((y) => fixtureLonLat(CX + 0.5 - half(y), y))];
	// No point twice in a row (the rim's tip where the two sides meet), then closed.
	const ring = all.filter((p, i) => i === 0 || p[0] !== all[i - 1]![0] || p[1] !== all[i - 1]![1]);
	if (ring.length > 1 && ring[ring.length - 1]![0] === ring[0]![0] && ring[ring.length - 1]![1] === ring[0]![1]) ring.pop();
	return [...ring, ring[0]!];
}
