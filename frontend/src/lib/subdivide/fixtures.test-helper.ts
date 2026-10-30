/**
 * Test fixtures for the wizard: the worked example of docs/theory/subdivide.md
 * (synthetic quaternary Z01A, no real catchment) and a fake engine that answers
 * with its numbers, standing in for agent 5.4's functions.
 */

import type { AreaGeometry, CalibrationIteration, CalibrationResult, CalibrationTarget, DelineateResponse, MapGridCells, NetworkBundle, RunoffModule, SplitPlan, SplitPreview } from '@pitman/wrsm';
import type { LoadedBundle } from '#lib/network/engine.js';
import type { MapGridMean } from './data.js';
import type { SubdivideEngine } from './engine.js';

/** A rectangle in longitude/latitude. */
export const box = (west: number, south: number, east: number, north: number): AreaGeometry => ({
	type: 'Polygon',
	coordinates: [
		[
			[west, south],
			[east, south],
			[east, north],
			[west, north],
			[west, south]
		]
	]
});

export const QUATERNARY = box(20.5, -33.7, 20.7, -33.5);
export const TRIBUTARY = box(20.5, -33.7, 20.6, -33.5);
export const REMAINDER = box(20.6, -33.7, 20.7, -33.5);

export function sample(meanMapMm: number, overrides: Partial<MapGridMean> = {}): MapGridMean {
	return {
		grid: 'Synthetic MAP grid',
		cellSizeM: 1000,
		cellCount: 400,
		meanMapMm,
		fetchedOn: '2026-10-30',
		cellDeg: 0.01,
		coveragePct: 98.5,
		version: 'v1',
		attribution: 'Synthetic, invented values',
		source: 'local',
		...overrides
	};
}

/** The delineation of the worked example. */
export const DELINEATED: DelineateResponse = {
	tributary: TRIBUTARY,
	remainder: REMAINDER,
	tributaryKm2: 121.1,
	remainderKm2: 282.6,
	outsideKm2: 3.9,
	outsidePct: 3.1,
	warning: null,
	snapM: 41,
	dem: { label: 'Synthetic DEM', fingerprint: 'abc', zoom: 11 }
};

const runoff = (number: number, name: string, extra: Partial<RunoffModule> = {}): RunoffModule => ({ kind: 'RU', number, name, areaKm2: 400, mapMm: 640, rainfallFile: 'Z01A.RAN', ...extra }) as unknown as RunoffModule;

/** RU 3 → RV 2 (40 %) and → CR 4 (60 %); RV 2 → CR 4; CR 4 → out: the worked example's outflow. */
export function workedBundle(extra: Partial<NetworkBundle> = {}): LoadedBundle {
	const bundle = {
		network: {
			code: 'ZZ',
			startYear: 1920,
			endYear: 2009,
			gauges: [],
			summaryLines: [],
			modules: [
				{ number: 3, type: 'RU', solve: true },
				{ number: 2, type: 'RV', solve: true },
				{ number: 4, type: 'CR', solve: true },
				{ number: 7, type: 'RU', solve: true },
				{ number: 8, type: 'RU', solve: true }
			],
			routes: [
				{ number: 10, upstreamPosition: 1, downstreamPosition: 2, cost: 0 },
				{ number: 11, upstreamPosition: 1, downstreamPosition: 3, cost: 0 },
				{ number: 12, upstreamPosition: 2, downstreamPosition: 3, cost: 0 },
				{ number: 13, upstreamPosition: 3, downstreamPosition: 0, cost: 0 },
				{ number: 14, upstreamPosition: 4, downstreamPosition: 3, cost: 0 }
			]
		},
		modules: [runoff(3, 'Z01A upper'), runoff(7, 'Z02B', { sfrChildren: [8] }), runoff(8, 'SFR child')],
		rainfall: {},
		observed: {},
		flowFiles: {},
		...extra
	};
	return bundle as unknown as LoadedBundle;
}

