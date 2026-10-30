// Copied from IC-WBT backend/src/delineation/delineate.test.ts at f888e4461 (MIT, same author).
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDem } from './dem.js';
import {
	boundsText,
	delineate,
	delineationMethod,
	DelineationRefused,
	METHOD_VERSION,
	SNAP_RADIUS_M,
	toPx,
	type Delineation
} from './delineate.js';
import { BASIN_AREA_M2, DAM_CELL, FIXTURE_CELL_M, FIXTURE_CELLS, FIXTURE_ZOOM, fixtureElevation, fixtureLonLat, OUTLET_CELL, PAN } from './fixture.js';
import { d8, DX, DY, edgeMask, fill, OUT } from './flow.js';
import { PAN_METHOD } from './pans.js';

// Against the committed synthetic DEM (backend/fixtures/dem/, fixture.ts): a
// valley in an elliptical ridge whose area is known, with a dam, a pan and a
// flat reservoir.
const dem = openDem(fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url)));
const at = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
/** Whether the catchment's cell mask holds a point. */
const inMask = (d: Delineation, p: [number, number]) => {
	const { mask, n, x0, y0, W } = d.catchment;
	const [px, py] = toPx(p[0], p[1], W);
	return mask[(Math.floor(py) - y0) * n + Math.floor(px) - x0] === 1;
};

async function refusal(p: Promise<unknown>): Promise<DelineationRefused> {
	const e = await p.then(
		() => null,
		(err: unknown) => err
	);
	expect(e).toBeInstanceOf(DelineationRefused);
	return e as DelineationRefused;
}

describe('delineate (synthetic DEM)', () => {
	it('finds the whole valley from its outlet: the ridge’s area within 3 %, the mask around the outlet', async () => {
		const r = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		expect(Math.abs(r.areaM2 / BASIN_AREA_M2 - 1)).toBeLessThan(0.03);
		// A point well inside the valley is in the mask; one beyond the ridge is not.
		expect(inMask(r, at(OUTLET_CELL.x, OUTLET_CELL.y - 100))).toBe(true);
		expect(inMask(r, at(OUTLET_CELL.x + 120, OUTLET_CELL.y - 100))).toBe(false);
		expect(r.snapDistanceM).toBeLessThanOrEqual(1.5 * FIXTURE_CELL_M);
		expect(r.zoom).toBe(FIXTURE_ZOOM);
		expect(r.methodVersion).toBe(METHOD_VERSION);
		expect(r.method).toMatch(/Priority-Flood\+ε/);
		expect(r.dataset.label).toMatch(/Synthetic DEM/);
		expect(r.dataset.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it('proposes less from the dam wall than from the outlet: the valley above the wall, not below it', async () => {
		const outlet = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		const dam = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 1));
		expect(dam.areaM2).toBeGreaterThan(0.4 * outlet.areaM2);
		expect(dam.areaM2).toBeLessThan(0.8 * outlet.areaM2);
		expect(inMask(outlet, at(DAM_CELL.x, DAM_CELL.y - 60))).toBe(true);
		expect(inMask(dam, at(DAM_CELL.x, DAM_CELL.y - 60))).toBe(true);
		// Below the dam is the outlet's, not the dam's.
		expect(inMask(dam, at(DAM_CELL.x, DAM_CELL.y + 50))).toBe(false);
	});

	it('snaps a click beside the river onto it', async () => {
		const r = await delineate(dem, at(OUTLET_CELL.x + 1, OUTLET_CELL.y - 30));
		expect(r.snapDistanceM).toBeGreaterThan(0);
		expect(r.cells).toBeGreaterThan(100);
	});

	it('never snaps further than the stated radius (150 m), measured from the exact click, nor past the nearest channel (issues #387, #472)', async () => {
		// Clicks 0.1–1.49 cells (13–190 m) east of the river's centre line, between the dam and the outlet, some off their cell's
		// middle; the valley side's small channels run a cell east of the river. The nearest channel cell is taken: the river's
		// own while it is the nearer, never a more-drained cell further off.
		const river = DAM_CELL.x + 0.5;
		const row = DAM_CELL.y + 60.5;
		for (const dx of [0.1, 0.3, 0.6, 1.0, 1.2, 1.49]) {
			for (const dy of [0, 0.3]) {
				const r = await delineate(dem, fixtureLonLat(river + dx, row + dy), { keepPoint: true });
				expect(r.snapDistanceM, `${dx}, ${dy}`).toBeLessThanOrEqual(SNAP_RADIUS_M);
				// The river's cell centre is hypot(dx, dy) cells away: the outlet is never further than that.
				expect(r.snapDistanceM, `${dx}, ${dy}`).toBeLessThanOrEqual(Math.hypot(dx, dy) * FIXTURE_CELL_M + 1e-6);
				const onRiver = Math.abs(r.outlet[0] - fixtureLonLat(river, row)[0]) < 1e-6;
				// Nearer the river's cell than the side channel's (a cell east): on the river.
				expect(onRiver, `${dx}, ${dy}`).toBe(Math.hypot(dx, dy) < Math.hypot(1 - dx, dy));
			}
		}
	});

	it('refuses a point outside the DEM', async () => {
		const r = await refusal(delineate(dem, [25, -30]));
		expect(r.code).toBe('outside');
		// In degrees south, as people read them (it said "-33.7243397° to -33.1375512° N").
		expect(r.message).toMatch(/covers 20\.39° E to 21\.09° E, 33\.72° S to 33\.14° S\)\.$/);
	});

	it('refuses a click with no terrain channel within the snap radius, saying to click on one (issue #472)', async () => {
		// Just past the ridge, where nothing drains a square kilometre.
		const e = await refusal(delineate(dem, at(OUTLET_CELL.x - 91, OUTLET_CELL.y - 120)));
		expect(e.code).toBe('off_channel');
		expect(e.message).toBe(
			`No terrain channel runs within ${SNAP_RADIUS_M} m of that point. Zoom in until the terrain channels show, and click on one: they are the elevation model's rivers, which the outline follows.`
		);
	});

	it('refuses a catchment that runs past the largest window rather than cut it off', async () => {
		const e = await refusal(delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y), { windows: [64, 128] }));
		expect(e.code).toBe('too_large');
		expect(e.message).toMatch(/^The catchment above that point reaches beyond the \d+ km the app delineates around a click, so it can’t be proposed whole\. Click further upstream for a smaller catchment\.$/);
	});

	it('stops before a window that would break the budget', async () => {
		let t = 0;
		// Each window "takes" 10 s: after the first, the next (4× the cells) can't fit a 20 s budget.
		const e = await refusal(delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y), { windows: [128, 256, 1024], budgetMs: 20_000, now: () => (t += 5_000) }));
		expect(e.code).toBe('too_large');
		const r = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y), { windows: [128, 1024] });
		expect(r.windowCells).toBe(1024);
	});

	it('refuses a catchment that reaches where the DEM has no data', async () => {
		// A click on the fixture's western edge: the ground there falls west, off the data, so what lies beyond is unknown.
		expect((await refusal(delineate(dem, at(0, 256)))).code).toBe('no_data');
	});
});

