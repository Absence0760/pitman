/**
 * What the panel hands the two tools the page supplies. The map and the
 * tributary tool aren't imported here: they arrive as snippets, so the panel
 * compiles and tests alone, and neither ever talks to the other directly.
 *
 * The page writes:
 *
 *     {#snippet map(props)}<Map {...props} />{/snippet}
 *     {#snippet tributary(slot)}<TributaryTool {...slot} />{/snippet}
 */

import type { AreaGeometry, ChannelCollection, DelineateResponse } from '@pitman/wrsm';
import type { Bbox } from './geometry.js';

/** The tributary tool's side of the wizard (subdivide.md § Hydrological split). */
export interface TributarySlot {
	/** The quaternary's code. */
	readonly quaternary: string;
	/** The piece being split: the quaternary, or a piece of it. */
	readonly within: AreaGeometry;
	/** The last click on the map, `[lon, lat]`; the panel puts the map in `point` mode while the tool is on. */
	readonly click: readonly [number, number] | null;
	/** The map's view, for loading the channels by box. */
	readonly view: Bbox | null;
	/** Show a delineated tributary on the map, not yet accepted. */
	readonly onproposal: (geometry: AreaGeometry | null) => void;
	/** The terrain channels to draw while the tool is on. */
	readonly onchannels: (channels: ChannelCollection | null) => void;
	/** The user accepted this tributary. */
	readonly onaccept: (answer: DelineateResponse, click: readonly [number, number]) => void;
}
