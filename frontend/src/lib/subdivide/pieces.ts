/**
 * The pieces of a quaternary while the wizard works on them: repeated splits,
 * each piece's MAP (grid or typed, rule 8) and everything the review step says
 * about them, up to the `SplitPlan` the engine takes. Pure.
 *
 * Numbers are positions and stay put: a split leaves the remainder in the
 * split piece's place and adds the new piece at the end, so the numbers on the
 * map and the cards never move under the user.
 */

import type { AreaGeometry, DamRecord, DelineateResponse, ModuleRef, PieceAreas, PiecePlan, PieceRole, ShareBasis, SplitByZone, SplitPlan, SplitPreview, SplitRecord } from '@pitman/wrsm';
import { parseFactor } from '#lib/extend/factors.js';
import type { MapPiece } from '#lib/map/contract.js';
import { formatNumber } from '#lib/results/format.js';
import type { MapGridMean } from './data.js';
import { pointInGeometry } from './geometry.js';

/** B8. */
export const MAX_PIECES = 8;
/** subdivide.md § Starting values: under this a piece is not covered by the grid. */
export const MIN_COVERAGE_PCT = 90;
/** subdivide.md § Guards: the engine's MAP range. */
export const MIN_MAP_MM = 1;
export const MAX_MAP_MM = 12_000;
/** subdivide.md § Starting values: below this many cells' area the grid can't resolve rain inside a piece. */
export const MIN_RESOLVED_CELLS = 4;

export interface Piece {
	readonly id: string;
	readonly role: PieceRole;
	readonly geometry: AreaGeometry;
	/** Geodesic polygon area, km². */
	readonly polygonKm2: number;
}

export interface PieceSet {
	readonly pieces: readonly Piece[];
	readonly splits: readonly SplitRecord[];
	readonly nextId: number;
}

/** A piece of the split about to be accepted. */
export interface NewPiece {
	readonly role: PieceRole;
	readonly geometry: AreaGeometry;
	readonly polygonKm2: number;
}

export interface SplitResult {
	readonly record: SplitRecord;
	/** The tributary or the zone. */
	readonly part: NewPiece;
	/** The remainder or the rest. */
	readonly remainder: NewPiece;
}

/** The whole quaternary, before any split. */
export function startPieces(geometry: AreaGeometry, polygonKm2: number): PieceSet {
	return { pieces: [{ id: 'piece-1', role: 'rest', geometry, polygonKm2 }], splits: [], nextId: 2 };
}

/** `set` with piece `index` split: the remainder keeps its number, the new piece takes the next one. */
/**
 * Back to an earlier set. Its pieces return, but `nextId` doesn't rewind: a later split must never reuse an id,
 * or it would pick up the grid means and typed MAPs kept for the undone split's pieces.
 */
export function undoTo(previous: PieceSet, current: PieceSet): PieceSet {
	return { ...previous, nextId: current.nextId };
}

export function splitPiece(set: PieceSet, index: number, split: SplitResult): PieceSet {
	const target = set.pieces[index];
	if (target === undefined) throw new RangeError(`No piece ${index + 1}.`);
	if (set.pieces.length >= MAX_PIECES) throw new RangeError(`A quaternary takes at most ${MAX_PIECES} pieces.`);
	const pieces = [...set.pieces];
	pieces[index] = { id: `piece-${set.nextId}`, ...split.remainder };
	pieces.push({ id: `piece-${set.nextId + 1}`, ...split.part });
	return { pieces, splits: [...set.splits, split.record], nextId: set.nextId + 2 };
}

/** An accepted tributary (the delineation's answer and the click that asked for it) as a split. */
export function tributarySplit(answer: DelineateResponse, click: readonly [number, number]): SplitResult {
	return {
		record: { kind: 'tributary', click, snapM: answer.snapM, dem: answer.dem, outsideQuaternaryPct: answer.outsidePct },
		part: { role: 'tributary', geometry: answer.tributary, polygonKm2: answer.tributaryKm2 },
		remainder: { role: 'remainder', geometry: answer.remainder, polygonKm2: answer.remainderKm2 }
	};
}