describe('delineate: on the terrain channel nearest the click (issue #472)', () => {
	// Three cells (about 380 m) east of the river, between the dam and the outlet: on one of the valley side's small terrain
	// channels (about 1 km² each where they reach the river), as a displaced river line puts a click.
	const off = at(DAM_CELL.x + 3, DAM_CELL.y + 60);
	const onRiver = at(DAM_CELL.x, DAM_CELL.y + 60);

	it('puts a click on the river on the river’s channel, and says the mapped river network wasn’t used', async () => {
		const d = await delineate(dem, onRiver);
		expect(d.snapDistanceM).toBeLessThanOrEqual(SNAP_RADIUS_M);
		expect(d.areaM2 / 1e6).toBeGreaterThan(400);
		expect(d.method).toMatch(/outlet placed on the terrain channel \(at least 1 km² draining through it\) nearest the point, within 150 m; no mapped river network used to place it;/);
		expect(d.methodVersion).toBe('delineate-13');
	});

	it('refuses beside a much larger channel, naming it: where, how far, and both areas', async () => {
		const r = await refusal(delineate(dem, off));
		expect(r.code).toBe('larger_channel');
		// The channel's whole catchment is in the window: its area, not an "about" (finding 10).
		expect(r.message).toMatch(/^A much larger terrain channel runs \d+ m west of your point: [\d\s,]+ km² drains through it, against [\d.]+ km² on the terrain channel nearest your point\. Use that channel, or keep your point if you meant the small one\.$/);
		expect(r.larger!.distanceM).toBeGreaterThan(200);
		expect(r.larger!.distanceM).toBeLessThan(1000);
		expect(r.larger!.pointKm2).toBeGreaterThanOrEqual(1);
		// The channel it names is the river: delineating there gives the valley above it.
		const river = await delineate(dem, r.larger!.at);
		expect(river.areaM2 / 1e6).toBeGreaterThan(100 * r.larger!.pointKm2);
	});

	it('says "at least" when the channel runs past the window (the hydrologist’s review, finding 10)', async () => {
		// A 128-cell window cuts the river.
		const r = await refusal(delineate(dem, off, { windows: [128] }));
		expect(r.code).toBe('larger_channel');
		expect(r.message).toMatch(/^A much larger terrain channel runs \d+ m west of your point: at least [\d\s,]+ km² drains through it inside the \d+ km routed around your point, and more from beyond, against [\d.]+ km² on the terrain channel nearest your point\./);
		expect(r.message).not.toMatch(/about/);
	});

	it('keeps the point when asked: the small catchment of the terrain channel it is on, never the mapped river’s', async () => {
		const d = await delineate(dem, off, { keepPoint: true });
		expect(d.areaM2).toBeLessThan(0.05 * BASIN_AREA_M2);
		// On the click's own channel: the nearest cell, not moved towards the river.
		expect(d.snapDistanceM).toBeLessThan(FIXTURE_CELL_M);
		expect(d.method).toMatch(/kept there by the editor though a channel with 100× its upstream cells within 1000 m was offered/);
	});
});

