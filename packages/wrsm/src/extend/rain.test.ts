import { describe, expect, it } from 'vitest';
import { readRainfall, writeRainfall } from '../io/rainfall.js';
import { seededRandom } from '../synthetic/synthetic.js';
import type { Monthly12, MonthlyRow, RainfallSeries } from '../types.js';
import type { ChirpsMonthly, ExtensionProvenance } from './contract.js';
import { WORKED_1985, WORKED_FACTORS, WORKED_RAN, workedChirps } from './fixtures.js';
import {
	applyRainfallExtension,
	calendarMonth,
	checkFactor,
	estimateFactors,
	fitRainfallExtension,
	fitStatistics,
	hydroMonth,
	overlapYears,
	refitFromSidecar,
	roundHalfAwayFromZero,
	stripExtension
} from './rain.js';
import { syntheticChirpsMonthly } from './synthetic.js';

const PROVENANCE: ExtensionProvenance = { file: 'zza.ran', quaternaries: ['Z01A', 'Z01B'], accessed: '2026-10-28' };
const twelve = (f: (k: number) => number) => Array.from({ length: 12 }, (_, k) => f(k)) as unknown as Monthly12;

/** The worked example's file extended by synthetic years to `endYear`, so the overlap is long enough to fit. */
function ranFrom(startYear: number, endYear: number, seed = 1, code = 'ZZA'): RainfallSeries {
	const random = seededRandom(seed);
	const rows: MonthlyRow[] = [];
	const season = [7, 9, 11, 13, 13, 12, 9, 6, 4, 1, 5, 7];
	for (let y = startYear; y <= endYear; y++) {
		const f = 0.6 + 0.8 * random();
		rows.push({ year: y, months: twelve((k) => roundHalfAwayFromZero((season[k] as number) * f * (0.3 + 1.4 * random()), 2)) });
	}
	return { code, rows };
}

describe('hydrological years (extend.md § Step 3, U-19, A1)', () => {
	it('labels October–December of Y and January–September of Y + 1 as year Y', () => {
		expect(hydroMonth(1981, 10)).toEqual({ year: 1981, k: 0 });
		expect(hydroMonth(1981, 12)).toEqual({ year: 1981, k: 2 });
		expect(hydroMonth(1982, 1)).toEqual({ year: 1981, k: 3 });
		expect(hydroMonth(1982, 9)).toEqual({ year: 1981, k: 11 });
		for (let y = 1980; y < 1984; y++) for (let k = 0; k < 12; k++) {
			const c = calendarMonth(y, k);
			expect(hydroMonth(c.year, c.month)).toEqual({ year: y, k });
		}
	});

	it('does not use January–September 1981, the partial first CHIRPS year (A2)', () => {
		const a = fitRainfallExtension(WORKED_RAN, workedChirps(0));
		const b = fitRainfallExtension(WORKED_RAN, workedChirps(5000));
		expect(a.chirpsPct[0]?.year).toBe(1981);
		expect(a).toEqual(b);
	});
});

describe('rounding (extend.md § Step 7)', () => {
	it('rounds to two decimals half away from zero, as the decimal reads', () => {
		expect(roundHalfAwayFromZero(1.005)).toBe(1.01);
		expect(roundHalfAwayFromZero(-1.005)).toBe(-1.01);
		expect(roundHalfAwayFromZero(2.675)).toBe(2.68);
		expect(roundHalfAwayFromZero(0.125)).toBe(0.13);
		expect(roundHalfAwayFromZero(0.1249999)).toBe(0.12);
		expect(roundHalfAwayFromZero(6.0710)).toBe(6.07);
	});
});

