/**
 * A zone pasted as GeoJSON or WKT, checked as an upload is (subdivide.md
 * § MAP-zone split): closed, simple rings, holes inside, size limits. GeoJSON
 * goes through the extension's `parseArea`, so a pasted polygon and an
 * uploaded boundary answer alike; WKT is turned into GeoJSON first.
 */

import type { AreaGeometry } from '@pitman/wrsm';
import { parseArea } from '#lib/extend/area.js';

type Position = readonly [number, number];
type Ring = readonly Position[];

/** Segment pairs compared before a zone is refused as too complex (the backend's limit, `GEO_MAX_PAIR_CHECKS`). */
const MAX_PAIR_CHECKS = 5_000_000;

const orient = (a: Position, b: Position, c: Position) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const onSegment = (a: Position, b: Position, c: Position) =>
	Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);

function segmentsTouch(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
	const d1 = orient(p3, p4, p1);
	const d2 = orient(p3, p4, p2);
	const d3 = orient(p1, p2, p3);
	const d4 = orient(p1, p2, p4);
	if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
	return (d1 === 0 && onSegment(p3, p4, p1)) || (d2 === 0 && onSegment(p3, p4, p2)) || (d3 === 0 && onSegment(p1, p2, p3)) || (d4 === 0 && onSegment(p1, p2, p4));
}

/** Whether a closed ring crosses or touches itself, neighbouring edges apart. */
export function ringCrosses(ring: Ring): boolean | 'too complex' {
	const n = ring.length - 1;
	let checks = 0;
	for (let i = 0; i < n; i++) {
		const a = ring[i] as Position;
		const b = ring[i + 1] as Position;
		for (let j = i + 2; j < n; j++) {
			if (i === 0 && j === n - 1) continue; // the ring's last edge meets its first at the closing point
			if (++checks > MAX_PAIR_CHECKS) return 'too complex';
			if (segmentsTouch(a, b, ring[j] as Position, ring[j + 1] as Position)) return true;
		}
	}
	return false;
}

function insideRing(p: Position, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i] as Position;
		const [xj, yj] = ring[j] as Position;
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** The first problem with a geometry's rings, in words, or `null`. */
export function ringProblem(geometry: AreaGeometry): string | null {
	const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
	for (const [i, rings] of polygons.entries()) {
		const where = polygons.length > 1 ? `Polygon ${i + 1}` : 'The polygon';
		for (const ring of rings) {
			const crosses = ringCrosses(ring);
			if (crosses === 'too complex') return `${where} is too complex to check: simplify it.`;
			if (crosses) return `${where} crosses itself. Redraw it so its edge never meets itself.`;
		}
		const [outer, ...holes] = rings;
		if (outer !== undefined && holes.some((hole) => !insideRing(hole[0] as Position, outer))) return `${where} has a hole outside its outer ring.`;
	}
	return null;
}

class BadWkt extends Error {}

/** `(lon lat, lon lat, …)` lists nested to `depth`, as JSON text (the parser's checks then apply to it). */
function wktCoordinates(text: string, depth: number): string {
	const body = text.trim();
	if (!body.startsWith('(') || !body.endsWith(')')) throw new BadWkt('its brackets don’t match');
	const inner = body.slice(1, -1);
	if (depth === 1) {
		const points = inner.split(',').map((point) => {
			const parts = point.trim().split(/\s+/);
			if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(Number(p)))) throw new BadWkt(`“${point.trim().slice(0, 40)}” is not a longitude and a latitude`);
			return `[${parts[0]},${parts[1]}]`;
		});
		return `[${points.join(',')}]`;
	}
	const parts: string[] = [];
	let level = 0;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (c === '(') {
			if (level === 0) start = i;
			level += 1;
		} else if (c === ')') {
			level -= 1;
			if (level < 0) throw new BadWkt('its brackets don’t match');
			if (level === 0) parts.push(wktCoordinates(inner.slice(start, i + 1), depth - 1));
		}
	}
	if (level !== 0 || parts.length === 0) throw new BadWkt('its brackets don’t match');
	return `[${parts.join(',')}]`;
}

/** WKT `POLYGON` / `MULTIPOLYGON` as GeoJSON text. */
export function wktToGeoJson(text: string): string {
	const match = /^\s*(MULTIPOLYGON|POLYGON)\s*(?:Z\s*)?(\(.*\))\s*$/is.exec(text);
	if (!match) throw new BadWkt('it isn’t a POLYGON or a MULTIPOLYGON');
	const multi = (match[1] as string).toUpperCase() === 'MULTIPOLYGON';
	return `{"type":"${multi ? 'MultiPolygon' : 'Polygon'}","coordinates":${wktCoordinates(match[2] as string, multi ? 3 : 2)}}`;
}

export type PasteResult = { readonly ok: true; readonly geometry: AreaGeometry } | { readonly ok: false; readonly error: string };

/** A pasted zone, checked. Never throws: a refusal is `{ ok: false, error }`. */
export function parseZone(text: string): PasteResult {
	const trimmed = text.trim();
	if (trimmed === '') return { ok: false, error: 'Paste a polygon first: GeoJSON, or WKT such as POLYGON ((20.1 -33.5, 20.2 -33.5, 20.2 -33.4, 20.1 -33.5)).' };
	let json = trimmed;
	if (!trimmed.startsWith('{')) {
		try {
			json = wktToGeoJson(trimmed);
		} catch (error) {
			if (error instanceof BadWkt) return { ok: false, error: `That isn’t GeoJSON, and it can’t be read as WKT: ${error.message}.` };
			throw error;
		}
	}
	const parsed = parseArea(json);
	if (!parsed.ok) return parsed;
	const problem = ringProblem(parsed.geometry);
	return problem === null ? { ok: true, geometry: parsed.geometry } : { ok: false, error: problem };
}
