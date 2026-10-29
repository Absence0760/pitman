/**
 * A deterministic generator of small synthetic networks, so engine and CLI
 * tests never need real data (issue #3 rule 2).
 *
 * The values are plausible, not calibrated: parameter ranges and the
 * rainfall season follow the synthetic examples in
 * `docs/formats/examples/network/` (a summer-rainfall catchment, a few
 * hundred mm of MAP, classic Pitman parameters near SYRU1.DAT's).
 *
 * The network is three classic-groundwater runoff modules feeding a channel
 * reach that leaves the network:
 *
 *   RU1 --route 1--> RU2 (as its upstream inflow)
 *   RU2 --route 2--> CR4
 *   RU3 --route 3--> CR4
 *   CR4 --route 4--> (outside)
 *
 * Only the runoff modules are generated as objects; CR4 is a .NET entry
 * only. Each runoff module has one outflow route (100 %). RU3 names its
 * rainfall file in lower case while the file is upper case, the mismatch
 * real networks have (docs/formats.md, "Case").
 */

import type {
	Monthly12,
	MonthlyRow,
	Network,
	NetworkModuleEntry,
	RainfallSeries,
	Route,
	RunoffModule
} from '../types.js';

/** Options for `syntheticNetwork`. */
export interface SyntheticOptions {
	/** PRNG seed; the same seed always gives the same network. Default 1. */
	readonly seed?: number;
	/** Network code, the prefix of every file name. Default 'SY'. */
	readonly code?: string;
	/** First hydrological year. Default 1990. */
	readonly startYear?: number;
	/** Number of years. Default 10. */
	readonly years?: number;
}

/** A rainfall file and the name it is stored under. */
export interface SyntheticRainfallFile {
	/** File name as stored, e.g. `SYA.RAN`. */
	readonly fileName: string;
	readonly series: RainfallSeries;
}

/** A generated network: the .NET, its runoff modules and their rainfall. */
export interface SyntheticNetwork {
	readonly network: Network;
	/** Runoff modules in .NET order; file name `<code>RU<number>.DAT`. */
	readonly runoff: readonly RunoffModule[];
	readonly rainfall: readonly SyntheticRainfallFile[];
}

/**
 * Mulberry32: a small 32-bit PRNG, enough for test data. Returns a function
 * giving numbers in [0, 1).
 */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A uniform number in [low, high), rounded to `decimals`. */
function between(random: () => number, low: number, high: number, decimals: number): number {
	return round(low + (high - low) * random(), decimals);
}

function round(value: number, decimals: number): number {
	const scale = 10 ** decimals;
	return Math.round(value * scale) / scale;
}

function twelve(f: (month: number) => number): Monthly12 {
	return Array.from({ length: 12 }, (_, m) => f(m)) as unknown as Monthly12;
}

/**
 * Long-term share of annual rainfall per month, % (October first), for a
 * summer-rainfall catchment: wet December to March, dry June to August.
 * Sums to 100.
 */
const SUMMER_SEASON: Monthly12 = [7, 9, 11, 13, 13, 12, 9, 6, 4, 4, 5, 7];

/** Typical monthly Symons-pan evaporation, mm (as SYRU1.DAT). */
const S_PAN_MM: Monthly12 = [160, 150, 140, 150, 130, 120, 90, 70, 60, 65, 85, 120];

/**
 * A rainfall series of `years` years: each month is the season's share
 * scaled by a wet/dry-year factor and a monthly noise factor, so annual
 * totals scatter around 100 % of MAP.
 */
function rainfall(random: () => number, code: string, startYear: number, years: number): RainfallSeries {
	const rows: MonthlyRow[] = [];
	for (let i = 0; i < years; i++) {
		const yearFactor = 0.6 + 0.8 * random();
		const months = twelve((m) => round(SUMMER_SEASON[m]! * yearFactor * (0.2 + 1.6 * random()), 2));
		rows.push({ year: startYear + i, months });
	}
	return { code, rows };
}