describe('the worked example (extend.md § Worked example)', () => {
	const fit = fitRainfallExtension(WORKED_RAN, workedChirps());

	it('computes MAP_c over the complete CHIRPS years only (step 4)', () => {
		expect(fit.chirpsMapMm).toBeCloseTo(452.8, 10);
		expect(fit.chirpsMapYears).toEqual({ startYear: 1981, endYear: 1985 });
		const p1985 = fit.chirpsPct.find((r) => r.year === 1985)?.months;
		expect(p1985?.map((v) => Number((v as number).toFixed(3)))).toEqual([
			7.288, 10.601, 13.472, 17.005, 15.68, 12.147, 8.392, 5.963, 3.534, 0.442, 2.208, 4.859
		]);
		const p1987 = fit.chirpsPct.find((r) => r.year === 1987)?.months;
		expect(p1987?.slice(3)).toEqual(Array(9).fill(null));
		expect(fit.chirpsPct.find((r) => r.year === 1986)?.months[4]).toBeNull();
	});

	it('overlaps 1981–1984, too short to compute factors (step 5, |O| < 5)', () => {
		expect(fit.overlap).toEqual({ startYear: 1981, endYear: 1984, window: 'default' });
		for (const f of fit.factors) {
			expect(f.computed).toBe(1);
			expect(f.flag).toBe('shortOverlap');
			expect(f.years).toBe(4);
		}
		expect(fit.messages.some((m) => m.level === 'warning' && /only 4 years/.test(m.text))).toBe(true);
		expect(fit.after).toEqual(fit.before);
	});

	it('reports the overlap means behind each factor', () => {
		const meanR = [6.025, 9.0, 11.0, 13.45, 12.075, 9.95, 7.0, 4.925, 2.85, 0.225, 1.8, 3.925];
		const meanP = [7.233, 10.766, 13.637, 16.784, 14.907, 12.036, 8.392, 5.797, 3.147, 0.0, 2.153, 4.748];
		fit.factors.forEach((f, k) => {
			expect(f.meanFilePct).toBeCloseTo(meanR[k] as number, 10);
			expect(Math.abs(f.meanChirpsPct - (meanP[k] as number))).toBeLessThan(6e-4);
		});
	});

	it('gives the 12 factors by the ratio of overlap totals, July set to 1 and flagged', () => {
		const factors = estimateFactors(overlapYears(WORKED_RAN, fit));
		factors.forEach((f, k) => expect(f.computed).toBeCloseTo(WORKED_FACTORS[k] as number, 4));
		expect(factors[9]?.flag).toBe('chirpsDry');
		expect(factors[9]?.note).toMatch(/almost no rain in July/);
		expect(factors.filter((f) => f.flag === 'computed')).toHaveLength(11);
	});

	it('appends 1985, stopped by the missing February of 1986 (step 7)', () => {
		expect(fit.appendable).toEqual({ firstYear: 1985, lastYear: 1985 });
		expect(fit.stoppedAt).toEqual({ year: 1986, month: 4 });
		expect(fit.messages.some((m) => m.at?.year === 1986 && /February 1987/.test(m.text))).toBe(true);
		const factors = estimateFactors(overlapYears(WORKED_RAN, fit)).map((f) => f.computed) as unknown as Monthly12;
		const { series } = applyRainfallExtension(WORKED_RAN, workedChirps(), fit, factors, PROVENANCE);
		expect(series.rows).toHaveLength(7);
		expect(series.rows[6]).toEqual({ year: 1985, months: [...WORKED_1985] });
		const sum = (series.rows[6] as MonthlyRow).months.reduce((a, b) => a + b, 0);
		expect(Number(sum.toFixed(2))).toBe(83.75);
		const line = writeRainfall(series).split('\r\n')[6];
		expect(line).toBe('ZZA    1985   6.07   8.86  10.87  13.63  12.70  10.04   7.00   5.07   3.20   0.44   1.85   4.02');
	});

	it('reproduces the diagnostics before and after correction', () => {
		const overlap = overlapYears(WORKED_RAN, fit);
		const factors = estimateFactors(overlap).map((f) => f.computed) as unknown as Monthly12;
		const after = fitStatistics(overlap, factors);
		expect(fit.before.monthlyR2).toBeCloseTo(0.9988, 4);
		expect(after.monthlyR2).toBeCloseTo(0.9994, 4);
		expect(fit.before.monthlyNse).toBeCloseTo(0.813, 3);
		expect(after.monthlyNse).toBeCloseTo(0.9993, 4);
		expect(fit.before.annualR2).toBeCloseTo(0.9968, 4);
		expect(fit.before.annualBiasPct).toBeCloseTo(21.13, 2);
		expect(after.annualBiasPct).toBeCloseTo(-0.27, 2);
		// Bias is 0 by construction for every computed month, -100 % for July (no CHIRPS rain, factor 1).
		after.monthlyBiasPct.forEach((b, k) => (k === 9 ? expect(b).toBeCloseTo(-100, 10) : expect(b).toBeCloseTo(0, 10)));
	});
});

