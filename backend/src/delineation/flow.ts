// Copied from IC-WBT backend/src/delineation/flow.ts at f888e4461 (MIT, same author).
// Flow routing on a DEM grid (docs/design/delineation.md § Method):
// Priority-Flood+ε depression filling (Barnes, Lehman and Mulla 2014,
// Algorithm 3), D8 steepest descent on the filled surface, flow
// accumulation, snapping the outlet to the most-accumulating cell near the
// click, and the outlet's upstream cells.
//
// Pure functions over typed arrays, row-major, y down (north at row 0). No
// I/O: dem.ts fills the grid, delineate.ts drives it.

export interface Grid {
	nx: number;
	ny: number;
	/** Elevation, m; NaN where the DEM has no data. Filled in place by `fill`. */
	z: Float64Array;
}

/** D8 neighbours: E, SE, S, SW, W, NW, N, NE (dx, dy with y down). */
export const DX = [1, 1, 0, -1, -1, -1, 0, 1];
export const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];
/** A cell that drains out of the grid: the window's edge, or no data. */
export const OUT = 255;
/** edgeMask's codes: the window's border, where the terrain goes on beyond the window. */
export const BORDER = 1;
/** edgeMask's codes: a no-data cell, or a cell beside one, where what lies beyond is unknown. */
export const NO_DATA_EDGE = 2;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/** Which 32-bit half of the float64 holds the low word (0 on little-endian platforms). */
const LO = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 0 : 1;
const HI = 1 - LO;
/**
 * The next float64 above v (C's nextafter(v, +∞)) for finite v: one step of the bit pattern, up for a positive v, down
 * for a negative one. Done on two 32-bit words with a carry, not a BigUint64Array: fill() calls it for every cell, and the
 * BigInt arithmetic took twice as long.
 */
export function nextUp(v: number): number {
	if (v === 0) return Number.MIN_VALUE;
	f64[0] = v;
	if (v > 0) {
		if (u32[LO] === 0xffffffff) {
			u32[LO] = 0;
			u32[HI] = u32[HI]! + 1;
		} else u32[LO] = u32[LO]! + 1;
	} else if (u32[LO] === 0) {
		u32[LO] = 0xffffffff;
		u32[HI] = u32[HI]! - 1;
	} else u32[LO] = u32[LO]! - 1;
	return f64[0]!;
}

/**
 * A binary min-heap of cell indices keyed on z, ties broken by index, so the result never depends on insertion order.
 * Each entry's key is held beside its index (`k`), so a comparison reads the heap's own small arrays (a few thousand
 * entries), not the grid's elevations at scattered cells (n² float64s, 32 MB at 2 048 cells). The order is the same total
 * order, so the fill is the same to the bit.
 */
export class Heap {
	private a: Int32Array;
	private k: Float64Array;
	size = 0;
	constructor(cap: number) {
		this.a = new Int32Array(Math.max(16, cap));
		this.k = new Float64Array(this.a.length);
	}
	push(c: number, zc: number) {
		if (this.size === this.a.length) {
			const b = new Int32Array(this.a.length * 2);
			b.set(this.a);
			this.a = b;
			const kk = new Float64Array(b.length);
			kk.set(this.k);
			this.k = kk;
		}
		const a = this.a;
		const k = this.k;
		let i = this.size++;
		while (i > 0) {
			const p = (i - 1) >> 1;
			const zp = k[p]!;
			if (!(zc < zp || (zc === zp && c < a[p]!))) break;
			a[i] = a[p]!;
			k[i] = zp;
			i = p;
		}
		a[i] = c;
		k[i] = zc;
	}
	pop(): number {
		const a = this.a;
		const k = this.k;
		const top = a[0]!;
		const n = --this.size;
		const last = a[n]!;
		const zl = k[n]!;
		let i = 0;
		for (;;) {
			let c = 2 * i + 1;
			if (c >= n) break;
			let zc = k[c]!;
			if (c + 1 < n) {
				const z2 = k[c + 1]!;
				if (z2 < zc || (z2 === zc && a[c + 1]! < a[c]!)) {
					c++;
					zc = z2;
				}
			}
			if (!(zc < zl || (zc === zl && a[c]! < last))) break;
			a[i] = a[c]!;
			k[i] = zc;
			i = c;
		}
		if (n > 0) {
			a[i] = last;
			k[i] = zl;
		}
		return top;
	}
}

