/**
 * The area a `.RAN` file represents, uploaded as GeoJSON (decision D-1: no
 * licensed quaternary boundaries yet, so the user brings their own). The
 * upload is checked here, before anything is sent, and reduced to a bare
 * Polygon or MultiPolygon: the backend receives that geometry only, never
 * the file's properties or anything else from the network (issue #3 rule 7).
 *
 * Accepted: a Polygon or MultiPolygon geometry, a Feature holding one, or a
 * FeatureCollection of such Features (their polygons become one
 * MultiPolygon). WGS84 longitude/latitude only (RFC 7946).
 */

import type { AreaGeometry } from '@pitman/wrsm';

type Position = readonly [number, number];
type Ring = readonly Position[];
type PolygonCoords = readonly Ring[];

/** The CHIRPS copy's region (extend.md § Edge cases, docs/data.md § CHIRPS): 10–41° E, 35.5–8° S. */
export const CHIRPS_REGION = { west: 10, east: 41, south: -35.5, north: -8 } as const;

/** Largest boundary file read, bytes. A quaternary boundary is tens of kB; 5 MB leaves room for detailed hand-made ones. */
export const MAX_AREA_FILE_BYTES = 5 * 1024 * 1024;
/** Most vertices sent to the backend. */
export const MAX_AREA_VERTICES = 100_000;

/** Mean Earth radius (IUGG), m. */
const EARTH_RADIUS_M = 6_371_008.8;

export interface Bbox {
	readonly west: number;
	readonly south: number;
	readonly east: number;
	readonly north: number;
}

export interface ParsedArea {
	readonly ok: true;
	/** What is sent to `POST ${PUBLIC_API_URL}/chirps/monthly`: the geometry, nothing else. */
	readonly geometry: AreaGeometry;
	/** Area on the sphere, km² (the backend's geodesic figure replaces it once fetched). */
	readonly areaKm2: number;
	readonly polygons: number;
	readonly holes: number;
	readonly vertices: number;
	readonly bbox: Bbox;
	/** Features read from a FeatureCollection (1 otherwise). */
	readonly features: number;
	readonly warnings: readonly string[];
}

export interface AreaError {
	readonly ok: false;
	readonly error: string;
}

export type AreaResult = ParsedArea | AreaError;

class Refused extends Error {}

const refuse = (message: string): never => {
	throw new Refused(message);
};

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function position(v: unknown, where: string): Position {
	if (!Array.isArray(v) || v.length < 2 || v.length > 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
		refuse(`${where}: a position must be [longitude, latitude] in decimal degrees.`);
	}
	const [lon, lat] = v as number[];
	return [lon as number, lat as number];
}

function ring(v: unknown, where: string): Ring {
	if (!Array.isArray(v)) return refuse(`${where}: a ring must be a list of positions.`);
	const points = v.map((p, i) => position(p, `${where}, position ${i + 1}`));
	if (points.length < 4) refuse(`${where}: a ring needs at least 4 positions (a closed triangle).`);
	const first = points[0] as Position;
	const last = points[points.length - 1] as Position;
	if (first[0] !== last[0] || first[1] !== last[1]) refuse(`${where}: the ring is not closed (its last position must repeat the first).`);
	return points;
}

function polygon(v: unknown, where: string): PolygonCoords {
	if (!Array.isArray(v) || v.length === 0) return refuse(`${where}: a polygon must be a list of rings, the outer one first.`);
	return v.map((r, i) => ring(r, v.length === 1 ? where : `${where}, ${i === 0 ? 'outer ring' : `hole ${i}`}`));
}

function geometryPolygons(g: unknown, where: string): PolygonCoords[] {
	if (!isObject(g)) return refuse(`${where}: no geometry.`);
	if (g['type'] === 'Polygon') return [polygon(g['coordinates'], where)];
	if (g['type'] === 'MultiPolygon') {
		const parts = g['coordinates'];
		if (!Array.isArray(parts) || parts.length === 0) return refuse(`${where}: a MultiPolygon must be a list of polygons.`);
		return parts.map((p, i) => polygon(p, `${where}, part ${i + 1}`));
	}
	const type = typeof g['type'] === 'string' ? g['type'] : 'unknown';
	return refuse(`${where} is a ${type}: the area must be a Polygon or MultiPolygon (a boundary, not a point or line).`);
}

/** Read a CRS member (GeoJSON 2008); RFC 7946 dropped it, but old exports still carry one. */
function checkCrs(doc: Record<string, unknown>): void {
	const crs = doc['crs'];
	if (!isObject(crs)) return;
	const name = isObject(crs['properties']) ? String(crs['properties']['name'] ?? '') : '';
	if (!/CRS84|EPSG:+4326$|EPSG::4326/i.test(name)) {
		refuse(`The file says its coordinates are in ${name || 'another coordinate system'}. Export it in WGS84 longitude/latitude (EPSG:4326).`);
	}
}

function bboxOf(polygons: readonly PolygonCoords[]): Bbox {
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	for (const p of polygons)
		for (const r of p)
			for (const [lon, lat] of r) {
				west = Math.min(west, lon);
				east = Math.max(east, lon);
				south = Math.min(south, lat);
				north = Math.max(north, lat);
			}
	return { west, south, east, north };
}

function within(b: Bbox, r: Bbox): boolean {
	return b.west >= r.west && b.east <= r.east && b.south >= r.south && b.north <= r.north;
}

