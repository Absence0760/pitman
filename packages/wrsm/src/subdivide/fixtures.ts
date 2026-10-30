/**
 * The worked example of docs/theory/subdivide.md as a network, for tests:
 * synthetic, built on `syntheticNetwork()`. Not exported from the package.
 *
 *   RU15 --63--> RV8 --64--> CR4
 *   RU3  --10 (40 %)--> RV2 --12 (spill)--> CR4
 *        --11 (60 %)-----------------------> CR4 --5--> (out)
 *   RR7 (abstraction 20 from RV2, return flow 21 to CR4)
 */

import { syntheticNetwork } from '../synthetic/index.js';
import type { AreaGeometry } from '../extend/contract.js';
import type { ChannelModule, IrrigationPitmanLayout, Monthly12, NetworkBundle, ReservoirModule, RunoffModule, SamiParameters } from '../types.js';
import type { CalibrationTarget, PiecePlan, SplitPlan } from './contract.js';

const twelve = (v: number) => Array.from({ length: 12 }, () => v) as unknown as Monthly12;

export const SQUARE: AreaGeometry = {
	type: 'Polygon',
	coordinates: [
		[
			[20, -34],
			[20.2, -34],
			[20.2, -33.8],
			[20, -33.8],
			[20, -34]
		]
	]
};

export interface ExampleOptions {
	readonly years?: number;
	readonly irrigation?: boolean;
	readonly mapMm?: number;
	readonly initialStorageMm3?: number;
}

/** The worked example's network, RU 3 at 400 km² and 640 mm. */
export function exampleBundle(options: ExampleOptions = {}): NetworkBundle {
	const base = syntheticNetwork({ code: 'Z1', startYear: 1990, years: options.years ?? 20 });
	const { startYear, endYear } = base.network;
	const [template] = base.runoff as [RunoffModule];
	const rainfallFile = base.rainfall[0]!.fileName;
	const years = [startYear, endYear];
	const reservoir = (number: number, name: string, spillRoute: number, inflow: number, capacity: number, area: number): ReservoirModule => ({
		kind: 'RV',
		number,
		name,
		mapMm: 640,
		rainfallFile,
		areaVolumePower: 0.6,
		capacity: years.map((year) => ({ year, fullSupplyVolumeMm3: capacity, fullSupplyAreaKm2: area })),
		panMm: template.sPanMm,
		panFactors: twelve(0.8),
		spillRoute,
		inflows: [{ route: inflow, definedFlowFile: null }],
		outflows: [{ route: spillRoute, definedFlowFile: null }]
	});
	const ru3: RunoffModule = {
		...template,
		number: 3,
		name: 'Example module',
		areaKm2: 400,
		mapMm: options.mapMm ?? 640,
		rainfallFile,
		afforestation: {
			algorithm: 2,
			algorithmInFile: true,
			areaKm2: years.map((year) => ({ year, value: 12 })),
			species: { pine: { percent: 100, rotationYears: 30 }, eucalyptus: { percent: 0, rotationYears: 10 }, wattle: { percent: 0, rotationYears: 10 } },
			optimalPercent: 50,
			userDefinedReduction: { marPercent: 0, lowFlowPercent: 0 }
		},
		alienVegetation: { algorithm: 0, riparianArea: 0, areaKm2: [] },
		paved: { fraction: years.map((year) => ({ year, value: 0.02 })) },
		outflows: [
			{ route: 10, percent: 40 },
			{ route: 11, percent: 60 }
		],
		inflowRoute: 0
	};
	const ru15: RunoffModule = { ...template, number: 15, name: 'Upstream', areaKm2: 100, mapMm: 500, rainfallFile, outflows: [{ route: 63, percent: 100 }], inflowRoute: 0 };
	const rv2 = { ...reservoir(2, 'Farm dams', 12, 10, 6, 1.2), ...(options.initialStorageMm3 !== undefined ? { initialStorageMm3: options.initialStorageMm3 } : {}) };
	const rv8 = reservoir(8, 'Upstream dam', 64, 63, 3, 0.5);
	const channel: ChannelModule = {
		kind: 'CR',
		number: 4,
		name: 'Main stem',
		fileVersion: 2,
		wetlandMapMm: 0,
		wetlandRainfallFile: null,
		bedLossMm3PerMonth: 0,
		wetlandStorageMm3: 0,
		wetlandAreaKm2: 0,
		rechargeCoefficient: 1,
		panMm: twelve(0),
		panFactors: twelve(0),
		principalOutflowRoute: 5,
		inflows: [
			{ route: 11, definedFlowFile: null },
			{ route: 12, definedFlowFile: null },
			{ route: 64, definedFlowFile: null }
		],
		outflows: [{ route: 5, definedFlowFile: null }],
		reserved: 1,
		wetlandType: 0
	};
	const irrigation: IrrigationPitmanLayout = {
		kind: 'RR',
		layout: 'pitman',
		number: 7,
		name: 'Example irrigation',
		fileVersion: 0,
		modelType: 1,
		mapMm: 640,
		rainfallFile,
		areaKm2: years.map((year) => ({ year, value: 5.01 })),
		pIndex: twelve(1),
		panMm: template.sPanMm,
		panFactors: twelve(0.8),
		maxAnnualAllocationMm: 9999,
		effectiveRainfallFactors: twelve(0.7),
		abstractionRoute: 20,
		returnFlowRoute: 21,
		returnFlowPercent: 10
	};
	const withRr = options.irrigation === true;
	const routeList = [
		[5, 'CR4', ''],
		[10, 'RU3', 'RV2'],
		[11, 'RU3', 'CR4'],
		[12, 'RV2', 'CR4'],
		...(withRr ? [[20, 'RV2', 'RR7'] as const, [21, 'RR7', 'CR4'] as const] : []),
		[63, 'RU15', 'RV8'],
		[64, 'RV8', 'CR4']
	] as const;
	const order = ['RU15', 'RU3', ...(withRr ? ['RR7'] : []), 'RV2', 'RV8', 'CR4'];
	const position = (key: string) => order.indexOf(key) + 1;
	return {
		network: {
			...base.network,
			modules: order.map((key) => ({ number: Number(key.slice(2)), type: key.slice(0, 2) as 'RU' | 'RV' | 'CR' | 'RR', solve: true })),
			routes: routeList.map(([number, up, down]) => ({ number, upstreamPosition: position(up), downstreamPosition: down === '' ? 0 : position(down), cost: 0 }))
		},
		modules: [
			ru15,
			ru3,
			...(withRr ? [irrigation] : []),
			withRr ? { ...rv2, outflows: [...rv2.outflows, { route: 20, definedFlowFile: null }] } : rv2,
			rv8,
			withRr ? { ...channel, inflows: [...channel.inflows, { route: 21, definedFlowFile: null }] } : channel
		],
		rainfall: { [rainfallFile.toUpperCase()]: base.rainfall[0]!.series },
		observed: {},
		flowFiles: {}
	};
}

