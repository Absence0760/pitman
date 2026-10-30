import { describe, expect, it } from 'vitest';
import type { Position } from '../pieces.js';
import { canFinish, distinctCorners, draftProblem, editableCorners, geometryOf, midpoints, outlineCrosses, withoutCorner } from './shape.js';

const SQUARE: Position[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

describe('distinctCorners', () => {
	it('takes a double click as one corner and drops the closing repeat', () => {
		expect(distinctCorners([[0, 0], [0, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
	});
});

describe('geometryOf', () => {
	it('closes the ring', () => {
		expect(geometryOf(SQUARE)).toEqual({ type: 'Polygon', coordinates: [[...SQUARE, SQUARE[0]]] });
	});
	it('has nothing under three corners', () => {
		expect(geometryOf(SQUARE.slice(0, 2))).toBeNull();
	});
});

describe('editableCorners', () => {
	const ring = [...SQUARE, SQUARE[0]!];
	it('takes one outline, in a multi or not', () => {
		expect(editableCorners({ type: 'Polygon', coordinates: [ring] })).toEqual(SQUARE);
		expect(editableCorners({ type: 'MultiPolygon', coordinates: [[ring]] })).toEqual(SQUARE);
	});
	it('refuses holes and several parts', () => {
		expect(editableCorners({ type: 'Polygon', coordinates: [ring, ring] })).toBeNull();
		expect(editableCorners({ type: 'MultiPolygon', coordinates: [[ring], [ring]] })).toBeNull();
	});
});

describe('draftProblem', () => {
	it('passes a good shape', () => {
		expect(draftProblem(SQUARE)).toBeNull();
	});
	it('says what is wrong', () => {
		expect(draftProblem(SQUARE.slice(0, 2))).toContain('three corners');
		expect(draftProblem([[0, 0], [1, 1], [1, 0], [0, 1]])).toContain('crosses itself');
		expect(draftProblem([[0, 0], [1, 1], [2, 2]])).toContain('in a line');
	});
});

describe('outlineCrosses', () => {
	it('tells a bow tie from a square', () => {
		expect(outlineCrosses(SQUARE)).toBe(false);
		expect(outlineCrosses([[0, 0], [1, 1], [1, 0], [0, 1]])).toBe(true);
	});
});

describe('canFinish', () => {
	it('needs three corners', () => {
		expect(canFinish(SQUARE.slice(0, 2))).toBe(false);
		expect(canFinish(SQUARE.slice(0, 3))).toBe(true);
	});
});

describe('midpoints', () => {
	it('has every edge, the closing one too', () => {
		expect(midpoints(SQUARE)).toEqual([
			{ at: [0.5, 0], after: 0 },
			{ at: [1, 0.5], after: 1 },
			{ at: [0.5, 1], after: 2 },
			{ at: [0, 0.5], after: 3 }
		]);
	});
});

describe('withoutCorner', () => {
	it('removes one, but keeps three', () => {
		expect(withoutCorner(SQUARE, 0)).toEqual(SQUARE.slice(1));
		expect(withoutCorner(SQUARE.slice(0, 3), 0)).toBeNull();
		expect(withoutCorner(SQUARE, 9)).toBeNull();
	});
});
