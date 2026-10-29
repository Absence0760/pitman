/**
 * A synthetic `NetworkBundle` with every route kind the network runner
 * handles, for tests (issue #3 rule 2: no real data). Built on
 * `syntheticNetwork()`'s three runoff modules and rainfall:
 *
 *   pos 1  RU1 --route 1--> RU2 (its RTIN upstream inflow)
 *   pos 2  RU2 --route 2--> RV5
 *   pos 3  RU3 --route 3--> CR4
 *   pos 4  RR6 (abstraction route 7 from CR4; return-flow route 8 to the zero sink)
 *   pos 5  RV5 --route 5 (spill)--> CR4
 *   pos 6  CR4 --route 4 (principal)--> zero sink
 *              --route 7--> RR6 (irrigation abstraction: RR6 is solved first)
 *              --route 9--> zero sink, a defined abstraction ('SYRQ9.ABS')
 *          zero source --route 6--> CR4, a defined inflow ('SYTRANS.ABS')
 *
 * One gauge on route 4. Defined-flow files cover the whole run.
 */

import { syntheticNetwork, type SyntheticOptions } from '../synthetic/index.js';
import type {
	ChannelModule,
	DemandSeries,
	IrrigationPitmanLayout,
	Monthly12,
	MonthlyRow,
	Network,
	NetworkBundle,
	ObservedFlow,
	ObservedRow,
	ReservoirModule,
	RunoffModule,
	Twelve
} from '../types.js';

const twelve = (f: (m: number) => number) => Array.from({ length: 12 }, (_, m) => f(m)) as unknown as Monthly12;

function flowFile(fileName: string, startYear: number, endYear: number, f: (year: number, month: number) => number): DemandSeries {
	const rows: MonthlyRow[] = [];
	for (let year = startYear; year <= endYear; year++) rows.push({ year, months: twelve((m) => f(year, m)) });
	return { fileName, rows, hasTotals: false, hasAverage: false };
}

/**
 * Invented observed flow at the gauge for every run year, million m³: a
 * seasonal shape, one missing month (negative, docs/decisions.md) and one
 * incomplete (`+`) month, so readers and the results screen meet both.
 */
function observedFlow(startYear: number, endYear: number): ObservedFlow {
	const rows: ObservedRow[] = [];
	for (let year = startYear; year <= endYear; year++) {
		const months = twelve((m) => {
			if (year === startYear && m === 2) return -1;
			return Math.round((0.4 + 0.3 * Math.cos(((m - 4) * Math.PI) / 6) + 0.02 * (year - startYear)) * 1000) / 1000;
		});
		const incomplete = twelve(() => 0).map((_, m) => year === endYear && m === 11) as unknown as Twelve<boolean>;
		const annualTotal = Math.round(months.reduce((a, v) => a + Math.max(v, 0), 0) * 1000) / 1000;
		rows.push({ year, months, incomplete, annualTotal, annualIncomplete: year === endYear });
	}
	return { rows };
}

