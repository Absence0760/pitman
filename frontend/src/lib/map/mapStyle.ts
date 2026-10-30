// Ported from IC-WBT (Absence0760/project-water-management, MIT) frontend/src/lib/components/map/mapStyle.ts at f888e4461:
// the basemap, labels, relief, quaternaries, channels and proposal, stripped of farm parcels, rivers, units
// and results. Pitman's own: colours from the tokens (palette.ts) rather than constants, and the MAP grid
// drawn as cells from the contract's block rather than as points.
//
// The basemap and overlay layers as plain style objects. Pure (no MapLibre
// import), so vitest checks them, and the style's types stay out of the page's
// first load. The basemap is the Protomaps vector schema read from one PMTiles
// file over HTTP Range; no tile CDN, no third-party script, no sprites. Names
// need glyphs, self-hosted beside the tiles. With no tiles URL (a fresh clone,
// CI) the map is a plain background with everything else drawn on it.
import type { AreaGeometry, ChannelCollection, MapGridCells } from '@pitman/wrsm';
import type { MapModule, MapPiece } from './contract.js';
import { DRAFT_SOURCE, draftData, draftLayers } from './draw/drawLayers.js';
import type { Palette } from './palette.js';
import { pieceTintsFor } from './pieces.js';

/** Shown on the map whenever the basemap is (the Protomaps / OSM licence). */
export const BASEMAP_ATTRIBUTION = '© Protomaps © OpenStreetMap contributors';

/** Shown whenever the relief is: the notice the Copernicus DEM licence asks for (Art. 6(b); docs/data.md § DEM), and the tiles' compiler. */
export const TERRAIN_ATTRIBUTION =
	'Relief: <a href="https://mapterhorn.com/attribution">© Mapterhorn</a>, produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';

// Loose types: the style spec's own types live in maplibre-gl, which this module must not import.
export type Layer = Record<string, unknown> & { id: string; type: string };
export interface Style {
	version: 8;
	sources: Record<string, Record<string, unknown>>;
	layers: Layer[];
	/** The glyph ranges' URL template ({fontstack}, {range}), only when names are drawn. */
	glyphs?: string;
}

/** The fonts the names use: Protomaps' basemaps-assets set (Noto Sans, OFL 1.1), self-hosted. */
export const LABEL_FONTS = { regular: 'Noto Sans Regular', medium: 'Noto Sans Medium', italic: 'Noto Sans Italic' } as const;

/**
 * A tile or glyph URL as MapLibre needs it: absolute. A same-origin path
 * (`/tiles/…`, production) is put on `origin` by hand: `new URL` would
 * percent-encode the braces. Empty → null (no tiles, nothing fetched).
 */
export function absoluteUrl(raw: string | null | undefined, origin: string): string | null {
	const v = raw?.trim();
	if (!v) return null;
	return v.startsWith('/') ? `${origin.replace(/\/$/, '')}${v}` : v;
}

const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name']];

/** The basemap's place and water names, over everything (they need the tiles and the glyphs). */
export function labelLayers(c: Palette): Layer[] {
	const src = { source: 'basemap' };
	const halo = { 'text-halo-color': c.halo, 'text-halo-width': 1.5, 'text-halo-blur': 0.25 };
	const kindIn = (kinds: string[]) => ['in', ['get', 'kind'], ['literal', kinds]];
	return [
		{
			id: 'bm-label-waterway',
			type: 'symbol',
			...src,
			'source-layer': 'water',
			minzoom: 11,
			filter: ['all', ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]], kindIn(['river', 'stream', 'canal']), ['has', 'name']],
			layout: { 'symbol-placement': 'line', 'text-field': NAME, 'text-font': [LABEL_FONTS.italic], 'text-size': 12, 'text-letter-spacing': 0.1 },
			paint: { 'text-color': c.labelWater, ...halo }
		},
		{
			id: 'bm-label-water',
			type: 'symbol',
			...src,
			'source-layer': 'water',
			filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name']],
			layout: { 'text-field': NAME, 'text-font': [LABEL_FONTS.italic], 'text-size': 12, 'text-max-width': 9 },
			paint: { 'text-color': c.labelWater, ...halo }
		},
		{
			id: 'bm-label-places',
			type: 'symbol',
			...src,
			'source-layer': 'places',
			filter: ['all', kindIn(['locality', 'region', 'neighbourhood']), ['has', 'name']],
			layout: {
				'text-field': NAME,
				// Towns that show from far out (min_zoom ≤ 6) in the medium weight; the rest regular.
				'text-font': ['case', ['<=', ['coalesce', ['get', 'min_zoom'], 99], 6], ['literal', [LABEL_FONTS.medium]], ['literal', [LABEL_FONTS.regular]]],
				'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 12, 14],
				'text-max-width': 8,
				'symbol-sort-key': ['coalesce', ['get', 'sort_key'], ['get', 'min_zoom'], 99]
			},
			paint: { 'text-color': c.label, ...halo }
		}
	];
}

