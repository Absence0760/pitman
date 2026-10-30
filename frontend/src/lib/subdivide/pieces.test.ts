import type { DamRecord, ModuleRef } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { DELINEATED, QUATERNARY, REMAINDER, TRIBUTARY, box, fakeEngine, sample } from './fixtures.test-helper.js';
import {
	MAX_PIECES,
	buildPlan,
	damsByPiece,
	formatCellDeg,
	gridSourceLine,
	mapPieces,
	moduleLine,
	parseMapMm,
	pieceBlockers,
	pieceRows,
	planGrid,
	planLayout,
	damShares,
	planShares,
	resolutionNote,
	resolveMap,
	shareLines,
	splitLabel,
	splitPiece,
	undoTo,
	startPieces,
	tributarySplit,
	zoneSplit,
	type PieceSet,
	type SampleState
} from './pieces.js';

const MODULE: ModuleRef = { type: 'RU', number: 3 };
const whole = () => startPieces(QUATERNARY, 403.7);
const split = () => splitPiece(whole(), 0, tributarySplit(DELINEATED, [20.55, -33.6]));

function rowsOf(set: PieceSet, samples: Record<string, SampleState>, typed: Record<string, string> = {}) {
	return pieceRows({ set, samples, typed, areas: undefined, dams: [], preview: undefined }, MODULE);
}

const okAll = (set: PieceSet, ...maps: number[]): Record<string, SampleState> => Object.fromEntries(set.pieces.map((p, i) => [p.id, { state: 'ok', sample: sample(maps[i] as number) }]));

describe('splitting the pieces', () => {
	it('leaves the remainder in the split piece’s place and adds the new piece at the end', () => {
		const set = split();
		expect(set.pieces.map((p) => [p.role, p.polygonKm2])).toEqual([
			['remainder', 282.6],
			['tributary', 121.1]
		]);
		expect(set.splits).toHaveLength(1);
		expect(set.pieces[0]?.id).not.toBe(whole().pieces[0]?.id);
	});

	it('keeps other pieces’ numbers on a repeated split', () => {
		const once = split();
		const twice = splitPiece(once, 1, zoneSplit({ zone: box(20.5, -33.7, 20.55, -33.5), rest: box(20.55, -33.7, 20.6, -33.5), zoneKm2: 50, restKm2: 71.1 }, { kind: 'zone-drawn' }));
		expect(twice.pieces.map((p) => p.role)).toEqual(['remainder', 'rest', 'zone']);
		expect(twice.pieces[0]?.id).toBe(once.pieces[0]?.id);
		expect(new Set(twice.pieces.map((p) => p.id)).size).toBe(3);
	});

	it('refuses a ninth piece, and a piece that isn’t there', () => {
		let set = whole();
		for (let i = 1; i < MAX_PIECES; i++) set = splitPiece(set, 0, tributarySplit(DELINEATED, [20.55, -33.6]));
		expect(set.pieces).toHaveLength(8);
		expect(() => splitPiece(set, 0, tributarySplit(DELINEATED, [20.55, -33.6]))).toThrow('at most 8 pieces');
		expect(() => splitPiece(whole(), 3, tributarySplit(DELINEATED, [20.55, -33.6]))).toThrow('No piece 4');
	});

	it('records a tributary as the sidecar wants it', () => {
		expect(tributarySplit(DELINEATED, [20.55, -33.6]).record).toEqual({ kind: 'tributary', click: [20.55, -33.6], snapM: 41, dem: DELINEATED.dem, outsideQuaternaryPct: 3.1 });
	});

	it('gives the map the numbers the cards show, and nothing before the first split', () => {
		expect(mapPieces(whole())).toEqual([]);
		expect(mapPieces(split()).map((p) => [p.number, p.label])).toEqual([
			[1, '1 Outside the tributary'],
			[2, '2 Tributary']
		]);
	});
});

describe('splitLabel', () => {
	it('says what each split did', () => {
		expect(splitLabel(tributarySplit(DELINEATED, [20.55, -33.6]).record)).toBe('Tributary: the click moved 41 m to the channel; 3.1 % of its catchment lay outside the piece and was dropped (Synthetic DEM, zoom 11)');
		expect(splitLabel({ kind: 'zone-drawn' })).toBe('MAP zone: drawn or pasted');
		expect(splitLabel({ kind: 'zone-threshold', thresholdMm: 800, side: 'high' })).toBe('MAP zone: every grid cell with MAP at or above 800 mm');
		expect(splitLabel({ kind: 'zone-threshold', thresholdMm: 300, side: 'low' })).toBe('MAP zone: every grid cell with MAP at or below 300 mm');
	});
});

