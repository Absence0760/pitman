// Ported from IC-WBT (Absence0760/project-water-management, MIT) frontend/src/lib/components/map/draw/drawLayers.ts at f888e4461,
// stripped to polygons; colours from the palette.
//
// How a draft is drawn: one GeoJSON source, `draft`, and the layers over it, in
// the selection colour. Pure (no MapLibre), so vitest checks it.
import type { AreaGeometry } from '@pitman/wrsm';
import { type Palette, withAlpha } from '../palette.js';
import type { Position } from '../pieces.js';
import { midpoints } from './shape.js';

type Layer = Record<string, unknown> & { id: string; type: string };

export const DRAFT_SOURCE = 'draft';
/**
 * The drawn radius (px) of a corner and an edge's middle, each with its stroke.
 * A pointer grabs them by these sizes, but attachDrawing.ts `hitAt` tests the
 * draft itself, not the layers (MapLibre redraws them a frame or more after each
 * setData), so what draftData draws and what `hitAt` hits must change together.
 */
export const DRAWN_RADIUS = { corner: 8 + 3, mid: 5 + 2 } as const;

/** The draft's layers, over everything else. */
export function draftLayers(c: Palette): Layer[] {
	const src = { source: DRAFT_SOURCE };
	const role = (r: string) => ['==', ['get', 'role'], r];
	return [
		// Polygons only: MapLibre would fill the open line of a shape still being drawn, cut at the tile's edge.
		{ id: 'draft-fill', type: 'fill', ...src, filter: ['all', role('shape'), ['==', ['geometry-type'], 'Polygon']], paint: { 'fill-color': withAlpha(c.selected, 0.15) } },
		{ id: 'draft-casing', type: 'line', ...src, filter: ['any', role('shape'), role('band')], paint: { 'line-color': c.casing, 'line-width': 6, 'line-opacity': 0.85 } },
		{ id: 'draft-line', type: 'line', ...src, filter: role('shape'), paint: { 'line-color': c.selected, 'line-width': 3 } },
		// The line from the last corner to the pointer while drawing: dashed, so it reads as "not placed yet".
		{ id: 'draft-band', type: 'line', ...src, filter: role('band'), paint: { 'line-color': c.selected, 'line-width': 2, 'line-dasharray': [2, 2] } },
		// Where a corner would snap: a hollow ring, larger than a corner so it reads around one.
		{ id: 'draft-snap', type: 'circle', ...src, filter: role('snap'), paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': c.selected, 'circle-stroke-width': 2.5 } },
		{ id: 'draft-mid', type: 'circle', ...src, filter: role('mid'), paint: { 'circle-radius': DRAWN_RADIUS.mid - 2, 'circle-color': c.casing, 'circle-stroke-color': c.selected, 'circle-stroke-width': 2 } },
		{
			id: 'draft-corner',
			type: 'circle',
			...src,
			filter: role('corner'),
			// ≥ 24 px across with its stroke (WCAG 2.5.8), the picked corner filled.
			paint: { 'circle-radius': DRAWN_RADIUS.corner - 3, 'circle-color': ['case', ['==', ['get', 'picked'], true], c.selected, c.casing], 'circle-stroke-color': c.selected, 'circle-stroke-width': 3 }
		}
	];
}

export interface DraftView {
	coords: readonly Position[];
	phase: 'drawing' | 'review';
	/** A pasted shape of several parts, drawn whole with no corners. */
	whole: AreaGeometry | null;
	cursor: Position | null;
	corner: number | null;
	/** Where the pointer would snap, drawn as a ring. */
	snap?: Position | null;
}

type Out = { type: 'Feature'; properties: Record<string, unknown>; geometry: unknown };

/** The `draft` source's data: the shape (or its line so far), the line to the pointer, its corners and, once closed, its edges' middles. */
export function draftData(d: DraftView | null) {
	const features: Out[] = [];
	const fc = () => ({ type: 'FeatureCollection' as const, features });
	if (!d) return fc();
	if (d.whole) {
		features.push({ type: 'Feature', properties: { role: 'shape' }, geometry: d.whole });
		return fc();
	}
	const c = d.coords;
	const drawing = d.phase === 'drawing';
	if (c.length >= 3 && !drawing) features.push({ type: 'Feature', properties: { role: 'shape' }, geometry: { type: 'Polygon', coordinates: [[...c, c[0]!]] } });
	else if (c.length >= 2) features.push({ type: 'Feature', properties: { role: 'shape' }, geometry: { type: 'LineString', coordinates: [...c] } });
	if (drawing && d.cursor && c.length) {
		// To the pointer and back to the first corner, so the closing edge shows before the click.
		const band = c.length >= 2 ? [c[c.length - 1]!, d.cursor, c[0]!] : [c[c.length - 1]!, d.cursor];
		features.push({ type: 'Feature', properties: { role: 'band' }, geometry: { type: 'LineString', coordinates: band } });
	}
	if (!drawing) for (const m of midpoints(c)) features.push({ type: 'Feature', properties: { role: 'mid', after: m.after }, geometry: { type: 'Point', coordinates: m.at } });
	c.forEach((p, i) => features.push({ type: 'Feature', properties: { role: 'corner', index: i, picked: i === d.corner }, geometry: { type: 'Point', coordinates: p } }));
	if (d.snap) features.push({ type: 'Feature', properties: { role: 'snap' }, geometry: { type: 'Point', coordinates: d.snap } });
	return fc();
}