/** An accepted MAP zone (`splitByZone`'s answer) as a split. */
export function zoneSplit(zone: ReturnType<SplitByZone>, record: SplitRecord): SplitResult {
	return {
		record,
		part: { role: 'zone', geometry: zone.zone, polygonKm2: zone.zoneKm2 },
		remainder: { role: 'rest', geometry: zone.rest, polygonKm2: zone.restKm2 }
	};
}

const ROLE_LABELS: Readonly<Record<PieceRole, string>> = { tributary: 'Tributary', zone: 'MAP zone', remainder: 'Outside the tributary', rest: 'Outside the zone' };

export function roleLabel(role: PieceRole): string {
	return ROLE_LABELS[role];
}

/** The pieces as the map draws them: one number on the map and on the card. Nothing before the first split. */
export function mapPieces(set: PieceSet): MapPiece[] {
	if (set.pieces.length < 2) return [];
	return set.pieces.map((p, i) => ({ id: p.id, number: i + 1, label: `${i + 1} ${roleLabel(p.role)}`, geometry: p.geometry }));
}

/** What a split did, in a line. */
export function splitLabel(record: SplitRecord): string {
	switch (record.kind) {
		case 'tributary':
			return `Tributary: the click moved ${formatNumber(record.snapM, 0)} m to the channel; ${formatNumber(record.outsideQuaternaryPct, 1)} % of its catchment lay outside the piece and was dropped (${record.dem.label}, zoom ${record.dem.zoom})`;
		case 'zone-drawn':
			return 'MAP zone: drawn or pasted';
		case 'zone-threshold':
			return `MAP zone: every grid cell with MAP ${record.side === 'high' ? 'at or above' : 'at or below'} ${formatNumber(record.thresholdMm, 0)} mm`;
	}
}

/** The grid's mean for one piece, as it stands. */
export type SampleState =
	| { readonly state: 'loading' }
	| { readonly state: 'ok'; readonly sample: MapGridMean }
	/** `notCovered`: the grid has no value over 90 % of the piece. Otherwise the request failed and can be retried. */
	| { readonly state: 'failed'; readonly message: string; readonly notCovered: boolean };

export type MapResolution = { readonly value: number; readonly source: 'grid' | 'typed' } | { readonly value: null; readonly source: null; readonly problem: string };

/** A typed MAP: whole mm, as the file holds it, inside the engine's range. */
export function parseMapMm(text: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string } {
	const value = parseFactor(text);
	if (Number.isNaN(value)) return { ok: false, error: 'Type the MAP as a number, in mm.' };
	if (!Number.isInteger(value)) return { ok: false, error: 'Type a whole number of mm: the network file holds MAP in whole mm.' };
	if (value < MIN_MAP_MM || value > MAX_MAP_MM) return { ok: false, error: `A MAP must be from ${MIN_MAP_MM} to ${MAX_MAP_MM.toLocaleString('en-ZA')} mm.` };
	return { ok: true, value };
}

/** A typed value wins over the grid; a grid under 90 % coverage gives none. */
export function resolveMap(sample: SampleState | undefined, typed: string): MapResolution {
	if (typed.trim() !== '') {
		const parsed = parseMapMm(typed);
		return parsed.ok ? { value: parsed.value, source: 'typed' } : { value: null, source: null, problem: parsed.error };
	}
	if (sample?.state === 'ok' && sample.sample.coveragePct >= MIN_COVERAGE_PCT) return { value: sample.sample.meanMapMm, source: 'grid' };
	if (sample?.state === 'ok') return { value: null, source: null, problem: `The grid covers only ${formatNumber(sample.sample.coveragePct, 0)} % of this piece: type its MAP.` };
	if (sample?.state === 'failed') return { value: null, source: null, problem: sample.notCovered ? 'The grid does not cover this piece: type its MAP.' : 'The grid MAP could not be read: try again, or type the MAP.' };
	return { value: null, source: null, problem: 'The grid MAP is still loading.' };
}

