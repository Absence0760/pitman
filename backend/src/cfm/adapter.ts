// PROVISIONAL: the one place that knows what the Cape Farm Mapper layers look like.
//
// The real layers can't be read without the operator's token (docs/data.md § Cape Farm Mapper, questions 1–7,
// issue #22 step 6), so every name below is a GUESS, written so the answers change this file and no other.
// `arcgis.ts` asks for `OUT_FIELDS` and hands each GeoJSON feature here; nothing else reads a layer attribute.
//
// When the token arrives, settle against docs/data.md:
//   question 3  layer URLs        → CFM_CROPS_LAYER_URL, CFM_DAMS_LAYER_URL (environment, not here)
//   question 4  crop layer fields → CROP_LAYER below
//   question 5  dams layer fields → DAM_LAYER below (capacity units: DAM_CAPACITY_TO_MM3)
//   question 6  what is irrigated → irrigatedFrom()
//   question 7  coordinate system → arcgis.ts asks for outSR=4326, so nothing here depends on it
// and replace the invented samples in adapter.test.ts with the layer's own shape.
import type { AreaGeometry, DamCandidate } from '@pitman/wrsm';
import { geometryAreaM2 } from '../geo/area.js';

/** The census the crop layer holds: docs/data.md lists "Crops 2023" as the newest. */
export const CFM_DATASET = 'Cape Farm Mapper, Crops 2023 (WCDoA)';
export const CFM_SURVEY_YEAR = 2023;

/** Guesses at the crop layer's attribute names. `irrigation` may not exist at all (D-8); then set it to `null`. */
export const CROP_LAYER = { id: 'OBJECTID', crop: 'CROP', irrigation: 'IRRIGATION' as string | null };
/** Guesses at the dams layer's attribute names. `capacity` may not exist (docs/data.md: "no public source confirms dam capacity"). */
export const DAM_LAYER = { id: 'OBJECTID', name: 'NAME', capacity: 'CAPACITY' as string | null };
/** Guess: capacity in m³. */
export const DAM_CAPACITY_TO_MM3 = 1e-6;

const named = (...names: (string | null)[]) => names.filter((n): n is string => n !== null).join(',');
export const CROP_OUT_FIELDS = named(CROP_LAYER.id, CROP_LAYER.crop, CROP_LAYER.irrigation);
export const DAM_OUT_FIELDS = named(DAM_LAYER.id, DAM_LAYER.name, DAM_LAYER.capacity);

/** One field as Pitman wants it, before it is clipped to the area: `CropField` without the area, which is recomputed (never `Shape_Area`). */
export interface LayerField {
	id: string;
	crop: string;
	irrigated: boolean | null;
	geometry: AreaGeometry;
}

/** A GeoJSON feature as the query answers it; nothing about it is trusted. */
export interface LayerFeature {
	id?: unknown;
	properties?: Record<string, unknown> | null;
	geometry?: { type?: unknown; coordinates?: unknown } | null;
}

/**
 * What the layer's irrigation value says (question 6). The default of D-8: `true`/`false` when it says, `null`
 * when it doesn't and the user marks crops. Any wording not recognised is `null`, never a guess at "dry".
 */
export function irrigatedFrom(value: unknown): boolean | null {
	if (typeof value !== 'string') return null;
	const v = value.trim().toLowerCase();
	if (/^(irrigated|irrigation|yes|y|drip|micro|pivot|flood|sprinkler)\b/.test(v)) return true;
	if (/^(dry\s?land|dry|rain\s?fed|no|n)\b/.test(v)) return false;
	return null;
}

const text = (v: unknown): string | undefined => {
	if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

const isLonLat = (p: unknown): p is [number, number] =>
	Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const isRing = (r: unknown) => Array.isArray(r) && r.length >= 4 && r.every(isLonLat);
const isPolygon = (p: unknown) => Array.isArray(p) && p.length > 0 && p.every(isRing);

const flatRing = (r: unknown) => (Array.isArray(r) ? r.map((p: unknown) => (Array.isArray(p) ? p.slice(0, 2) : p)) : r);
const flatPolygon = (p: unknown) => (Array.isArray(p) ? p.map(flatRing) : p);

/** A feature's polygon, its 3D positions flattened, or `undefined`. A shape check only: `clip.ts` copes with the rest. */
function polygonOf(g: LayerFeature['geometry']): AreaGeometry | undefined {
	const c = g?.coordinates;
	if (!Array.isArray(c)) return undefined;
	if (g?.type === 'Polygon') {
		const rings = flatPolygon(c);
		return isPolygon(rings) ? ({ type: 'Polygon', coordinates: rings } as unknown as AreaGeometry) : undefined;
	}
	if (g?.type !== 'MultiPolygon') return undefined;
	const parts = c.map(flatPolygon);
	return parts.length > 0 && parts.every(isPolygon) ? ({ type: 'MultiPolygon', coordinates: parts } as unknown as AreaGeometry) : undefined;
}

/** A crop layer feature as a field, or `null` when it can't be read: the caller counts those and says so. */
export function fieldFromFeature(f: LayerFeature): LayerField | null {
	const p = f.properties ?? {};
	const id = text(p[CROP_LAYER.id]) ?? text(f.id);
	const crop = text(p[CROP_LAYER.crop]);
	const geometry = polygonOf(f.geometry);
	if (id === undefined || crop === undefined || !geometry) return null;
	return { id, crop, irrigated: CROP_LAYER.irrigation === null ? null : irrigatedFrom(p[CROP_LAYER.irrigation]), geometry };
}

/** The mean of a polygon's outer ring, for a dam drawn as an outline. Not a centroid, but inside any shape a dam is. */
function middleOf(g: AreaGeometry): [number, number] {
	const ring = (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0]?.[0]) ?? [];
	const open = ring.slice(0, -1);
	return [open.reduce((s, p) => s + p[0], 0) / open.length, open.reduce((s, p) => s + p[1], 0) / open.length];
}

/** A dams layer feature as a candidate, or `null`. A point gives a position; an outline a position and a geodesic area. */
export function damFromFeature(f: LayerFeature): DamCandidate | null {
	const p = f.properties ?? {};
	const id = text(p[DAM_LAYER.id]) ?? text(f.id);
	if (id === undefined) return null;
	const raw = DAM_LAYER.capacity === null ? undefined : p[DAM_LAYER.capacity];
	const capacity = typeof raw === 'number' && raw > 0 ? raw * DAM_CAPACITY_TO_MM3 : undefined;
	const name = text(p[DAM_LAYER.name]);
	const facts = { id: `cfm-${id}`, source: 'capeFarmMapper' as const, ...(capacity === undefined ? {} : { capacityMm3: capacity }), ...(name === undefined ? {} : { name }) };
	if (f.geometry?.type === 'Point' && isLonLat(f.geometry.coordinates)) return { ...facts, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
	const outline = polygonOf(f.geometry);
	if (!outline) return null;
	const [lon, lat] = middleOf(outline);
	return { ...facts, lon, lat, areaKm2: (geometryAreaM2(outline) ?? 0) / 1e6 };
}
