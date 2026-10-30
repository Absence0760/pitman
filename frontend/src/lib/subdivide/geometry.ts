/**
 * Small questions about a piece's outline, in the browser: its box (what the
 * MAP-grid request asks for), its centre (where the map puts a module), its
 * size and whether a point lies inside it (which dams fall where). The
 * clipping and the geodesic areas are the engine's and the backend's.
 */

import type { AreaGeometry } from '@pitman/wrsm';
import { ringAreaM2 } from '#lib/extend/area.js';

type Position = readonly [number, number];
type Ring = readonly Position[];

/** `[west, south, east, north]`, degrees. */
export type Bbox = readonly [number, number, number, number];

function polygonsOf(g: AreaGeometry): readonly (readonly Ring[])[] {
	return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

export function bboxOf(g: AreaGeometry): Bbox {
	let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const polygon of polygonsOf(g)) {
		for (const ring of polygon) {
			for (const [lon, lat] of ring) {
				west = Math.min(west, lon);
				east = Math.max(east, lon);
				south = Math.min(south, lat);
				north = Math.max(north, lat);
			}
		}
	}
	return [west, south, east, north];
}

/** The middle of the box: where a module's marker goes. */
export function centreOf(g: AreaGeometry): readonly [number, number] {
	const [west, south, east, north] = bboxOf(g);
	return [(west + east) / 2, (south + north) / 2];
}

/** Area on the sphere, km²: good enough to catch the wrong quaternary (the pieces' areas are geodesic). */
export function geometryAreaKm2(g: AreaGeometry): number {
	let m2 = 0;
	for (const [outer, ...holes] of polygonsOf(g)) {
		m2 += ringAreaM2(outer as Ring) - holes.reduce((sum, hole) => sum + ringAreaM2(hole), 0);
	}
	return m2 / 1e6;
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i] as Position;
		const [xj, yj] = ring[j] as Position;
		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** Whether a point lies inside: in an outer ring and in none of its holes. */
export function pointInGeometry(lon: number, lat: number, g: AreaGeometry): boolean {
	return polygonsOf(g).some(([outer, ...holes]) => pointInRing(lon, lat, outer as Ring) && !holes.some((hole) => pointInRing(lon, lat, hole)));
}
