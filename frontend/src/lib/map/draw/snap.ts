// Ported from IC-WBT (Absence0760/project-water-management, MIT) frontend/src/lib/components/map/draw/snap.ts at f888e4461;
// the targets are the map's quaternaries and pieces rather than IC-WBT's features.
//
// Snapping while drawing: a corner placed (or dragged) near a quaternary's or a
// piece's corner or edge lands exactly on it, so a zone drawn against the
// boundary shares its edge, with no sliver. With "Follow edges" on, two corners
// in a row on the same outline also take the corners between them along it (the
// shorter way round). Pure (no MapLibre): the map hands in its projection, so
// vitest covers it.
import type { AreaGeometry } from '@pitman/wrsm';
import type { Position } from '../pieces.js';

/** A screen point, px. */
export type ScreenPt = { x: number; y: number };

/** One outline a corner can snap to. */
export interface SnapLine {
	featureId: string;
	/** Which of the feature's rings (0 for most). */
	part: number;
	/** What the said line names: “Z01A” or “piece 2”. */
	label: string;
	/** Its corners; an outline's are not closed (the last isn't the first again). */
	coords: Position[];
	/** An outline: its last corner joins its first. */
	closed: boolean;
}

/** Where a corner snapped: the position, on which line, and where along it (a corner's index, or an edge's index plus how far along). */
export interface SnapHit {
	at: Position;
	line: SnapLine;
	/** Along the line: corner i is i; a point on the edge from corner i to i+1 is i + t (0 < t < 1). */
	pos: number;
	what: 'corner' | 'edge';
}

/** How near (px) a corner or edge must be to catch the pointer: the draft's own corner hit area. */
export const SNAP_PX = 12;

const ringOf = (r: readonly Position[]): Position[] => {
	const c = r.map((p) => [p[0], p[1]] as Position);
	if (c.length > 1 && c[0]![0] === c[c.length - 1]![0] && c[0]![1] === c[c.length - 1]![1]) c.pop();
	return c;
};

/** What a drawing can snap to: every ring of these geometries. */
export function snapLines(features: readonly { id: string; label: string; geometry: AreaGeometry }[]): SnapLine[] {
	const out: SnapLine[] = [];
	for (const f of features) {
		const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
		rings.forEach((r, part) => {
			const coords = ringOf(r);
			if (coords.length) out.push({ featureId: f.id, part, label: f.label, coords, closed: true });
		});
	}
	return out;
}

const d2 = (a: ScreenPt, b: ScreenPt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Whether a line's bounding box meets a lon/lat box (west, south, east, north). */
function meets(l: SnapLine, box: readonly [number, number, number, number]): boolean {
	let w = Infinity,
		s = Infinity,
		e = -Infinity,
		n = -Infinity;
	for (const p of l.coords) {
		if (p[0] < w) w = p[0];
		if (p[0] > e) e = p[0];
		if (p[1] < s) s = p[1];
		if (p[1] > n) n = p[1];
	}
	return !(e < box[0] || w > box[2] || n < box[1] || s > box[3]);
}

/** 7 decimals (~1 cm), the geometry check's own rounding. */
const round = (v: number) => Math.round(v * 1e7) / 1e7;

/**
 * The corner or edge nearest the screen point `p` within `tolPx`, or null.
 * A corner wins over an edge whenever one is in reach (so a shared corner is
 * met exactly); among edges, the nearest. `project` is the map's lon/lat →
 * screen px; `box`, when given, skips lines whose bounds miss it (the
 * pointer's reach in lon/lat), so a long list is cheap per mouse move.
 */
export function snapPoint(
	p: ScreenPt,
	lines: readonly SnapLine[],
	project: (q: Position) => ScreenPt,
	tolPx = SNAP_PX,
	box?: readonly [number, number, number, number]
): SnapHit | null {
	const tol2 = tolPx * tolPx;
	let corner: { hit: SnapHit; d: number } | null = null;
	let edge: { hit: SnapHit; d: number } | null = null;
	for (const l of lines) {
		if (box && !meets(l, box)) continue;
		const sc = l.coords.map(project);
		for (let i = 0; i < sc.length; i++) {
			const d = d2(p, sc[i]!);
			if (d <= tol2 && (!corner || d < corner.d)) corner = { hit: { at: [l.coords[i]![0], l.coords[i]![1]], line: l, pos: i, what: 'corner' }, d };
		}
		if (corner) continue;
		const edges = l.closed && sc.length >= 3 ? sc.length : sc.length - 1;
		for (let i = 0; i < edges; i++) {
			const a = sc[i]!;
			const b = sc[(i + 1) % sc.length]!;
			const len2 = d2(a, b);
			if (len2 === 0) continue;
			const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
			if (t === 0 || t === 1) continue; // at a corner: the corner pass decides
			const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
			const d = d2(p, q);
			if (d > tol2 || (edge && d >= edge.d)) continue;
			// Web Mercator is conformal: along one short edge, screen and lon/lat move in step closely enough at a few px.
			const A = l.coords[i]!;
			const B = l.coords[(i + 1) % l.coords.length]!;
			edge = { hit: { at: [round(A[0] + t * (B[0] - A[0])), round(A[1] + t * (B[1] - A[1]))], line: l, pos: i + t, what: 'edge' }, d };
		}
	}
	return corner?.hit ?? edge?.hit ?? null;
}

/** Approximate ground length of a path (degrees of longitude scaled by the cosine of the latitude): only to compare two ways round. */
function pathLength(pts: readonly Position[]): number {
	let s = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
		s += Math.hypot((b[0] - a[0]) * k, b[1] - a[1]);
	}
	return s;
}

const EPS = 1e-9;

/**
 * The corners of `line` strictly between two positions along it (SnapHit
 * `pos`), in order from `from` to `to`, the shorter way round the outline.
 * Empty when they are the same place or neighbours on one edge.
 */
export function traceAlong(line: SnapLine, from: number, to: number, fromAt: Position, toAt: Position): Position[] {
	const n = line.coords.length;
	const at = (k: number) => line.coords[((k % n) + n) % n]!;
	if (!line.closed) {
		const out: Position[] = [];
		if (to > from) for (let k = Math.floor(from) + 1; k < to - EPS; k++) out.push(at(k));
		else for (let k = Math.ceil(from) - 1; k > to + EPS; k--) out.push(at(k));
		return out;
	}
	if (n < 3) return [];
	const fwdTo = (((to - from) % n) + n) % n;
	const bwdTo = (((from - to) % n) + n) % n;
	if (fwdTo < EPS || bwdTo < EPS) return [];
	const fwd: Position[] = [];
	for (let k = Math.floor(from + EPS) + 1; k - from < fwdTo - EPS; k++) fwd.push(at(k));
	const bwd: Position[] = [];
	for (let k = Math.ceil(from - EPS) - 1; from - k < bwdTo - EPS; k--) bwd.push(at(k));
	return pathLength([fromAt, ...fwd, toAt]) <= pathLength([fromAt, ...bwd, toAt]) ? fwd : bwd;
}

/** Two hits on the same outline: the second can follow the first along it. */
export const sameLine = (a: SnapHit | null, b: SnapHit | null): boolean => !!a && !!b && a.line.featureId === b.line.featureId && a.line.part === b.line.part;
