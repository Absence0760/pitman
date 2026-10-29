// The `{ area }` body both data routes take (contract.ts ChirpsMonthlyRequest, AreaGeometry): a GeoJSON
// Polygon or MultiPolygon in WGS84, checked by the copied geo/geojson.ts checkGeometry (closed simple
// rings, holes inside, no overlapping parts, at most GEO_MAX_VERTICES positions, bounded check work)
// plus a ring count limit of Pitman's own. The checked geometry's hash keys the result caches.
import { createHash } from 'node:crypto';
import { checkGeometry, type Geometry } from '../geo/geojson.js';
import { ApiError } from './errors.js';

/** The largest request body the data routes read (bytes): a 50 000-vertex polygon is ~1.3 MB of JSON. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** The most rings (outer rings and holes, over every part) one area may have. */
export const GEO_MAX_RINGS = 1_000;

export interface CheckedArea {
	geometry: Extract<Geometry, { type: 'Polygon' | 'MultiPolygon' }>;
	/** SHA-256 of the checked geometry's JSON (coordinates rounded to 1e-7° by the check). */
	hash: string;
}

const isArr = Array.isArray;

/** The request body → the checked area, or an ApiError(400) saying what is wrong. */
export function parseArea(body: unknown): CheckedArea {
	if (typeof body !== 'object' || body === null || isArr(body)) throw new ApiError(400, 'the body must be a JSON object { "area": <GeoJSON Polygon or MultiPolygon> }');
	const area = (body as { area?: unknown }).area;
	if (typeof area !== 'object' || area === null || isArr(area)) throw new ApiError(400, 'the body has no "area" (a GeoJSON Polygon or MultiPolygon geometry)');
	const { type, coordinates } = area as { type?: unknown; coordinates?: unknown };
	if (type !== 'Polygon' && type !== 'MultiPolygon') {
		throw new ApiError(400, `the area must be a GeoJSON Polygon or MultiPolygon geometry, not ${typeof type === 'string' ? type.slice(0, 40) : 'a missing type'}`);
	}
	if (!isArr(coordinates)) throw new ApiError(400, 'the area has no coordinates');
	const rings = type === 'Polygon' ? coordinates.length : coordinates.reduce((n: number, p: unknown) => n + (isArr(p) ? p.length : 1), 0);
	if (rings > GEO_MAX_RINGS) throw new ApiError(400, `the area has ${rings} rings; at most ${GEO_MAX_RINGS.toLocaleString('en-ZA')} are taken`);
	const checked = checkGeometry({ type, coordinates });
	if ('problem' in checked) throw new ApiError(400, `the area ${checked.problem}`);
	const geometry = checked.geometry as CheckedArea['geometry'];
	return { geometry, hash: createHash('sha256').update(JSON.stringify(geometry)).digest('hex') };
}
