// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/geo/geojson.ts at f888e4461,
// stripped (docs/data.md § Code to copy): the types, the size limits and checkGeometry with its ring checks
// only. Dropped: the file parser, feature names and kinds, crs handling, centerOf / interiorPoint /
// pointInGeometry and intersectionArea (no caller in Pitman's API yet; Round 5 copies them when it needs them).
//
// GeoJSON in, checked (issue #288, WP-3.12; docs/maps.md § Uploads,
// docs/security.md § Map uploads). Every geometry the server stores passes
// here, whether it came from a file or from a point placed in the app:
//  - WGS84 longitude/latitude only (RFC 7946). A coordinate outside ±180 / ±90
//    (a projected file, e.g. a Lo zone), is refused with a message, never guessed;
//  - 2D only: a third coordinate (an elevation) is refused;
//  - Point, LineString, MultiLineString, Polygon, MultiPolygon; anything
//    else (GeometryCollection, MultiPoint, null) is refused;
//  - a polygon's rings are closed, have at least 4 positions and an area,
//    don't cross themselves, and each hole starts inside its outer ring;
//  - at most GEO_MAX_VERTICES positions per geometry.
import { geometryAreaM2 } from './area.js';
import { clipX, clipY, openRing } from './clip.js';

export type Position = [number, number];
export type GeometryType = 'Point' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
export type Geometry =
	| { type: 'Point'; coordinates: Position }
	| { type: 'LineString'; coordinates: Position[] }
	| { type: 'MultiLineString'; coordinates: Position[][] }
	| { type: 'Polygon'; coordinates: Position[][] }
	| { type: 'MultiPolygon'; coordinates: Position[][][] };

/** Most positions one feature may have. */
export const GEO_MAX_VERTICES = 50_000;
/** Segment pairs the self-intersection check may compare per ring before it gives up and refuses the ring as too complex. */
export const GEO_MAX_PAIR_CHECKS = 5_000_000;
/** Edge visits the overlap sweep (polygonsOverlap) may make before it gives up and refuses the shape as too complex. */
export const GEO_MAX_SWEEP_STEPS = 10_000_000;
/** The share of a shape's area its parts (or holes) may cover twice: digitising slivers between neighbours, never a part counted again. */
export const OVERLAP_SHARE = 0.001;
/** Coordinates are kept to 7 decimals (about 1 cm). */
const DECIMALS = 1e7;

class Refused extends Error {}

const round = (v: number) => Math.round(v * DECIMALS) / DECIMALS;

function position(p: unknown, count: { n: number }): Position {
	if (!Array.isArray(p) || p.length < 2) throw new Refused('a position is not a [longitude, latitude] pair');
	if (p.length > 2) throw new Refused('has 3D coordinates (an elevation); export the file in 2D');
	const [x, y] = p as unknown[];
	if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Refused('a coordinate is not a number');
	if (x < -180 || x > 180 || y < -90 || y > 90) {
		throw new Refused(`has a coordinate (${x}, ${y}) outside longitude/latitude: the file looks projected (a Lo zone or UTM, say); reproject it to WGS84 (EPSG:4326)`);
	}
	if (++count.n > GEO_MAX_VERTICES) throw new Refused(`has more than ${GEO_MAX_VERTICES.toLocaleString('en-ZA')} positions; simplify it`);
	return [round(x), round(y)];
}

function positions(a: unknown, min: number, what: string, count: { n: number }): Position[] {
	if (!Array.isArray(a)) throw new Refused(`a ${what} is not a list of positions`);
	const out = a.map((p) => position(p, count));
	if (out.length < min) throw new Refused(`a ${what} needs at least ${min} positions`);
	return out;
}

/** Signed planar area of a ring in degrees² (for "has an area" and orientation only). */
function planarArea(r: readonly Position[]): number {
	let s = 0;
	for (let i = 0; i < r.length - 1; i++) s += r[i]![0] * r[i + 1]![1] - r[i + 1]![0] * r[i]![1];
	return s / 2;
}

const orient = (a: Position, b: Position, c: Position) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const onSegment = (a: Position, b: Position, c: Position) =>
	Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);

