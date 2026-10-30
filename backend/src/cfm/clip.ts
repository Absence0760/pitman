// Fields cut to the (sub-)catchment, with the area recomputed from what is left (contract: geodesic, never `Shape_Area`).
//
// A boolean per field against an outline of thousands of vertices would take tens of seconds, and almost every
// field lies wholly inside or outside. So each field is first tested against the boundary: if no boundary edge
// comes near its box, one point says which, and only a field the boundary really crosses goes to the boolean,
// against just the part of the outline near it. The work is at most fields × area vertices of plain comparisons,
// both bounded by the route, and `checkDeadline` runs between fields.
import { type AreaGeometry, intersectGeometry, pointInGeometry } from '@pitman/wrsm';
import { geometryAreaM2 } from '../geo/area.js';
import { clipX, clipY, openRing } from '../geo/clip.js';
import type { Position } from '../geo/geojson.js';
import type { LayerField } from './adapter.js';

/** Clipped areas are kept to 1 m², and shapes to 1e-6° (about 10 cm): they only draw the field on the map. */
const AREA_DECIMALS = 4;
const COORD_DECIMALS = 1e6;
/** Added around a field's box so the outline's cut edges lie clear of the field itself. */
const MARGIN_DEG = 1e-6;

type Rings = Position[][];
interface Box {
	w: number;
	s: number;
	e: number;
	n: number;
}

const polygonsOf = (g: AreaGeometry) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as unknown as Rings[];

function boxOf(polygons: readonly Rings[]): Box {
	const box = { w: Infinity, s: Infinity, e: -Infinity, n: -Infinity };
	for (const rings of polygons) {
		for (const [x, y] of rings[0]!) {
			box.w = Math.min(box.w, x);
			box.e = Math.max(box.e, x);
			box.s = Math.min(box.s, y);
			box.n = Math.max(box.n, y);
		}
	}
	return box;
}

const round = (g: AreaGeometry): AreaGeometry => {
	const r = (v: number) => Math.round(v * COORD_DECIMALS) / COORD_DECIMALS;
	const ring = (points: readonly (readonly [number, number])[]) => points.map(([x, y]) => [r(x), r(y)] as [number, number]);
	return (g.type === 'Polygon' ? { type: g.type, coordinates: g.coordinates.map(ring) } : { type: g.type, coordinates: g.coordinates.map((p) => p.map(ring)) }) as AreaGeometry;
};

/** Whether any boundary edge's box meets `box`. */
function boundaryNear(polygons: readonly Rings[], box: Box): boolean {
	for (const rings of polygons) {
		for (const ring of rings) {
			for (let i = 0; i + 1 < ring.length; i++) {
				const [x1, y1] = ring[i]!;
				const [x2, y2] = ring[i + 1]!;
				if (Math.max(x1, x2) >= box.w && Math.min(x1, x2) <= box.e && Math.max(y1, y2) >= box.s && Math.min(y1, y2) <= box.n) return true;
			}
		}
	}
	return false;
}

/** The outline cut to a box. Sutherland–Hodgman: a concave ring's extra edges run along the box's sides, outside the field by MARGIN_DEG. */
function outlineNear(polygons: readonly Rings[], box: Box): AreaGeometry | null {
	const parts: Rings[] = [];
	for (const rings of polygons) {
		const cut = rings.flatMap((ring, i) => {
			const c = clipY(clipX(openRing(ring), box.w, box.e), box.s, box.n);
			if (c.length < 3) return i === 0 ? [[]] : [];
			return [[...c, c[0]!]];
		});
		if (cut[0]!.length > 0) parts.push(cut);
	}
	return parts.length === 0 ? null : { type: 'MultiPolygon', coordinates: parts };
}

export interface ClippedFields {
	fields: { id: string; crop: string; irrigated: boolean | null; areaHa: number; geometry: AreaGeometry }[];
	/** Fields the boolean could not cut: the caller says so, never drops them quietly. */
	failed: number;
}

/** The fields' parts inside `area`. A field with nothing inside is dropped. */
export function clipFields(fields: readonly LayerField[], area: AreaGeometry, checkDeadline: () => void = () => {}): ClippedFields {
	const polygons = polygonsOf(area);
	const areaBox = boxOf(polygons);
	const out: ClippedFields['fields'] = [];
	let failed = 0;
	fields.forEach((field, i) => {
		if (i % 256 === 0) checkDeadline();
		const own = polygonsOf(field.geometry);
		const box = boxOf(own);
		if (box.w > areaBox.e || box.e < areaBox.w || box.s > areaBox.n || box.n < areaBox.s) return;
		let geometry: AreaGeometry | null = field.geometry;
		if (boundaryNear(polygons, box)) {
			try {
				const near = outlineNear(polygons, { w: box.w - MARGIN_DEG, s: box.s - MARGIN_DEG, e: box.e + MARGIN_DEG, n: box.n + MARGIN_DEG });
				geometry = near && intersectGeometry(field.geometry, near);
			} catch {
				// A ring the boolean can't take (the layer's own digitising): counted, and the screen says how many.
				failed++;
				return;
			}
		} else if (!pointInGeometry(own[0]![0]![0]!, area)) {
			return;
		}
		if (geometry === null) return;
		const areaHa = Math.round(((geometryAreaM2(geometry) ?? 0) / 1e4) * 10 ** AREA_DECIMALS) / 10 ** AREA_DECIMALS;
		if (areaHa > 0) out.push({ id: field.id, crop: field.crop, irrigated: field.irrigated, areaHa, geometry: round(geometry) });
	});
	return { fields: out, failed };
}
