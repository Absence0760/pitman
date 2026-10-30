import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AreaGeometry, MapGridCells } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { draftData } from './draw/drawLayers.js';
import {
	absoluteUrl,
	basemapLayerIds,
	BASEMAP_ATTRIBUTION,
	channelData,
	FIELD_LAYER,
	fieldData,
	fieldLayers,
	fieldState,
	mapGridData,
	mapGridLabelMinZoom,
	mapGridStride,
	mapStyle,
	MAP_GRID_LAYER,
	MAP_RAMP_MM,
	moduleData,
	pieceData,
	proposalData,
	quaternaryData,
	QUATERNARY_HIT_LAYER,
	RELIEF_LAYER,
	reliefBeforeId,
	TERRAIN_ATTRIBUTION
} from './mapStyle.js';
import { PALETTE_TOKENS, paletteFrom, RAMP_STOPS, withAlpha, type Palette } from './palette.js';

// The tokens themselves, read from app.css, so the guards hold for what ships.
const css = readFileSync(join(import.meta.dirname, '..', '..', 'app.css'), 'utf8');
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((m) => [m[1] as string, m[2] as string]));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const lightTokens = tokens(css.slice(0, darkStart));
const darkTokens = { ...lightTokens, ...tokens(css.slice(darkStart, css.indexOf('@media (pointer: fine)'))) };
const LIGHT = paletteFrom((t) => lightTokens[t] as string);
const DARK = paletteFrom((t) => darkTokens[t] as string);