/** The worked example's iteration log (subdivide.md § Worked example). */
export const WORKED_ITERATIONS: readonly CalibrationIteration[] = [
	{ n: 0, s: 1, maps: [820, 610], marMm3: 30.11, errorPct: 25.46, step: 'start' },
	{ n: 1, s: 0.7971, maps: [654, 486], marMm3: 14.068, errorPct: -41.38, step: 'ratio' },
	{ n: 2, s: 0.9227, maps: [757, 563], marMm3: 23.282, errorPct: -2.99, step: 'secant' },
	{ n: 3, s: 0.9325, maps: [765, 569], marMm3: 24.098, errorPct: 0.41, step: 'secant' }
];

const PERIOD = { startYear: 1920, endYear: 2009 } as const;

export const CONVERGED: CalibrationResult = {
	status: 'converged',
	message: null,
	iterations: WORKED_ITERATIONS,
	best: WORKED_ITERATIONS[3] as CalibrationIteration,
	finalMapsMm: [765, 569],
	finalMarMm3: 24.098,
	period: PERIOD
};

export const NOT_CONVERGED: CalibrationResult = {
	...CONVERGED,
	status: 'not_converged',
	message: 'The MAPs would have to change by more than a factor of 2: check the target and the grid.',
	best: WORKED_ITERATIONS[2] as CalibrationIteration,
	iterations: WORKED_ITERATIONS.slice(0, 3),
	finalMapsMm: [757, 563],
	finalMarMm3: 23.282
};

export const REFUSED: CalibrationResult = {
	status: 'refused',
	message: 'The natural run gives no runoff, so no factor can be found.',
	iterations: [],
	best: null,
	finalMapsMm: [],
	finalMarMm3: null,
	period: PERIOD
};

/** A fake engine: the worked example's numbers, each overridable. */
export function fakeEngine(overrides: Partial<SubdivideEngine> = {}): SubdivideEngine {
	return {
		scalePieceAreas: (moduleKm2, polygonKm2) => {
			const total = polygonKm2.reduce((s, a) => s + a, 0);
			const scale = moduleKm2 / total;
			return { areasKm2: polygonKm2.map((a) => Math.round(a * scale * 10) / 10), scale, warning: scale < 0.95 || scale > 1.05 ? `the network’s area for this module differs from its boundary by ${Math.round(Math.abs(1 - scale) * 100)} %: check you picked the right quaternary` : null };
		},
		previewSplit: (_bundle, plan: SplitPlan): SplitPreview => ({
			pieces: plan.pieces.map((p, i) => ({ role: p.role, module: { type: 'RU', number: i === 0 ? plan.module.number : 15 + i }, areaKm2: p.polygonKm2, outlet: i === 0 })),
			changes: ['RU 16 is new, inserted before RU 3.', 'Route 65 is new: RU 16 to CR 4.'],
			messages: []
		}),
		calibrateMap: () => CONVERGED,
		unsplitNaturalMar: () => ({ marMm3: 23.7, period: PERIOD }),
		applySplit: (bundle) => bundle,
		zoneFromThreshold: (_cells, within) => within,
		splitByZone: (within, zone) => ({ zone, rest: within, zoneKm2: 120, restKm2: 283.7 }),
		...overrides
	};
}

export const TARGET: CalibrationTarget = { marMm3: 24, source: 'hand-entered: WR2012, volume 1, table 2' };

/** A 3 × 3 block of cells over `box(20, -33.3, 20.3, -33)`, 0.1° each, north-west first; one has no value. */
export const CELLS: MapGridCells = {
	dataset: 'Synthetic MAP grid',
	source: 'Invented',
	cellDeg: 0.1,
	originLon: 20.05,
	originLat: -33.05,
	cols: 3,
	rows: 3,
	values: [900, 800, 700, 650, null, 600, 500, 400, 300]
};
