import { describe, expect, it } from 'vitest';
import { readDemand, writeDemand } from '../io/demand.js';
import type { DemandSpec, Monthly12 } from '../types.js';
import { DEMAND_ROUNDING_LIMIT_PERCENT, demandFileYears, demandSpecProblems, demandVolumeIn, demandDecimals,
	demandYearChecks, generateDemandRows, generateDemandSeries, specGenerates } from './generate.js';

// Invented volumes only (issue #3 rule 2).

const even = Array<number>(12).fill(100 / 12) as unknown as Monthly12;
const seasonal = [12, 12, 12, 10, 10, 8, 6, 6, 6, 6, 6, 6] as unknown as Monthly12;
const spec = (overrides: Partial<DemandSpec> = {}): DemandSpec => ({
	annualVolumeMm3: 1.2,
	monthlyDistributionPercent: seasonal,
	growth: [
		{ year: 2000, value: 1.2 },
		{ year: 2010, value: 2.2 },
		{ year: 2025, value: 3.7 }
	],
	...overrides
});

describe('demandVolumeIn', () => {
	it('interpolates linearly between years and holds flat beyond them', () => {
		const s = spec();
		expect(demandVolumeIn(s, 1990)).toBe(1.2);
		expect(demandVolumeIn(s, 2000)).toBe(1.2);
		expect(demandVolumeIn(s, 2005)).toBeCloseTo(1.7, 12);
		expect(demandVolumeIn(s, 2020)).toBeCloseTo(3.2, 12);
		expect(demandVolumeIn(s, 2025)).toBe(3.7);
		expect(demandVolumeIn(s, 2050)).toBe(3.7);
	});

	it('reads a table given out of order', () => {
		const s = spec({ growth: [{ year: 2010, value: 2 }, { year: 2000, value: 1 }] });
		expect(demandVolumeIn(s, 2005)).toBeCloseTo(1.5, 12);
	});

	it('is the annual volume when the table is empty', () => {
		expect(demandVolumeIn(spec({ growth: [] }), 1950)).toBe(1.2);
	});
});

describe('demandFileYears', () => {
	const network = { startYear: 1980, endYear: 2004 };

	it('covers the run', () => {
		expect(demandFileYears(spec({ growth: [] }), network)).toEqual({ firstYear: 1980, lastYear: 2004 });
	});

	it('runs on to the last growth year, so present day finds its row', () => {
		expect(demandFileYears(spec(), network)).toEqual({ firstYear: 1980, lastYear: 2025 });
	});

	it('keeps the whole run when the table stops first', () => {
		expect(demandFileYears(spec(), { startYear: 1920, endYear: 2030 })).toEqual({ firstYear: 1920, lastYear: 2030 });
	});
});

describe('generateDemandRows', () => {
	it('gives each month A_Y × its share, October first', () => {
		const [row] = generateDemandRows(spec({ growth: [] }), 2000, 2000);
		expect(row?.year).toBe(2000);
		expect(row?.months[0]).toBe(0.144); // October: 12 % of 1.2
		expect(row?.months[5]).toBe(0.096); // March: 8 % of 1.2
		expect(row?.months[11]).toBe(0.072); // September: 6 % of 1.2
	});

	it('holds the rounded values the file will hold, so a saved run equals this one', () => {
		const rows = generateDemandRows(spec(), 1999, 2026);
		const series = { fileName: 'SYRQ11.abs', rows, hasTotals: false, hasAverage: false, decimals: 3 as const };
		expect(readDemand(writeDemand(series), 'SYRQ11.abs').rows).toEqual(rows);
	});

	it('takes the shares relative to their sum', () => {
		const [row] = generateDemandRows(spec({ annualVolumeMm3: 12, monthlyDistributionPercent: even, growth: [] }), 2000, 2000);
		expect(row?.months.every((v) => v === 1)).toBe(true);
	});

	it('refuses a month the file cannot hold', () => {
		expect(() => generateDemandRows(spec({ annualVolumeMm3: 1e7, growth: [] }), 2000, 2000, 'SYRQ9.abs')).toThrow(/SYRQ9\.abs year 2000 month 1.*does not fit F7\.2/);
	});
});

describe('the generated file', () => {
	it('is 4X,I4,12F8.3 with CRLF, 104 columns a row (docs/formats.md §12, R7-X7)', () => {
		const series = generateDemandSeries(spec({ growth: [{ year: 2000, value: 1.2 }, { year: 2001, value: 2.4 }] }), { fileName: 'SYRQ11.abs', firstYear: 2000, lastYear: 2001 });
		const text = writeDemand(series);
		expect(text).toBe(
			'    2000   0.144   0.144   0.144   0.120   0.120   0.096   0.072   0.072   0.072   0.072   0.072   0.072\r\n' +
				'    2001   0.288   0.288   0.288   0.240   0.240   0.192   0.144   0.144   0.144   0.144   0.144   0.144\r\n'
		);
		for (const line of text.split('\r\n').slice(0, 2)) expect(line).toHaveLength(104);
	});

	it('round-trips byte for byte through readDemand and writeDemand', () => {
		const series = generateDemandSeries(spec(), { fileName: 'SYRQ11.abs', firstYear: 1990, lastYear: 2030 });
		const text = writeDemand(series);
		const read = readDemand(text, 'SYRQ11.abs');
		expect(read.rows).toEqual(series.rows);
		expect([read.hasTotals, read.hasAverage]).toEqual([false, false]);
		expect(writeDemand(read)).toBe(text);
		const { source: _source, ...bare } = { ...read, decimals: 3 as const };
		expect(writeDemand(bare)).toBe(text);
	});

	it('is ASCII, one row per year, contiguous', () => {
		const series = generateDemandSeries(spec(), { fileName: 'SYRQ11.abs', firstYear: 1920, lastYear: 2025 });
		expect(series.rows).toHaveLength(106);
		expect(series.rows.map((r) => r.year)).toEqual(Array.from({ length: 106 }, (_, k) => 1920 + k));
		expect(/^[\x20-\x7e\r\n]*$/.test(writeDemand(series))).toBe(true);
	});
});

