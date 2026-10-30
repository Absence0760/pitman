/**
 * Method B: sub-dividing a quaternary (docs/theory/subdivide.md). The
 * functions implement the types in `contract.ts`.
 */

export { fileRound, largestRemainder, scalePieceAreas } from './areas.js';
export { FACTOR_BOUNDS, MAP_LIMITS_MM, MAR_TOLERANCE, MAX_EVALUATIONS, calibrateMap, naturalPeriod, roundedResult, solveFactor, unsplitNaturalMar, type FactorSearch, type NaturalPeriod } from './calibrate.js';
export { cellAreaKm2, geometryAreaKm2 } from './geodesic.js';
export { MAX_PIECES, SubdivisionError } from './pieces.js';
export { applySplit, mergePieces, previewSplit } from './split.js';
export { describeValueSplit, distinctValues } from './values.js';
export { differenceGeometry, intersectGeometry, pointInGeometry, splitByZone, zoneFromThreshold } from './zones.js';