/** The basemap: a background, and the Protomaps layers when there is a tiles URL. */
export function basemapStyle(tilesUrl: string | null, c: Palette): Pick<Style, 'sources' | 'layers'> {
	const layers: Layer[] = [{ id: 'background', type: 'background', paint: { 'background-color': c.bg } }];
	if (!tilesUrl) return { sources: {}, layers };
	const src = { source: 'basemap' };
	layers.push(
		{ id: 'bm-earth', type: 'fill', ...src, 'source-layer': 'earth', paint: { 'fill-color': c.earth } },
		{ id: 'bm-landcover', type: 'fill', ...src, 'source-layer': 'landcover', filter: ['in', ['get', 'kind'], ['literal', ['forest', 'grassland', 'scrub', 'farmland']]], paint: { 'fill-color': c.green, 'fill-opacity': 0.6 } },
		{ id: 'bm-landuse', type: 'fill', ...src, 'source-layer': 'landuse', filter: ['in', ['get', 'kind'], ['literal', ['park', 'nature_reserve', 'farmland', 'orchard', 'vineyard']]], paint: { 'fill-color': c.green, 'fill-opacity': 0.5 } },
		{ id: 'bm-water', type: 'fill', ...src, 'source-layer': 'water', paint: { 'fill-color': c.water } },
		{ id: 'bm-boundaries', type: 'line', ...src, 'source-layer': 'boundaries', paint: { 'line-color': c.border, 'line-width': 1, 'line-dasharray': [3, 2] } },
		{ id: 'bm-roads-case', type: 'line', ...src, 'source-layer': 'roads', minzoom: 9, paint: { 'line-color': c.roadCase, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 14, 6] } },
		{ id: 'bm-roads', type: 'line', ...src, 'source-layer': 'roads', paint: { 'line-color': c.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 14, 4] } }
	);
	return { sources: { basemap: { type: 'vector', url: `pmtiles://${tilesUrl}`, attribution: BASEMAP_ATTRIBUTION } }, layers };
}

/** The basemap layers' ids, to drop when the tiles can't be read. */
export const basemapLayerIds = (style: Pick<Style, 'layers'>) => style.layers.filter((l) => l.id.startsWith('bm-')).map((l) => l.id);

export const TERRAIN_SOURCE = 'terrain';
export const RELIEF_LAYER = 'tr-hillshade';

/** The relief's source: one PMTiles file of Terrarium-encoded 512 px elevation tiles. MapLibre overzooms past its maxzoom. */
export const terrainSource = (url: string) => ({ type: 'raster-dem', url: `pmtiles://${url}`, encoding: 'terrarium', tileSize: 512, attribution: TERRAIN_ATTRIBUTION });

