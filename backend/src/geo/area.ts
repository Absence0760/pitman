// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/geo/area.ts at f888e4461
// Geodesic area of a GeoJSON polygon on the WGS84 ellipsoid (issue #288,
// WP-3.12; docs/maps.md § Areas). The server computes every area it stores;
// a client's figure is never trusted.
//
// Method: each vertex is mapped to Lambert's cylindrical equal-area
// projection of the ellipsoid (x = Rq·λ, y = Rq·sin β, with β the authalic
// latitude and Rq the authalic radius), where areas are exactly the
// ellipsoid's, and the ring's area is the shoelace sum there. That is the
// Chamberlain & Duquette (2007) formula `@turf/area` uses, but on the
// ellipsoid rather than a sphere of mean radius (which is off by up to
// ~0.5 % at South African latitudes). Edges are straight in longitude and
// authalic latitude, a difference from geodesic edges far below a metre for
// the edges of any digitised farm or catchment boundary.
//
// No dependency: these few lines are the whole algorithm (geo/area.test.ts
// checks it against squares of known size and the ellipsoid's own zones).
import type { Position } from './geojson.js';

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
export const AUTHALIC_RADIUS_M = A * Math.sqrt(QP / 2);

/** sin β, the sine of the authalic latitude of geodetic latitude `latDeg`. */
export function sinAuthalic(latDeg: number): number {
	return Math.max(-1, Math.min(1, q(Math.sin((latDeg * Math.PI) / 180)) / QP));
}

/** Area of one ring (m²), unsigned. The ring is closed (first = last) or not; either works. */
export function ringAreaM2(ring: readonly Position[]): number {
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
export function polygonAreaM2(rings: readonly (readonly Position[])[]): number {
	if (rings.length === 0) return 0;
	let area = ringAreaM2(rings[0]!);
	for (let i = 1; i < rings.length; i++) area -= ringAreaM2(rings[i]!);
	return Math.max(0, area);
}

/** Area of a Polygon or MultiPolygon geometry (m²); null for any other type. */
export function geometryAreaM2(g: { type: string; coordinates: unknown }): number | null {
	if (g.type === 'Polygon') return polygonAreaM2(g.coordinates as Position[][]);
	if (g.type === 'MultiPolygon') return (g.coordinates as Position[][][]).reduce((s, p) => s + polygonAreaM2(p), 0);
	return null;
}

/** The latitude (degrees, unrounded) of row edge `y` of a Web Mercator grid `W` cells round the world. */
export const mercatorLat = (y: number, W: number): number => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / W))) * 180) / Math.PI;

/**
 * The area (m²) on the WGS84 ellipsoid of one cell of a Web Mercator grid `W` cells round the world whose row runs from
 * latitude `top` to `bottom`: R_q² · Δλ · |sin β(top) − sin β(bottom)|, with β the authalic latitude and R_q the authalic
 * radius (Snyder 1987, eq. 3-12; the measure this module uses for every polygon). Not the cell's side squared at its centre,
 * which is a sphere's figure and drifts from the ellipsoid's by up to half a per cent.
 */
export function cellRowAreaM2(top: number, bottom: number, W: number): number {
	return AUTHALIC_RADIUS_M * AUTHALIC_RADIUS_M * ((2 * Math.PI) / W) * Math.abs(sinAuthalic(top) - sinAuthalic(bottom));
}
