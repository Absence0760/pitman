/**
 * Geodesic area on the WGS84 ellipsoid (docs/data.md § Backend: geometry).
 *
 * Ported from IC-WBT (Absence0760/project-water-management, MIT)
 * backend/src/geo/area.ts at f888e4461, the file `backend/src/geo/area.ts`
 * here also copies: the engine is a package of its own and can't import the
 * backend. Kept: the authalic latitude and the polygon areas. Changed: takes
 * an `AreaGeometry`, answers in km², and a cell is measured in degrees of
 * longitude rather than Web Mercator columns.
 *
 * Method: each vertex goes to Lambert's cylindrical equal-area projection of
 * the ellipsoid (x = Rq·λ, y = Rq·sin β, β the authalic latitude, Rq the
 * authalic radius; Snyder 1987, eq. 3-12), where a ring's area is the
 * shoelace sum.
 */

import type { AreaGeometry } from '../extend/contract.js';

/** WGS84 semi-major axis (m) and first eccentricity squared. */
const A = 6_378_137;
const E2 = 0.006_694_379_990_14;
const E = Math.sqrt(E2);

/** q(φ) of the authalic latitude (Snyder 1987, eq. 3-12). */
function q(sinPhi: number): number {
	const es = E * sinPhi;
	return (1 - E2) * (sinPhi / (1 - es * es) - (1 / (2 * E)) * Math.log((1 - es) / (1 + es)));
}

const QP = q(1);
/** The authalic radius (m): the sphere with the ellipsoid's surface area. */
const AUTHALIC_RADIUS_M = A * Math.sqrt(QP / 2);

/** sin β, the sine of the authalic latitude of geodetic latitude `latDeg`. */
function sinAuthalic(latDeg: number): number {
	return Math.max(-1, Math.min(1, q(Math.sin((latDeg * Math.PI) / 180)) / QP));
}

type Position = readonly [number, number];

/** Area of one ring (m²), unsigned. Closed (first = last) or not, either works. */
function ringAreaM2(ring: readonly Position[]): number {
	const n = ring.length;
	if (n < 3) return 0;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const [x1, y1] = ring[i]!;
		const [x2, y2] = ring[(i + 1) % n]!;
		// Shoelace in (λ radians, sin β): Σ (λ2 − λ1)(s1 + s2) / 2, the trapezoid form, stable for small rings.
		sum += (((x2 - x1) * Math.PI) / 180) * (sinAuthalic(y1) + sinAuthalic(y2));
	}
	return Math.abs((sum / 2) * AUTHALIC_RADIUS_M * AUTHALIC_RADIUS_M);
}

/** Area of a polygon (outer ring less its holes), m². */
function polygonAreaM2(rings: readonly (readonly Position[])[]): number {
	if (rings.length === 0) return 0;
	let area = ringAreaM2(rings[0]!);
	for (let i = 1; i < rings.length; i++) area -= ringAreaM2(rings[i]!);
	return Math.max(0, area);
}

/** Geodesic area of a Polygon or MultiPolygon, km². */
export function geometryAreaKm2(geometry: AreaGeometry): number {
	const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
	return polygons.reduce((s, p) => s + polygonAreaM2(p), 0) / 1e6;
}

/** Area on the ellipsoid of a cell `widthDeg` wide between latitudes `northDeg` and `southDeg`, km². */
export function cellAreaKm2(northDeg: number, southDeg: number, widthDeg: number): number {
	return (AUTHALIC_RADIUS_M * AUTHALIC_RADIUS_M * ((widthDeg * Math.PI) / 180) * Math.abs(sinAuthalic(northDeg) - sinAuthalic(southDeg))) / 1e6;
}