function segmentsCross(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
	const d1 = orient(p3, p4, p1);
	const d2 = orient(p3, p4, p2);
	const d3 = orient(p1, p2, p3);
	const d4 = orient(p1, p2, p4);
	if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
	return (d1 === 0 && onSegment(p3, p4, p1)) || (d2 === 0 && onSegment(p3, p4, p2)) || (d3 === 0 && onSegment(p1, p2, p3)) || (d4 === 0 && onSegment(p1, p2, p4));
}

/**
 * Whether closed rings cross or touch themselves or each other (other than
 * a ring's neighbouring edges sharing their vertex). A sweep over the edges
 * sorted by their least longitude, comparing only edges whose extents
 * overlap. Every comparison counts against GEO_MAX_PAIR_CHECKS, the ones
 * skipped by latitude too, so past it the shape is refused as too complex:
 * a hostile ring (a zigzag whose edges all overlap in longitude) can't cost
 * quadratic time.
 */
export function ringsIntersect(rings: readonly (readonly Position[])[]): boolean {
	const edges: { r: number; i: number; n: number; minX: number }[] = [];
	rings.forEach((ring, r) => {
		const n = ring.length - 1; // edges; the ring is closed
		for (let i = 0; i < n; i++) edges.push({ r, i, n, minX: Math.min(ring[i]![0], ring[i + 1]![0]) });
	});
	edges.sort((a, b) => a.minX - b.minX);
	const active: (typeof edges)[number][] = [];
	let checks = 0;
	for (const e of edges) {
		const ring = rings[e.r]!;
		const a = ring[e.i]!;
		const b = ring[e.i + 1]!;
		let kept = 0;
		for (let k = 0; k < active.length; k++) {
			const o = active[k]!;
			const other = rings[o.r]!;
			const c = other[o.i]!;
			const d = other[o.i + 1]!;
			if (Math.max(c[0], d[0]) < e.minX) continue; // passed: dropped from the sweep
			active[kept++] = o;
			if (++checks > GEO_MAX_PAIR_CHECKS) throw new Refused('has a ring too complex to check; simplify it');
			if (o.r === e.r && (Math.abs(e.i - o.i) === 1 || Math.abs(e.i - o.i) === e.n - 1)) continue;
			if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue;
			if (segmentsCross(a, b, c, d)) return true;
		}
		active.length = kept;
		active.push(e);
	}
	return false;
}

/** Whether one closed ring crosses or touches itself (ringsIntersect of the ring alone). */
export const ringSelfIntersects = (ring: readonly Position[]): boolean => ringsIntersect([ring]);

