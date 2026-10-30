import { describe, expect, it } from 'vitest';

import type { AreaGeometry } from '../extend/contract.js';
import type { MapGridCells, SplitByZone, ZoneFromThreshold } from './contract.js';
import { SQUARE } from './fixtures.js';
import { cellAreaKm2, geometryAreaKm2 } from './geodesic.js';
import { insideRing, signedArea, simplifyRing, traceRings } from './outline.js';
import { differenceGeometry, intersectGeometry, pointInGeometry, splitByZone, zoneFromThreshold } from './zones.js';

const box = (w: number, s: number, e: number, n: number): AreaGeometry => ({
	type: 'Polygon',
	coordinates: [
		[
			[w, s],
			[e, s],
			[e, n],
			[w, n],
			[w, s]
		]
	]
});

/** 0.01° cells (about 1 km²) over SQUARE. */
function grid(value: (col: number, row: number) => number | null, cellDeg = 0.01): MapGridCells {
	const cols = Math.round(0.2 / cellDeg);
	const rows = cols;
	return {
		dataset: 'synthetic',
		source: 'synthetic',
		cellDeg,
		originLon: 20 + cellDeg / 2,
		originLat: -33.8 - cellDeg / 2,
		cols,
		rows,
		values: Array.from({ length: cols * rows }, (_, k) => value(k % cols, Math.floor(k / cols)))
	};
}

describe('geodesic area', () => {
	it('gives the known size of a one-degree square at the equator and of a band of the ellipsoid', () => {
		// Lambert cylindrical equal-area on WGS84 (Snyder 1987): about 12 308 km² at the equator.
		expect(geometryAreaKm2(box(0, 0, 1, 1))).toBeCloseTo(12308.8, 0);
		const total = 2 * cellAreaKm2(90, 0, 360);
		expect(total).toBeCloseTo(510065622, -2); // WGS84 surface area
	});

	it('takes holes off and adds the polygons of a MultiPolygon', () => {
		const outer = box(20, -34, 20.2, -33.8);
		const hole = box(20.05, -33.95, 20.1, -33.9);
		const holed = differenceGeometry(outer, hole)!;
		expect(geometryAreaKm2(holed)).toBeCloseTo(geometryAreaKm2(outer) - geometryAreaKm2(hole), 6);
		const two = differenceGeometry(outer, box(20.09, -35, 20.11, -33))!;
		expect(two.type).toBe('MultiPolygon');
		expect(geometryAreaKm2(two)).toBeCloseTo(geometryAreaKm2(outer) * 0.9, 1);
	});
});

describe('differenceGeometry and intersectGeometry', () => {
	it('tile: the two parts add up to the whole (invariant 1)', () => {
		const tributary: AreaGeometry = {
			type: 'Polygon',
			coordinates: [
				[
					[20.03, -33.97],
					[20.11, -33.95],
					[20.14, -33.83],
					[20.02, -33.86],
					[20.03, -33.97]
				]
			]
		};
		const rest = differenceGeometry(SQUARE, tributary)!;
		const whole = geometryAreaKm2(SQUARE);
		expect(Math.abs(geometryAreaKm2(rest) + geometryAreaKm2(tributary) - whole) / whole).toBeLessThan(1e-6);
	});

	it('answers null when nothing is left', () => {
		expect(differenceGeometry(SQUARE, box(19, -35, 21, -33))).toBeNull();
		expect(intersectGeometry(SQUARE, box(30, -35, 31, -33))).toBeNull();
	});
});

describe('pointInGeometry', () => {
	it('honours holes and every polygon of a MultiPolygon', () => {
		const holed = differenceGeometry(SQUARE, box(20.05, -33.95, 20.1, -33.9))!;
		expect(pointInGeometry([20.01, -33.99], holed)).toBe(true);
		expect(pointInGeometry([20.07, -33.92], holed)).toBe(false);
		expect(pointInGeometry([21, -33], holed)).toBe(false);
		const two = differenceGeometry(SQUARE, box(20.09, -35, 20.11, -33))!;
		expect(pointInGeometry([20.05, -33.9], two)).toBe(true);
		expect(pointInGeometry([20.15, -33.9], two)).toBe(true);
	});
});