function luminance(hex: string): number {
	const channel = (i: number) => {
		const v = parseInt(hex.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

const box = (w: number, s: number, e: number, n: number): AreaGeometry => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const DATA = {
	quaternaries: quaternaryData([]),
	channels: channelData(null),
	pieces: pieceData([]),
	fields: fieldData([]),
	proposal: proposalData(null),
	modules: moduleData([]),
	mapGrid: mapGridData(null),
	mapGridCellDeg: null,
	draft: draftData(null)
};
const OPTS = { tilesUrl: null, glyphs: null, terrain: null, dark: false };
const ids = (s: { layers: { id: string }[] }) => s.layers.map((l) => l.id);

describe.each([
	['light', LIGHT],
	['dark', DARK]
] as const)('the %s palette', (_name, c: Palette) => {
	it('has every token', () => {
		for (const token of PALETTE_TOKENS) expect(lightTokens[token]).toMatch(/^#/);
		expect(c.pieces).toHaveLength(6);
		expect(c.ramp).toHaveLength(RAMP_STOPS);
	});
	it.each(['quaternary', 'selected', 'proposal', 'field', 'channel', 'module'] as const)('%s stands 3:1 off the plain background and the land', (mark) => {
		expect(contrast(c[mark], c.bg)).toBeGreaterThanOrEqual(3);
		expect(contrast(c[mark], c.earth)).toBeGreaterThanOrEqual(3);
	});
	it('names read at 4.5:1 on their halo', () => {
		expect(contrast(c.label, c.halo)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(c.labelWater, c.halo)).toBeGreaterThanOrEqual(4.5);
	});
	it('the selection is apart from the quaternaries’ outline', () => {
		expect(c.selected).not.toBe(c.quaternary);
	});
	it('draws in this order, the drawing on top', () => {
		const s = mapStyle(c, { ...OPTS, tilesUrl: 'http://x/a.pmtiles', glyphs: 'http://x/{fontstack}/{range}.pbf', terrain: 'http://x/t.pmtiles' }, DATA);
		const order = ids(s);
		const at = (id: string) => order.indexOf(id);
		expect(at('background')).toBe(0);
		expect(at(RELIEF_LAYER)).toBeLessThan(at('bm-water'));
		expect(at('bm-roads')).toBeLessThan(at(MAP_GRID_LAYER));
		expect(at(MAP_GRID_LAYER)).toBeLessThan(at(QUATERNARY_HIT_LAYER));
		expect(at('qt-line')).toBeLessThan(at('dem-channels'));
		expect(at('dem-channels')).toBeLessThan(at(FIELD_LAYER));
		expect(at('fld-line')).toBeLessThan(at('pc-fill'));
		expect(at('pc-fill')).toBeLessThan(at('pr-fill'));
		expect(at('pr-line')).toBeLessThan(at('mod-point'));
		expect(at('mod-point')).toBeLessThan(at('draft-fill'));
		expect(order.at(-1)).toBe('draft-corner');
	});
});

describe('the style with nothing configured (local-first)', () => {
	const s = mapStyle(LIGHT, OPTS, DATA);
	it('has a background and the overlay, and reads no tiles, glyphs or relief', () => {
		expect(ids(s)).toContain('background');
		expect(ids(s)).toContain(QUATERNARY_HIT_LAYER);
		expect(basemapLayerIds(s)).toEqual([]);
		expect(s.glyphs).toBeUndefined();
		expect(Object.keys(s.sources)).not.toContain('basemap');
		expect(Object.keys(s.sources)).not.toContain('terrain');
		expect(JSON.stringify(s)).not.toContain('pmtiles');
	});
	it('draws no names with no tiles, even with glyphs', () => {
		const g = mapStyle(LIGHT, { ...OPTS, glyphs: 'http://x/{fontstack}/{range}.pbf' }, DATA);
		expect(g.glyphs).toBeUndefined();
		expect(ids(g).filter((id) => id.includes('label'))).toEqual([]);
	});
});

describe('the style with tiles', () => {
	it('credits the basemap and the relief, the DEM notice word for word (docs/data.md § DEM)', () => {
		const s = mapStyle(LIGHT, { ...OPTS, tilesUrl: 'http://x/a.pmtiles', terrain: 'http://x/t.pmtiles' }, DATA);
		expect(s.sources['basemap']).toMatchObject({ url: 'pmtiles://http://x/a.pmtiles', attribution: BASEMAP_ATTRIBUTION });
		expect(BASEMAP_ATTRIBUTION).toBe('© Protomaps © OpenStreetMap contributors');
		expect(s.sources['terrain']).toMatchObject({ type: 'raster-dem', encoding: 'terrarium', attribution: TERRAIN_ATTRIBUTION });
		expect(TERRAIN_ATTRIBUTION).toContain('produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved');
		expect(TERRAIN_ATTRIBUTION).toContain('© Mapterhorn');
	});
	it('puts the relief first when there is no basemap to go under', () => {
		expect(reliefBeforeId(['background', 'qt-fill'])).toBe('qt-fill');
		expect(reliefBeforeId(['background'])).toBeUndefined();
	});
});

describe('absoluteUrl', () => {
	it('puts a same-origin path on the origin without encoding the braces', () => {
		expect(absoluteUrl('/tiles/fonts/{fontstack}/{range}.pbf', 'https://x.test/')).toBe('https://x.test/tiles/fonts/{fontstack}/{range}.pbf');
	});
	it('leaves a full URL, and has nothing for an empty one', () => {
		expect(absoluteUrl('http://localhost:9000/a.pmtiles', 'https://x.test')).toBe('http://localhost:9000/a.pmtiles');
		expect(absoluteUrl('', 'https://x.test')).toBeNull();
		expect(absoluteUrl('  ', 'https://x.test')).toBeNull();
		expect(absoluteUrl(undefined, 'https://x.test')).toBeNull();
	});
});

describe('source data', () => {
	it('marks the selected quaternary', () => {
		const d = quaternaryData([{ properties: { code: 'Z01A' }, geometry: box(0, 0, 1, 1) }, { properties: { code: 'Z01B' }, geometry: box(1, 0, 2, 1) }], 'Z01B');
		expect(d.features.map((f) => f.properties)).toEqual([
			{ code: 'Z01A', selected: false },
			{ code: 'Z01B', selected: true }
		]);
	});
	it('is empty for no data', () => {
		expect(quaternaryData(null).features).toEqual([]);
		expect(proposalData(null).features).toEqual([]);
		expect(channelData(null).features).toEqual([]);
		expect(pieceData(null).features).toEqual([]);
		expect(moduleData(null).features).toEqual([]);
	});
	it('says what a field is, in words and in a state the fill follows', () => {
		const d = fieldData([
			{ id: '1', crop: 'Lucerne', irrigated: true, geometry: box(0, 0, 1, 1) },
			{ id: '2', crop: 'Wheat', irrigated: false, geometry: box(1, 0, 2, 1) },
			{ id: '3', crop: 'Maize', irrigated: null, geometry: box(2, 0, 3, 1) }
		]);
		expect(d.features.map((f) => f.properties.label)).toEqual(['Lucerne, irrigated', 'Wheat, dryland', 'Maize, the layer doesn’t say']);
		expect([true, false, null].map(fieldState)).toEqual(['irrigated', 'dry', 'unknown']);
		expect(fieldData(null).features).toEqual([]);
	});
	it('edges a field solid, unlike the proposal’s dash', () => {
		expect(JSON.stringify(fieldLayers(LIGHT))).not.toContain('line-dasharray');
	});
	it('gives each piece a tint, neighbours apart', () => {
		const d = pieceData([
			{ id: 'a', number: 1, label: 'One', geometry: box(0, 0, 1, 1) },
			{ id: 'b', number: 2, label: 'Two', geometry: box(1, 0, 2, 1) }
		]);
		expect(d.features[0]?.properties.tint).not.toBe(d.features[1]?.properties.tint);
	});
	it('draws a module at its place, with its label', () => {
		expect(moduleData([{ id: 'RU1', label: 'RU1 Z01A', lngLat: [21, -33] }]).features[0]).toMatchObject({ properties: { id: 'RU1', label: 'RU1 Z01A' }, geometry: { type: 'Point', coordinates: [21, -33] } });
	});
});

describe('mapGridData', () => {
	const cells = (cols: number, rows: number, values?: (number | null)[]): MapGridCells => ({
		dataset: 'g',
		source: 's',
		cellDeg: 0.1,
		originLon: 21.05,
		originLat: -33.05,
		cols,
		rows,
		values: values ?? new Array<number>(cols * rows).fill(500)
	});
	it('draws each cell’s square from the north-west origin, and its value', () => {
		const d = mapGridData(cells(2, 2, [100, 200, 300, 400]));
		expect(d.features).toHaveLength(4);
		expect(d.features[1]).toMatchObject({ properties: { mm: 200, label: '200 mm' } });
		const ring = (d.features[2] as { geometry: { coordinates: number[][][] } }).geometry.coordinates[0]!;
		expect(ring[0]![0]).toBeCloseTo(21, 9);
		expect(ring[0]![1]).toBeCloseTo(-33.2, 9);
		expect(ring[2]![0]).toBeCloseTo(21.1, 9);
		expect(ring[2]![1]).toBeCloseTo(-33.1, 9);
	});
	it('leaves out a cell with no value', () => {
		expect(mapGridData(cells(2, 1, [null, 200])).features).toHaveLength(1);
	});
	it('is empty with no block', () => {
		expect(mapGridData(null).features).toEqual([]);
	});
	it('thins a dense block to the limit, wider cells covering the same ground', () => {
		const dense = cells(400, 400);
		expect(mapGridStride(dense, 20_000)).toBe(3);
		const d = mapGridData(dense, 20_000);
		expect(d.features.length).toBeLessThanOrEqual(20_000);
		const ring = (d.features[0] as { geometry: { coordinates: number[][][] } }).geometry.coordinates[0]!;
		expect(ring[1]![0]! - ring[0]![0]!).toBeCloseTo(0.3, 9);
		expect(ring[0]![0]).toBeCloseTo(21, 9);
		expect(ring[2]![1]).toBeCloseTo(-33, 9);
	});
	it('labels a cell from the zoom it fits at, finer grids later', () => {
		expect(mapGridLabelMinZoom(null)).toBe(0);
		expect(mapGridLabelMinZoom(0.001)).toBeGreaterThan(mapGridLabelMinZoom(0.01));
	});
	it('runs its ramp upward, one colour per stop', () => {
		expect([...MAP_RAMP_MM].sort((a, b) => a - b)).toEqual(MAP_RAMP_MM);
		expect(MAP_RAMP_MM).toHaveLength(RAMP_STOPS);
	});
});

describe('withAlpha', () => {
	it('writes rgba', () => {
		expect(withAlpha('#ff0080', 0.5)).toBe('rgba(255, 0, 128, 0.5)');
	});
});