/**
 * Edge cells, where water leaves the grid and the flood starts: the grid's
 * border (BORDER), and every no-data cell and every cell beside one
 * (NO_DATA_EDGE; one beside both is NO_DATA_EDGE). The cells beside a hole
 * are the data's border, as the window's border cells are the window's: an
 * edge at its own elevation, where what lies beyond is unknown. A no-data
 * cell has no elevation and seeds nothing (fill). RichDEM's Priority-Flood
 * (Barnes 2014) instead floods no data as lower than any elevation, which
 * suits a DEM whose no data is the sea; here the sea is data (elevation 0 or
 * below) and no data is a missing tile, the extract's edge (delineate-6).
 */
export function edgeMask(g: Grid): Uint8Array {
	const { nx, ny, z } = g;
	const edge = new Uint8Array(nx * ny);
	for (let y = 0; y < ny; y++) {
		for (let x = 0; x < nx; x++) {
			const i = y * nx + x;
			if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) edge[i] = BORDER;
			if (!Number.isNaN(z[i]!)) continue;
			edge[i] = NO_DATA_EDGE;
			for (let d = 0; d < 8; d++) {
				const xx = x + DX[d]!;
				const yy = y + DY[d]!;
				if (xx >= 0 && yy >= 0 && xx < nx && yy < ny) edge[yy * nx + xx] = NO_DATA_EDGE;
			}
		}
	}
	return edge;
}

/**
 * Priority-Flood+ε: raises every cell of a depression or flat to just above
 * the cell it spills through (the next float64 up), so every non-edge cell
 * has a strictly lower neighbour and D8 drains everything to an edge.
 * Changes `g.z` in place; returns how many cells were raised.
 */
export function fill(g: Grid, edge: Uint8Array): number {
	const { nx, ny, z } = g;
	const n = nx * ny;
	const closed = new Uint8Array(n);
	const heap = new Heap(4 * (nx + ny));
	const pit = new Int32Array(n);
	let pitHead = 0;
	let pitTail = 0;
	for (let i = 0; i < n; i++) {
		if (!edge[i]) continue;
		closed[i] = 1;
		// A no-data cell has no elevation: it is never a spill point. The cells beside it are edges at their own elevation
		// (edgeMask), so water leaves there only where the data's border is the lowest way out, as at the window's border.
		// (Until delineate-6 it flooded at −∞, so every cell beside a hole drained into it and no catchment could reach one.)
		if (!Number.isNaN(z[i]!)) heap.push(i, z[i]!);
	}
	let raised = 0;
	while (heap.size > 0 || pitHead < pitTail) {
		const c = pitHead < pitTail ? pit[pitHead++]! : heap.pop();
		const cx = c % nx;
		const cy = (c - cx) / nx;
		const up = nextUp(z[c]!);
		for (let d = 0; d < 8; d++) {
			const x = cx + DX[d]!;
			const y = cy + DY[d]!;
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const k = y * nx + x;
			if (closed[k]) continue;
			closed[k] = 1;
			const zk = z[k]!;
			if (zk <= up) {
				z[k] = up;
				raised++;
				pit[pitTail++] = k;
			} else heap.push(k, zk);
		}
	}
	return raised;
}

/** D8 on the filled surface: each cell's steepest strictly-downhill neighbour (0–7), OUT for an edge. */
export function d8(g: Grid, edge: Uint8Array): Uint8Array {
	const { nx, ny, z } = g;
	const dir = new Uint8Array(nx * ny).fill(OUT);
	for (let y = 1; y < ny - 1; y++) {
		for (let x = 1; x < nx - 1; x++) {
			const i = y * nx + x;
			if (edge[i]) continue;
			let best = -1;
			let slope = 0;
			for (let d = 0; d < 8; d++) {
				const k = i + DY[d]! * nx + DX[d]!;
				const s = (z[i]! - z[k]!) / DIST[d]!;
				if (s > slope) {
					slope = s;
					best = d;
				}
			}
			// fill() guarantees a strictly lower neighbour; a grid that skipped it keeps OUT.
			if (best >= 0) dir[i] = best;
		}
	}
	return dir;
}

/** Upstream cell count of every cell, itself included (topological order: no recursion). */
export function accumulate(nx: number, ny: number, dir: Uint8Array): Int32Array {
	const n = nx * ny;
	const indeg = new Int32Array(n);
	// The index step to each D8 neighbour, as a typed array, in place of a closure over DX and DY per cell.
	const step = Int32Array.from(DX, (dx, d) => DY[d]! * nx + dx);
	for (let i = 0; i < n; i++) {
		const d = dir[i]!;
		if (d !== OUT) indeg[i + step[d]!]!++;
	}
	const acc = new Int32Array(n).fill(1);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;
	for (let i = 0; i < n; i++) if (indeg[i] === 0) queue[tail++] = i;
	while (head < tail) {
		const i = queue[head++]!;
		const d = dir[i]!;
		if (d === OUT) continue;
		const k = i + step[d]!;
		acc[k]! += acc[i]!;
		indeg[k] = indeg[k]! - 1;
		if (indeg[k] === 0) queue[tail++] = k;
	}
	return acc;
}

