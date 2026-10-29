/**
 * Test fixtures for the extension screen: the worked example of
 * docs/theory/extend.md § Worked example (synthetic, no real catchment), and
 * a fake engine that answers with it. The fake stands in for agent 4.3's
 * functions; it does no fitting of its own.
 */

import type {
	ChirpsMonth,
	ChirpsMonthly,
	ExtensionFit,
	FactorCheck,
	FactorFit,
	FitOptions,
	Monthly12,
	RainfallExtension,
	RainfallSeries,
	Twelve
} from '@pitman/wrsm';
import type { ExtensionEngine } from './engine.js';

/** The `.RAN` of the worked example, zone ZZA, 1979–1984. */
export const WORKED_RAN: RainfallSeries = {
	code: 'ZZA',
	rows: [
		[1979, 6.1, 9.4, 11.2, 13.5, 12.8, 10.6, 7.3, 5.2, 3.1, 0.4, 1.9, 4.2],
		[1980, 5.8, 8.7, 10.1, 14.9, 13.2, 11.3, 6.9, 4.8, 2.7, 0.1, 1.6, 3.9],
		[1981, 7.2, 10.3, 12.6, 15.1, 11.9, 9.8, 8.1, 5.6, 3.4, 0.3, 2.2, 4.6],
		[1982, 4.9, 7.6, 9.3, 11.8, 10.7, 8.9, 5.7, 4.1, 2.2, 0.2, 1.3, 3.1],
		[1983, 6.6, 9.9, 11.7, 14.2, 13.6, 10.9, 7.6, 5.3, 3.0, 0.1, 2.0, 4.4],
		[1984, 5.4, 8.2, 10.4, 12.7, 12.1, 10.2, 6.6, 4.7, 2.8, 0.3, 1.7, 3.6]
	].map(([year, ...months]) => ({ year: year as number, months: months as unknown as Monthly12 }))
};

/** CHIRPS mm by hydrological year (October first), `null` = missing; 1987 holds October–December only. */
const CHIRPS_MM: Record<number, (number | null)[]> = {
	1981: [38, 55, 70, 86, 66, 52, 44, 30, 17, 0, 12, 25],
	1982: [27, 41, 52, 66, 60, 49, 31, 22, 11, 0, 7, 17],
	1983: [36, 54, 66, 80, 76, 60, 41, 28, 15, 0, 11, 24],
	1984: [30, 45, 59, 72, 68, 57, 36, 25, 14, 0, 9, 20],
	1985: [33, 48, 61, 77, 71, 55, 38, 27, 16, 2, 10, 22],
	1986: [29, 44, 57, 70, null, 53, 35, 24, 13, 0, 8, 19],
	1987: [35, 50, 64]
};

export const CHIRPS_MAP_MM = 452.8;

function chirpsMonths(): ChirpsMonth[] {
	const months: ChirpsMonth[] = [];
	// January–September 1981: the partial hydrological year 1980, not used by the method.
	for (let m = 1; m <= 9; m++) months.push({ year: 1981, month: m, mm: 20 });
	for (let hy = 1981; hy <= 1987; hy++) {
		const values = CHIRPS_MM[hy] as (number | null)[];
		values.forEach((mm, k) => months.push({ year: k < 3 ? hy : hy + 1, month: k < 3 ? k + 10 : k - 2, mm }));
	}
	return months;
}

export const WORKED_CHIRPS: ChirpsMonthly = {
	months: chirpsMonths(),
	cells: 41,
	weightRemovedPct: 0,
	areaKm2: 812.4,
	product: 'CHIRPS v3 rnl (final)',
	revision: 17,
	finalThrough: '1987-12-31',
	source: 'local'
};

const twelve = <T>(f: (k: number) => T): Twelve<T> => Array.from({ length: 12 }, (_, k) => f(k)) as unknown as Twelve<T>;

/** The worked example's factor table. */
const FACTORS: [number, number, number][] = [
	[6.025, 7.233, 0.833],
	[9.0, 10.766, 0.8359],
	[11.0, 13.637, 0.8066],
	[13.45, 16.784, 0.8013],
	[12.075, 14.907, 0.81],
	[9.95, 12.036, 0.8267],
	[7.0, 8.392, 0.8341],
	[4.925, 5.797, 0.8495],
	[2.85, 3.147, 0.9056],
	[0.225, 0, 1],
	[1.8, 2.153, 0.8359],
	[3.925, 4.748, 0.8266]
];

export function workedFactors(flag: FactorFit['flag'] = 'computed'): Twelve<FactorFit> {
	return twelve((k) => {
		const [meanFilePct, meanChirpsPct, computed] = FACTORS[k] as [number, number, number];
		const dry = k === 9;
		return {
			computed: flag === 'shortOverlap' ? 1 : computed,
			flag: flag === 'shortOverlap' ? 'shortOverlap' : dry ? 'chirpsDry' : 'computed',
			note: dry ? 'CHIRPS shows almost no rain in July over the overlap, the model’s file does; the factor can’t be estimated and is set to 1' : '',
			years: 4,
			meanFilePct,
			meanChirpsPct
		};
	});
}

