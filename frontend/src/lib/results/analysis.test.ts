import { describe, expect, it } from 'vitest';
import { analyseTarget, commonTimeline, onTimeline } from './analysis.js';
import { bundle, flow, natural, presentDay } from './fixtures.js';
import { resultTargets, type ResultTarget } from './targets.js';

const targets = resultTargets(bundle, [presentDay, natural]).flatMap((g) => g.targets);
const byId = (id: string) => targets.find((t) => t.id === id) as ResultTarget;

describe('timeline', () => {
	it('spans every series and lays each on it', () => {
		const t = commonTimeline([flow(2001, new Array(12).fill(1)), null, flow(1999, new Array(24).fill(2))]);
		expect(t).toEqual({ startYear: 1999, years: 3 });
		const on = onTimeline(flow(2001, new Array(12).fill(1)), t!);
		expect(on.slice(0, 24).every((v) => v === null)).toBe(true);
		expect(on[24]).toBe(1);
		expect(commonTimeline([null])).toBeNull();
	});
});

describe('analyseTarget at a gauge', () => {
	it('uses the gauge record and compares over the complete years', () => {
		const a = analyseTarget(byId('route-3'), [presentDay, natural]);
		expect(a.period).toEqual({ startYear: 2000, endYear: 2002 });
		expect(a.runs.map((r) => r.label)).toEqual(['Present day (2025)', 'Natural']);
		// Complete observed years 2000 (36) and 2002 (60, one month incomplete but kept).
		expect(a.observedStatistics?.years).toBe(2);
		expect(a.observedStatistics?.marMm3).toBeCloseTo(48, 9);
		expect(a.runs[0]?.statistics?.marMm3).toBeCloseTo(48.66, 9);
		expect(a.runs[0]?.gauge?.comparison[0]?.errorPercent).toBeCloseTo((0.66 / 48) * 100, 9);
		expect(a.observedPeriodMonths).toHaveLength(35);
		expect(a.runs[1]?.periodMonths).toHaveLength(35);
		expect(a.observed?.values[12 + 2]).toBeNull();
	});

	it('leaves incomplete months out when asked', () => {
		const a = analyseTarget(byId('route-3'), [presentDay], { includeIncomplete: false });
		expect(a.observedStatistics?.years).toBe(1);
		expect(a.observedPeriodMonths).toHaveLength(34);
	});

	it('honours a chosen period, clamped to the record', () => {
		const a = analyseTarget(byId('route-3'), [presentDay], { startYear: 1980, endYear: 2000 });
		expect(a.period).toEqual({ startYear: 2000, endYear: 2000 });
		expect(analyseTarget(byId('route-3'), [presentDay], { startYear: 2002, endYear: 2001 }).period).toBeNull();
	});

	it('falls back to simulated statistics when the gauge has no year in the period', () => {
		const target = { ...byId('route-3'), observed: { rows: [] } };
		const a = analyseTarget(target, [presentDay]);
		expect(a.period).toEqual({ startYear: 2000, endYear: 2002 });
		expect(a.runs[0]?.gauge).toBeNull();
		expect(a.runs[0]?.statistics?.years).toBe(3);
	});
});

describe('analyseTarget without a gauge', () => {
	it('covers the whole record', () => {
		const a = analyseTarget(byId('route-1'), [presentDay, natural]);
		expect(a.observed).toBeNull();
		expect(a.period).toEqual({ startYear: 2000, endYear: 2002 });
		expect(a.runs[1]?.statistics?.years).toBe(3);
		expect(a.runs[1]?.periodMonths).toHaveLength(36);
	});

	it('copes with a run that lacks the target', () => {
		const a = analyseTarget(byId('route-1'), [{ ...presentDay, routeFlows: {} }]);
		expect(a.timeline).toBeNull();
		expect(a.period).toBeNull();
		expect(a.runs[0]?.statistics).toBeNull();
	});
});