/**
 * The cell the outlet snaps to: the one with the most upstream cells whose
 * centre lies within `radius` cells of the click (cx, cy), measured from the
 * exact click (fractional cell coordinates, not its cell's corner), so the
 * distance a caller records never exceeds the radius it states (issue #387);
 * the nearest of equals; never an edge cell. The click's own cell always
 * counts, however small the radius. Null when every cell in reach is an edge.
 */
export function snap(nx: number, ny: number, acc: Int32Array, edge: Uint8Array, cx: number, cy: number, radius: number): number | null {
	let best = -1;
	let bestAcc = -1;
	let bestD = Infinity;
	const ix = Math.floor(cx);
	const iy = Math.floor(cy);
	const r = Math.ceil(radius);
	for (let y = iy - r; y <= iy + r; y++) {
		for (let x = ix - r; x <= ix + r; x++) {
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
			if (d > radius && !(x === ix && y === iy)) continue;
			const i = y * nx + x;
			if (edge[i]) continue;
			const a = acc[i]!;
			if (a > bestAcc || (a === bestAcc && d < bestD)) {
				best = i;
				bestAcc = a;
				bestD = d;
			}
		}
	}
	return best < 0 ? null : best;
}

/** The outlet's catchment: every cell whose D8 path passes through it (itself included). */
export function upstream(nx: number, ny: number, dir: Uint8Array, outlet: number): Uint8Array {
	const mask = new Uint8Array(nx * ny);
	const stack = [outlet];
	mask[outlet] = 1;
	while (stack.length) {
		const c = stack.pop()!;
		const cx = c % nx;
		const cy = (c - cx) / nx;
		for (let d = 0; d < 8; d++) {
			const x = cx + DX[d]!;
			const y = cy + DY[d]!;
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const k = y * nx + x;
			// Neighbour k drains into c when its direction is the opposite of d.
			if (!mask[k] && dir[k] === (d + 4) % 8) {
				mask[k] = 1;
				stack.push(k);
			}
		}
	}
	return mask;
}

/** Whether the catchment reaches a cell beside an edge (so it may continue past the window) and whether that edge is no data's. */
export function touchesEdge(g: Grid, edge: Uint8Array, mask: Uint8Array): { edge: boolean; noData: boolean } {
	const { nx, ny } = g;
	let atEdge = false;
	let atNoData = false;
	for (let y = 0; y < ny; y++) {
		for (let x = 0; x < nx; x++) {
			if (!mask[y * nx + x]) continue;
			for (let d = 0; d < 8; d++) {
				const xx = x + DX[d]!;
				const yy = y + DY[d]!;
				if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
				const k = yy * nx + xx;
				if (edge[k]) {
					atEdge = true;
					if (edge[k] === NO_DATA_EDGE) atNoData = true;
				}
			}
		}
	}
	return { edge: atEdge, noData: atNoData };
}

/**
 * For every cell, whether its catchment reaches a cell beside the window's
 * border (bit BORDER) or beside the data's (bit NO_DATA_EDGE): what
 * touchesEdge says of `upstream(cell)`, for all cells at once. A catchment
 * reaches an edge exactly when one of its cells is beside one, so each such
 * cell's bits are carried down its D8 path, stopping where they already are:
 * each cell is passed at most twice.
 */
export function openFlags(nx: number, ny: number, dir: Uint8Array, edge: Uint8Array): Uint8Array {
	const flags = new Uint8Array(nx * ny);
	for (let y = 1; y < ny - 1; y++) {
		for (let x = 1; x < nx - 1; x++) {
			const i = y * nx + x;
			if (edge[i]) continue;
			let bits = 0;
			for (let d = 0; d < 8; d++) bits |= edge[i + DY[d]! * nx + DX[d]!]!;
			if (!bits || (flags[i]! & bits) === bits) continue;
			for (let c = i; c >= 0 && !edge[c] && (flags[c]! & bits) !== bits; ) {
				flags[c] = flags[c]! | bits;
				const dd = dir[c]!;
				c = dd === OUT ? -1 : c + DY[dd]! * nx + DX[dd]!;
			}
		}
	}
	return flags;
}