/** A cell size in degrees, without the noise of a value computed from a box. */
export function formatCellDeg(cellDeg: number): string {
	return `${Number(cellDeg.toPrecision(4))}°`;
}

/** Where a grid MAP came from, in the words the card shows. */
export function gridSourceLine(sample: MapGridMean): string {
	const version = sample.version ? ` ${sample.version}` : '';
	return `${sample.grid}${version}, ${formatCellDeg(sample.cellDeg)} cells (about ${formatNumber(sample.cellSizeM, 0)} m), read ${sample.fetchedOn}`;
}

/** When the piece is too small for the grid to say anything about rain inside it, the sentence that says so. */
export function resolutionNote(polygonKm2: number, sample: MapGridMean): string | null {
	const cellKm2 = (sample.cellSizeM * sample.cellSizeM) / 1e6;
	if (polygonKm2 >= MIN_RESOLVED_CELLS * cellKm2) return null;
	return `This piece covers fewer than ${MIN_RESOLVED_CELLS} grid cells, so the grid can’t resolve rain inside it.`;
}

export interface DamCount {
	readonly count: number;
	readonly capacityMm3: number;
}

/** The sidecar's dams per piece, by which piece holds the dam's point (subdivide.md § Farm dams). */
export function damsByPiece(dams: readonly DamRecord[], pieces: readonly Piece[]): DamCount[] {
	const counts = pieces.map(() => ({ count: 0, capacityMm3: 0 }));
	for (const dam of dams) {
		const count = counts[pieces.findIndex((p) => pointInGeometry(dam.lon, dam.lat, p.geometry))];
		if (count === undefined) continue;
		count.count += 1;
		count.capacityMm3 += dam.capacityMm3;
	}
	return counts;
}

/** Every dam located or the total shared, never a mix (subdivide.md § Farm dams). Land-use polygons don't exist yet, so those share by area. */
export function planShares(counts: readonly DamCount[]): SplitPlan['shares'] {
	const dams: ShareBasis = counts.some((c) => c.capacityMm3 > 0) ? 'location' : 'area';
	return { afforestation: 'area', alien: 'area', dams };
}

/** Each piece's share of the located capacity, as a plan shared by location carries it. */
export function damShares(counts: readonly DamCount[]): number[] {
	const total = counts.reduce((sum, c) => sum + c.capacityMm3, 0);
	return counts.map((c) => c.capacityMm3 / total);
}

/** How each table is shared out, in words (subdivide.md § Fields: "the screen says which was used, per table"). */
export function shareLines(shares: SplitPlan['shares']): readonly string[] {
	const by = (basis: ShareBasis) => (basis === 'location' ? 'by where it lies' : 'by each piece’s share of the area, because its location isn’t known');
	return [`Afforestation: ${by(shares.afforestation)}.`, `Alien vegetation: ${by(shares.alien)}.`, `Farm dams: ${by(shares.dams)}.`, `Irrigated fields: ${by('area')}.`];
}

export interface PieceRow {
	readonly id: string;
	readonly number: number;
	readonly title: string;
	readonly polygonKm2: number;
	/** `A_i`, the engine's rounded value; undefined until the engine answers. */
	readonly areaKm2: number | undefined;
	readonly sample: SampleState | undefined;
	readonly typed: string;
	readonly map: MapResolution;
	readonly resolution: string | null;
	readonly dams: DamCount | undefined;
	/** The module this piece becomes, when the preview is known. */
	readonly module: string | undefined;
}

export interface RowInput {
	readonly set: PieceSet;
	readonly samples: Readonly<Record<string, SampleState>>;
	readonly typed: Readonly<Record<string, string>>;
	readonly areas: PieceAreas | undefined;
	readonly dams: readonly DamCount[];
	readonly preview: SplitPreview | undefined;
}

