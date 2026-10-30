// `a − b`, the one vector boolean the tributary split needs (subdivide.md § Hydrological split, step 5).
// The call is here alone so it can move to the engine's `differenceGeometry` (`@pitman/wrsm`) once that is
// merged, which would take `polyclip-ts` out of the backend's own dependencies (decision R5-D3).
import type { AreaGeometry } from '@pitman/wrsm';
import { difference as polyclipDifference, type Geom } from 'polyclip-ts';

/** `a − b`, or null when nothing is left. A single polygon comes back as a Polygon. */
export function differenceGeometry(a: AreaGeometry, b: AreaGeometry): AreaGeometry | null {
	const parts = polyclipDifference(a.coordinates as unknown as Geom, b.coordinates as unknown as Geom);
	if (parts.length === 0) return null;
	const coordinates = parts as unknown as [number, number][][][];
	return coordinates.length === 1 ? { type: 'Polygon', coordinates: coordinates[0]! } : { type: 'MultiPolygon', coordinates };
}