/** The bundle described in the module comment. Same options as `syntheticNetwork`. */
export function syntheticBundle(options: SyntheticOptions = {}): NetworkBundle {
	const base = syntheticNetwork(options);
	const { code, startYear, endYear } = base.network;
	const [ru1, ru2, ru3] = base.runoff as [RunoffModule, RunoffModule, RunoffModule];
	const rainA = base.rainfall[0]!.fileName;

	const network: Network = {
		...base.network,
		modules: [
			{ number: 1, type: 'RU', solve: true },
			{ number: 2, type: 'RU', solve: true },
			{ number: 3, type: 'RU', solve: true },
			{ number: 6, type: 'RR', solve: true },
			{ number: 5, type: 'RV', solve: true },
			{ number: 4, type: 'CR', solve: true }
		],
		gauges: [{ route: 4, label: `${code}H001`, observedFile: `${code}H001.OBS` }],
		routes: [
			{ number: 1, upstreamPosition: 1, downstreamPosition: 2, cost: 0 },
			{ number: 2, upstreamPosition: 2, downstreamPosition: 5, cost: 0 },
			{ number: 3, upstreamPosition: 3, downstreamPosition: 6, cost: 0 },
			{ number: 4, upstreamPosition: 6, downstreamPosition: 0, cost: 0 },
			{ number: 5, upstreamPosition: 5, downstreamPosition: 6, cost: 0 },
			{ number: 6, upstreamPosition: 0, downstreamPosition: 6, cost: 0 },
			{ number: 7, upstreamPosition: 6, downstreamPosition: 4, cost: 0 },
			{ number: 8, upstreamPosition: 4, downstreamPosition: 0, cost: 0 },
			{ number: 9, upstreamPosition: 6, downstreamPosition: 0, cost: 0 }
		]
	};

	const reservoir: ReservoirModule = {
		kind: 'RV',
		number: 5,
		name: 'Synthetic dam',
		mapMm: ru2.mapMm,
		rainfallFile: rainA,
		areaVolumePower: 0.6,
		// TT 689 p.91: at least two triplets, the first in or before the first simulated year and the last in or after the last.
		capacity: [
			{ year: startYear, fullSupplyVolumeMm3: 2, fullSupplyAreaKm2: 0.5 },
			{ year: endYear, fullSupplyVolumeMm3: 2, fullSupplyAreaKm2: 0.5 }
		],
		panMm: ru2.sPanMm,
		panFactors: twelve(() => 0.8),
		spillRoute: 5,
		inflows: [{ route: 2, definedFlowFile: null }],
		outflows: [{ route: 5, definedFlowFile: null }],
		initialStorageMm3: 1
	};

	const channel: ChannelModule = {
		kind: 'CR',
		number: 4,
		name: 'Synthetic river',
		fileVersion: 2,
		wetlandMapMm: 0,
		wetlandRainfallFile: null,
		bedLossMm3PerMonth: 0.01,
		wetlandStorageMm3: 0,
		wetlandAreaKm2: 0,
		rechargeCoefficient: 1,
		panMm: twelve(() => 0),
		panFactors: twelve(() => 0),
		principalOutflowRoute: 4,
		inflows: [
			{ route: 3, definedFlowFile: null },
			{ route: 5, definedFlowFile: null },
			{ route: 6, definedFlowFile: `${code}TRANS.ABS` }
		],
		outflows: [
			{ route: 4, definedFlowFile: null },
			{ route: 7, definedFlowFile: null },
			{ route: 9, definedFlowFile: `${code}RQ9.ABS` }
		],
		reserved: 1,
		wetlandType: 0
	};

	const irrigation: IrrigationPitmanLayout = {
		kind: 'RR',
		layout: 'pitman',
		number: 6,
		name: 'Synthetic irrigation',
		fileVersion: 0,
		modelType: 1,
		mapMm: ru3.mapMm,
		rainfallFile: rainA,
		areaKm2: [{ year: startYear, value: 2 }],
		pIndex: twelve(() => 1),
		panMm: ru3.sPanMm,
		panFactors: twelve(() => 0.8),
		maxAnnualAllocationMm: 9999,
		effectiveRainfallFactors: twelve(() => 0.7),
		abstractionRoute: 7,
		returnFlowRoute: 8,
		returnFlowPercent: 10
	};

	const rainfall = Object.fromEntries(base.rainfall.map((r) => [r.fileName.toUpperCase(), r.series]));
	const files = [
		flowFile(`${code}TRANS.ABS`, startYear, endYear, (year, m) => 0.05 + 0.01 * ((year + m) % 3)),
		flowFile(`${code}RQ9.ABS`, startYear, endYear, (year) => 0.02 + 0.001 * (year - startYear))
	];
	return {
		network,
		modules: [ru1, ru2, ru3, irrigation, reservoir, channel],
		rainfall,
		observed: { [`${code}H001.OBS`]: observedFlow(startYear, endYear) },
		flowFiles: Object.fromEntries(files.map((f) => [f.fileName.toUpperCase(), f]))
	};
}
