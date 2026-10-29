// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/geo/clip.test.ts at f888e4461
// Clipping a ring into a grid's bands by halving (clip.ts eachBand): the same
// pieces as clipping the ring to each band on its own (a comb, a ring with a
// hole), and work that grows with vertices × log(bands), never vertices ×
// bands, so a crafted comb of ~48 000 vertices (the auth audit's 92 s
// evaporation summary, docs/security.md § Map uploads) stays cheap; and the
// work budget, which refuses the one shape halving can't help (teeth that
// run the full height put every vertex in every row).
import { describe, expect, it } from 'vitest';
import type { Position } from './geojson.js';
import { clipX, clipY, eachBand, GRID_WORK_BUDGET, GridWorkExceeded, signedArea2, type SignedPiece } from './clip.js';
import { gridShares } from './gridShares.js';

const CELL = 0.0025;

/** A comb: a strip along the bottom of [x0, x0 + w] with `teeth` thin teeth up to y0 + h; 4 vertices a tooth. */
function comb(x0: number, y0: number, w: number, h: number, teeth: number): Position[] {
	const s = w / teeth;
	const base = h / 10;
	const ring: Position[] = [
		[x0, y0],
		[x0 + w, y0]
	];
	for (let i = teeth - 1; i >= 0; i--) {
		const left = x0 + i * s;
		ring.push([left + s / 2, y0 + base], [left + s / 2, y0 + h], [left, y0 + h], [left, y0 + base]);
	}
	return ring;
}

const area = (ps: SignedPiece[]) => ps.reduce((a, p) => a + (p.sign * Math.abs(signedArea2(p.ring))) / 2, 0);

describe('eachBand', () => {
	const ring = comb(21.3, -33.7, 0.1, 0.05, 300);
	const hole: Position[] = [
		[21.33, -33.695],
		[21.36, -33.695],
		[21.36, -33.693],
		[21.33, -33.693]
	];
	const pieces: SignedPiece[] = [
		{ ring, sign: 1 },
		{ ring: hole, sign: -1 }
	];

	for (const axis of ['x', 'y'] as const) {
		it(`gives each ${axis} band the area clipping to that band alone gives`, () => {
			const clip = axis === 'x' ? clipX : clipY;
			const [lo, hi] = axis === 'x' ? [Math.floor(21.3 / CELL) - 2, Math.ceil(21.4 / CELL) + 2] : [Math.floor(-33.7 / CELL) - 2, Math.ceil(-33.65 / CELL) + 2];
			const got = new Map<number, number>();
			eachBand(pieces, lo, hi, CELL, axis, (i, ps) => {
				expect(got.has(i)).toBe(false);
				got.set(i, area(ps));
			});
			// The bands outside the shape are never visited.
			expect(got.has(lo)).toBe(false);
			expect(got.has(hi - 1)).toBe(false);
			let naiveTotal = 0;
			for (let i = lo; i < hi; i++) {
				const want = area(pieces.map((p) => ({ ring: clip(p.ring, i * CELL, (i + 1) * CELL), sign: p.sign })).filter((p) => p.ring.length >= 3));
				naiveTotal += want;
				expect(got.get(i) ?? 0).toBeCloseTo(want, 15);
			}
			const total = [...got.values()].reduce((a, b) => a + b, 0);
			expect(total).toBeCloseTo(naiveTotal, 14);
			// Positive control: the bands add up to the shape itself.
			expect(total).toBeCloseTo(Math.abs(signedArea2(ring)) / 2 - Math.abs(signedArea2(hole)) / 2, 14);
		});
	}

	it('clips a ~48 000-vertex comb into 200 bands for a few passes over it, not one pass a band', () => {
		const big = comb(21.3, -33.8, 200 * CELL, 200 * CELL, 12_000);
		expect(big.length).toBe(48_002);
		const work = { vertices: 0 };
		let bands = 0;
		eachBand([{ ring: big, sign: 1 }], Math.floor(21.3 / CELL), Math.floor(21.3 / CELL) + 200, CELL, 'x', () => bands++, work);
		expect(bands).toBe(200);
		// Halving 200 bands is 8 levels plus the leaves; clipping to each band alone reads all 48 002 vertices 200 times.
		expect(work.vertices).toBeLessThan(20 * big.length);
	});

	it('stops with GridWorkExceeded once the work passes its limit', () => {
		const big = comb(21.3, -33.8, 200 * CELL, 200 * CELL, 12_000);
		const work = { vertices: 0, limit: 100_000 };
		expect(() => eachBand([{ ring: big, sign: 1 }], Math.floor(21.3 / CELL), Math.floor(21.3 / CELL) + 200, CELL, 'x', () => {}, work)).toThrow(GridWorkExceeded);
		expect(work.vertices).toBeLessThan(100_000 + big.length);
	});
});

/** A ring of `n` vertices round a circle: a detailed but ordinary outline. */
function circle(x0: number, y0: number, r: number, n: number): Position[] {
	return Array.from({ length: n }, (_, i): Position => [x0 + r * Math.cos((2 * Math.PI * i) / n), y0 + r * Math.sin((2 * Math.PI * i) / n)]);
}

describe('gridShares and the work budget', () => {
	it('reads a 48 000-vertex outline over 40 000 cells, under the budget, its shares adding up to its area (positive control)', () => {
		const round = circle(21.55, -33.55, 100 * CELL, 48_000);
		const r = gridShares({ type: 'Polygon', coordinates: [[...round, round[0]!]] }, CELL, 40_000);
		if ('problem' in r) throw new Error(r.problem);
		const sum = r.cells.reduce((a, c) => a + c.share, 0) * CELL * CELL;
		expect(sum).toBeCloseTo(Math.abs(signedArea2(round)) / 2, 10);
		// Ordered row by row, then cell by cell, as the summaries read them.
		const order = r.cells.map((c) => c.row * 1e6 + c.col);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it('refuses a comb whose 12 000 teeth run its full height (every row holds every vertex), within the budget, not after minutes', () => {
		// 20 000 rows × 2 columns: clipped, its pieces alone are 48 000 vertices × 20 000 rows, about a billion.
		const tall = comb(21.3, -33.8, 2 * CELL, 20_000 * CELL, 12_000).map(([x, y]): Position => [x, y]);
		const g = { type: 'Polygon' as const, coordinates: [[...tall, tall[0]!]] };
		const r = gridShares(g, CELL, 40_000, undefined, 'evaporation');
		expect(r).toEqual({ problem: `the polygon’s outline is too detailed to summarise over evaporation cells (more than ${GRID_WORK_BUDGET.toLocaleString('en-ZA')} vertex cuts); simplify it` });
		// Positive control: the same comb over a few rows is read.
		const short = comb(21.3, -33.8, 2 * CELL, 4 * CELL, 12_000);
		expect('problem' in gridShares({ type: 'Polygon', coordinates: [[...short, short[0]!]] }, CELL, 40_000)).toBe(false);
	});
});
