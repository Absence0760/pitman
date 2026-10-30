import type { AreaGeometry } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import type { Position } from '../pieces.js';
import { sameLine, snapLines, snapPoint, traceAlong, type SnapHit } from './snap.js';

const SQUARE: AreaGeometry = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
const [LINE] = snapLines([{ id: 'Z01A', label: 'Z01A', geometry: SQUARE }]);
/** 1° = 10 px, y up. */
const project = (q: Position) => ({ x: q[0] * 10, y: q[1] * 10 });

describe('snapLines', () => {
	it('takes each ring, unclosed, of every shape', () => {
		expect(LINE).toMatchObject({ featureId: 'Z01A', label: 'Z01A', part: 0, closed: true });
		expect(LINE?.coords).toHaveLength(4);
		const multi: AreaGeometry = { type: 'MultiPolygon', coordinates: [SQUARE.coordinates as never, SQUARE.coordinates as never] };
		expect(snapLines([{ id: 'x', label: 'x', geometry: multi }])).toHaveLength(2);
	});
});

describe('snapPoint', () => {
	it('prefers a corner to an edge', () => {
		expect(snapPoint({ x: 5, y: 5 }, [LINE!], project)).toMatchObject({ what: 'corner', at: [0, 0], pos: 0 });
	});
	it('lands on an edge, with how far along', () => {
		const hit = snapPoint({ x: 50, y: 6 }, [LINE!], project);
		expect(hit).toMatchObject({ what: 'edge', at: [5, 0] });
		expect(hit?.pos).toBeCloseTo(0.5, 9);
	});
	it('misses past its reach', () => {
		expect(snapPoint({ x: 50, y: 50 }, [LINE!], project)).toBeNull();
	});
	it('skips a line whose box misses the reach', () => {
		expect(snapPoint({ x: 5, y: 5 }, [LINE!], project, 12, [50, 50, 60, 60])).toBeNull();
	});
});

describe('traceAlong', () => {
	it('takes the shorter way round an outline', () => {
		expect(traceAlong(LINE!, 0.5, 1.5, [5, 0], [10, 5])).toEqual([[10, 0]]);
		expect(traceAlong(LINE!, 0.5, 3.5, [5, 0], [0, 5])).toEqual([[0, 0]]);
	});
	it('takes nothing between two places on one edge', () => {
		expect(traceAlong(LINE!, 0.2, 0.8, [2, 0], [8, 0])).toEqual([]);
		expect(traceAlong(LINE!, 1, 1, [10, 0], [10, 0])).toEqual([]);
	});
});

describe('sameLine', () => {
	const hit = (featureId: string, part: number) => ({ at: [0, 0], pos: 0, what: 'corner', line: { featureId, part, label: '', coords: [], closed: true } }) as SnapHit;
	it('needs the same feature’s same ring', () => {
		expect(sameLine(hit('a', 0), hit('a', 0))).toBe(true);
		expect(sameLine(hit('a', 0), hit('a', 1))).toBe(false);
		expect(sameLine(hit('a', 0), hit('b', 0))).toBe(false);
		expect(sameLine(null, hit('a', 0))).toBe(false);
	});
});
