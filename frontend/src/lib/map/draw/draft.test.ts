import { describe, expect, it } from 'vitest';
import type { Position } from '../pieces.js';
import { Draft } from './draft.svelte.js';
import { draftData } from './drawLayers.js';
import { snapLines, type SnapHit } from './snap.js';

function drawn(...corners: Position[]) {
	const d = new Draft();
	d.start();
	for (const c of corners) d.add(c);
	return d;
}
const TRIANGLE: Position[] = [[0, 0], [1, 0], [1, 1]];

describe('Draft', () => {
	it('adds corners, finishes, and gives the closed polygon', () => {
		const d = drawn(...TRIANGLE);
		expect(d.said).toContain('Corner 3');
		expect(d.canFinish).toBe(true);
		expect(d.finish()).toBe(true);
		expect(d.phase).toBe('review');
		expect(d.geometry).toEqual({ type: 'Polygon', coordinates: [[...TRIANGLE, TRIANGLE[0]]] });
	});
	it('won’t finish under three corners', () => {
		expect(drawn([0, 0], [1, 0]).finish()).toBe(false);
	});
	it('undoes corner by corner, past the finish', () => {
		const d = drawn(...TRIANGLE);
		d.finish();
		d.undo();
		expect(d.phase).toBe('drawing');
		d.undo();
		expect(d.coords).toHaveLength(2);
	});
	it('moves a corner as one undo step', () => {
		const d = drawn(...TRIANGLE);
		d.finish();
		d.beginChange();
		d.moveCorner(1, [2, 0]);
		d.moveCorner(1, [3, 0]);
		expect(d.coords[1]).toEqual([3, 0]);
		d.undo();
		expect(d.coords[1]).toEqual([1, 0]);
	});
	it('inserts and removes corners, keeping three', () => {
		const d = drawn(...TRIANGLE);
		d.finish();
		d.insertCorner(0, [0.5, 0]);
		expect(d.coords).toHaveLength(4);
		expect(d.corner).toBe(1);
		expect(d.removeCorner(1)).toBe(true);
		expect(d.removeCorner(0)).toBe(false);
		expect(d.said).toContain('at least 3');
	});
	it('asks once before Escape drops work, and not for one corner', () => {
		const one = drawn([0, 0]);
		one.escape();
		expect(one.coords).toEqual([]);
		const d = drawn(...TRIANGLE);
		d.escape();
		expect(d.coords).toHaveLength(3);
		expect(d.said).toContain('Press Escape again');
		d.escape();
		expect(d.coords).toEqual([]);
		expect(d.active).toBe(true);
	});
	it('forgets the first Escape once the drawing changes', () => {
		const d = drawn(...TRIANGLE);
		d.escape();
		d.add([0, 1]);
		d.escape();
		expect(d.coords).toHaveLength(4);
	});
	it('takes a pasted shape: editable with one outline, whole with several', () => {
		const ring = [...TRIANGLE, TRIANGLE[0]!];
		const d = new Draft();
		d.start();
		d.replace({ type: 'Polygon', coordinates: [ring] });
		expect(d.coords).toEqual(TRIANGLE);
		expect(d.phase).toBe('review');
		const multi = { type: 'MultiPolygon' as const, coordinates: [[ring], [ring]] };
		d.replace(multi);
		expect(d.whole).toEqual(multi);
		expect(d.geometry).toEqual(multi);
		d.undo();
		expect(d.whole).toBeNull();
	});
	it('follows an outline between two snapped corners', () => {
		const [line] = snapLines([{ id: 'Z01A', label: 'Z01A', geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } }]);
		const hit = (at: Position, pos: number): SnapHit => ({ at, pos, what: 'edge', line: line! });
		const d = new Draft();
		d.start();
		d.add([5, 0], hit([5, 0], 0.5));
		d.add([10, 5], hit([10, 5], 1.5));
		expect(d.coords).toEqual([[5, 0], [10, 0], [10, 5]]);
		expect(d.said).toContain('1 corner followed');
		d.follow = false;
		d.add([5, 10], hit([5, 10], 2.5));
		expect(d.coords).toHaveLength(4);
	});
	it('stops and starts clean', () => {
		const d = drawn(...TRIANGLE);
		d.stop();
		expect(d.active).toBe(false);
		expect(d.coords).toEqual([]);
		expect(d.canUndo).toBe(false);
	});
});

describe('draftData', () => {
	const roles = (d: ReturnType<typeof draftData>) => d.features.map((f) => f.properties['role']);
	it('is empty with no draft', () => {
		expect(draftData(null).features).toEqual([]);
	});
	it('while drawing: a line, the band to the pointer, the corners', () => {
		const d = draftData({ coords: TRIANGLE.slice(0, 2), phase: 'drawing', whole: null, cursor: [2, 2], corner: null });
		expect(roles(d)).toEqual(['shape', 'band', 'corner', 'corner']);
		expect(d.features[0]?.geometry).toMatchObject({ type: 'LineString' });
	});
	it('once closed: the polygon, the middles, the corners, the picked one marked', () => {
		const d = draftData({ coords: TRIANGLE, phase: 'review', whole: null, cursor: null, corner: 1 });
		expect(roles(d)).toEqual(['shape', 'mid', 'mid', 'mid', 'corner', 'corner', 'corner']);
		expect(d.features[0]?.geometry).toMatchObject({ type: 'Polygon' });
		expect(d.features[5]?.properties['picked']).toBe(true);
	});
	it('a whole pasted shape has no corners', () => {
		const whole = { type: 'MultiPolygon' as const, coordinates: [] };
		expect(roles(draftData({ coords: [], phase: 'review', whole, cursor: null, corner: null }))).toEqual(['shape']);
	});
	it('shows where a corner would snap', () => {
		expect(roles(draftData({ coords: [], phase: 'drawing', whole: null, cursor: null, corner: null, snap: [1, 1] }))).toEqual(['snap']);
	});
});
