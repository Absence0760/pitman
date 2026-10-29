import { describe, expect, it } from 'vitest';
import { analyseTarget } from './analysis.js';
import { annualChart, chartTable, durationChart, meanMonthlyChart, monthlyChart, targetCharts, xLabelOf } from './charts.js';
import { bundle, natural, presentDay } from './fixtures.js';
import { resultTargets, type ResultTarget } from './targets.js';

const targets = resultTargets(bundle, [presentDay, natural]).flatMap((g) => g.targets);
const byId = (id: string) => targets.find((t) => t.id === id) as ResultTarget;
const gauged = analyseTarget(byId('route-3'), [presentDay, natural]);

describe('charts at a gauge, two runs side by side', () => {
	it('draws every run and the observed flows on the monthly hydrograph, with units', () => {
		const c = monthlyChart(gauged)!;
		expect(c.title).toBe('Monthly hydrograph');
		expect(c.yLabel).toBe('Monthly flow (million m³/month)');
		expect(c.xLabel).toBe('Hydrological year (October–September)');
		expect(c.x).toHaveLength(36);
		expect(c.lines.map((l) => [l.label, l.style])).toEqual([
			['Present day (2025)', 0],
			['Natural', 1],
			['Observed', 'observed']
		]);
		expect(c.lines[2]?.values[14]).toBeNull();
		expect(c.lines[2]?.marks?.[24 + 4]).toBe(true);
	});

	it('totals hydrological years, observed only where the year is complete', () => {
		const c = annualChart(gauged)!;
		expect(c.yLabel).toBe('Annual flow (million m³/year)');
		expect(c.x).toEqual([2000, 2001, 2002]);
		expect(c.lines[0]?.values[0]).toBeCloseTo(36.66, 9);
		expect(c.lines[2]?.values).toEqual([36, null, 60]);
		const strict = annualChart(analyseTarget(byId('route-3'), [presentDay], { includeIncomplete: false }))!;
		expect(strict.lines[1]?.values).toEqual([36, null, null]);
	});

	it('draws mean monthly flows as bars over the compared years', () => {
		const c = meanMonthlyChart(gauged)!;
		expect(c.bars).toBe(true);
		expect(c.x).toHaveLength(12);
		expect(c.lines[2]?.values).toEqual(new Array(12).fill(4));
	});

	it('draws flow-duration curves on a merged x with a log flow axis', () => {
		const c = durationChart(gauged)!;
		expect(c.spanGaps).toBe(true);
		expect(c.yLog).toBe(true);
		expect(c.x[0]).toBeCloseTo(100 / 36, 9);
		expect(c.lines.map((l) => l.values.filter((v) => v !== null).length)).toEqual([35, 35, 35]);
		expect(c.xLabel).toBe('Time equalled or exceeded (% of months)');
	});

	it('gives all four charts in order', () => {
		expect(targetCharts(gauged).map((c) => c.id)).toEqual(['monthly', 'annual', 'mean-monthly', 'duration']);
	});
});

describe('reservoir charts', () => {
	const a = analyseTarget(byId('reservoir-2'), [presentDay]);
	it('shows storage, with the annual figure as mean storage', () => {
		expect(monthlyChart(a)?.yLabel).toBe('End-of-month storage (million m³)');
		const annual = annualChart(a)!;
		expect(annual.title).toBe('Annual mean storage');
		expect(annual.lines[0]?.values[0]).toBeCloseTo(10.055, 9);
		expect(durationChart(a)?.title).toBe('Storage-duration curve');
	});
});

describe('chartTable', () => {
	it('lists every plotted value with x labels and a note for incomplete months', () => {
		const t = chartTable(monthlyChart(gauged)!);
		expect(t.columns).toEqual(['Hydrological year (October–September)', 'Present day (2025)', 'Natural', 'Observed', 'Note']);
		expect(t.rows).toHaveLength(36);
		expect(t.rows[0]).toEqual(['Oct 2000', '3.00', '4.50', '3.00', '']);
		expect(t.rows[3]?.[0]).toBe('Jan 2001');
		expect(t.rows[14]?.[3]).toBe('—');
		expect(t.rows[28]?.[4]).toBe('observed month incomplete (+)');
	});

	it('labels x values of each kind', () => {
		expect(xLabelOf('month', 2000 + 11 / 12)).toBe('Sep 2001');
		expect(xLabelOf('hydroYear', 2000)).toBe('2000/01');
		expect(xLabelOf('monthOfYear', 0)).toBe('Oct');
		expect(xLabelOf('percent', 12.5)).toBe('12.5 %');
	});
});

describe('no data', () => {
	it('gives no charts when no run has the target', () => {
		expect(targetCharts(analyseTarget(byId('route-1'), [{ ...presentDay, routeFlows: {} }]))).toEqual([]);
	});
});