/** Whether point `p` lies inside ring `r` (ray casting; on the edge counts as outside). */
export function pointInRing(p: Position, r: readonly Position[]): boolean {
	let inside = false;
	for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
		const [xi, yi] = r[i]!;
		const [xj, yj] = r[j]!;
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/**
 * Whether a hole lies inside another hole (its area would be taken away
 * twice). The holes have passed ringsIntersect, so no two cross or touch:
 * each pair is either apart or one wholly inside the other, and one is
 * inside another exactly when its first vertex is. This is GEOS's
 * IndexedNestedHoleTester (IsValidOp, once it knows no rings cross): an
 * index of the holes' boxes, then a point-in-ring test only for a box that
 * holds another, against the ring indexed by its edges' latitudes
 * (IndexedPointInAreaLocator).
 *
 * Sub-quadratic: the holes' boxes are swept by their least longitude, so a
 * hole is compared only with the boxes still open at its west edge, and a
 * pair goes on to the point-in-ring test only when one box holds the other.
 * Each ring with candidates inside its box is indexed once into horizontal
 * strips (about √edges of them, each edge in the strips its latitudes span),
 * so a big hole with thousands of small holes in its box costs its edges
 * once plus a strip per candidate, not its edges per candidate. Every box
 * compared, edge indexed and edge tested counts against GEO_MAX_SWEEP_STEPS;
 * past it the polygon is refused as too complex (the box comparisons are
 * already bounded by ringsIntersect's own sweep: boxes open together at a
 * longitude have edges open together there).
 */
export function holesNested(holes: readonly (readonly Position[])[]): boolean {
	if (holes.length < 2) return false;
	let steps = 0;
	const spend = (n: number) => {
		steps += n;
		if (steps > GEO_MAX_SWEEP_STEPS) throw new Refused('has holes too complex to check; simplify it');
	};
	const boxes = holes.map((r) => {
		let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
		for (const [x, y] of r) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
		return { w, s, e, n };
	});
	spend(holes.reduce((a, r) => a + r.length, 0));
	const holds = (o: number, i: number) => {
		const [a, b] = [boxes[o]!, boxes[i]!];
		return a.w <= b.w && a.e >= b.e && a.s <= b.s && a.n >= b.n;
	};
	// Candidate pairs, by the ring that may hold the other.
	const inside = new Map<number, number[]>();
	const add = (o: number, i: number) => {
		const list = inside.get(o);
		if (list) list.push(i);
		else inside.set(o, [i]);
	};
	const order = holes.map((_, i) => i).sort((a, b) => boxes[a]!.w - boxes[b]!.w);
	const open: number[] = [];
	for (const i of order) {
		const b = boxes[i]!;
		let kept = 0;
		for (let k = 0; k < open.length; k++) {
			const o = open[k]!;
			if (boxes[o]!.e < b.w) continue; // passed: dropped from the sweep
			open[kept++] = o;
			spend(1);
			// Open boxes start at or west of this one: only an equal west edge lets this one hold the other.
			if (holds(o, i)) add(o, i);
			else if (holds(i, o)) add(i, o);
		}
		open.length = kept;
		open.push(i);
	}
	for (const [o, list] of inside) {
		const ring = holes[o]!;
		const { s, n } = boxes[o]!;
		const m = ring.length - 1; // edges; the ring is closed
		const strips = Math.max(1, Math.ceil(Math.sqrt(m)));
		const h = (n - s) / strips;
		const strip = (y: number) => Math.min(strips - 1, Math.max(0, Math.floor((y - s) / h)));
		const index: number[][] = Array.from({ length: strips }, () => []);
		for (let k = 0; k < m; k++) {
			const [lo, hi] = [ring[k]![1], ring[k + 1]![1]];
			const [a, b] = [strip(Math.min(lo, hi)), strip(Math.max(lo, hi))];
			spend(b - a + 1);
			for (let t = a; t <= b; t++) index[t]!.push(k);
		}
		for (const i of list) {
			// pointInRing's ray, over the edges of the point's strip only (an edge crosses latitude y only if it spans it).
			const [px, py] = holes[i]![0]!;
			const edges = index[strip(py)]!;
			spend(edges.length);
			let odd = false;
			for (const k of edges) {
				const [xi, yi] = ring[k]!;
				const [xj, yj] = ring[k + 1]!;
				if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) odd = !odd;
			}
			if (odd) return true;
		}
	}
	return false;
}

/**
 * Whether `groups` overlap by more than `share` of their area: the area
 * inside two of them (in degrees², planar: a ratio over one catchment)
 * against the sum of their own areas. Each group is one region of closed
 * rings read even-odd, rings that don't cross each other (a polygon's outer
 * ring and holes, or one hole alone). Parts of a MultiPolygon that overlap,
 * or a hole inside another hole, make the area count twice (or take it away
 * twice), so the checks refuse them. Parts that share an edge, as
 * neighbouring quaternaries do, pass, and so do the slivers where two
 * independently digitised neighbours overlap a little along their shared
 * boundary: the DWS quaternaries overlap by up to 0.023 % of a group's area,
 * so OVERLAP_SHARE leaves several times that. (Holes inside holes are
 * holesNested's: rings that can't cross need no area sweep.)
 *
 * Two groups can overlap only inside the box their boxes share, so each
 * pair whose boxes meet is clipped to that box (geo/clip.ts) and swept
 * there: over the horizontal slabs between successive vertex latitudes,
 * where no ring has a vertex and each edge is straight, the width inside
 * both is measured at the slab's bottom, middle and top (a group inside
 * while an odd number of its edges lie to the west) and integrated by
 * Simpson's rule. Every vertex clipped and every edge visited counts against
 * GEO_MAX_SWEEP_STEPS; past it the shape is refused as too complex, so a
 * hostile file can't cost quadratic time.
 */
