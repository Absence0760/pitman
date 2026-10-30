// Copied from IC-WBT backend/src/delineation/delineate.windows.test.ts at f888e4461 (MIT, same author).
import { describe, expect, it } from 'vitest';
import { aimAt, delineate, DelineationRefused, windowOrigin } from './delineate.js';
import { at, functionDem, HW, OY, VALLEY_TILE, valley } from './valleyFixture.js';

// The window a delineation routes, against the invented valley (valleyFixture.ts): longer than half the windows the tests give, so a
// window centred on the click cuts it (persona-hydrologist, issue #390, findings 1, 2 and 6).

async function refusal(p: Promise<unknown>): Promise<DelineationRefused> {
	const e = await p.then(
		() => null,
		(err: unknown) => err
	);
	expect(e).toBeInstanceOf(DelineationRefused);
	return e as DelineationRefused;
}

describe('delineate: windows over a river longer than half the window', () => {
	const LONG = 200;
	const dem = functionDem(valley(LONG));

	it('grows into a window placed over the catchment, not centred on the outlet (finding 6)', async () => {
		// The whole valley, from a window centred on the outlet that holds it (256 cells to the north).
		const whole = await delineate(dem, at(0, 0), { windows: [512] });
		expect(whole.cells).toBeGreaterThan((2 * HW + 1) * LONG);
		// Centred, a 256-cell window reaches 128 cells north of the outlet: the valley's 200 run past it. Placed over the valley
		// once the 128-cell window cut it at the north, it reaches past the valley's 200 (all but the few cells kept south of the outlet).
		const r = await delineate(dem, at(0, 0), { windows: [128, 256] });
		expect(r.windowCells).toBe(256);
		expect(r.cells).toBe(whole.cells);
	});

	it('still refuses a catchment longer than the placed window, at the window it stopped at', async () => {
		const e = await refusal(delineate(functionDem(valley(260)), at(0, 0), { windows: [128, 256] }));
		expect(e.code).toBe('too_large');
	});
});

describe('delineate: the data’s edge (finding 2)', () => {
	// No tile north of the tile row 100 cells above the outlet: the valley's top half lies in the hole.
	const holeAbove = Math.floor((OY - 100) / VALLEY_TILE);

	it('refuses a catchment that runs into no data, instead of proposing what drains into the hole’s side', async () => {
		const dem = functionDem(valley(200), holeAbove);
		const e = await refusal(delineate(dem, at(0, 0), { windows: [512] }));
		expect(e.code).toBe('no_data');
		expect(e.message).toMatch(/runs past the edge of the elevation model’s data/);
	});

	it('proposes a catchment that stops short of the hole, whole: the land beside no data is not a sink', async () => {
		// With a pan on the valley floor (a pit 15 m deep), so the pans' report beside missing data is checked too.
		const pitted = (u: number, v: number) => valley(40)(u, v) - (Math.hypot(u, v + 25) < 4 ? 15 * (1 - Math.hypot(u, v + 25) / 4) : 0);
		const short = await delineate(functionDem(pitted), at(0, 0), { windows: [512] });
		const r = await delineate(functionDem(pitted, holeAbove), at(0, 0), { windows: [512] });
		expect(r.cells).toBe(short.cells);
		// The pans read the elevations before the fill, where the hole is NaN: the pit is the one pan, the hole none.
		expect(short.pans.count).toBe(1);
		expect(r.pans).toEqual(short.pans);
	});
});

describe('windowOrigin', () => {
	it('centres the first window on the click', () => {
		expect(windowOrigin(100, 1000.7, 2000.2, 10, null)).toEqual([950, 1950]);
	});

	it('runs the next window the way the catchment was cut, keeping the click inside', () => {
		// A 20-cell window at (0, 0) whose catchment ran from the outlet's row (15) to its north border.
		const mask = new Uint8Array(400);
		for (let y = 0; y <= 15; y++) mask[y * 20 + 10] = 1;
		const aim = aimAt(mask, 20, 0, 0);
		expect(aim).toEqual({ box: [10, 0, 10, 15], cut: [false, true, false, false] });
		// North: the window ends `keep` cells past the box's south end; east–west: centred on the box.
		expect(windowOrigin(40, 10.5, 15.5, 3, aim)).toEqual([-10, -21]);
		// Cut at the south: the window starts `keep` cells short of the box's north end.
		expect(windowOrigin(40, 10.5, 15.5, 3, { box: [10, 0, 10, 15], cut: [false, false, false, true] })).toEqual([-10, -3]);
		// The click stays `keep` cells inside, however far the box runs the other way.
		expect(windowOrigin(40, 10.5, 15.5, 3, { box: [10, -50, 10, 15], cut: [false, false, false, true] })).toEqual([-10, -21]);
	});
});