/**
 * Area of a ring on the sphere, m² (the spherical-excess sum of Chamberlain
 * & Duquette 2007, "Some algorithms for polygons on a sphere", JPL; as Turf's
 * `area`). Exact for a longitude/latitude rectangle.
 */
export function ringAreaM2(r: Ring): number {
	const n = r.length - 1; // closed: the last position repeats the first
	if (n < 3) return 0;
	const rad = Math.PI / 180;
	let total = 0;
	for (let i = 0; i < n; i++) {
		const p1 = r[i] as Position;
		const p2 = r[(i + 1) % n] as Position;
		const p3 = r[(i + 2) % n] as Position;
		total += (p3[0] - p1[0]) * rad * Math.sin(p2[1] * rad);
	}
	return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

function polygonAreaM2(p: PolygonCoords): number {
	const [outer, ...holes] = p;
	return Math.max(0, ringAreaM2(outer as Ring) - holes.reduce((s, h) => s + ringAreaM2(h), 0));
}

/** Read and check an uploaded boundary. Never throws: a refusal comes back as `{ ok: false, error }`. */
export function parseArea(text: string): AreaResult {
	try {
		if (text.length > MAX_AREA_FILE_BYTES) refuse(`The file is larger than ${MAX_AREA_FILE_BYTES / 1024 / 1024} MB. Simplify the boundary and try again.`);
		let doc: unknown;
		try {
			doc = JSON.parse(text.replace(/^﻿/, ''));
		} catch {
			return refuse('The file is not GeoJSON (it does not read as JSON). Export the boundary as GeoJSON and try again.');
		}
		if (!isObject(doc)) return refuse('The file is not a GeoJSON object.');
		checkCrs(doc);
		let polygons: PolygonCoords[];
		let features = 1;
		const warnings: string[] = [];
		if (doc['type'] === 'FeatureCollection') {
			const list = doc['features'];
			if (!Array.isArray(list) || list.length === 0) return refuse('The FeatureCollection holds no features.');
			features = list.length;
			polygons = list.flatMap((f, i) => {
				if (!isObject(f) || f['type'] !== 'Feature') return refuse(`Feature ${i + 1} is not a GeoJSON Feature.`);
				return geometryPolygons(f['geometry'], `Feature ${i + 1}`);
			});
			if (features > 1) {
				warnings.push(
					`The file holds ${features} features; Pitman uses them together as one area. Where features overlap, the overlap counts twice, so use boundaries that only touch (as quaternaries from one layer do).`
				);
			}
		} else if (doc['type'] === 'Feature') {
			polygons = geometryPolygons(doc['geometry'], 'The feature');
		} else {
			polygons = geometryPolygons(doc, 'The geometry');
		}

		const bbox = bboxOf(polygons);
		if (bbox.west < -180 || bbox.east > 180 || bbox.south < -90 || bbox.north > 90) {
			refuse('The coordinates are not longitude/latitude (they look projected, e.g. in metres). Export the boundary in WGS84 longitude/latitude (EPSG:4326).');
		}
		if (!within(bbox, CHIRPS_REGION)) {
			const swapped = { west: bbox.south, east: bbox.north, south: bbox.west, north: bbox.east };
			if (within(swapped, CHIRPS_REGION)) {
				refuse('The longitude and latitude look swapped (GeoJSON puts longitude first). Export the boundary again with longitude first.');
			}
			refuse(
				`The area reaches outside the CHIRPS copy Pitman reads (longitude ${CHIRPS_REGION.west}° to ${CHIRPS_REGION.east}° E, latitude ${-CHIRPS_REGION.north}° to ${-CHIRPS_REGION.south}° S).`
			);
		}
		const vertices = polygons.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
		if (vertices > MAX_AREA_VERTICES) {
			refuse(`The boundary has ${vertices.toLocaleString('en-ZA')} vertices; at most ${MAX_AREA_VERTICES.toLocaleString('en-ZA')} are sent. Simplify it and try again.`);
		}
		const areaKm2 = polygons.reduce((s, p) => s + polygonAreaM2(p), 0) / 1e6;
		if (!(areaKm2 > 0)) refuse('The boundary encloses no area.');

		const geometry: AreaGeometry =
			polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] as PolygonCoords } : { type: 'MultiPolygon', coordinates: polygons };
		return {
			ok: true,
			geometry,
			areaKm2,
			polygons: polygons.length,
			holes: polygons.reduce((s, p) => s + p.length - 1, 0),
			vertices,
			bbox,
			features,
			warnings
		};
	} catch (error) {
		if (error instanceof Refused) return { ok: false, error: error.message };
		throw error;
	}
}

/** Quaternary codes as typed (`H80A, h80b`): upper-cased, de-duplicated; the invalid ones named. */
export function parseQuaternaries(text: string): { readonly codes: readonly string[]; readonly invalid: readonly string[] } {
	const parts = text
		.split(/[\s,;]+/)
		.map((s) => s.trim().toUpperCase())
		.filter(Boolean);
	const codes = [...new Set(parts.filter((p) => /^[A-Z]\d{2}[A-Z]$/.test(p)))];
	const invalid = [...new Set(parts.filter((p) => !/^[A-Z]\d{2}[A-Z]$/.test(p)))];
	return { codes, invalid };
}
