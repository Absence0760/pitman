// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/geo/clip.ts at f888e4461
// Polygon clipping against a grid's rows and cells, shared by the CHIRPS
// cells a boundary covers (feeds/boundaryCells.ts, issue #326 B-rain) and the
// land-cover cells a parcel covers (geo/gridShares.ts, B-landcover).
//
// Sutherland–Hodgman against axis-parallel half-planes. A cell is convex, so
// clipping a concave ring to it still gives a polygon whose signed area is
// exactly the area of the intersection: the extra edges the algorithm leaves
// along the cell's sides run there and back and cancel.
import type { Position } from './geojson.js';

/** Twice the signed area of a ring (shoelace, any closure). */
export function signedArea2(ring: readonly Position[]): number {
	let s = 0;
	for (let i = 0, n = ring.length; i < n; i++) {
		const [x1, y1] = ring[i]!;
		const [x2, y2] = ring[(i + 1) % n]!;
		s += x1 * y2 - x2 * y1;
	}
	return s;
}

/** Sutherland–Hodgman against one half-plane: keep points where `inside` holds, cutting each crossing edge at `cut`. */
function clipHalf(ring: readonly Position[], inside: (p: Position) => boolean, cut: (a: Position, b: Position) => Position): Position[] {
	const out: Position[] = [];
	const n = ring.length;
	for (let i = 0; i < n; i++) {
		const cur = ring[i]!;
		const prev = ring[(i + n - 1) % n]!;
		const inCur = inside(cur);
		if (inCur !== inside(prev)) out.push(cut(prev, cur));
		if (inCur) out.push(cur);
	}
	return out;
}

const atY = (y: number) => (a: Position, b: Position): Position => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
const atX = (x: number) => (a: Position, b: Position): Position => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];

/** A ring clipped to the band lo ≤ y ≤ hi. */
export function clipY(ring: readonly Position[], lo: number, hi: number): Position[] {
	const a = clipHalf(ring, (p) => p[1] >= lo, atY(lo));
	return a.length ? clipHalf(a, (p) => p[1] <= hi, atY(hi)) : a;
}

/** A ring clipped to the band lo ≤ x ≤ hi. */
export function clipX(ring: readonly Position[], lo: number, hi: number): Position[] {
	const a = clipHalf(ring, (p) => p[0] >= lo, atX(lo));
	return a.length ? clipHalf(a, (p) => p[0] <= hi, atX(hi)) : a;
}

/** A ring without its closing repeat of the first position. */
export const openRing = (ring: readonly Position[]): Position[] => {
	const n = ring.length;
	return n > 1 && ring[0]![0] === ring[n - 1]![0] && ring[0]![1] === ring[n - 1]![1] ? ring.slice(0, -1) : [...ring];
};

/**
 * The most vertices one polygon's summary over a grid may clip (eachBand's
 * `work`), about a second of CPU. Halving keeps an ordinary outline well
 * below it (a 48 000-vertex circle over 200 × 200 cells clips under 2
 * million), but no clipping order helps a shape whose every row holds all its
 * vertices (a comb whose teeth run its full height): its pieces alone are
 * vertices × rows. Past this the summary is refused (GridWorkExceeded), not
 * computed for minutes.
 */
export const GRID_WORK_BUDGET = 8_000_000;

/** Thrown by eachBand when `work.vertices` passes `work.limit`. */
export class GridWorkExceeded extends Error {
	constructor(readonly limit: number) {
		super(`more than ${limit} vertices to clip`);
	}
}

/** A ring's piece and its sign: + an outer ring, − a hole. */
export interface SignedPiece {
	ring: Position[];
	sign: number;
}

/**
 * Visits each band i in [lo, hi) of width `cellDeg` along `axis` (band i is
 * i × cellDeg ≤ coordinate ≤ (i + 1) × cellDeg) that the pieces reach, with
 * the pieces clipped to it. The range is halved, the pieces clipped to each
 * half, until one band is left, so the work is about the vertices times
 * log(bands) plus the cuts, never vertices × bands: a ring with tens of
 * thousands of vertices (a crafted comb) over a few hundred cells costs no
 * more than a few passes over it, where clipping the whole ring to every
 * cell cost minutes (docs/security.md § Map uploads). `work`, when given,
 * counts the vertices clipped, and past its `limit` throws GridWorkExceeded.
 */
export function eachBand(
	pieces: readonly SignedPiece[],
	lo: number,
	hi: number,
	cellDeg: number,
	axis: 'x' | 'y',
	visit: (i: number, pieces: SignedPiece[]) => void,
	work?: { vertices: number; limit?: number }
): void {
	const clip = axis === 'x' ? clipX : clipY;
	const to = (ps: readonly SignedPiece[], a: number, b: number) => {
		const out: SignedPiece[] = [];
		for (const p of ps) {
			if (work) {
				work.vertices += p.ring.length;
				if (work.limit !== undefined && work.vertices > work.limit) throw new GridWorkExceeded(work.limit);
			}
			const ring = clip(p.ring, a * cellDeg, b * cellDeg);
			if (ring.length >= 3) out.push({ ring, sign: p.sign });
		}
		return out;
	};
	const walk = (ps: SignedPiece[], a: number, b: number): void => {
		if (!ps.length || a >= b) return;
		if (b - a === 1) {
			const leaf = to(ps, a, b);
			if (leaf.length) visit(a, leaf);
			return;
		}
		const mid = a + Math.floor((b - a) / 2);
		walk(to(ps, a, mid), a, mid);
		walk(to(ps, mid, b), mid, b);
	};
	walk([...pieces], lo, hi);
}
