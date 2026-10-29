import type { Monthly12 } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { annualChart, chartTable, meansChart, scatterChart, scatterPoints } from './charts.js';
import { CHIRPS_MAP_MM, WORKED_RAN, workedFit } from './fixtures.test-helper.js';

const fit = workedFit();
const computed = fit.factors.map((f) => f.computed) as unknown as Monthly12;
const ones = Array(12).fill(1) as unknown as Monthly12;

describe('scatterPoints', () => {
	it('takes every overlap month, x ascending, CHIRPS p against the file r', () => {
		const points = scatterPoints(fit, WORKED_RAN, computed, false);
		expect(points).toHaveLength(4 * 12);
		expect(points.every((pt, i) => i === 0 || (points[i - 1] as typeof pt).x <= pt.x)).toBe(true);
		const oct1981 = points.find((pt) => pt.year === 1981 && pt.month === 0);
		expect(oct1981).toEqual({ year: 1981, month: 0, x: (100 * 38) / CHIRPS_MAP_MM, y: 7.2 });
		expect(points.some((pt) => pt.year < 1981 || pt.year > 1984)).toBe(false);
	});

	it('scales x by the month’s factor when corrected', () => {
		const pt = scatterPoints(fit, WORKED_RAN, computed, true).find((p) => p.year === 1982 && p.month === 3);
		expect(pt?.x).toBeCloseTo(0.8013 * ((100 * 66) / CHIRPS_MAP_MM), 12);
	});

	it('leaves out a missing CHIRPS month', () => {
		const withGap = workedFit({ chirpsPct: fit.chirpsPct.map((y) => (y.year === 1982 ? { ...y, months: y.months.map((v, k) => (k === 4 ? null : v)) as unknown as typeof y.months } : y)) });
		expect(scatterPoints(withGap, WORKED_RAN, computed, false)).toHaveLength(47);
	});
});

describe('scatterChart', () => {
	it('has one point series per month and the 1:1 line', () => {
		const spec = scatterChart(fit, WORKED_RAN, computed, false);
		expect(spec.series.map((s) => s.label)).toEqual([
			'October',
			'November',
			'December',
			'January',
			'February',
			'March',
			'April',
			'May',
			'June',
			'July',
			'August',
			'September',
			'1:1 line'
		]);
		const line = spec.series[12];
		expect(line?.values).toEqual(spec.x);
		// Each point appears in exactly one month series.
		spec.x.forEach((_, i) => expect(spec.series.slice(0, 12).filter((s) => s.values[i] !== null)).toHaveLength(1));
	});

	it('shows one month when asked', () => {
		const spec = scatterChart(fit, WORKED_RAN, computed, true, 5);
		expect(spec.series.map((s) => s.label)).toEqual(['March', '1:1 line']);
		expect(spec.x).toHaveLength(4);
		expect(spec.title).toMatch(/corrected/);
	});

	it('tabulates every point', () => {
		const points = scatterPoints(fit, WORKED_RAN, computed, false);
		const table = chartTable(scatterChart(fit, WORKED_RAN, computed, false), points);
		expect(table.rows).toHaveLength(48);
		expect(table.columns[0]).toBe('Year');
		expect(table.rows.find((r) => r[0] === '1981/82' && r[1] === 'October')?.[3]).toBe('7.20');
	});
});

describe('meansChart', () => {
	it('shows the overlap means and f × p̄, with each factor above its month', () => {
		const spec = meansChart(fit, computed);
		expect(spec.series.map((s) => s.values[0])).toEqual([6.025, 7.233, 0.833 * 7.233]);
		expect(spec.xNotes?.[0]).toBe('×0.83');
		const table = chartTable(spec);
		expect(table.columns).toEqual(['Month (hydrological year, October first)', 'The file, r (% of MAP)', 'CHIRPS, p (% of MAP)', 'Corrected, f × p (% of MAP)', 'Factor in use']);
		expect(table.rows[9]?.[0]).toBe('July');
	});
});

describe('annualChart', () => {
	it('runs from the overlap to the last appended year, the appended stretch shaded', () => {
		const spec = annualChart(fit, WORKED_RAN, ones);
		expect(spec.x).toEqual([1981, 1982, 1983, 1984, 1985]);
		expect(spec.bands).toEqual([{ from: 1984.5, to: 1985.5, label: 'Appended years (shaded)' }]);
		const [model, chirps, corrected] = spec.series;
		expect(model?.values[0]).toBeCloseTo(91.1, 9);
		expect(model?.values[4]).toBeNull(); // the file ends 1984
		expect(chirps?.values[0]).toBeCloseTo(109.32, 2);
		expect(corrected?.values).toEqual(chirps?.values);
		const table = chartTable(spec);
		expect(table.columns.at(-1)).toBe('Appended');
		expect(table.rows.map((r) => r.at(-1))).toEqual(['no', 'no', 'no', 'no', 'yes']);
	});

	it('gives no total for a year with a missing month, and no band when nothing is appended', () => {
		const spec = annualChart(workedFit({ appendable: null, overlap: { startYear: 1981, endYear: 1986, window: 'user' } }), WORKED_RAN, ones);
		expect(spec.bands).toEqual([]);
		expect(spec.series[1]?.values.at(-1)).toBeNull(); // 1986: February missing
	});
});
