// The dams one area holds, by each candidate's point (subdivide.md § Farm dams assigns a dam the same way). Matching them
// is the engine's (`matchDams`, D4): the screen runs it, so a change of radius needs no second request.
import { type AreaGeometry, type DamCandidate, pointInGeometry } from '@pitman/wrsm';

/** The candidates inside the area, each id once. */
export function damsInArea(candidates: readonly DamCandidate[], area: AreaGeometry): DamCandidate[] {
	const seen = new Set<string>();
	return candidates.filter((d) => {
		if (seen.has(d.id) || !pointInGeometry([d.lon, d.lat], area)) return false;
		seen.add(d.id);
		return true;
	});
}