describe('a typed MAP', () => {
	it('takes whole mm in the engine’s range', () => {
		expect(parseMapMm(' 820 ')).toEqual({ ok: true, value: 820 });
		expect(parseMapMm('1')).toEqual({ ok: true, value: 1 });
		expect(parseMapMm('12000')).toEqual({ ok: true, value: 12000 });
	});

	it('refuses, in words, what the file can’t hold', () => {
		expect(parseMapMm('820.5')).toEqual({ ok: false, error: expect.stringContaining('whole number') });
		expect(parseMapMm('820,5')).toEqual({ ok: false, error: expect.stringContaining('whole number') });
		expect(parseMapMm('0')).toEqual({ ok: false, error: expect.stringContaining('from 1 to') });
		expect(parseMapMm('12001')).toEqual({ ok: false, error: expect.stringContaining('from 1 to') });
		expect(parseMapMm('wet')).toEqual({ ok: false, error: expect.stringContaining('as a number') });
	});
});

describe('resolveMap', () => {
	it('uses the grid, unless the user typed a value', () => {
		const ok: SampleState = { state: 'ok', sample: sample(820) };
		expect(resolveMap(ok, '')).toEqual({ value: 820, source: 'grid' });
		expect(resolveMap(ok, '700')).toEqual({ value: 700, source: 'typed' });
	});

	it('does not fall back to the grid under a bad typed value', () => {
		expect(resolveMap({ state: 'ok', sample: sample(820) }, 'x').value).toBeNull();
	});

	it('gives no MAP under 90 % coverage, at exactly 90 % it does', () => {
		expect(resolveMap({ state: 'ok', sample: sample(820, { coveragePct: 89.9 }) }, '')).toEqual({ value: null, source: null, problem: 'The grid covers only 90 % of this piece: type its MAP.' });
		expect(resolveMap({ state: 'ok', sample: sample(820, { coveragePct: 90 }) }, '').value).toBe(820);
	});

	it('tells not covered from failed from still loading', () => {
		const problem = (s: SampleState | undefined) => {
			const r = resolveMap(s, '');
			return r.value === null ? r.problem : '';
		};
		expect(problem({ state: 'failed', message: 'x', notCovered: true })).toContain('does not cover');
		expect(problem({ state: 'failed', message: 'x', notCovered: false })).toContain('try again');
		expect(problem({ state: 'loading' })).toContain('loading');
		expect(problem(undefined)).toContain('loading');
	});
});

describe('where a grid MAP came from', () => {
	it('names the grid, its cell size and when it was read', () => {
		expect(gridSourceLine(sample(820))).toBe('Synthetic MAP grid v1, 0.01° cells (about 1000 m), read 2026-10-30');
	});

	it('keeps a computed cell size readable', () => {
		expect(formatCellDeg(0.009999999999999964)).toBe('0.01°');
		expect(formatCellDeg(0.001)).toBe('0.001°');
	});

	it('says when a piece is too small for the grid: under 4 cells’ area', () => {
		expect(resolutionNote(3.9, sample(820))).toContain('fewer than 4 grid cells');
		expect(resolutionNote(4, sample(820))).toBeNull();
	});
});

describe('dams and shares', () => {
	const dam = (lon: number, lat: number, capacityMm3: number): DamRecord => ({ id: `${lon}`, lon, lat, capacityMm3, source: { kind: 'manual' } });

	it('counts each located dam in the piece that holds it, and leaves out dams outside', () => {
		const counts = damsByPiece([dam(20.65, -33.6, 0.5), dam(20.66, -33.6, 0.25), dam(20.55, -33.6, 1), dam(25, -30, 9)], split().pieces);
		expect(counts).toEqual([
			{ count: 2, capacityMm3: 0.75 },
			{ count: 1, capacityMm3: 1 }
		]);
	});

	it('shares dams by location when some capacity is located, and land use by area until it has polygons', () => {
		expect(planShares([{ count: 1, capacityMm3: 1 }, { count: 0, capacityMm3: 0 }])).toEqual({ afforestation: 'area', alien: 'area', dams: 'location' });
		expect(planShares([{ count: 0, capacityMm3: 0 }]).dams).toBe('area');
	});

	it('carries each piece’s share of the located capacity into the plan (the worked example: two of six dams)', () => {
		const counts = [{ count: 4, capacityMm3: 4 }, { count: 2, capacityMm3: 2 }];
		expect(damShares(counts)).toEqual([4 / 6, 2 / 6]);
		const set = split();
		const plan = buildPlan('Z01A', MODULE, set, rowsOf(set, okAll(set, 610, 820)), planShares(counts), counts);
		expect(plan?.pieces.map((p) => p.locationShares?.damCapacity)).toEqual([4 / 6, 2 / 6]);
	});

	it('says, per table, which basis was used', () => {
		const lines = shareLines({ afforestation: 'area', alien: 'area', dams: 'location' });
		expect(lines[0]).toContain('Afforestation: by each piece’s share of the area');
		expect(lines[2]).toBe('Farm dams: by where it lies.');
		expect(lines[3]).toContain('Irrigated fields');
	});
});

describe('moduleLine', () => {
	it('says whether a piece keeps the module or becomes a new one', () => {
		expect(moduleLine({ role: 'remainder', module: MODULE, areaKm2: 280, outlet: true }, MODULE)).toBe('Stays RU 3, the outlet piece');
		expect(moduleLine({ role: 'tributary', module: { type: 'RU', number: 16 }, areaKm2: 120, outlet: false }, MODULE)).toBe('Becomes RU 16 (new)');
	});
});