export function polygonsOverlap(groups: readonly (readonly (readonly Position[])[])[], share = OVERLAP_SHARE): boolean {
	const boxes = groups.map((rings) => {
		let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
		for (const r of rings) for (const [x, y] of r) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
		return { w, s, e, n };
	});
	// The groups' own areas, holes taken away.
	const own = groups.reduce((sum, rings) => sum + Math.abs(Math.abs(planarArea(rings[0]!)) - rings.slice(1).reduce((h, r) => h + Math.abs(planarArea(r)), 0)), 0);
	const limit = share * own;
	const work = { steps: 0 };
	const spend = (n: number) => {
		work.steps += n;
		if (work.steps > GEO_MAX_SWEEP_STEPS) throw new Refused('has parts too complex to check for overlaps; simplify it');
	};
	let overlap = 0;
	for (let i = 0; i < groups.length; i++) {
		for (let j = i + 1; j < groups.length; j++) {
			const [a, b] = [boxes[i]!, boxes[j]!];
			spend(1);
			const box = { w: Math.max(a.w, b.w), s: Math.max(a.s, b.s), e: Math.min(a.e, b.e), n: Math.min(a.n, b.n) };
			if (box.w >= box.e || box.s >= box.n) continue;
			const clipped = [groups[i]!, groups[j]!].map((rings) =>
				rings.flatMap((r) => {
					spend(r.length);
					const c = clipY(clipX(openRing(r), box.w, box.e), box.s, box.n);
					return c.length >= 3 ? [c] : [];
				})
			);
			if (!clipped[0]!.length || !clipped[1]!.length) continue;
			overlap += twiceCovered(clipped, spend);
			if (overlap > limit) return true;
		}
	}
	return false;
}

/** The area (degrees²) inside both of two groups of open rings (each read even-odd): polygonsOverlap's slab sweep. */
function twiceCovered(groups: readonly (readonly Position[])[][], spend: (n: number) => void): number {
	// Each edge from its lower end to its upper (so an edge two groups share is computed identically for both); flat edges cross no slab.
	const edges: { g: number; x0: number; y0: number; x1: number; y1: number }[] = [];
	groups.forEach((rings, g) => {
		for (const r of rings) {
			for (let i = 0; i < r.length; i++) {
				const p = r[i]!;
				const q = r[(i + 1) % r.length]!;
				const [lo, hi] = p[1] <= q[1] ? [p, q] : [q, p];
				if (lo[1] !== hi[1]) edges.push({ g, x0: lo[0], y0: lo[1], x1: hi[0], y1: hi[1] });
			}
		}
	});
	edges.sort((a, b) => a.y0 - b.y0);
	const ys = [...new Set(edges.flatMap((e) => [e.y0, e.y1]))].sort((a, b) => a - b);
	const xAt = (e: (typeof edges)[number], y: number) => (y === e.y0 ? e.x0 : y === e.y1 ? e.x1 : e.x0 + ((e.x1 - e.x0) * (y - e.y0)) / (e.y1 - e.y0));
	/** The width inside both groups along latitude y, of the edges crossing it. */
	const both = (crossing: readonly (typeof edges)[number][], y: number) => {
		const row = crossing.map((e) => ({ g: e.g, x: xAt(e, y) })).sort((a, b) => a.x - b.x);
		const inside = [false, false];
		let w = 0;
		for (let i = 0; i < row.length - 1; i++) {
			inside[row[i]!.g] = !inside[row[i]!.g];
			if (inside[0] && inside[1]) w += row[i + 1]!.x - row[i]!.x;
		}
		return w;
	};
	let active: (typeof edges)[number][] = [];
	let next = 0;
	let area = 0;
	for (let k = 0; k < ys.length - 1; k++) {
		const lo = ys[k]!;
		const hi = ys[k + 1]!;
		active = active.filter((e) => e.y1 > lo);
		while (next < edges.length && edges[next]!.y0 <= lo) active.push(edges[next++]!);
		spend(3 * active.length);
		// Every active edge spans the whole slab, so the three lines cross the same edges.
		area += ((hi - lo) * (both(active, lo) + 4 * both(active, (lo + hi) / 2) + both(active, hi))) / 6;
	}
	return area;
}