describe('demandYearChecks', () => {
	it('reports what rounding did to each year: a small town is exact at 0.001, a very small demand isn\'t', () => {
		const town = spec({ annualVolumeMm3: 0.3, monthlyDistributionPercent: even, growth: [] });
		const [check] = demandYearChecks(town, generateDemandRows(town, 2000, 2000));
		expect(check?.askedMm3).toBe(0.3);
		expect(check?.writtenMm3).toBeCloseTo(0.3, 9); // 0.025 a month, which two decimals wrote as 0.03: 20 % over
		const tiny = spec({ annualVolumeMm3: 0.03, monthlyDistributionPercent: even, growth: [] });
		const [small] = demandYearChecks(tiny, generateDemandRows(tiny, 2000, 2000));
		expect(small?.writtenMm3).toBeCloseTo(0.024, 9); // 0.0025 a month is under it in float32, so it rounds to 0.002
		expect(Math.abs(small?.differencePercent ?? 0)).toBeGreaterThan(DEMAND_ROUNDING_LIMIT_PERCENT);
	});

	it('a read-back file keeps its three decimals when one row changes', () => {
		const series = generateDemandSeries(spec({ annualVolumeMm3: 0.3, monthlyDistributionPercent: even, growth: [] }), { fileName: 'SYRQ11.abs', firstYear: 2000, lastYear: 2001 });
		const read = readDemand(writeDemand(series), 'SYRQ11.abs');
		const changed = { ...read, rows: read.rows.map((row, i) => (i === 1 ? { ...row, months: row.months.map(() => 0.026) as unknown as typeof row.months } : row)) };
		expect(writeDemand(changed)).toContain('   0.026');
		expect(specGenerates(spec({ annualVolumeMm3: 0.3, monthlyDistributionPercent: even, growth: [] }), read.rows)).toBe(true);
	});

	it('decides its decimals on the volumes the file holds: a growth table replaces the annual volume', () => {
		expect(demandDecimals(spec({ annualVolumeMm3: 5000, growth: [{ year: 2000, value: 0.3 }] }))).toBe(3);
	});

	it('keeps two decimals where a month could reach 100 million m³, as its field needs', () => {
		const large = spec({ annualVolumeMm3: 2400, monthlyDistributionPercent: even, growth: [] });
		expect(demandDecimals(large)).toBe(2);
		expect(demandDecimals(spec({ annualVolumeMm3: 1.2 }))).toBe(3);
	});

	it('leaves a large demand under the limit', () => {
		const s = spec({ annualVolumeMm3: 24, growth: [] });
		const [check] = demandYearChecks(s, generateDemandRows(s, 2000, 2000));
		expect(Math.abs(check?.differencePercent ?? 1)).toBeLessThanOrEqual(DEMAND_ROUNDING_LIMIT_PERCENT);
	});

	it('does not divide by a zero year', () => {
		const s = spec({ growth: [{ year: 2000, value: 0 }, { year: 2001, value: 1 }] });
		expect(demandYearChecks(s, generateDemandRows(s, 2000, 2000))[0]?.differencePercent).toBe(0);
	});
});

describe('specGenerates', () => {
	const s = spec();
	const rows = generateDemandRows(s, 2000, 2010);

	it('is true of the rows the spec makes, whatever years the file holds', () => {
		expect(specGenerates(s, rows)).toBe(true);
		expect(specGenerates(s, rows.slice(3, 5))).toBe(true);
	});

	it('is false once a value changes', () => {
		const changed = rows.map((row, i) => (i === 2 ? { ...row, months: row.months.map((v) => v + 0.01) as unknown as Monthly12 } : row));
		expect(specGenerates(s, changed)).toBe(false);
	});
});

describe('demandSpecProblems', () => {
	it('passes a good spec, even 12 × 8.3333', () => {
		expect(demandSpecProblems(spec())).toEqual([]);
		expect(demandSpecProblems(spec({ monthlyDistributionPercent: Array<number>(12).fill(8.3333) as unknown as Monthly12 }))).toEqual([]);
	});

	it('names each problem', () => {
		expect(demandSpecProblems(spec({ monthlyDistributionPercent: Array<number>(12).fill(8.33) as unknown as Monthly12 }))).toEqual(['the monthly shares add up to 99.96 %, not 100 %']);
		expect(demandSpecProblems(spec({ annualVolumeMm3: -1 }))).toEqual(['the annual volume is negative or not a number']);
		expect(demandSpecProblems(spec({ growth: [{ year: 2000, value: 1 }, { year: 2000, value: 2 }] }))).toEqual(['a growth year is listed twice']);
		expect(demandSpecProblems(spec({ growth: [{ year: 2000, value: 0 }] }))).toEqual(['the demand is zero in every year']);
	});
});