/** `Stays RU 3, the outlet piece` or `Becomes RU 16 (new)`. */
export function moduleLine(piece: SplitPreview['pieces'][number], original: ModuleRef): string {
	const name = `${piece.module.type} ${piece.module.number}`;
	const outlet = piece.outlet ? ', the outlet piece' : '';
	if (piece.module.type === original.type && piece.module.number === original.number) return `Stays ${name}${outlet}`;
	return `Becomes ${name} (new)${outlet}`;
}

export function pieceRows(input: RowInput, original: ModuleRef): PieceRow[] {
	const { set, samples, typed, areas, dams, preview } = input;
	return set.pieces.map((piece, i) => {
		const sample = samples[piece.id];
		const text = typed[piece.id] ?? '';
		const shown = preview?.pieces[i];
		return {
			id: piece.id,
			number: i + 1,
			title: `Piece ${i + 1}: ${roleLabel(piece.role)}`,
			polygonKm2: piece.polygonKm2,
			areaKm2: areas?.areasKm2[i],
			sample,
			typed: text,
			map: resolveMap(sample, text),
			resolution: sample?.state === 'ok' ? resolutionNote(piece.polygonKm2, sample.sample) : null,
			dams: dams[i],
			module: shown ? moduleLine(shown, original) : undefined
		};
	});
}

/** The one grid of a plan: the finest among the pieces' samples (D6). */
export function planGrid(rows: readonly PieceRow[]): SplitPlan['grid'] {
	const used = rows.flatMap((r) => (r.map.source === 'grid' && r.sample?.state === 'ok' ? [r.sample.sample] : []));
	const finest = [...used].sort((a, b) => a.cellDeg - b.cellDeg)[0];
	if (finest === undefined) return { dataset: 'none', cellDeg: 0, source: 'every MAP typed by the user' };
	return { dataset: finest.grid, cellDeg: finest.cellDeg, source: `${finest.attribution || finest.grid}, read ${finest.fetchedOn}` };
}

export interface Blocker {
	readonly number: number;
	readonly text: string;
}

/** What stops the pieces going on to calibration. Two grids in one quaternary are refused: they can differ by tens of percent. */
export function pieceBlockers(rows: readonly PieceRow[]): Blocker[] {
	const grid = planGrid(rows);
	return rows.flatMap((r): Blocker[] => {
		if (r.map.value === null) return [{ number: r.number, text: `Piece ${r.number}: ${r.map.problem}` }];
		if (r.map.source === 'grid' && r.sample?.state === 'ok' && r.sample.sample.grid !== grid.dataset) {
			return [{ number: r.number, text: `Piece ${r.number} came from ${r.sample.sample.grid}, the others from ${grid.dataset}. One grid serves every piece: type this piece’s MAP.` }];
		}
		return [];
	});
}

/** Series when any split is a tributary, otherwise side by side (subdivide.md § Routes). */
export function planLayout(splits: readonly SplitRecord[]): SplitPlan['layout'] {
	return splits.some((s) => s.kind === 'tributary') ? 'series' : 'sideBySide';
}

/** The plan the engine takes, or `null` until every piece has a MAP from one grid. */
export function buildPlan(quaternary: string, module: ModuleRef, set: PieceSet, rows: readonly PieceRow[], shares: SplitPlan['shares'], dams: readonly DamCount[] = []): SplitPlan | null {
	if (set.pieces.length < 2 || pieceBlockers(rows).length > 0) return null;
	const located = shares.dams === 'location' ? damShares(dams) : undefined;
	const pieces = set.pieces.flatMap((piece, i): PiecePlan[] => {
		const map = rows[i]?.map;
		return map === undefined || map.value === null ? [] : [{ role: piece.role, geometry: piece.geometry, polygonKm2: piece.polygonKm2, gridMapMm: map.value, mapSource: map.source, ...(located ? { locationShares: { damCapacity: located[i]! } } : {}) }];
	});
	return { quaternary, module, pieces, splits: set.splits, grid: planGrid(rows), layout: planLayout(set.splits), shares };
}