describe('the outline port', () => {
	const mask = (rows: readonly string[]) => Uint8Array.from(rows.join('').split('').map((c) => (c === '#' ? 1 : 0)));

	it('traces a square of cells closed and holes the other way round', () => {
		const { outer, holes } = traceRings(5, 5, mask(['#####', '#...#', '#...#', '#...#', '#####']), 4);
		expect(outer[0]).toEqual(outer[outer.length - 1]);
		expect(Math.abs(signedArea(outer))).toBe(25);
		expect(holes).toHaveLength(1);
		expect(Math.abs(signedArea(holes[0]!))).toBe(9);
		expect(Math.sign(signedArea(holes[0]!))).toBe(-Math.sign(signedArea(outer)));
		expect(insideRing(holes[0]![0]!, outer)).toBe(true);
	});

	it('keeps cells that touch only at a corner as one ring', () => {
		const { outer } = traceRings(4, 4, mask(['##..', '##..', '..##', '..##']));
		expect(Math.abs(signedArea(outer))).toBeGreaterThan(7.5);
	});

	it('drops a hole under the size asked for', () => {
		expect(traceRings(3, 3, mask(['###', '#.#', '###']), 2).holes).toHaveLength(0);
		expect(traceRings(3, 3, mask(['###', '#.#', '###']), 1).holes).toHaveLength(1);
	});

	it('simplifies within the tolerance and leaves a triangle alone', () => {
		const stairs: [number, number][] = [
			[0, 0],
			[1, 0],
			[1, 1],
			[2, 1],
			[2, 2],
			[3, 2],
			[3, 3],
			[0, 3],
			[0, 0]
		];
		const simple = simplifyRing(stairs, 0.8);
		expect(simple.length).toBeLessThan(stairs.length);
		expect(simple[0]).toEqual(simple[simple.length - 1]);
		const triangle: [number, number][] = [
			[0, 0],
			[1, 0],
			[0, 1],
			[0, 0]
		];
		expect(simplifyRing(triangle, 5)).toEqual(triangle);
	});
});

