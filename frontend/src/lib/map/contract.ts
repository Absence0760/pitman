/**
 * Round 5 contract for the map (agents 5.1, 5.2, 5.3, 5.5), written by the
 * orchestrator. 5.1 owns `Map.svelte`, which takes these props; the tools
 * only hand it data and react to its callbacks, so they never touch
 * MapLibre. Change it here first.
 */

import type { AreaGeometry, ChannelCollection, MapGridCells, QuaternaryCollection } from '@pitman/wrsm';

/** A piece drawn over the quaternaries; its number is what names it, the tint only helps the eye. */
export interface MapPiece {
	readonly id: string;
	/** 1-based, shown on the piece and on its card. */
	readonly number: number;
	readonly label: string;
	readonly geometry: AreaGeometry;
}

/** What a click on the map does. */
export type MapTool = 'select' | 'point' | 'draw';

/** A network module placed on a quaternary (by the code in its name, or chosen by the user). */
export interface MapModule {
	readonly id: string;
	readonly label: string;
	readonly lngLat: readonly [number, number];
}

/** A crop field from the land-use data: what is on the ground, not something waiting to be accepted. */
export interface MapField {
	readonly id: string;
	readonly crop: string;
	/** What the layer says of irrigation; `null` when it doesn't say. */
	readonly irrigated: boolean | null;
	readonly geometry: AreaGeometry;
}

/** The props of `$lib/map/Map.svelte`. */
export interface MapProps {
	readonly quaternaries: QuaternaryCollection | null;
	/** The selected quaternary's code. */
	readonly selected: string | null;
	readonly modules?: readonly MapModule[];
	readonly pieces?: readonly MapPiece[];
	/** Crop fields, solid-edged and filled by what is known of their irrigation. */
	readonly fields?: readonly MapField[];
	/** Drawn while the tributary tool is on. */
	readonly channels?: ChannelCollection | null;
	/** The MAP grid as a layer, off when `null`. */
	readonly mapGrid?: MapGridCells | null;
	/** A proposal not yet accepted (a MAP-zone preview, a delineated tributary). */
	readonly proposal?: AreaGeometry | null;
	readonly tool?: MapTool;
	readonly onselect?: (code: string) => void;
	/** `tool: 'point'`: the click. */
	readonly onpoint?: (lngLat: readonly [number, number]) => void;
	/** `tool: 'draw'`: the finished polygon. */
	readonly ondraw?: (geometry: AreaGeometry) => void;
	/** The view changed, for tools that load by box: `[west, south, east, north]`. */
	readonly onview?: (bbox: readonly [number, number, number, number]) => void;
}
