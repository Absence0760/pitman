import { describe, expect, it } from 'vitest';
import { allocateDrafts, shareInProportion } from './allocate.js';

describe('shareInProportion (TT 689 p.170)', () => {
	it("reproduces the manual's example: 2.5 and 3.0 demanded, 3.5 available", () => {
		const [a, b] = shareInProportion([2.5, 3.0], 3.5);
		expect(a).toBeCloseTo(1.59, 2);
		expect(b).toBeCloseTo(1.91, 2);
		expect(a! + b!).toBeCloseTo(3.5, 12);
	});
	it('gives the full demand when there is enough, nothing when there is none', () => {
		expect(shareInProportion([1, 2], 5)).toEqual([1, 2]);
		expect(shareInProportion([1, 2], 0)).toEqual([0, 0]);
		expect(shareInProportion([0, 0], 1)).toEqual([0, 0]);
	});
});

describe('allocateDrafts (TT 689 ch.8 priorities, spec §3.3)', () => {
	it('supplies every draft when there is enough water', () => {
		expect(allocateDrafts(10, [1], [2, 3])).toEqual({ defined: [1], calculated: [2, 3], deficitCase: 'none', definedDeficit: 0, calculatedDeficit: 0 });
	});
	it('meets defined drafts first and shares the rest between calculated drafts', () => {
		const a = allocateDrafts(4, [1], [2, 4]);
		expect(a.deficitCase).toBe('calculatedReduced');
		expect(a.defined).toEqual([1]);
		expect(a.calculated[0]).toBeCloseTo(1, 12);
		expect(a.calculated[1]).toBeCloseTo(2, 12);
		expect(a.calculatedDeficit).toBeCloseTo(3, 12);
		expect(a.definedDeficit).toBe(0);
	});
	it('sets calculated drafts to zero and shares what there is between defined drafts', () => {
		const a = allocateDrafts(1.5, [1, 2], [5]);
		expect(a.deficitCase).toBe('definedReduced');
		expect(a.defined[0]).toBeCloseTo(0.5, 12);
		expect(a.defined[1]).toBeCloseTo(1, 12);
		expect(a.calculated).toEqual([0]);
		expect(a.definedDeficit).toBeCloseTo(1.5, 12);
		expect(a.calculatedDeficit).toBe(5);
	});
	it('a dry reservoir supplies nothing', () => {
		const a = allocateDrafts(-0.2, [1], [1]);
		expect(a).toEqual({ defined: [0], calculated: [0], deficitCase: 'dry', definedDeficit: 1, calculatedDeficit: 1 });
	});
	it('no drafts at all is never a deficit, even when the dam is short of water', () => {
		expect(allocateDrafts(0, [], []).deficitCase).toBe('none');
		expect(allocateDrafts(-1, [], []).definedDeficit + allocateDrafts(-1, [], []).calculatedDeficit).toBe(0);
	});
});