/** The shaded relief: soft and translucent, so the land colours read through it and the overlay's strokes keep their contrast. Black and white by design: a shadow, not a theme colour. */
export function reliefLayer(dark: boolean): Layer {
	return {
		id: RELIEF_LAYER,
		type: 'hillshade',
		source: TERRAIN_SOURCE,
		paint: dark
			? { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': 'rgba(0, 0, 0, 0.55)', 'hillshade-highlight-color': 'rgba(255, 255, 255, 0.10)', 'hillshade-accent-color': 'rgba(0, 0, 0, 0.25)' }
			: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': 'rgba(40, 46, 38, 0.45)', 'hillshade-highlight-color': 'rgba(255, 255, 255, 0.35)', 'hillshade-accent-color': 'rgba(40, 46, 38, 0.2)' }
	};
}

/** Where the relief goes: over the land and land cover, under the water and everything after. Undefined: on top (an empty style). */
export function reliefBeforeId(layerIds: readonly string[]): string | undefined {
	return layerIds.find((id) => id === 'bm-water') ?? layerIds.find((id) => !['background', 'bm-earth', 'bm-landcover', 'bm-landuse'].includes(id));
}

// ---------------------------------------------------------------------------
// The overlay: one GeoJSON source per kind of thing, each with its own data
// function, so Map.svelte re-sends only the source whose input changed.
// ---------------------------------------------------------------------------

const EMPTY = { type: 'FeatureCollection' as const, features: [] as unknown[] };

/** The `quaternaries` source's data: each outline with its code and whether it is the selected one. */
export function quaternaryData(features: readonly { properties: { code: string }; geometry: AreaGeometry }[] | null | undefined, selected: string | null = null) {
	return {
		type: 'FeatureCollection' as const,
		features: (features ?? []).map((q) => ({ type: 'Feature' as const, properties: { code: q.properties.code, selected: q.properties.code === selected }, geometry: q.geometry }))
	};
}

/** The layer a click on a quaternary hits (a nearly invisible fill: the outline alone is too thin to aim at). */
export const QUATERNARY_HIT_LAYER = 'qt-fill';

/** The quaternaries: a thin solid outline; the selected one heavier, on a casing, in the selection colour. Never tinted: it would change the MAP grid's colours under it. Under the pieces. */
export function quaternaryLayers(c: Palette): Layer[] {
	const src = { source: 'quaternaries' };
	const selected = ['==', ['get', 'selected'], true];
	return [
		// Opacity 0.01, not 0: an invisible fill still answers queryRenderedFeatures, so a click inside picks the quaternary.
		{ id: QUATERNARY_HIT_LAYER, type: 'fill', ...src, paint: { 'fill-color': c.selected, 'fill-opacity': 0.01 } },
		{ id: 'qt-line', type: 'line', ...src, paint: { 'line-color': c.quaternary, 'line-width': 1.5 } },
		{ id: 'qt-selected-casing', type: 'line', ...src, filter: selected, paint: { 'line-color': c.casing, 'line-width': 6, 'line-opacity': 0.85 } },
		{ id: 'qt-selected', type: 'line', ...src, filter: selected, paint: { 'line-color': c.selected, 'line-width': 3 } }
	];
}

/** The elevation model's channels, drawn while the tributary tool is on: solid, wider for a larger area (when the data says). */
export function channelLayers(c: Palette): Layer[] {
	return [
		{
			id: 'dem-channels',
			type: 'line',
			source: 'channels',
			layout: { 'line-cap': 'round', 'line-join': 'round' },
			paint: { 'line-color': c.channel, 'line-width': ['interpolate', ['linear'], ['log10', ['max', 1, ['coalesce', ['get', 'km2'], 1]]], 0, 1, 2, 2, 4, 3.5], 'line-opacity': 0.9 }
		}
	];
}

/** The `channels` source's data. */
export const channelData = (channels: ChannelCollection | null | undefined) => channels ?? EMPTY;

/** The `pieces` source's data: each piece with its tint (neighbours differ, pieces.ts). */
export function pieceData(pieces: readonly MapPiece[] | null | undefined) {
	const list = pieces ?? [];
	const tints = pieceTintsFor(list.map((p) => p.geometry));
	return {
		type: 'FeatureCollection' as const,
		features: list.map((p, i) => ({ type: 'Feature' as const, properties: { id: p.id, tint: tints[i]! }, geometry: p.geometry }))
	};
}

/** The pieces: a translucent tint under a solid edge, so the edges between them show. The number is the name; the tint only helps the eye. */
export function pieceLayers(c: Palette): Layer[] {
	const src = { source: 'pieces' };
	return [
		{ id: 'pc-fill', type: 'fill', ...src, paint: { 'fill-color': ['match', ['get', 'tint'], ...c.pieces.flatMap((t, i) => [i, t]), c.selected], 'fill-opacity': 0.3 } },
		{ id: 'pc-casing', type: 'line', ...src, paint: { 'line-color': c.casing, 'line-width': 4, 'line-opacity': 0.85 } },
		{ id: 'pc-line', type: 'line', ...src, paint: { 'line-color': c.selected, 'line-width': 1.75 } }
	];
}

/** The `proposal` source's data. */
export function proposalData(proposal: AreaGeometry | null | undefined) {
	return proposal ? { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: proposal }] } : EMPTY;
}