describe('factors: dry months and short overlaps (extend.md § Step 5)', () => {
	const year = (y: number, file: number[], chirps: (number | null)[]) => ({
		year: y,
		file: file as unknown as Monthly12,
		chirps: chirps as unknown as readonly [number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null]
	});

	it('sets a month dry in both to 1, flagged dryBoth', () => {
		// ε·|O_k| = 0.1 for two years: sums of 0.08 are dry, 0.1 is not.
		const dry = estimateFactors([year(2000, Array(12).fill(0.04), Array(12).fill(0.04)), year(2001, Array(12).fill(0.04), Array(12).fill(0.04))]);
		expect(dry[0]).toMatchObject({ computed: 1, flag: 'dryBoth', years: 2 });
		expect(dry[0]?.note).toMatch(/October is dry in both/);
		const edge = estimateFactors([year(2000, Array(12).fill(0.05), Array(12).fill(0.05)), year(2001, Array(12).fill(0.05), Array(12).fill(0.05))]);
		expect(edge[0]).toMatchObject({ computed: 1, flag: 'computed' });
	});

	it('sets a month missing in every overlap year to 1, flagged noOverlapMonths', () => {
		const f = estimateFactors([year(2000, Array(12).fill(5), [null, ...Array(11).fill(5)]), year(2001, Array(12).fill(5), [null, ...Array(11).fill(4)])]);
		expect(f[0]).toMatchObject({ computed: 1, flag: 'noOverlapMonths', years: 0 });
		expect(f[1]).toMatchObject({ computed: 5 / 4.5, flag: 'computed', years: 2 });
	});

	it('drops a missing month from that month only', () => {
		const f = estimateFactors([year(2000, Array(12).fill(6), [3, ...Array(11).fill(2)]), year(2001, Array(12).fill(4), [null, ...Array(11).fill(2)])]);
		expect(f[0]).toMatchObject({ computed: 2, years: 1 });
		expect(f[1]).toMatchObject({ computed: 2.5, years: 2 });
	});

	it('needs no special case for a zero month in a single year', () => {
		const f = estimateFactors([year(2000, Array(12).fill(3), Array(12).fill(0)), year(2001, Array(12).fill(3), Array(12).fill(6))]);
		expect(f[0]).toMatchObject({ computed: 1, flag: 'computed' });
	});

	it('refuses to compute below 5 years and warns below 15', () => {
		const chirps = syntheticChirpsMonthly();
		const four = fitRainfallExtension(ranFrom(1960, 1984), chirps);
		expect(four.factors.every((f) => f.flag === 'shortOverlap' && f.computed === 1)).toBe(true);
		const five = fitRainfallExtension(ranFrom(1960, 1985), chirps);
		expect(five.factors.some((f) => f.flag === 'computed')).toBe(true);
		expect(five.messages.some((m) => /only 5 overlap years/.test(m.text))).toBe(true);
		const fifteen = fitRainfallExtension(ranFrom(1960, 1995), chirps);
		expect(fifteen.messages.some((m) => /overlap years/.test(m.text))).toBe(false);
	});
});