describe('boundsText', () => {
	it('names each side east or west, north or south, to two decimals', () => {
		expect(boundsText([-1.5, -2.25, 3, 4.125])).toBe('1.50° W to 3.00° E, 2.25° S to 4.13° N');
	});
});

/** What drains into the fixture's pan (m², at the fixture's nominal cell size): every cell whose D8 path enters its disc, routed here from the terrain itself. */
function panCatchmentM2(): number {
	const n = FIXTURE_CELLS;
	const z = new Float64Array(n * n);
	for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) z[y * n + x] = fixtureElevation(x, y);
	const g = { nx: n, ny: n, z };
	const edge = edgeMask(g);
	fill(g, edge);
	const dir = d8(g, edge);
	const inPan = (c: number) => Math.hypot((c % n) - PAN.x, Math.floor(c / n) - PAN.y) < PAN.radius;
	let cells = 0;
	for (let i = 0; i < n * n; i++) {
		for (let c = i, k = 0; k < n * n; k++) {
			if (inPan(c)) {
				cells++;
				break;
			}
			const d = dir[c]!;
			if (d === OUT) break;
			c += DY[d]! * n + DX[d]!;
		}
	}
	return cells * FIXTURE_CELL_M * FIXTURE_CELL_M;
}

describe('delineate: pans (the hydrologist’s review, finding 8)', () => {
	const expected = panCatchmentM2();

	it('reports what drains into the valley’s pan as non-contributing, beside the catchment it leaves whole', async () => {
		const r = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		expect(r.pans.count).toBe(1);
		// Ellipsoid row areas against the nominal cell: within 1 %.
		expect(Math.abs(r.pans.nonContributingM2 / expected - 1)).toBeLessThan(0.01);
		const [pan] = r.pans.largest;
		expect(pan!.drainsM2).toBe(r.pans.nonContributingM2);
		expect(pan!.depthM).toBeGreaterThanOrEqual(PAN.depthM);
		expect(pan!.floorM2).toBeGreaterThan(0.9 * Math.PI * PAN.radius ** 2 * FIXTURE_CELL_M ** 2);
		expect(pan!.storageMm).toBeGreaterThan(1000);
		// Its deepest point is on the pan.
		const [lon, lat] = fixtureLonLat(PAN.x + 0.5, PAN.y + 0.5);
		expect(Math.hypot((pan!.at[0] - lon) * Math.cos((lat * Math.PI) / 180), pan!.at[1] - lat) * 111_320).toBeLessThan(PAN.radius * FIXTURE_CELL_M);
		expect(r.pans.method).toBe(PAN_METHOD);
		// The catchment is the gross one, as before: the pan's area is inside it, and named in the method.
		expect(Math.abs(r.areaM2 / BASIN_AREA_M2 - 1)).toBeLessThan(0.03);
		expect(inMask(r, at(PAN.x, PAN.y))).toBe(true);
		expect(r.method).toMatch(/pans \(closed depressions\) reported beside it as non-contributing, not taken out/);
	});

	it('counts the pan above a dam wall but never the dam’s own reservoir (it holds a few mm over its catchment, and is at the point)', async () => {
		const r = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 1));
		expect(r.pans.count).toBe(1);
		expect(Math.abs(r.pans.nonContributingM2 / expected - 1)).toBeLessThan(0.01);
	});

	it('finds no pan in a catchment without one (positive control above)', async () => {
		// A small channel on the west flank, away from the pan on the east flank.
		const side = await delineate(dem, at(DAM_CELL.x - 5, DAM_CELL.y + 40), { keepPoint: true });
		expect(side.pans).toEqual({ nonContributingM2: 0, count: 0, largest: [], method: PAN_METHOD });
	});

});
