// Copied from IC-WBT backend/src/delineation/flow.test.ts at f888e4461 (MIT, same author).
import { describe, expect, it } from 'vitest';
import { accumulate, BORDER, d8, DX, DY, edgeMask, fill, NO_DATA_EDGE, nextUp, openFlags, OUT, snap, touchesEdge, upstream, type Grid } from './flow.js';

const grid = (nx: number, ny: number, f: (x: number, y: number) => number): Grid => {
	const z = new Float64Array(nx * ny);
	for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) z[y * nx + x] = f(x, y);
	return { nx, ny, z };
};

/** Follows every cell's D8 path; fails on a cycle, and returns where each one leaves the grid. */
function exits(g: Grid, dir: Uint8Array): Int32Array {
	const out = new Int32Array(g.nx * g.ny);
	for (let i = 0; i < out.length; i++) {
		let c = i;
		for (let steps = 0; dir[c] !== OUT; steps++) {
			if (steps > out.length) throw new Error(`cell ${i} never reaches an edge`);
			c += DY[dir[c]!]! * g.nx + DX[dir[c]!]!;
		}
		out[i] = c;
	}
	return out;
}

const route = (g: Grid) => {
	const edge = edgeMask(g);
	fill(g, edge);
	const dir = d8(g, edge);
	return { edge, dir, acc: accumulate(g.nx, g.ny, dir) };
};

