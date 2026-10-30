// Invented dams for local development, over the same block as cfm/synthetic.ts, in all three of D4's sources so
// the matching has something to do: some dams are listed by several sources with figures that disagree, some by one,
// and a few have no figure at all. **Invented values only:** the positions, names and capacities are a hash of a
// grid cell. Nothing here is a real dam, and the "register" here is not the DWS register.
import type { DamCandidate } from '@pitman/wrsm';
import { cellNoise, SYNTHETIC_LAND_USE } from '../cfm/synthetic.js';

/** At most one dam site per cell of this size, about 5.5 km. */
const SITE_DEG = 0.05;
/** The share of cells with a dam. */
const SITE_CHANCE = 0.65;
/** 100 m in degrees of latitude: how far apart the sources put one dam, inside the default match radius. */
const OFFSET_DEG = 0.0009;

function siteAt(x: number, y: number): DamCandidate[] {
	const [chance, kind, px, py] = cellNoise(x, y, 2);
	if (chance >= SITE_CHANCE) return [];
	const [size, depth, drift, driftAgain] = cellNoise(x, y, 3);
	const [lon, lat] = [SYNTHETIC_LAND_USE.west + (x + 0.1 + 0.8 * px) * SITE_DEG, SYNTHETIC_LAND_USE.south + (y + 0.1 + 0.8 * py) * SITE_DEG];
	const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
	const capacityMm3 = r(0.02 + size * size * 0.6, 3);
	const areaKm2 = r(capacityMm3 / (2 + 3 * depth), 4);
	const name = `Synthetic dam ${x}-${y}`;
	const at = (d: number) => ({ lon: r(lon + OFFSET_DEG * (d - 0.5), 6), lat: r(lat + OFFSET_DEG * (0.5 - d), 6) });
	const key = `${x}-${y}`;
	const register = (): DamCandidate => ({ id: `syn-reg-${key}`, source: 'register', lon: r(lon, 6), lat: r(lat, 6), capacityMm3, name });
	const cfm = (): DamCandidate => ({ id: `syn-cfm-${key}`, source: 'capeFarmMapper', ...at(drift), capacityMm3: r(capacityMm3 * (0.85 + 0.3 * driftAgain), 3), name });
	const water = (): DamCandidate => ({ id: `syn-sw-${key}`, source: 'surfaceWater', ...at(driftAgain), areaKm2 });
	if (kind < 0.15) return [register(), cfm(), water()];
	if (kind < 0.5) return [cfm(), water()];
	if (kind < 0.85) return [water()];
	if (kind < 0.93) return [{ id: `syn-cfm-${key}`, source: 'capeFarmMapper', ...at(drift), name }];
	return [{ id: `syn-sw-${key}`, source: 'surfaceWater', ...at(drift), areaKm2: 0.0006 }];
}

/** The invented candidates in the box `[west, south, east, north]`; off the block, none. */
export function syntheticDams(box: readonly [number, number, number, number]): DamCandidate[] {
	const g = SYNTHETIC_LAND_USE;
	const out: DamCandidate[] = [];
	const cols = Math.round((g.east - g.west) / SITE_DEG);
	const rows = Math.round((g.north - g.south) / SITE_DEG);
	for (let y = Math.max(0, Math.floor((box[1] - g.south) / SITE_DEG)); y <= Math.min(rows - 1, Math.floor((box[3] - g.south) / SITE_DEG)); y++) {
		for (let x = Math.max(0, Math.floor((box[0] - g.west) / SITE_DEG)); x <= Math.min(cols - 1, Math.floor((box[2] - g.west) / SITE_DEG)); x++) {
			out.push(...siteAt(x, y));
		}
	}
	return out;
}