function ring(a: unknown, count: { n: number }): Position[] {
	// A position repeated in a row (common in digitised files) is one vertex.
	const r = positions(a, 4, 'polygon ring', count).filter((p, i, all) => i === 0 || p[0] !== all[i - 1]![0] || p[1] !== all[i - 1]![1]);
	if (r.length < 4) throw new Refused('a polygon ring needs at least 4 positions');
	const [f, l] = [r[0]!, r[r.length - 1]!];
	if (f[0] !== l[0] || f[1] !== l[1]) throw new Refused('has a polygon ring that is not closed (its last position must repeat its first)');
	if (planarArea(r) === 0) throw new Refused('has a polygon ring with no area');
	return r;
}

function polygon(a: unknown, count: { n: number }): Position[][] {
	if (!Array.isArray(a) || a.length === 0) throw new Refused('a polygon has no rings');
	const rings = a.map((r) => ring(r, count));
	// One sweep over every ring: a ring that crosses itself, or a hole that crosses its outer ring or another hole.
	if (ringsIntersect(rings)) throw new Refused(rings.length === 1 ? 'has a polygon ring that crosses itself' : 'has polygon rings that cross themselves or each other');
	for (const hole of rings.slice(1)) {
		if (!pointInRing(hole[0]!, rings[0]!)) throw new Refused('has a hole outside its polygon');
	}
	// The rings don't cross, so a hole can still lie inside another: its area would be taken away twice.
	if (rings.length > 2 && holesNested(rings.slice(1))) throw new Refused('has a hole inside another hole');
	const xs = rings[0]!.map((p) => p[0]);
	if (Math.max(...xs) - Math.min(...xs) > 180) throw new Refused('crosses the antimeridian, which isn’t supported');
	return rings;
}

/** A checked geometry, or throws Refused with what is wrong. */
function geometry(g: unknown): Geometry {
	if (g === null || typeof g !== 'object' || Array.isArray(g)) throw new Refused('has no geometry');
	const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
	const count = { n: 0 };
	switch (type) {
		case 'Point':
			return { type, coordinates: position(coordinates, count) };
		case 'LineString':
			return { type, coordinates: positions(coordinates, 2, 'line', count) };
		case 'MultiLineString':
			if (!Array.isArray(coordinates) || coordinates.length === 0) throw new Refused('a MultiLineString has no lines');
			return { type, coordinates: coordinates.map((l) => positions(l, 2, 'line', count)) };
		case 'Polygon':
			return { type, coordinates: polygon(coordinates, count) };
		case 'MultiPolygon':
			if (!Array.isArray(coordinates) || coordinates.length === 0) throw new Refused('a MultiPolygon has no polygons');
			const polygons = coordinates.map((p) => polygon(p, count));
			// Overlapping parts would count the overlap twice in the area (and in every share taken from it).
			if (polygons.length > 1 && polygonsOverlap(polygons)) throw new Refused('has MultiPolygon parts that overlap; merge them into one polygon');
			return { type, coordinates: polygons };
		default:
			throw new Refused(
				`has a ${typeof type === 'string' ? type : 'missing'} geometry; the map takes Point, LineString, MultiLineString, Polygon and MultiPolygon`
			);
	}
}

/** One geometry, checked: `{ geometry }` or `{ problem }` (a sentence starting lowercase, "has …"). */
export function checkGeometry(g: unknown): { geometry: Geometry; areaM2: number | null } | { problem: string } {
	try {
		const out = geometry(g);
		return { geometry: out, areaM2: geometryAreaM2(out) };
	} catch (e) {
		if (e instanceof Refused) return { problem: e.message };
		throw e;
	}
}
