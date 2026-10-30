import { describe, expect, it } from 'vitest';
import { CELLS, box } from '#lib/subdivide/fixtures.test-helper.js';
import { noZoneMessage, sideSummary, thresholdProblem, thresholdRange, valuesInside } from './threshold.js';

describe('valuesInside', () => {
	it('takes every cell whose centre is inside, ascending, and skips cells without a value', () => {
		expect(valuesInside(CELLS, box(20, -33.3, 20.3, -33))).toEqual([300, 400, 500, 600, 650, 700, 800, 900]);
	});

	it('leaves out cells outside the piece, by their centres', () => {
		expect(valuesInside(CELLS, box(20, -33.1, 20.2, -33))).toEqual([800, 900]);
		expect(valuesInside(CELLS, box(25, -30, 25.1, -29.9))).toEqual([]);
	});
});

describe('thresholdRange', () => {
	it('spans the values on whole 10 mm steps and starts at the median', () => {
		expect(thresholdRange([304, 400, 500, 600, 896])).toEqual({ minMm: 300, maxMm: 900, startMm: 500 });
	});

	it('has nothing to offer with no value, or a single one', () => {
		expect(thresholdRange([])).toBeNull();
		expect(thresholdRange([700, 700])).toBeNull();
	});
});

describe('sideSummary', () => {
	const values = [300, 400, 500, 600];

	it('counts at-or-above for a high zone', () => {
		expect(sideSummary(values, 500, 'high')).toEqual({ cells: 2, sharePct: 50, zoneMeanMm: 550, restMeanMm: 350 });
	});

	it('counts at-or-below for a low zone', () => {
		expect(sideSummary(values, 500, 'low')).toEqual({ cells: 3, sharePct: 75, zoneMeanMm: 400, restMeanMm: 600 });
	});

	it('has no mean for an empty side', () => {
		expect(sideSummary(values, 700, 'high')).toMatchObject({ cells: 0, zoneMeanMm: null, restMeanMm: 450 });
		expect(sideSummary([], 700, 'high')).toMatchObject({ cells: 0, sharePct: 0 });
	});
});

describe('words for the tool', () => {
	const range = { minMm: 300, maxMm: 900, startMm: 500 };

	it('checks a typed threshold', () => {
		expect(thresholdProblem(500, range)).toBeNull();
		expect(thresholdProblem(300, range)).toBeNull();
		expect(thresholdProblem(null, range)).toBe('Type the threshold in mm.');
		expect(thresholdProblem(1000, range)).toContain('from 300 to 900 mm');
	});

	it('says why there is no zone', () => {
		expect(noZoneMessage(800, 'high')).toContain('at or above 800 mm');
		expect(noZoneMessage(300, 'low')).toContain('at or below 300 mm');
	});
});
