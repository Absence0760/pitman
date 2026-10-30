// The box a view asks for. `snappedViewBbox` is ported from IC-WBT
// (Absence0760/project-water-management, MIT) frontend/src/lib/components/map/mapLayers.ts at f888e4461.
// Pure, so vitest checks it.
import type { Box } from './pieces.js';

/** The widest box the MAP grid is asked for (the server's MAP_GRID_BBOX_MAX_DEG). */
export const MAP_GRID_BBOX_MAX_DEG = 2;
/** The grid a view is snapped out to before the MAP grid is asked for it, so small pans share one answer. */
export const MAP_GRID_VIEW_SNAP_DEG = 0.1;

/**
 * A map view snapped outward to whole multiples of `snap` degrees, so a small
 * pan asks the same box again: null when no view is known or the snapped view
 * is wider than `maxDeg` a side (the server refuses it: zoom in).
 */
export function snappedViewBbox(view: Box | null, snap: number, maxDeg: number): Box | null {
	if (!view || !view.every(Number.isFinite)) return null;
	const r = (v: number) => Math.round(v * 1e4) / 1e4;
	const w = r(Math.max(-180, Math.floor(view[0] / snap) * snap));
	const s = r(Math.max(-90, Math.floor(view[1] / snap) * snap));
	const e = r(Math.min(180, Math.ceil(view[2] / snap) * snap));
	const n = r(Math.min(90, Math.ceil(view[3] / snap) * snap));
	if (e <= w || n <= s || e - w > maxDeg || n - s > maxDeg) return null;
	return [w, s, e, n];
}

/** The box the MAP grid is asked for: the view snapped outward; null past the limit (zoom in). */
export const mapGridViewBbox = (view: Box | null): Box | null => snappedViewBbox(view, MAP_GRID_VIEW_SNAP_DEG, MAP_GRID_BBOX_MAX_DEG);

/** Whether box `outer` holds box `inner`: a view inside the box already loaded asks for nothing new. */
export const boxHolds = (outer: Box | null, inner: Box | null): boolean => !!outer && !!inner && outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