describe('the overlap window (D5)', () => {
	const ran = ranFrom(1920, 2009);
	const chirps = syntheticChirpsMonthly();

	it('defaults to 1981/82 to the file end (29 years for a WR2012 record)', () => {
		const fit = fitRainfallExtension(ran, chirps);
		expect(fit.overlap).toEqual({ startYear: 1981, endYear: 2009, window: 'default' });
		expect(fit.factors[0]?.years).toBe(29);
	});

	it('narrows to a user window, and clamps one that runs past the overlap', () => {
		expect(fitRainfallExtension(ran, chirps, { overlap: { startYear: 1990, endYear: 2005 } }).overlap).toEqual({
			startYear: 1990,
			endYear: 2005,
			window: 'user'
		});
		const clamped = fitRainfallExtension(ran, chirps, { overlap: { startYear: 1970, endYear: 2020 } });
		expect(clamped.overlap).toEqual({ startYear: 1981, endYear: 2009, window: 'user' });
		expect(clamped.messages.some((m) => /narrowed to 1981–2009/.test(m.text))).toBe(true);
	});

	it('refuses a window outside the overlap or backwards', () => {
		expect(() => fitRainfallExtension(ran, chirps, { overlap: { startYear: 1950, endYear: 1970 } })).toThrow(/outside the overlap/);
		expect(() => fitRainfallExtension(ran, chirps, { overlap: { startYear: 2000, endYear: 1990 } })).toThrow(/not a range/);
	});
});

