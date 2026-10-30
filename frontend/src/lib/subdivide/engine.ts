/**
 * Method B (docs/theory/subdivide.md) as the screen calls it. The screen never
 * scales an area, rewires a route or iterates a factor itself: it calls the
 * engine's functions (contract: `packages/wrsm/src/subdivide/contract.ts`)
 * through this interface, so tests pass a fake.
 */

import {
	applySplit,
	calibrateMap,
	previewSplit,
	scalePieceAreas,
	splitByZone,
	unsplitNaturalMar,
	zoneFromThreshold,
	type ApplySplit,
	type CalibrateMap,
	type PreviewSplit,
	type ScalePieceAreas,
	type SplitByZone,
	type UnsplitNaturalMar,
	type ZoneFromThreshold
} from '@pitman/wrsm';
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

export const subdivideEngine: SubdivideEngine = { scalePieceAreas, previewSplit, calibrateMap, unsplitNaturalMar, applySplit, zoneFromThreshold, splitByZone };