/** The proposal: a faint fill, a casing and a short dash, so it reads as not yet accepted. Over the pieces: it is what is being decided on. */
export function proposalLayers(c: Palette): Layer[] {
	const src = { source: 'proposal' };
	return [
		{ id: 'pr-fill', type: 'fill', ...src, paint: { 'fill-color': c.proposal, 'fill-opacity': 0.14 } },
		{ id: 'pr-casing', type: 'line', ...src, paint: { 'line-color': c.casing, 'line-width': 6, 'line-opacity': 0.85 } },
		{ id: 'pr-line', type: 'line', ...src, paint: { 'line-color': c.proposal, 'line-width': 3, 'line-dasharray': [1.5, 1.5] } }
	];
}

/** The `modules` source's data. */
export function moduleData(modules: readonly MapModule[] | null | undefined) {
	return {
		type: 'FeatureCollection' as const,
		features: (modules ?? []).map((m) => ({ type: 'Feature' as const, properties: { id: m.id, label: m.label }, geometry: { type: 'Point' as const, coordinates: [m.lngLat[0], m.lngLat[1]] } }))
	};
}

/** The layer the pointer finds a module on. */
export const MODULE_LAYER = 'mod-point';

/** The network's modules: a ringed dot, over the areas. Their names show under the pointer: there may be no glyphs to write them with. */
export function moduleLayers(c: Palette): Layer[] {
	return [{ id: MODULE_LAYER, type: 'circle', source: 'modules', paint: { 'circle-radius': 5.5, 'circle-color': c.module, 'circle-stroke-color': c.casing, 'circle-stroke-width': 2 } }];
}

// ---------------------------------------------------------------------------
// The MAP grid
// ---------------------------------------------------------------------------

/** The MAP ramp's stops, mm/yr; `--map-ramp-1…5` are their colours, the same in both themes. The key reads these. */
export const MAP_RAMP_MM: readonly number[] = [200, 500, 800, 1200, 2000];

/** The most cells drawn at once: a finer block is thinned, and the panel says so. */
export const MAP_GRID_MAX_DRAWN = 20_000;

/** Every how many rows and columns a block is drawn at. */
export const mapGridStride = (cells: Pick<MapGridCells, 'cols' | 'rows'>, max = MAP_GRID_MAX_DRAWN) => Math.max(1, Math.ceil(Math.sqrt((cells.cols * cells.rows) / max)));

/** The `mapgrid` source's data: each cell's square with its MAP. A thinned block draws every n-th cell, n cells wide. No value, no cell. */
export function mapGridData(cells: MapGridCells | null | undefined, max = MAP_GRID_MAX_DRAWN) {
	if (!cells) return EMPTY;
	const step = mapGridStride(cells, max);
	const half = (cells.cellDeg * step) / 2;
	const offset = ((step - 1) * cells.cellDeg) / 2;
	const features = [];
	for (let row = 0; row < cells.rows; row += step) {
		for (let col = 0; col < cells.cols; col += step) {
			const mm = cells.values[row * cells.cols + col];
			if (mm === null || mm === undefined) continue;
			const lon = cells.originLon + col * cells.cellDeg + offset;
			const lat = cells.originLat - row * cells.cellDeg - offset;
			features.push({
				type: 'Feature' as const,
				properties: { mm, label: `${Math.round(mm)} mm` },
				geometry: {
					type: 'Polygon' as const,
					coordinates: [
						[
							[lon - half, lat - half],
							[lon + half, lat - half],
							[lon + half, lat + half],
							[lon - half, lat + half],
							[lon - half, lat - half]
						]
					]
				}
			});
		}
	}
	return { type: 'FeatureCollection' as const, features };
}

/** The layer the pointer finds a cell on, and the label layer whose zoom follows the grid drawn. */
export const MAP_GRID_LAYER = 'mapgrid-cell';
export const MAP_GRID_LABEL_LAYER = 'mapgrid-label';