describe('refusals and edge cases (extend.md § Edge cases)', () => {
	const chirps = syntheticChirpsMonthly();

	it('refuses a file that ends before 1981/82: no overlap', () => {
		expect(() => fitRainfallExtension(ranFrom(1920, 1980), chirps)).toThrow(/before CHIRPS begins.*no overlap/);
	});

	it('says there is nothing to append when the file reaches the last complete CHIRPS year', () => {
		const fit = fitRainfallExtension(ranFrom(1950, 2025), chirps);
		expect(fit.appendable).toBeNull();
		expect(fit.stoppedAt).toBeNull();
		expect(fit.messages.some((m) => /nothing to append/.test(m.text))).toBe(true);
		expect(() => applyRainfallExtension(ranFrom(1950, 2025), chirps, fit, twelve(() => 1), PROVENANCE)).toThrow(/nothing to append/);
	});

	it('never appends the partial last year, and says how many months CHIRPS holds of it', () => {
		const partial = syntheticChirpsMonthly({ finalThrough: '2026-03-31' });
		const fit = fitRainfallExtension(ranFrom(1920, 2009), partial);
		expect(fit.appendable).toEqual({ firstYear: 2010, lastYear: 2024 });
		expect(fit.messages.some((m) => /holds 6 months of 2025\/26/.test(m.text))).toBe(true);
	});

	it('stops at a missing month after the overlap even when later years are complete', () => {
		const gap = syntheticChirpsMonthly({ missing: ['2015-11'] });
		const fit = fitRainfallExtension(ranFrom(1920, 2009), gap);
		expect(fit.appendable).toEqual({ firstYear: 2010, lastYear: 2014 });
		expect(fit.stoppedAt).toEqual({ year: 2015, month: 1 });
		const result = applyRainfallExtension(ranFrom(1920, 2009), gap, fit, twelve(() => 1), PROVENANCE);
		expect(result.series.rows.at(-1)?.year).toBe(2014);
		expect(result.extension.stoppedAt).toEqual({ year: 2015, month: 1 });
	});

	it('appends nothing but reports the stop when the first year after the file has a missing month', () => {
		const gap = syntheticChirpsMonthly({ missing: ['2010-10'] });
		const fit = fitRainfallExtension(ranFrom(1920, 2009), gap);
		expect(fit.appendable).toBeNull();
		expect(fit.stoppedAt).toEqual({ year: 2010, month: 0 });
	});

	it('lists missing months inside the overlap and keeps the other months of that year', () => {
		const gap = syntheticChirpsMonthly({ missing: ['1990-02'] });
		const fit = fitRainfallExtension(ranFrom(1920, 2009), gap);
		expect(fit.factors[4]?.years).toBe(28);
		expect(fit.factors[3]?.years).toBe(29);
		expect(fit.messages.some((m) => /missing 1 month inside the overlap \(Feb 1990\)/.test(m.text))).toBe(true);
		// MAP_c drops 1989 (incomplete), the overlap does not.
		expect(fit.overlap.startYear).toBe(1981);
	});

	it('warns on a coastal area above 10 % sea weight, and notes fewer than 4 cells', () => {
		const coast = fitRainfallExtension(ranFrom(1920, 2009), syntheticChirpsMonthly({ weightRemovedPct: 12.5, cells: 3 }));
		expect(coast.messages.some((m) => m.level === 'warning' && /12\.5 %/.test(m.text))).toBe(true);
		expect(coast.messages.some((m) => /only 3 CHIRPS cells/.test(m.text))).toBe(true);
		const inland = fitRainfallExtension(ranFrom(1920, 2009), syntheticChirpsMonthly({ weightRemovedPct: 10 }));
		expect(inland.messages.some((m) => /sea or no-data/.test(m.text))).toBe(false);
	});

	it('refuses a CHIRPS series with gaps, bad months, negative totals or no complete year', () => {
		const base = syntheticChirpsMonthly({ finalThrough: '1990-12-31' });
		const skip = { ...base, months: base.months.filter((m) => !(m.year === 1985 && m.month === 3)) };
		expect(() => fitRainfallExtension(ranFrom(1920, 2009), skip)).toThrow(/skips from 1985-02 to 1985-04/);
		const negative = { ...base, months: base.months.map((m, i) => (i === 30 ? { ...m, mm: -1 } : m)) };
		expect(() => fitRainfallExtension(ranFrom(1920, 2009), negative)).toThrow(/invalid total/);
		const short = syntheticChirpsMonthly({ finalThrough: '1982-06-30' });
		expect(() => fitRainfallExtension(ranFrom(1920, 2009), short)).toThrow(/no complete hydrological year/);
		expect(() => fitRainfallExtension(ranFrom(1920, 2009), { ...base, months: [] })).toThrow(/empty/);
		const dry: ChirpsMonthly = { ...base, months: base.months.map((m) => ({ ...m, mm: 0 })) };
		expect(() => fitRainfallExtension(ranFrom(1920, 2009), dry)).toThrow(/no rain at all/);
	});
});

describe('computed factors outside the accepted range', () => {
	it('warns when a computed factor is far from 1, and when it is above 5', () => {
		const chirps = syntheticChirpsMonthly();
		const wet = ranFrom(1920, 2009);
		const scaled = (f: number) => ({ ...wet, rows: wet.rows.map((r) => ({ year: r.year, months: twelve((k) => (k === 0 ? r.months[k]! * f : r.months[k]!)) })) });
		const base = fitRainfallExtension(wet, chirps).factors[0]!.computed;
		const far = fitRainfallExtension(scaled(3 / base), chirps);
		expect(far.factors[0]!.computed).toBeCloseTo(3, 1);
		expect(far.messages.some((m) => /October factor \(3\.\d\d\) is far from 1/.test(m.text))).toBe(true);
		const huge = fitRainfallExtension(scaled(7 / base), chirps);
		expect(huge.messages.some((m) => /October factor \(7\.\d\d\) is above 5/.test(m.text))).toBe(true);
		const factors = huge.factors.map((f) => f.computed) as unknown as Monthly12;
		expect(() => applyRainfallExtension(scaled(7 / base), chirps, huge, factors, PROVENANCE)).toThrow(/October factor/);
	});
});