/** The worked example's fit (extend.md § Worked example), as the engine would return it. */
export function workedFit(overrides: Partial<ExtensionFit> = {}): ExtensionFit {
	return {
		chirpsMapMm: CHIRPS_MAP_MM,
		chirpsMapYears: { startYear: 1981, endYear: 1985 },
		chirpsPct: [1981, 1982, 1983, 1984, 1985, 1986].map((year) => ({
			year,
			months: twelve((k) => {
				const mm = (CHIRPS_MM[year] as (number | null)[])[k];
				return mm === null || mm === undefined ? null : (100 * mm) / CHIRPS_MAP_MM;
			})
		})),
		overlap: { startYear: 1981, endYear: 1984, window: 'default' },
		factors: workedFactors(),
		before: {
			monthlyR2: 0.9988,
			monthlyNse: 0.813,
			annualR2: 0.9968,
			monthlyBiasPct: twelve((k) => 20 - k),
			annualBiasPct: 21.13
		},
		after: {
			monthlyR2: 0.9994,
			monthlyNse: 0.9993,
			annualR2: 0.9968,
			monthlyBiasPct: twelve((k) => (k === 9 ? -100 : 0)),
			annualBiasPct: -0.27
		},
		appendable: { firstYear: 1985, lastYear: 1985 },
		stoppedAt: { year: 1986, month: 4 },
		messages: [{ level: 'warning', text: 'The overlap is 4 years.' }],
		...overrides
	};
}

/** extend.md § Step 6, for the fake. */
export function fakeCheck(value: number): FactorCheck {
	if (!Number.isFinite(value) || value < 0 || value > 5) return 'refused';
	if (value === 0) return 'confirmZero';
	if (value < 0.5 || value > 2) return 'warn';
	return 'ok';
}

const round2 = (v: number) => Math.sign(v) * Math.round(Math.abs(v) * 100) / 100;

/** A fake engine: `fit` returns `fit` (narrowed to the window when given), `apply` appends `round(f·p, 2)` for the appendable years. */
export function fakeEngine(fit: ExtensionFit = workedFit(), calls: { fit: (FitOptions | undefined)[] } = { fit: [] }): ExtensionEngine {
	return {
		available: true,
		check: fakeCheck,
		fit: (_ran, _chirps, options) => {
			calls.fit.push(options);
			return options?.overlap ? { ...fit, overlap: { ...options.overlap, window: 'user' } } : fit;
		},
		apply: (ran, _chirps, f, factors, provenance) => {
			const appended = [];
			for (let y = f.appendable?.firstYear ?? 1; y <= (f.appendable?.lastYear ?? 0); y++) {
				const p = f.chirpsPct.find((r) => r.year === y)?.months;
				if (!p) break;
				appended.push({ year: y, months: twelve((k) => round2(factors[k] * (p[k] ?? 0))) as Monthly12 });
			}
			const last = ran.rows[ran.rows.length - 1]?.year ?? 0;
			return {
				series: { ...ran, rows: [...ran.rows, ...appended] },
				extension: {
					file: provenance.file.toUpperCase(),
					quaternary: provenance.quaternaries.join(','),
					chirps: { dataset: 'CHIRPS v3 rnl (final)', firstMonth: '1981-10', lastMonth: '1986-09', chirpsMapMm: f.chirpsMapMm, fetchedOn: provenance.accessed },
					overlap: { startYear: f.overlap.startYear, endYear: f.overlap.endYear },
					computedFactors: f.factors.map((x) => x.computed) as unknown as Monthly12,
					appliedFactors: factors,
					...(provenance.factorNotes && Object.keys(provenance.factorNotes).length > 0 && { factorNotes: provenance.factorNotes }),
					appendedYears: { first: last + 1, last: last + appended.length },
					originalEndYear: last
				}
			};
		}
	};
}

/** A sidecar entry for a file Pitman extended before. */
export function extensionOf(file: string, originalEndYear: number, last: number): RainfallExtension {
	return {
		file,
		quaternary: '',
		chirps: { dataset: 'CHIRPS v3 rnl (final)', firstMonth: '1981-10', lastMonth: '2025-09', chirpsMapMm: 452.8, fetchedOn: '2026-10-28' },
		overlap: { startYear: 1990, endYear: originalEndYear },
		computedFactors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
		appliedFactors: [1, 1, 1, 1, 1, 1, 1, 1.2, 1, 1, 1, 1],
		appendedYears: { first: originalEndYear + 1, last },
		originalEndYear
	};
}