describe('flow routing', () => {
	it('nextUp is the next float64', () => {
		expect(nextUp(1)).toBe(1 + Number.EPSILON);
		expect(nextUp(-1)).toBeGreaterThan(-1);
		expect(nextUp(-1)).toBeLessThan(-1 + Number.EPSILON);
		expect(nextUp(0)).toBe(Number.MIN_VALUE);
	});

	it('drains a pit and a flat out of the grid, with no cycles (Priority-Flood+ε)', () => {
		// A bowl with a flat floor, spilling through a notch in the south wall.
		const g = grid(21, 21, (x, y) => {
			const r = Math.hypot(x - 10, y - 10);
			if (x === 10 && y >= 15) return 5 - (y - 15) * 0.5; // the notch
			return r < 4 ? 0 : r;
		});
		const { dir, edge } = route(g);
		const ends = exits(g, dir);
		// The floor's cells all leave through the notch, at the south edge.
		expect(ends[10 * 21 + 10]).toBe(20 * 21 + 10);
		expect(ends[8 * 21 + 12]).toBe(20 * 21 + 10);
		for (let i = 0; i < edge.length; i++) if (!edge[i]) expect(dir[i]).not.toBe(OUT);
	});

	it('accumulates every cell exactly once: the edge cells hold them all', () => {
		const g = grid(15, 9, (x, y) => (x * 7 + y * 13) % 5);
		const { acc, edge, dir } = route(g);
		let total = 0;
		for (let i = 0; i < acc.length; i++) if (dir[i] === OUT) total += acc[i]!;
		expect(total).toBe(15 * 9);
		expect(Math.min(...acc)).toBe(1);
		expect(edge.reduce((s, v) => s + v, 0)).toBe(2 * 15 + 2 * 9 - 4);
	});

	it('makes no data and the cells beside it edges of their own kind, the window’s border another', () => {
		const g = grid(9, 9, (x, y) => (x === 4 && y === 4 ? Number.NaN : 10 - Math.hypot(x - 4, y - 4)));
		const edge = edgeMask(g);
		expect(edge[4 * 9 + 4]).toBe(NO_DATA_EDGE);
		for (let d = 0; d < 8; d++) expect(edge[(4 + DY[d]!) * 9 + 4 + DX[d]!]).toBe(NO_DATA_EDGE);
		expect(edge[0]).toBe(BORDER);
		expect(edge[2 * 9 + 4]).toBe(0);
	});

	it('does not sink the land into no data: a river running in from a hole reaches it, and is seen to (persona-hydrologist finding 2)', () => {
		// A plane falling south with a valley down column 6; the top three rows have no data, the river comes in from there.
		const g = grid(13, 16, (x, y) => (y < 3 ? Number.NaN : 100 - 2 * y + Math.abs(x - 6)));
		const { edge, dir, acc } = route(g);
		// Every cell two rows below the hole drains south or along, never north into it (it used to flood at −∞ and swallow them).
		for (let x = 1; x < 12; x++) expect(DY[dir[5 * 13 + x]!]).toBeGreaterThanOrEqual(0);
		const outlet = 14 * 13 + 6;
		expect(acc[outlet]).toBeGreaterThan(9);
		const mask = upstream(13, 16, dir, outlet);
		expect(touchesEdge(g, edge, mask)).toEqual({ edge: true, noData: true });
		expect(openFlags(13, 16, dir, edge)[outlet]! & NO_DATA_EDGE).toBe(NO_DATA_EDGE);
	});

	it('openFlags says for every cell what touchesEdge says of its catchment', () => {
		let seed = 7;
		const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
		const g = grid(30, 24, (x, y) => ((x - 12) ** 2 + (y - 20) ** 2 < 10 ? Number.NaN : 50 - y + 3 * Math.abs(x - 15) * 0.3 + rand() * 4));
		const { edge, dir } = route(g);
		const flags = openFlags(30, 24, dir, edge);
		for (let i = 0; i < flags.length; i++) {
			if (edge[i]) continue;
			const t = touchesEdge(g, edge, upstream(30, 24, dir, i));
			expect({ i, border: !!flags[i], noData: !!(flags[i]! & NO_DATA_EDGE) }).toEqual({ i, border: t.edge, noData: t.noData });
		}
	});

	it('snaps to the most-accumulating cell in reach, the nearest of equals, never an edge', () => {
		const acc = new Int32Array(25).fill(1);
		const edge = new Uint8Array(25);
		acc[2 * 5 + 3] = 9;
		expect(snap(5, 5, acc, edge, 2.5, 2.5, 1)).toBe(2 * 5 + 3);
		expect(snap(5, 5, acc, edge, 1.5, 2.5, 1)).toBe(2 * 5 + 1); // the 9 is out of reach: the click's own cell
		edge.fill(1);
		expect(snap(5, 5, acc, edge, 2.5, 2.5, 2)).toBeNull();
	});

	it('measures the radius from the exact click to each cell’s centre, not in whole cells from the clicked cell (issue #387)', () => {
		const acc = new Int32Array(25).fill(1);
		const edge = new Uint8Array(25);
		acc[2 * 5 + 3] = 9; // centre (3.5, 2.5)
		// A click near its cell's western edge: the 9 is 1.9 cells away, out of a 1.5-cell radius (the old rule, round(1.5) = 2 whole cells from cell (1, 2), took it).
		expect(snap(5, 5, acc, edge, 1.6, 2.5, 1.5)).toBe(2 * 5 + 1);
		// Near the eastern edge of the same cell, 1.1 cells away: in reach.
		expect(snap(5, 5, acc, edge, 2.4, 2.5, 1.5)).toBe(2 * 5 + 3);
		// A radius under half a cell still has the click's own cell.
		expect(snap(5, 5, acc, edge, 2.9, 2.9, 0.1)).toBe(2 * 5 + 2);
	});

	it('collects exactly the cells whose paths pass the outlet', () => {
		// A tilted plane draining south, with a valley down column 5.
		const g = grid(11, 12, (x, y) => (11 - y) + Math.abs(x - 5) * 2);
		const { dir, acc } = route(g);
		const outlet = 10 * 11 + 5;
		const mask = upstream(11, 12, dir, outlet);
		const ends = exits(g, dir);
		let count = 0;
		for (let i = 0; i < mask.length; i++) {
			if (!mask[i]) continue;
			count++;
			expect(ends[i]).toBe(ends[outlet]);
		}
		expect(count).toBe(acc[outlet]);
	});
});