describe('fitStatistics', () => {
	it('is NaN where undefined and null bias where the file has no rain', () => {
		const one = [{ year: 2000, file: Array(12).fill(0) as unknown as Monthly12, chirps: [1, ...Array(11).fill(null)] as never }];
		const s = fitStatistics(one, twelve(() => 1));
		expect(s.monthlyR2).toBeNaN();
		expect(s.monthlyNse).toBeNaN();
		expect(s.annualR2).toBeNaN();
		expect(s.annualBiasPct).toBeNaN();
		expect(s.monthlyBiasPct).toEqual(Array(12).fill(null));
	});
});

describe('checkFactor (extend.md § Step 6, A5)', () => {
	it('refuses outside [0, 5], confirms 0, warns outside [0.5, 2]', () => {
		for (const f of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 5.0001]) expect(checkFactor(f)).toBe('refused');
		expect(checkFactor(0)).toBe('confirmZero');
		for (const f of [0.01, 0.4999, 2.0001, 5]) expect(checkFactor(f)).toBe('warn');
		for (const f of [0.5, 1, 2]) expect(checkFactor(f)).toBe('ok');
	});

	it('makes apply refuse a refused factor and accept 0', () => {
		const ran = ranFrom(1920, 2009);
		const chirps = syntheticChirpsMonthly();
		const fit = fitRainfallExtension(ran, chirps);
		const bad = twelve((k) => (k === 9 ? 6 : 1));
		expect(() => applyRainfallExtension(ran, chirps, fit, bad, PROVENANCE)).toThrow(/July factor \(6\) is refused/);
		const zero = applyRainfallExtension(ran, chirps, fit, twelve((k) => (k === 9 ? 0 : 1)), PROVENANCE);
		expect(zero.series.rows.slice(90).every((r) => r.months[9] === 0)).toBe(true);
		expect(() => applyRainfallExtension(ran, chirps, fit, [1, 1] as unknown as Monthly12, PROVENANCE)).toThrow(/12 factors/);
	});
});

