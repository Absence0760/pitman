// The hydrological split against the synthetic terrain (syntheticDem.ts), whose valleys are laid out on the
// synthetic quaternaries, so each click below has a known result.
import { readFileSync } from 'node:fs';
import type { AreaGeometry } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { geometryAreaM2 } from '../geo/area.js';
import { parseArea } from '../http/area.js';
import { DelineationRefused } from './delineate.js';
import { differenceGeometry } from './difference.js';
import { syntheticDem } from './syntheticDem.js';
import { delineateTributary, largestPiece, MAX_TRIBUTARY_SHARE, OUTSIDE_WARNING, pointInArea, SLIVER_KM2, WHOLE_QUATERNARY_TEXT } from './tributary.js';

const dem = syntheticDem();
const quaternaries = JSON.parse(readFileSync(new URL('../../fixtures/geo/quaternaries.synthetic.geojson', import.meta.url), 'utf8')) as {
	features: { properties: { code: string }; geometry: AreaGeometry }[];
};
const q = (code: string) => quaternaries.features.find((f) => f.properties.code === code)!.geometry;
const km2 = (g: AreaGeometry) => geometryAreaM2(g as unknown as { type: string; coordinates: unknown })! / 1e6;
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

const TRIBUTARY: [number, number] = [21.1110878, -33.6584957];
const Z01A_OUTLET: [number, number] = [21.1066246, -33.7359036];
const Z02A_RIVER: [number, number] = [21.115551, -33.8001191];
const Z02A_INLET: [number, number] = [21.1079979, -33.7501778];
const UPPER_RIVER: [number, number] = [21.1162376, -33.6001795];

async function refused(p: Promise<unknown>): Promise<DelineationRefused> {
	const e = await p.then(
		() => null,
		(err: unknown) => err
	);
	expect(e).toBeInstanceOf(DelineationRefused);
	return e as DelineationRefused;
}