describe('the rows', () => {
	it('carry the engine’s rounded areas and the preview’s modules', () => {
		const set = split();
		const areas = fakeEngine().scalePieceAreas(400, [282.6, 121.1]);
		const preview = { pieces: [{ role: 'remainder' as const, module: MODULE, areaKm2: 280, outlet: true }, { role: 'tributary' as const, module: { type: 'RU' as const, number: 16 }, areaKm2: 120, outlet: false }], changes: [], messages: [] };
		const rows = pieceRows({ set, samples: okAll(set, 610, 820), typed: {}, areas, dams: [], preview }, MODULE);
		expect(rows.map((r) => [r.number, r.title, r.areaKm2, r.module])).toEqual([
			[1, 'Piece 1: Outside the tributary', 280, 'Stays RU 3, the outlet piece'],
			[2, 'Piece 2: Tributary', 120, 'Becomes RU 16 (new)']
		]);
	});
});

describe('planGrid', () => {
	it('is the finest grid among the pieces', () => {
		const set = split();
		const samples: Record<string, SampleState> = {
			[set.pieces[0]?.id as string]: { state: 'ok', sample: sample(610, { grid: 'Coarse', cellDeg: 0.01 }) },
			[set.pieces[1]?.id as string]: { state: 'ok', sample: sample(820, { grid: 'Fine', cellDeg: 0.001 }) }
		};
		expect(planGrid(rowsOf(set, samples)).dataset).toBe('Fine');
	});

	it('says so when every MAP was typed', () => {
		const set = split();
		const typed = Object.fromEntries(set.pieces.map((p) => [p.id, '600']));
		expect(planGrid(rowsOf(set, {}, typed))).toEqual({ dataset: 'none', cellDeg: 0, source: 'every MAP typed by the user' });
	});
});

describe('pieceBlockers', () => {
	it('names every piece without a MAP', () => {
		const set = split();
		const samples: Record<string, SampleState> = { [set.pieces[0]?.id as string]: { state: 'failed', message: 'x', notCovered: true } };
		const blockers = pieceBlockers(rowsOf(set, samples));
		expect(blockers.map((b) => b.number)).toEqual([1, 2]);
		expect(blockers[0]?.text).toBe('Piece 1: The grid does not cover this piece: type its MAP.');
	});

	it('refuses two grids in one quaternary, and a typed MAP clears it', () => {
		const set = split();
		const id = set.pieces[0]?.id as string;
		const samples: Record<string, SampleState> = {
			[id]: { state: 'ok', sample: sample(610, { grid: 'Coarse', cellDeg: 0.01 }) },
			[set.pieces[1]?.id as string]: { state: 'ok', sample: sample(820, { grid: 'Fine', cellDeg: 0.001 }) }
		};
		expect(pieceBlockers(rowsOf(set, samples))[0]?.text).toContain('One grid serves every piece');
		expect(pieceBlockers(rowsOf(set, samples, { [id]: '610' }))).toEqual([]);
	});
});

describe('the plan', () => {
	const shares = planShares([]);

	it('is series with a tributary anywhere, side by side otherwise', () => {
		expect(planLayout([{ kind: 'zone-drawn' }])).toBe('sideBySide');
		expect(planLayout([{ kind: 'zone-drawn' }, tributarySplit(DELINEATED, [20.55, -33.6]).record])).toBe('series');
	});

	it('waits for two pieces and a MAP on each', () => {
		const one = whole();
		expect(buildPlan('Z01A', MODULE, one, rowsOf(one, okAll(one, 640)), shares)).toBeNull();
		const set = split();
		expect(buildPlan('Z01A', MODULE, set, rowsOf(set, {}), shares)).toBeNull();
	});

	it('carries each piece’s MAP with where it came from', () => {
		const set = split();
		const id = set.pieces[0]?.id as string;
		const plan = buildPlan('Z01A', MODULE, set, rowsOf(set, okAll(set, 610, 820), { [id]: '600' }), shares);
		expect(plan?.pieces.map((p) => [p.role, p.gridMapMm, p.mapSource, p.polygonKm2])).toEqual([
			['remainder', 600, 'typed', 282.6],
			['tributary', 820, 'grid', 121.1]
		]);
		expect(plan?.pieces[0]?.geometry).toBe(REMAINDER);
		expect(plan?.pieces[1]?.geometry).toBe(TRIBUTARY);
		expect(plan?.layout).toBe('series');
		expect(plan?.grid.dataset).toBe('Synthetic MAP grid');
		expect(plan?.quaternary).toBe('Z01A');
		expect(plan?.splits).toBe(set.splits);
	});
});

describe('undoing a split', () => {
	it('never lets a later split reuse an id, so it can’t pick up the undone pieces’ MAPs', () => {
		const first = split();
		const undone = undoTo(whole(), first);
		const again = splitPiece(undone, 0, tributarySplit(DELINEATED, [20.55, -33.6]));
		const before = new Set(first.pieces.map((p) => p.id));
		expect(again.pieces.some((p) => before.has(p.id))).toBe(false);
		expect(undone.pieces).toEqual(whole().pieces);
	});
});