describe('apply and the sidecar entry (extend.md §§ Steps 7–8)', () => {
	const ran = ranFrom(1920, 2009);
	const chirps = syntheticChirpsMonthly({ revision: 17, source: 's3' });
	const fit = fitRainfallExtension(ran, chirps);
	const computed = fit.factors.map((f) => f.computed) as unknown as Monthly12;

	it('appends the whole hydrological years to the last complete one, with the file code', () => {
		const { series } = applyRainfallExtension(ran, chirps, fit, computed, PROVENANCE);
		expect(series.code).toBe('ZZA');
		expect(series.rows.slice(0, 90)).toEqual(ran.rows);
		expect(series.rows.slice(90).map((r) => r.year)).toEqual(Array.from({ length: 16 }, (_, i) => 2010 + i));
		for (const row of series.rows.slice(90)) for (const v of row.months) expect(v).toBe(roundHalfAwayFromZero(v));
	});

	it('records provenance in the shape of § Step 8', () => {
		const edited = twelve((k) => (k === 2 ? 1.1 : (computed[k] as number)));
		const { extension } = applyRainfallExtension(ran, chirps, fit, edited, { ...PROVENANCE, factorNotes: { 2: 'gauge record says wetter' } });
		expect(extension).toMatchObject({
			method: 'extend-1',
			file: 'ZZA.RAN',
			area: { quaternaries: ['Z01A', 'Z01B'], areaKm2: 812.4, cells: 41, weightRemovedPct: 0 },
			chirps: {
				product: 'CHIRPS v3 rnl (final)',
				copy: 'IC-WBT rain data copy',
				manifestRevision: 17,
				finalThrough: '2026-09-30',
				doi: '10.15780/G2JQ0P',
				accessed: '2026-10-28'
			},
			chirpsMap: { mm: fit.chirpsMapMm, years: [1981, 2025] },
			overlap: { from: 1981, to: 2009, window: 'default' },
			appended: { from: 2010, to: 2025, rows: 16 },
			originalEndYear: 2009,
			stoppedAt: null
		});
		expect(extension.factors.map((f) => f.month)).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
		expect(extension.factors[2]).toEqual({ month: 'Dec', computed: computed[2], used: 1.1, note: 'gauge record says wetter', edited: true });
		expect(extension.factors[0]).toEqual({ month: 'Oct', computed: computed[0], used: computed[0], note: '' });
		expect('createdAt' in extension).toBe(false);
		// Round-trips through JSON (pitman.json).
		expect(JSON.parse(JSON.stringify(extension))).toEqual(extension);
	});

	it('refuses a fit made for another file', () => {
		expect(() => applyRainfallExtension(ranFrom(1920, 2005), chirps, fit, computed, PROVENANCE)).toThrow(/different file/);
	});

	it('keeps every original row byte-identical on write, appended rows in the canonical layout', () => {
		// A hand-made layout: integers without a point, a missing final newline, a trailing blank line.
		const lines = ran.rows.map((r, i) => `ZZA    ${r.year}` + r.months.map((v) => (i % 7 === 0 ? String(Math.round(v)).padStart(7) : v.toFixed(2).padStart(7))).join(''));
		const text = [...lines, ''].join('\r\n');
		const read = readRainfall(text, 'ZZA.RAN');
		const f = fitRainfallExtension(read, chirps);
		const { series } = applyRainfallExtension(read, chirps, f, f.factors.map((x) => x.computed) as unknown as Monthly12, PROVENANCE);
		const written = writeRainfall(series).split('\r\n');
		expect(written.slice(0, 90)).toEqual(lines);
		for (const line of written.slice(90, 106)) expect(line).toMatch(/^ZZA    20\d\d( {1,4}\d{1,4}\.\d\d){12}$/);
		expect(written.slice(90, 106).every((l) => l.length === 95)).toBe(true);
		expect(readRainfall(writeRainfall(series), 'ZZA.RAN').rows.slice(90)).toEqual(series.rows.slice(90));
	});
});

describe('re-extending from the sidecar (extend.md § Step 4: the recorded MAP_c)', () => {
	it('re-applies edited factors with the recorded MAP_c, leaving earlier appended rows unchanged', () => {
		const ran = ranFrom(1920, 2009);
		const old = syntheticChirpsMonthly({ finalThrough: '2020-09-30' });
		const fit = fitRainfallExtension(ran, old);
		const edited = twelve((k) => (k === 5 ? 1.3 : (fit.factors[k]?.computed as number)));
		const first = applyRainfallExtension(ran, old, fit, edited, PROVENANCE);
		const text = writeRainfall(first.series);

		// Five more years of CHIRPS: MAP_c moves, so a fresh fit's factors move too.
		const later = syntheticChirpsMonthly({ finalThrough: '2026-09-30' });
		expect(fitRainfallExtension(ran, later).chirpsMapMm).not.toBe(fit.chirpsMapMm);
		const again = refitFromSidecar(readRainfall(text, 'ZZA.RAN'), later, first.extension);
		expect(again.ran.rows).toHaveLength(90);
		expect(again.fit.chirpsMapMm).toBe(first.extension.chirpsMap.mm);
		expect(again.fit.chirpsMapYears).toEqual({ startYear: 1981, endYear: 2019 });
		expect(again.factors).toEqual(edited);
		const second = applyRainfallExtension(again.ran, later, again.fit, again.factors, PROVENANCE);
		expect(second.series.rows.slice(0, 100)).toEqual(first.series.rows);
		expect(second.series.rows.at(-1)?.year).toBe(2025);
		const rewritten = writeRainfall(second.series).split('\r\n');
		expect(rewritten.slice(0, 100)).toEqual(text.split('\r\n').slice(0, 100));
	});

	it('keeps a user window when refitting', () => {
		const ran = ranFrom(1920, 2009);
		const chirps = syntheticChirpsMonthly({ finalThrough: '2020-09-30' });
		const fit = fitRainfallExtension(ran, chirps, { overlap: { startYear: 1990, endYear: 2009 } });
		const { extension, series } = applyRainfallExtension(ran, chirps, fit, fit.factors.map((f) => f.computed) as unknown as Monthly12, PROVENANCE);
		expect(refitFromSidecar(series, chirps, extension).fit.overlap).toEqual({ startYear: 1990, endYear: 2009, window: 'user' });
		expect(stripExtension(series, extension).rows).toEqual(ran.rows);
	});
});

