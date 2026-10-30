/**
 * Method B (docs/theory/subdivide.md) as the screen calls it. The screen never
 * scales an area, rewires a route or iterates a factor itself: it calls the
 * engine's functions (contract: `packages/wrsm/src/subdivide/contract.ts`)
 * through this interface, so tests pass a fake.
 *
 * `subdivideEngine` is the one adapter to repoint when the engine lands:
 * import the seven functions from `@pitman/wrsm` and list them here. Until
 * then each answers with a plain sentence the panel shows, so nothing crashes.
 */

import type { ApplySplit, CalibrateMap, PreviewSplit, ScalePieceAreas, SplitByZone, UnsplitNaturalMar, ZoneFromThreshold } from '@pitman/wrsm';
import type { LoadedBundle } from '#lib/network/engine.js';

export interface SubdivideEngine {
	readonly scalePieceAreas: ScalePieceAreas;
	readonly previewSplit: PreviewSplit;
	readonly calibrateMap: CalibrateMap;
	readonly unsplitNaturalMar: UnsplitNaturalMar;
	readonly applySplit: ApplySplit<LoadedBundle>;
	readonly zoneFromThreshold: ZoneFromThreshold;
	readonly splitByZone: SplitByZone;
}

const pending = (name: string) => (): never => {
	throw new Error(`The sub-division engine is not in this build yet (${name}).`);
};

export const subdivideEngine: SubdivideEngine = {
	scalePieceAreas: pending('scalePieceAreas'),
	previewSplit: pending('previewSplit'),
	calibrateMap: pending('calibrateMap'),
	unsplitNaturalMar: pending('unsplitNaturalMar'),
	applySplit: pending('applySplit'),
	zoneFromThreshold: pending('zoneFromThreshold'),
	splitByZone: pending('splitByZone')
};