/** A classic-groundwater runoff module (file version 7, GWMODEL 0). */
function runoffModule(
	random: () => number,
	number: number,
	rainfallFile: string,
	outflowRoute: number,
	inflowRoute: number
): RunoffModule {
	return {
		kind: 'RU',
		number,
		name: `Synthetic ${number}`,
		fileVersion: 7,
		fileVersionInFile: true,
		areaKm2: between(random, 40, 200, 1),
		mapMm: Math.round(between(random, 450, 850, 0)),
		rainfallFile,
		pitman: {
			POW: 2,
			SL: 0,
			ST: Math.round(between(random, 150, 350, 0)),
			FT: between(random, 10, 40, 1),
			GW: between(random, 0, 5, 1),
			ZMIN: Math.round(between(random, 10, 40, 0)),
			ZMAX: Math.round(between(random, 400, 900, 0)),
			PI: 1.5,
			TL: 0.25,
			GL: between(random, 0, 2, 1),
			R: 0.5,
			FF: 1
		},
		sPanMm: S_PAN_MM,
		panFactors: twelve((m) => (m === 0 || m >= 9 ? 0.85 : 0.9)),
		afforestation: { algorithm: 0, algorithmInFile: true, areaKm2: [] },
		alienVegetation: { algorithm: 0, riparianArea: 0, areaKm2: [] },
		paved: { fraction: [] },
		outflows: [{ route: outflowRoute, percent: 100 }],
		inflowRoute,
		upstreamGroundwaterModule: 0,
		groundwaterModel: 0,
		naturalised: false,
		sfrChildren: [],
		aPanFactors: twelve((m) => (m >= 2 && m <= 6 ? 0.75 : 0.6))
	};
}

/** Generate a synthetic network (see the module comment for its shape). */
export function syntheticNetwork(options: SyntheticOptions = {}): SyntheticNetwork {
	const { seed = 1, code = 'SY', startYear = 1990, years = 10 } = options;
	const random = seededRandom(seed);

	const modules: NetworkModuleEntry[] = [
		{ number: 1, type: 'RU', solve: true },
		{ number: 2, type: 'RU', solve: true },
		{ number: 3, type: 'RU', solve: true },
		{ number: 4, type: 'CR', solve: true }
	];
	// Endpoints are 1-based positions in `modules` (TT 691 §12.6 L.014).
	const routes: Route[] = [
		{ number: 1, upstreamPosition: 1, downstreamPosition: 2, cost: 0 },
		{ number: 2, upstreamPosition: 2, downstreamPosition: 4, cost: 0 },
		{ number: 3, upstreamPosition: 3, downstreamPosition: 4, cost: 0 },
		{ number: 4, upstreamPosition: 4, downstreamPosition: 0, cost: 0 }
	];
	const network: Network = {
		code,
		fileVersion: 1,
		inputDirectory: `C:\\WRSM\\${code}\\`,
		outputDirectory: `C:\\WRSM\\${code}\\Out\\`,
		debug: 'N',
		summaryFile: false,
		modules,
		gauges: [],
		startYear,
		endYear: startYear + years - 1,
		routes,
		summaryLines: []
	};

	const fileA = `${code}A.RAN`;
	const fileB = `${code}B.RAN`;
	const rainfallFiles: SyntheticRainfallFile[] = [
		{ fileName: fileA, series: rainfall(random, `${code}A`, startYear, years) },
		{ fileName: fileB, series: rainfall(random, `${code}B`, startYear, years) }
	];
	const runoff = [
		runoffModule(random, 1, fileA, 1, 0),
		runoffModule(random, 2, fileA, 2, 1),
		runoffModule(random, 3, `${code.toLowerCase()}b.RAN`, 3, 0)
	];
	return { network, runoff, rainfall: rainfallFiles };
}