describe('invariants over random synthetic inputs', () => {
	const cases = Array.from({ length: 25 }, (_, i) => i + 1).map((seed) => {
		const random = seededRandom(1000 + seed);
		const start = 1920 + Math.floor(random() * 50);
		const end = 1990 + Math.floor(random() * 25);
		const missing = random() < 0.5 ? [`${1982 + Math.floor(random() * 8)}-0${1 + Math.floor(random() * 9)}`] : [];
		return { seed, ran: ranFrom(start, end, seed), chirps: syntheticChirpsMonthly({ seed, mapMm: 200 + random() * 900, missing }) };
	});

	it.each(cases)('seed $seed: originals unchanged, years contiguous, overlap means reproduced, MAP_c cancels', ({ ran, chirps }) => {
		const fit = fitRainfallExtension(ran, chirps);
		const computed = fit.factors.map((f) => f.computed) as unknown as Monthly12;
		const result = applyRainfallExtension(ran, chirps, fit, computed, PROVENANCE);

		// Original rows unchanged, appended years contiguous to the last complete CHIRPS year.
		expect(result.series.rows.slice(0, ran.rows.length)).toEqual(ran.rows);
		result.series.rows.forEach((row, i) => i > 0 && expect(row.year).toBe((result.series.rows[i - 1] as MonthlyRow).year + 1));
		expect(result.series.rows.at(-1)?.year).toBe(2025);

		// Ratio of totals: per month, the overlap mean of f·p equals the file's.
		const overlap = overlapYears(ran, fit);
		for (let k = 0; k < 12; k++) {
			if (fit.factors[k]?.flag !== 'computed') continue;
			let sumFp = 0;
			let sumR = 0;
			for (const y of overlap) {
				const p = y.chirps[k];
				if (p === null || p === undefined) continue;
				sumFp += (computed[k] as number) * p;
				sumR += y.file[k] as number;
			}
			expect(sumFp).toBeCloseTo(sumR, 9);
			expect(fit.after.monthlyBiasPct[k]).toBeCloseTo(0, 9);
		}

		// MAP_c cancels: any other MAP_c gives the same appended values with computed factors.
		const other = refitFromSidecar(result.series, chirps, { ...result.extension, chirpsMap: { mm: fit.chirpsMapMm * 1.37, years: [1981, 2025] } });
		const otherFactors = other.fit.factors.map((f) => f.computed) as unknown as Monthly12;
		otherFactors.forEach((f, k) => fit.factors[k]?.flag === 'computed' && expect(f).toBeCloseTo((computed[k] as number) * 1.37, 9));
		const recomputed = applyRainfallExtension(other.ran, chirps, other.fit, otherFactors, PROVENANCE);
		expect(recomputed.series.rows).toEqual(result.series.rows);

		// Statistics are defined for a real-length record.
		for (const s of [fit.before, fit.after]) for (const v of [s.monthlyR2, s.monthlyNse, s.annualR2, s.annualBiasPct]) expect(Number.isFinite(v)).toBe(true);
	});
});
