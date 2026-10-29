/**
 * A stand-in for the engine's `run()` (a stub until Round 3 integration):
 * deterministic, and it depends on the bundle's content (rainfall rows,
 * module areas and MAPs) and the mode, so "the same network gives the same
 * results" is a real check. Not hydrology.
 */

import type { MonthlySeries, NetworkBundle, RunMode, RunResult } from '@pitman/wrsm';

export function fakeRun(bundle: NetworkBundle, mode: RunMode): RunResult {
	const { startYear, endYear } = bundle.network;
	const factor = mode.kind === 'natural' ? 1 : mode.kind === 'historical' ? 0.9 : 0.8 + (mode.year - 2000) / 1000;
	const rain = Object.values(bundle.rainfall)[0];
	const scale = bundle.modules.reduce((sum, m) => sum + (m.kind === 'RU' ? m.areaKm2 * m.mapMm : 0), 0) / 1e6;
	const routeFlows: Record<number, MonthlySeries> = {};
	for (const route of bundle.network.routes) {
		const values: number[] = [];
		for (let y = startYear; y <= endYear; y++) {
			const row = rain?.rows.find((r) => r.year === y);
			for (let m = 0; m < 12; m++) values.push(((row?.months[m] ?? 0) * scale * factor * route.number) / 100);
		}
		routeFlows[route.number] = { startYear, values, unit: 'Mm3' };
	}
	return { mode, startYear, endYear, routeFlows, reservoirStorage: {}, messages: [] };
}