export function piece(role: PiecePlan['role'], polygonKm2: number, gridMapMm: number, extra: Partial<PiecePlan> = {}): PiecePlan {
	return { role, geometry: SQUARE, polygonKm2, gridMapMm, mapSource: 'grid', ...extra };
}

/** The worked example's plan: `T` 121.1 km² at 820 mm, `R` 282.6 km² at 610 mm, located land use. */
export function examplePlan(overrides: Partial<SplitPlan> = {}): SplitPlan {
	return {
		quaternary: 'Z01A',
		module: { type: 'RU', number: 3 },
		pieces: [
			piece('tributary', 121.1, 820, { locationShares: { afforestation: 0.25, damCapacity: 2 / 6 } }),
			piece('remainder', 282.6, 610, { locationShares: { afforestation: 0.75, damCapacity: 4 / 6 } })
		],
		splits: [{ kind: 'tributary', click: [20.7412, -33.5521], snapM: 41, dem: { label: 'Copernicus GLO-30', fingerprint: 'abc', zoom: 11 }, outsideQuaternaryPct: 3.1 }],
		grid: { dataset: 'synthetic grid', cellDeg: 0.001, source: 'synthetic' },
		layout: 'series',
		shares: { afforestation: 'location', alien: 'area', dams: 'location' },
		...overrides
	};
}

export const hand = (marMm3: number): CalibrationTarget => ({ marMm3, source: 'hand-entered: synthetic table' });

/** A Sami block with invented, plausible values (docs/theory/sami.md §2.1 defaults). */
export function samiBlock(pitman: RunoffModule['pitman']): SamiParameters {
	return {
		aquiferThicknessM: 20,
		storativity: 0.005,
		initialAquiferStorage: 60,
		staticWaterLevelMm: 60,
		unsaturatedStorage: 20,
		initialUnsaturatedStorage: 10,
		PPOW: 0.2,
		GPOW: 3,
		maxDischarge: 2,
		gwSwPower: -0.05,
		HGSL: 0,
		HGGW: 2,
		maxHydraulicGradient: 0.001,
		transmissivity: 10,
		boreholeDistanceToRiver: 1000,
		gwEvaporationArea: 12,
		K2: 0.1,
		K3: -3,
		interflowLag: 0,
		rechargeAveragingMonths: 2,
		abstractionMode: 1,
		pitman,
		abstractions: [
			{ year: 1990, value: 0.5 },
			{ year: 2009, value: 0.801 }
		]
	};
}
