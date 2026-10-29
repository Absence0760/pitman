// The copy's index maths (grid.ts): whole-cell arithmetic from a cell centre to the region's (y, x) and
// back, refusals outside D1, chunk grouping, and the day-of-year slots of leap and non-leap years.
import { describe, expect, it } from 'vitest';
import { cellCentre, cellsByChunk, chcCell, chcCellOf, dateOfDoy, doyIndex, gridOf, MIRROR_REGION, mirrorCell, MirrorOutsideRegionError, regionSize } from './grid.js';

describe('the D1 grid', () => {
	it('is 620 × 550 cells with its south-west cell centred at 35.475° S, 10.025° E', () => {
		expect(regionSize(MIRROR_REGION)).toEqual({ rows: 550, cols: 620 });
		expect(gridOf(MIRROR_REGION).origin).toEqual({ lat: -35.475, lon: 10.025 });
	});

	it('puts the south-west and north-east cells at (0, 0) and (549, 619), and round-trips every corner', () => {
		expect(mirrorCell(chcCell(-35.475, 10.025))).toEqual({ y: 0, x: 0 });
		expect(mirrorCell(chcCell(-8.025, 40.975))).toEqual({ y: 549, x: 619 });
		for (const m of [{ y: 0, x: 0 }, { y: 309, x: 300 }, { y: 549, x: 619 }]) {
			const c = chcCellOf(m);
			expect(mirrorCell(c)).toEqual(m);
			expect(mirrorCell(chcCell(cellCentre(c).lat, cellCentre(c).lon))).toEqual(m);
		}
	});

	it('refuses a cell outside the region, naming the point', () => {
		expect(() => mirrorCell(chcCell(-36, 20))).toThrow(MirrorOutsideRegionError);
		expect(() => mirrorCell(chcCell(-20, 9.975))).toThrow(/outside the region the rain data copy holds/);
		expect(() => chcCell(-61, 20)).toThrow(RangeError);
	});

	it('groups cells by 20 × 20 chunk, each with the box of its own cells', () => {
		const g = cellsByChunk([{ y: 0, x: 0 }, { y: 19, x: 3 }, { y: 20, x: 0 }, { y: 5, x: 21 }], 20, 20);
		expect(g).toEqual([
			{ y0: 0, y1: 19, x0: 0, x1: 3, cells: [0, 1] },
			{ y0: 20, y1: 20, x0: 0, x1: 0, cells: [2] },
			{ y0: 5, y1: 5, x0: 21, x1: 21, cells: [3] }
		]);
	});

	it('gives day-of-year slot 365 a date only in a leap year', () => {
		expect(doyIndex('2024-12-31')).toBe(365);
		expect(doyIndex('2023-12-31')).toBe(364);
		expect(dateOfDoy(2024, 365)).toBe('2024-12-31');
		expect(dateOfDoy(2023, 365)).toBeNull();
		expect(dateOfDoy(2024, 59)).toBe('2024-02-29');
		expect(dateOfDoy(2023, 59)).toBe('2023-03-01');
	});
});
