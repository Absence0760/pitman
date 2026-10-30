// Ported from IC-WBT (Absence0760/project-water-management, MIT) frontend/src/lib/components/map/pieces.ts at f888e4461,
// keeping interiorPoint and pieceTintsFor; the bounds helpers are Pitman's own.
//
// Where a piece's number goes and which tint it takes, and the boxes the map
// frames. Pure, so vitest checks it.
import type { AreaGeometry } from '@pitman/wrsm';
import { PIECE_TINT_COUNT } from './palette.js';

export type Position = readonly [number, number];
/** `[west, south, east, north]`. */
export type Box = readonly [number, number, number, number];

const ringsOf = (g: AreaGeometry): readonly (readonly Position[])[] => (g.type === 'Polygon' ? g.coordinates : g.coordinates.flat());

/** A geometry's box; null when it has no positions. */
export function boxOf(g: AreaGeometry): Box | null {
	let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const ring of ringsOf(g)) {
		for (const [x, y] of ring) {
			w = Math.min(w, x);
			s = Math.min(s, y);
			e = Math.max(e, x);
			n = Math.max(n, y);
		}
	}
	return w <= e ? [w, s, e, n] : null;
}

/** The box around several geometries; null when none has positions. */
export function boxOfAll(geometries: readonly AreaGeometry[]): Box | null {
	let out: Box | null = null;
	for (const g of geometries) {
		const b = boxOf(g);
		if (!b) continue;
		out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : b;
	}
	return out;
}

/** Boxes that touch or overlap, by a hair: taken as neighbours (more than the true neighbours, never fewer). */
const touching = (a: Box, b: Box) => {
	const e = 1e-9;
	return a[0] <= b[2] + e && b[0] <= a[2] + e && a[1] <= b[3] + e && b[1] <= a[3] + e;
};

/**
 * Tints for pieces so that neighbours differ: greedy, in the plan's order,
 * each takes the first tint none of its neighbours has, and where all are
 * taken, the one fewest neighbours share. Neighbours are pieces whose boxes
 * touch, so never fewer than the true ones.
 */
export function pieceTintsFor(geometries: readonly AreaGeometry[]): number[] {
	const boxes = geometries.map(boxOf);
	const tints: number[] = [];
	boxes.forEach((b, i) => {
		const count = new Array<number>(PIECE_TINT_COUNT).fill(0);
		for (let j = 0; j < i; j++) {
			const other = boxes[j];
			if (b && other && touching(b, other)) count[tints[j] as number]! += 1;
		}
		const free = count.indexOf(0);
		tints.push(free >= 0 ? free : count.indexOf(Math.min(...count)));
	});
	return tints;
}

function ringArea(r: readonly Position[]): number {
	let a = 0;
	for (let i = 0; i + 1 < r.length; i++) a += r[i]![0] * r[i + 1]![1] - r[i + 1]![0] * r[i]![1];
	return a / 2;
}

/**
 * A point inside a polygon (holes kept out), for a label or a piece's number:
 * the middle of the widest stretch of the horizontal line through the outer
 * ring's centroid that lies inside the polygon. Inside by construction, unlike
 * the centroid of a crescent or of a piece with a hole in its middle. Null when
 * the ring is degenerate.
 */
export function interiorPoint(g: AreaGeometry): Position | null {
	const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
	let best: (typeof polys)[number] | null = null;
	let bestArea = -1;
	for (const p of polys) {
		const a = Math.abs(ringArea(p[0] ?? []));
		if (a > bestArea) {
			bestArea = a;
			best = p;
		}
	}
	if (!best || bestArea <= 0) return null;
	const outer = best[0]!;
	let cy = 0;
	let wsum = 0;
	for (let i = 0; i + 1 < outer.length; i++) {
		const [x0, y0] = outer[i]!;
		const [x1, y1] = outer[i + 1]!;
		const cross = x0 * y1 - x1 * y0;
		cy += (y0 + y1) * cross;
		wsum += cross;
	}
	const y = wsum ? cy / (3 * wsum) : outer[0]![1];
	const xs: number[] = [];
	for (const ring of best) {
		for (let i = 0; i + 1 < ring.length; i++) {
			const [ax, ay] = ring[i]!;
			const [bx, by] = ring[i + 1]!;
			if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
		}
	}
	xs.sort((a, b) => a - b);
	let mid: number | null = null;
	let width = -1;
	for (let k = 0; k + 1 < xs.length; k += 2) {
		if (xs[k + 1]! - xs[k]! > width) {
			width = xs[k + 1]! - xs[k]!;
			mid = (xs[k]! + xs[k + 1]!) / 2;
		}
	}
	return mid === null ? null : [mid, y];
}
