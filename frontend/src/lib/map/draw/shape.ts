// Ported from IC-WBT (Absence0760/project-water-management, MIT) frontend/src/lib/components/map/draw/shape.ts at f888e4461,
// stripped to polygons: Pitman draws one kind of shape, a MAP zone.
//
// A drawing's corners, the geometry they make, and what stops it being used.
// Pure (no MapLibre), so vitest covers it and the bar and the map agree. The
// wizard and the server check the geometry again.
import type { AreaGeometry } from '@pitman/wrsm';
import type { Position } from '../pieces.js';

const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];

/** The corners with a corner repeated in a row (a double click) taken as one, and the closing repeat dropped. */
export function distinctCorners(coords: readonly Position[]): Position[] {
	const out = coords.filter((p, i) => i === 0 || !same(p, coords[i - 1]!));
	if (out.length > 1 && same(out[0]!, out[out.length - 1]!)) out.pop();
	return out;
}

/** The polygon a draft makes, its ring closed here, or null while it has too few corners. */
export function geometryOf(coords: readonly Position[]): AreaGeometry | null {
	const c = distinctCorners(coords);
	return c.length >= 3 ? { type: 'Polygon', coordinates: [[...c, c[0]!]] } : null;
}

/** The corners of a polygon of one outline and no holes (or a "multi" of one), or null: that is used whole, not reshaped corner by corner. */
export function editableCorners(g: AreaGeometry): Position[] | null {
	if (g.type === 'MultiPolygon') return g.coordinates.length === 1 ? editableCorners({ type: 'Polygon', coordinates: g.coordinates[0]! }) : null;
	return g.coordinates.length === 1 ? distinctCorners(g.coordinates[0]!) : null;
}

const orient = (a: Position, b: Position, c: Position) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const onSegment = (a: Position, b: Position, c: Position) =>
	Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);

/** Whether segments p1–p2 and p3–p4 cross or touch. */
export function segmentsCross(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
	const d1 = orient(p3, p4, p1);
	const d2 = orient(p3, p4, p2);
	const d3 = orient(p1, p2, p3);
	const d4 = orient(p1, p2, p4);
	if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
	return (d1 === 0 && onSegment(p3, p4, p1)) || (d2 === 0 && onSegment(p3, p4, p2)) || (d3 === 0 && onSegment(p1, p2, p3)) || (d4 === 0 && onSegment(p1, p2, p4));
}

/** Whether an outline (its corners, not closed) crosses or touches itself anywhere but where neighbouring edges meet. */
export function outlineCrosses(corners: readonly Position[]): boolean {
	const n = corners.length;
	if (n < 4) return false;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (j === i + 1 || (i === 0 && j === n - 1)) continue;
			if (segmentsCross(corners[i]!, corners[(i + 1) % n]!, corners[j]!, corners[(j + 1) % n]!)) return true;
		}
	}
	return false;
}

/** Twice the signed planar area of an outline (degrees²): zero when its corners are in a line. */
function planarArea2(c: readonly Position[]): number {
	let s = 0;
	for (let i = 0; i < c.length; i++) {
		const a = c[i]!;
		const b = c[(i + 1) % c.length]!;
		s += a[0] * b[1] - b[0] * a[1];
	}
	return s;
}

/** Why a draft can't be used yet, in a sentence, or null when it can. */
export function draftProblem(coords: readonly Position[]): string | null {
	const c = distinctCorners(coords);
	if (c.length < 3) return 'A shape needs at least three corners.';
	// Crossing first: a symmetric bow tie's signed area is zero too, and "crosses itself" is what's wrong with it.
	if (outlineCrosses(c)) return 'Its outline crosses itself: move or remove a corner so the edges don’t cross.';
	if (planarArea2(c) === 0) return 'Its corners are all in a line, so it has no area.';
	return null;
}

/** Whether the draft has the corners to close (Finish), whatever else is wrong. */
export const canFinish = (coords: readonly Position[]) => distinctCorners(coords).length >= 3;

/** The middle of each edge (the closing edge too): a click there adds a corner after `after`. */
export function midpoints(coords: readonly Position[]): { at: Position; after: number }[] {
	const out: { at: Position; after: number }[] = [];
	const n = coords.length;
	const edges = n >= 3 ? n : n - 1;
	for (let i = 0; i < edges; i++) {
		const a = coords[i]!;
		const b = coords[(i + 1) % n]!;
		out.push({ at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], after: i });
	}
	return out;
}

/** The corners with one removed, unless that leaves fewer than three. */
export function withoutCorner(coords: readonly Position[], i: number): Position[] | null {
	if (coords.length - 1 < 3 || i < 0 || i >= coords.length) return null;
	return coords.filter((_, k) => k !== i);
}
