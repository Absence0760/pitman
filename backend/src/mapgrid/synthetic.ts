// A synthetic MAP grid for local development (CLAUDE.md Local-first), in the JSON form of IC-WBT's
// committed fixture (geo/rainMap.ts rainMapToJson: `{ cellDeg, source, version, attribution, cells:
// [[lon, lat, mapMm], …] }`, each cell by its centre). **Invented values only:** a smooth hill of rain
// over the same invented area as the synthetic CHIRPS copy (21–22° E, 34.5–33.5° S, 0.01° cells), with
// no value south of 34.25° S (the same invented coast). Deterministic: no randomness at all.

export const SYNTHETIC_MAP_GRID = {
	dataset: 'synthetic',
	cellDeg: 0.01,
	w: 21,
	s: -34.5,
	e: 22,
	n: -33.5,
	coastLat: -34.25,
	source: 'Invented MAP grid for local development (backend/scripts/gen-synthetic-data.ts): a smooth hill of rainfall, never real data',
	version: 'synthetic 1',
	attribution: 'Synthetic test data'
} as const;

/** The invented MAP (mm) at a cell centre. */
export function syntheticMap(lon: number, lat: number): number {
	const hill = 650 * Math.exp(-((lon - 21.4) ** 2 + (lat + 33.7) ** 2) / 0.06);
	return Math.round(280 + hill + 120 * (lat + 34.25));
}

/** The grid's JSON. */
export function syntheticMapGridJson(): string {
	const g = SYNTHETIC_MAP_GRID;
	const r7 = (x: number) => Math.round(x * 1e7) / 1e7;
	const rows = Math.round((g.n - g.s) / g.cellDeg);
	const cols = Math.round((g.e - g.w) / g.cellDeg);
	const cells: [number, number, number][] = [];
	for (let r = 0; r < rows; r++) {
		const lat = r7(g.s + (r + 0.5) * g.cellDeg);
		if (lat < g.coastLat) continue;
		for (let c = 0; c < cols; c++) {
			const lon = r7(g.w + (c + 0.5) * g.cellDeg);
			cells.push([lon, lat, syntheticMap(lon, lat)]);
		}
	}
	return JSON.stringify({ cellDeg: g.cellDeg, source: g.source, version: g.version, attribution: g.attribution, cells });
}