/** The zoom from which a cell is wide enough to hold its value (512 px tiles: a degree is 512 × 2^z ÷ 360 px); about 40 px. 0 with no grid. */
export function mapGridLabelMinZoom(cellDeg: number | null | undefined): number {
	if (!(typeof cellDeg === 'number' && cellDeg > 0 && Number.isFinite(cellDeg))) return 0;
	return Math.min(24, Math.max(0, Math.round(Math.log2((40 * 360) / (512 * cellDeg)) * 10) / 10));
}

/** The MAP grid: translucent cells on the ramp, with no edge (an antialiased edge would rule a grid across the surface); each cell's value once it fits, when there are glyphs. */
export function mapGridLayers(c: Palette, labels: boolean, labelMinZoom = 0): { cells: Layer[]; labels: Layer[] } {
	const src = { source: 'mapgrid' };
	const stops = MAP_RAMP_MM.flatMap((mm, i) => [mm, c.ramp[i]!]);
	return {
		cells: [{ id: MAP_GRID_LAYER, type: 'fill', ...src, paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'mm'], ...stops], 'fill-opacity': 0.6, 'fill-antialias': false } }],
		labels: labels
			? [
					{
						id: MAP_GRID_LABEL_LAYER,
						type: 'symbol',
						...src,
						...(labelMinZoom > 0 ? { minzoom: labelMinZoom } : {}),
						layout: { 'text-field': ['get', 'label'], 'text-font': [LABEL_FONTS.regular], 'text-size': 11, 'text-padding': 2 },
						paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.5 }
					}
				]
			: []
	};
}

export interface StyleData {
	quaternaries: ReturnType<typeof quaternaryData>;
	channels: ReturnType<typeof channelData>;
	pieces: ReturnType<typeof pieceData>;
	proposal: ReturnType<typeof proposalData>;
	modules: ReturnType<typeof moduleData>;
	mapGrid: ReturnType<typeof mapGridData>;
	mapGridCellDeg: number | null;
	draft: ReturnType<typeof draftData>;
}

export interface StyleOptions {
	tilesUrl: string | null;
	/** The glyphs URL, absolute. Null: no names, no glyphs fetched. */
	glyphs: string | null;
	/** The relief's PMTiles URL, absolute. Null: no relief, nothing fetched. */
	terrain: string | null;
	dark: boolean;
}

/**
 * The basemap with the overlay over it: one style, so a theme switch
 * (`setStyle`) redraws everything with the current data. Order, bottom up: the
 * basemap's land, the relief, the rest of the basemap, the MAP grid, the
 * quaternaries, the channels, the pieces, the proposal, the modules, the names,
 * the drawing.
 */
export function mapStyle(c: Palette, opts: StyleOptions, data: StyleData): Style {
	const base = basemapStyle(opts.tilesUrl, c);
	const glyphs = opts.glyphs && opts.tilesUrl ? opts.glyphs : null;
	const grid = mapGridLayers(c, !!glyphs, mapGridLabelMinZoom(data.mapGridCellDeg));
	const style: Style = {
		version: 8,
		sources: {
			...base.sources,
			quaternaries: { type: 'geojson', data: data.quaternaries },
			channels: { type: 'geojson', data: data.channels },
			pieces: { type: 'geojson', data: data.pieces },
			proposal: { type: 'geojson', data: data.proposal },
			modules: { type: 'geojson', data: data.modules },
			mapgrid: { type: 'geojson', data: data.mapGrid },
			[DRAFT_SOURCE]: { type: 'geojson', data: data.draft }
		},
		layers: [
			...base.layers,
			...grid.cells,
			...quaternaryLayers(c),
			...channelLayers(c),
			...pieceLayers(c),
			...proposalLayers(c),
			...moduleLayers(c),
			...(glyphs ? labelLayers(c) : []),
			...grid.labels,
			...draftLayers(c)
		]
	};
	if (opts.terrain) {
		style.sources[TERRAIN_SOURCE] = terrainSource(opts.terrain);
		const before = reliefBeforeId(style.layers.map((l) => l.id));
		const at = before ? style.layers.findIndex((l) => l.id === before) : style.layers.length;
		style.layers.splice(at, 0, reliefLayer(opts.dark));
	}
	if (glyphs) style.glyphs = glyphs;
	return style;
}
