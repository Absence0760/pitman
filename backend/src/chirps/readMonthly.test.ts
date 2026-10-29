// readMonthly and areaMonthly (extend.md §§ Steps 2–3): monthly totals summed by calendar date on the
// fixture copy (leap Februaries and Decembers, slot 365 of a non-leap year ignored), invalid months NaN,
// months past finalThrough NaN, the read deadline; the weighted mean, sea cells removed, the 90 % rule.
import { describe, expect, it } from 'vitest';
import { FIXTURE_MIRROR_DIR } from '../__tests__/fakeS3.js';
import { openFinals, readFinalsBlock } from './mirror/arrays.js';
import { openStore } from './mirror/store.js';
import { areaMonthly, MONTH_COVERAGE, ReadDeadlineError, readMonthly } from './readMonthly.js';

const fixture = openStore(`file://${FIXTURE_MIRROR_DIR}`);
const LAND = { y: 309, x: 300 };
const LAND2 = { y: 300, x: 307 };
const SEA = { y: 304, x: 307 };
const FAR = { y: 100, x: 100 };
const idx = (year: number, month: number, from = 2023) => (year - from) * 12 + month - 1;

describe('readMonthly on the fixture copy', () => {
	it('sums each month’s days by date: February 29 days in 2024, 28 in 2023, December’s 31 either way', async () => {
		const f = (await openFinals(fixture, 'rnl'))!;
		const [land] = await readMonthly(f, [LAND], 2023, 2025, { finalThrough: '2025-12-31' });
		const day = async (year: number) => (await readFinalsBlock(f, year, 0, 365, { y0: LAND.y, x0: LAND.x, h: 1, w: 1 })).values;
		const sum = (v: Float32Array, a: number, b: number) => Array.from(v.subarray(a, b)).reduce((s, x) => s + x, 0);
		const [d23, d24] = [await day(2023), await day(2024)];
		expect(land![idx(2024, 2)]).toBeCloseTo(sum(d24, 31, 60), 6);
		expect(land![idx(2023, 2)]).toBeCloseTo(sum(d23, 31, 59), 6);
		expect(land![idx(2024, 12)]).toBeCloseTo(sum(d24, 335, 366), 6);
		// 2023's slot 365 is NaN, and December 2023 is still valid: it ends at slot 364.
		expect(Number.isNaN(d23[365]!)).toBe(true);
		expect(land![idx(2023, 12)]).toBeCloseTo(sum(d23, 334, 365), 6);
		expect(land!.every(Number.isFinite)).toBe(true);
	});

	it('gives the sea cell and an unwritten chunk NaN throughout, and years the copy doesn’t hold NaN', async () => {
		const f = (await openFinals(fixture, 'rnl'))!;
		const [land, sea, far] = await readMonthly(f, [LAND, SEA, FAR], 1981, 2025, { finalThrough: '2025-12-31' });
		expect(sea!.every(Number.isNaN)).toBe(true);
		expect(far!.every(Number.isNaN)).toBe(true);
		expect(land!.subarray(0, idx(2023, 1, 1981)).every(Number.isNaN)).toBe(true);
		expect(land!.subarray(idx(2023, 1, 1981)).every(Number.isFinite)).toBe(true);
	});

	it('leaves a month with any day after finalThrough NaN, and every month after it', async () => {
		const f = (await openFinals(fixture, 'rnl'))!;
		const [land] = await readMonthly(f, [LAND], 2024, 2026, { finalThrough: '2024-03-15' });
		expect(Number.isFinite(land![idx(2024, 2, 2024)])).toBe(true);
		expect(Number.isNaN(land![idx(2024, 3, 2024)])).toBe(true);
		expect(land!.subarray(idx(2024, 3, 2024)).every(Number.isNaN)).toBe(true);
	});

	it('stops with ReadDeadlineError once the deadline has passed, rather than starting more reads', async () => {
		const f = (await openFinals(fixture, 'rnl'))!;
		let t = 0;
		const now = () => (t += 10);
		await expect(readMonthly(f, [LAND, LAND2], 1981, 2025, { finalThrough: '2025-12-31', deadline: 50, now, concurrency: 1 })).rejects.toThrow(ReadDeadlineError);
	});

	it('refuses an empty or backwards year range', async () => {
		const f = (await openFinals(fixture, 'rnl'))!;
		await expect(readMonthly(f, [LAND], 2025, 2024, { finalThrough: '2025-12-31' })).rejects.toThrow(RangeError);
	});
});

describe('areaMonthly', () => {
	const nan = Number.NaN;
	const t = (...v: number[]) => Float64Array.from(v);

	it('takes the weighted mean over valid cells, and removes all-NaN cells with their share of the weight', () => {
		const r = areaMonthly([1, 3, 1], [t(10, 20), t(30, 40), t(nan, nan)]);
		expect(r.kept).toEqual([0, 1]);
		expect(r.weightRemovedPct).toBe(20);
		expect(r.mm).toEqual([25, 35]);
	});

	it(`makes a month missing (null, never 0) when valid cells carry under ${MONTH_COVERAGE * 100} % of the kept weight`, () => {
		// Weights 9 and 1: the light cell alone missing leaves exactly 90 % (kept), the heavy one leaves 10 % (null).
		const r = areaMonthly([9, 1], [t(10, nan, 10), t(20, 20, nan)]);
		expect(r.mm).toEqual([11, null, 10]);
		const just = areaMonthly([8.9, 1.1], [t(10, 10), t(nan, 20)]);
		expect(just.mm).toEqual([null, 11.1]);
	});

	it('takes the 90 % rule over the kept (land) weight, so a coastal area keeps its months', () => {
		const r = areaMonthly([1, 1, 1], [t(10), t(nan), t(nan)]);
		expect(r.weightRemovedPct).toBeCloseTo(66.667, 3);
		expect(r.mm).toEqual([10]);
	});

	it('answers nothing kept when every cell is NaN', () => {
		expect(areaMonthly([1], [t(nan, nan)])).toEqual({ mm: [null, null], kept: [], weightRemovedPct: 100 });
	});
});