describe('delineateTributary', () => {
	it('splits Z01A along a tributary: areas that add up, nothing dropped, polygons the API itself accepts', async () => {
		const r = await delineateTributary(dem, TRIBUTARY, q('Z01A'));
		expect(r.tributaryKm2).toBeGreaterThan(20);
		expect(r.tributaryKm2).toBeLessThan(40);
		expect(r.tributaryKm2 + r.remainderKm2).toBeCloseTo(km2(q('Z01A')), 9);
		expect(r.outsideKm2).toBeCloseTo(0, 6);
		expect(r.warning).toBeNull();
		expect(r.snapM).toBeLessThanOrEqual(150);
		// `POST /map-grid/mean` will be asked about both pieces.
		expect(() => parseArea({ area: r.tributary })).not.toThrow();
		expect(() => parseArea({ area: r.remainder })).not.toThrow();
		expect(pointInArea(TRIBUTARY, r.tributary) || r.snapM > 0).toBe(true);
	});

	it('leaves no sliver: the pieces partition the quaternary, the tributary stays inside it', async () => {
		const r = await delineateTributary(dem, UPPER_RIVER, q('Z01A'));
		expect(r.remainder.type).toBe('Polygon');
		// What is left of Q after the tributary is the remainder, to well under a cell's area.
		expect(Math.abs(km2(differenceGeometry(q('Z01A'), r.tributary)!) - km2(r.remainder))).toBeLessThan(0.001);
		expect(differenceGeometry(r.tributary, q('Z01A'))).toBeNull();
	});

	it('keeps the remainder a MultiPolygon when the tributary cuts the piece in two', async () => {
		// A strip ending at the click: the catchment above it runs up to the strip's far side, leaving each slope its own part.
		const strip = box(21.03, -33.6002, 21.2, -33.56);
		const r = await delineateTributary(dem, UPPER_RIVER, strip);
		expect(r.tributaryKm2 + r.remainderKm2).toBeCloseTo(km2(strip), 9);
		expect(r.remainder.type).toBe('MultiPolygon');
		expect(r.remainder.coordinates.length).toBeGreaterThanOrEqual(2);
		for (const part of (r.remainder as Extract<AreaGeometry, { type: 'MultiPolygon' }>).coordinates) {
			expect(km2({ type: 'Polygon', coordinates: part })).toBeGreaterThanOrEqual(SLIVER_KM2);
		}
	});

	it('takes a piece with a hole, the hole staying out of both results', async () => {
		const hole = [
			[21.13, -33.56],
			[21.13, -33.54],
			[21.15, -33.54],
			[21.15, -33.56],
			[21.13, -33.56]
		] as [number, number][];
		const outer = (box(21, -33.75, 21.25, -33.5) as unknown as { coordinates: [number, number][][] }).coordinates[0]!;
		const within: AreaGeometry = { type: 'Polygon', coordinates: [outer, hole] };
		const r = await delineateTributary(dem, UPPER_RIVER, within);
		expect(r.tributaryKm2 + r.remainderKm2).toBeCloseTo(km2(within), 9);
		expect(pointInArea([21.14, -33.55], r.tributary)).toBe(false);
		expect(pointInArea([21.14, -33.55], r.remainder)).toBe(false);
	});

	it('warns, with the spec’s sentence, on a river most of whose catchment is upstream of the quaternary', async () => {
		const r = await delineateTributary(dem, Z02A_RIVER, q('Z02A'));
		expect(r.outsidePct).toBeGreaterThan(80);
		expect(r.outsideKm2).toBeGreaterThan(600);
		expect(r.warning).toBe(OUTSIDE_WARNING);
		expect(r.warning).toBe('most of this river’s catchment is outside the quaternary; its flow from upstream already reaches this quaternary by route. Click further down a tributary that rises inside it.');
		// The upstream quaternary is dropped, not pulled in.
		expect(r.tributaryKm2).toBeLessThan(120);
		expect(r.delineation.windowCells).toBe(2048);
	});

	it('refuses a tributary that is almost the whole quaternary', async () => {
		const e = await refused(delineateTributary(dem, Z01A_OUTLET, q('Z01A')));
		expect(e.code).toBe('whole_quaternary');
		expect(e.message).toBe(WHOLE_QUATERNARY_TEXT);
		expect(MAX_TRIBUTARY_SHARE).toBe(0.95);
	});

	it('refuses under 1 km² inside the piece, though the river above it is large', async () => {
		const e = await refused(delineateTributary(dem, Z02A_INLET, q('Z02A')));
		expect(e.code).toBe('too_small');
		expect(e.message).toMatch(/under the elevation model’s 1 km² channel threshold/);
	});

	it('keeps IC-WBT’s refusals: off a channel, and outside the elevation model', async () => {
		expect((await refused(delineateTributary(dem, [21.24, -33.62], q('Z01A')))).code).toBe('off_channel');
		expect((await refused(delineateTributary(dem, [20.9, -33.6], box(20.8, -33.7, 20.95, -33.5)))).code).toBe('outside');
	});

	it('refuses a click outside the piece before reading any elevation', async () => {
		const reads: string[] = [];
		const counting = { info: dem.info, tile: (z: number, x: number, y: number) => (reads.push(`${z}/${x}/${y}`), dem.tile(z, x, y)) };
		const e = await refused(delineateTributary(counting, Z02A_RIVER, q('Z01A')));
		expect(e.code).toBe('outside');
		expect(e.message).toMatch(/outside the quaternary/);
		expect(reads).toEqual([]);
	});

	it('copes with a boundary of thousands of vertices (the polygons still pass the API’s check)', async () => {
		const ring: [number, number][] = [];
		const N = 20_000;
		for (let i = 0; i < N; i++) {
			const a = (2 * Math.PI * i) / N;
			const radius = 0.12 * (1 + 0.03 * Math.sin(a * 37) + 0.01 * Math.sin(a * 401));
			ring.push([21.125 + radius * Math.cos(a), -33.63 + radius * Math.sin(a)]);
		}
		ring.push(ring[0]!);
		const within = parseArea({ area: { type: 'Polygon', coordinates: [ring] } }).geometry as AreaGeometry;
		const r = await delineateTributary(dem, UPPER_RIVER, within);
		expect(r.tributaryKm2 + r.remainderKm2).toBeCloseTo(km2(within), 9);
		expect(() => parseArea({ area: r.tributary })).not.toThrow();
		expect(() => parseArea({ area: r.remainder })).not.toThrow();
	});
});

describe('largestPiece', () => {
	it('keeps the largest 8-connected piece: a corner joins, a gap doesn’t', () => {
		const n = 5;
		// prettier-ignore
		const mask = Uint8Array.from([
			1, 0, 0, 0, 0,
			0, 1, 0, 0, 1,
			0, 0, 1, 0, 1,
			0, 0, 0, 0, 0,
			0, 0, 0, 0, 0
		]);
		// prettier-ignore
		expect([...largestPiece(n, mask)]).toEqual([
			1, 0, 0, 0, 0,
			0, 1, 0, 0, 0,
			0, 0, 1, 0, 0,
			0, 0, 0, 0, 0,
			0, 0, 0, 0, 0
		]);
	});

	it('is empty for an empty mask', () => {
		expect([...largestPiece(2, new Uint8Array(4))]).toEqual([0, 0, 0, 0]);
	});
});

describe('differenceGeometry', () => {
	it('gives a Polygon, a MultiPolygon, or null when nothing is left', () => {
		const a = box(0, 0, 3, 1);
		expect(differenceGeometry(a, box(2, -1, 4, 2))!.type).toBe('Polygon');
		expect(differenceGeometry(a, box(1, -1, 2, 2))!.type).toBe('MultiPolygon');
		expect(differenceGeometry(a, box(-1, -1, 4, 2))).toBeNull();
	});
});