describe('zoneFromThreshold', () => {
	const contract: ZoneFromThreshold = zoneFromThreshold;
	const gradient = grid((col) => 400 + col * 50); // 400 mm in the west to 1 350 mm in the east, 20 columns

	it('takes cells with MAP ≥ t on the high side and ≤ t on the low side', () => {
		const high = contract(gradient, SQUARE, 1000, 'high')!;
		const low = contract(gradient, SQUARE, 990, 'low')!;
		expect(pointInGeometry([20.15, -33.9], high)).toBe(true);
		expect(pointInGeometry([20.03, -33.9], high)).toBe(false);
		expect(pointInGeometry([20.03, -33.9], low)).toBe(true);
		const whole = geometryAreaKm2(SQUARE);
		expect(geometryAreaKm2(high) + geometryAreaKm2(low)).toBeCloseTo(whole, 0);
		expect(geometryAreaKm2(high)).toBeCloseTo(whole * 0.4, 0); // columns 12–19 of 20
	});

	it('leaves out cells without a value and cells whose centre is outside the area', () => {
		const holed = grid((col, row) => (col >= 8 && col < 12 && row >= 8 && row < 12 ? null : 800));
		const zone = contract(holed, SQUARE, 500, 'high')!;
		expect(pointInGeometry([20.1, -33.9], zone)).toBe(false);
		const half = contract(grid(() => 800), box(20, -34, 20.1, -33.8), 500, 'high')!;
		expect(pointInGeometry([20.15, -33.9], half)).toBe(false);
		expect(geometryAreaKm2(half)).toBeCloseTo(geometryAreaKm2(SQUARE) / 2, -1);
	});

	it('drops regions under 1 km² and keeps a larger one, each as its own polygon', () => {
		// A 0.01° cell is over 1 km², so a finer grid: 0.0025° is about 0.06 km².
		const fine = grid((col, row) => {
			if (col >= 2 && col < 4 && row >= 2 && row < 4) return 900; // 4 cells: dropped
			if (col >= 20 && col < 30 && row >= 20 && row < 30) return 900; // 100 cells: kept
			if (col >= 60 && col < 70 && row >= 60 && row < 70) return 900; // 100 cells: kept
			return 300;
		}, 0.0025);
		const zone = contract(fine, SQUARE, 800, 'high')!;
		expect(zone.type).toBe('MultiPolygon');
		expect(pointInGeometry([20 + 0.0025 * 3, -33.8 - 0.0025 * 3], zone)).toBe(false);
		expect(pointInGeometry([20 + 0.0025 * 25, -33.8 - 0.0025 * 25], zone)).toBe(true);
		expect(geometryAreaKm2(zone)).toBeCloseTo(2 * 100 * cellAreaKm2(-33.85, -33.8525, 0.0025), 0);
	});

	it('fills a hole under 1 km² and keeps a bigger one', () => {
		const small = grid((col, row) => (col >= 40 && col < 42 && row >= 40 && row < 42 ? 300 : 900), 0.0025);
		expect(pointInGeometry([20 + 0.0025 * 41, -33.8 - 0.0025 * 41], contract(small, SQUARE, 800, 'high')!)).toBe(true);
		const big = grid((col, row) => (col >= 40 && col < 60 && row >= 40 && row < 60 ? 300 : 900), 0.0025);
		expect(pointInGeometry([20 + 0.0025 * 50, -33.8 - 0.0025 * 50], contract(big, SQUARE, 800, 'high')!)).toBe(false);
	});

	it('answers null when nothing survives', () => {
		expect(contract(gradient, SQUARE, 5000, 'high')).toBeNull();
		expect(contract(grid(() => null), SQUARE, 0, 'high')).toBeNull();
	});

	it('simplifies a staircase edge by about half a cell, never far from the cells', () => {
		const diagonal = grid((col, row) => (col > row ? 900 : 300));
		const zone = contract(diagonal, SQUARE, 800, 'high')!;
		const rings = zone.type === 'Polygon' ? zone.coordinates : zone.coordinates[0]!;
		expect(rings[0]!.length).toBeLessThan(40);
		expect(geometryAreaKm2(zone)).toBeCloseTo(geometryAreaKm2(SQUARE) * 0.475, -1); // 190 of 400 cells
	});
});

describe('splitByZone', () => {
	const contract: SplitByZone = splitByZone;

	it('gives Z ∩ Q and Q − Z, adding up exactly (invariant 1)', () => {
		const zone = box(20.1, -34.5, 20.5, -33.5); // reaches outside Q
		const r = contract(SQUARE, zone);
		const whole = geometryAreaKm2(SQUARE);
		expect(r.zoneKm2 + r.restKm2).toBeCloseTo(whole, 9);
		expect(Math.abs(geometryAreaKm2(r.rest) - r.restKm2) / whole).toBeLessThan(1e-6);
		expect(r.zoneKm2).toBeCloseTo(whole / 2, 0);
		expect(pointInGeometry([20.15, -33.9], r.zone)).toBe(true);
		expect(pointInGeometry([20.05, -33.9], r.rest)).toBe(true);
	});

	it('allows a zone that cuts the rest in two', () => {
		const r = contract(SQUARE, box(20.09, -35, 20.11, -33));
		expect(r.rest.type).toBe('MultiPolygon');
	});

	it('refuses either piece under 1 km²', () => {
		expect(() => contract(SQUARE, box(20.1, -33.9, 20.102, -33.898))).toThrow(/less than 1 km²/);
		expect(() => contract(SQUARE, box(30, -35, 31, -34))).toThrow(/less than 1 km²/);
		expect(() => contract(SQUARE, box(19, -35, 21, -33))).toThrow(/leaves less than 1 km²/);
		expect(() => contract(SQUARE, box(20.0001, -33.9999, 21, -33))).toThrow(/leaves less than 1 km²/);
	});
});
