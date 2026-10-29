// Monthly CHIRPS totals per cell, and their area mean (docs/theory/extend.md §§ Steps 2–3; docs/data.md
// § CHIRPS, "A polygon's monthly series"). Pitman's own, written on the block reads copied from IC-WBT
// (mirror/arrays.ts readFinalsBlock) in place of IC-WBT's readCells, whose day codes Pitman doesn't need.
//
// The finals layout holds 366 day-of-year slots a year and slot 365 is NaN in a non-leap year, so days
// are summed into months **by calendar date** (February 28 or 29 days), never by slot: a non-leap year's
// slot 365 is not a missing day. A cell-month is valid only when every one of its days holds a value and
// is final (on or before the manifest's `finalThrough`); otherwise it is NaN, never zero.
import { FeedUnavailableError } from './errors.js';
import { type FinalsArray, FINALS_CHUNK, readFinalsBlock } from './mirror/arrays.js';
import { daysInMonth, toEpochDay } from './mirror/calendar.js';
import { cellsByChunk, type MirrorCell } from './mirror/grid.js';

/** Chunk reads in flight at once (each ~0.6 MB uncompressed). */
export const READ_CONCURRENCY = 6;

/** The read ran out of time: a 504, and the next request starts again (nothing partial is cached). */
export class ReadDeadlineError extends FeedUnavailableError {
	constructor() {
		super('reading the rain data copy took too long; try again, or extend the file over a smaller area');
	}
}

export interface ReadMonthlyOptions {
	/** The copy's last final day (`YYYY-MM-DD`): a month with any day after it is NaN. */
	finalThrough: string;
	/** Reads in flight at once. */
	concurrency?: number;
	/** Wall-clock time (ms since epoch, `now()`'s clock) after which no new read starts. */
	deadline?: number;
	now?: () => number;
}

/** Day-of-year index of the first of each month, January first. */
const monthStarts = (year: number): number[] => {
	const jan1 = toEpochDay(`${year}-01-01`);
	return Array.from({ length: 12 }, (_, m) => toEpochDay(`${year}-${String(m + 1).padStart(2, '0')}-01`) - jan1);
};

/** Run `tasks` with at most `limit` at once, stopping new ones once `stop()` says so. */
async function pool(tasks: (() => Promise<void>)[], limit: number, stop: () => boolean): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			if (stop()) throw new ReadDeadlineError();
			await tasks[next++]!();
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

/**
 * Each cell's monthly totals (mm) from January `fromYear` to December `toYear`, month index
 * `(year − fromYear) × 12 + (month − 1)`, NaN where a month is not valid. Cells are grouped by chunk and
 * each group's block read once a year (one GET per chunk per year).
 */
export async function readMonthly(f: FinalsArray, cells: readonly MirrorCell[], fromYear: number, toYear: number, opts: ReadMonthlyOptions): Promise<Float64Array[]> {
	if (!(Number.isInteger(fromYear) && Number.isInteger(toYear) && fromYear <= toYear)) throw new RangeError('fromYear ≤ toYear, whole years');
	const months = (toYear - fromYear + 1) * 12;
	const out = cells.map(() => new Float64Array(months).fill(Number.NaN));
	const finalDay = toEpochDay(opts.finalThrough);
	const groups = cellsByChunk(cells, FINALS_CHUNK[2], FINALS_CHUNK[3]);
	const now = opts.now ?? Date.now;
	const tasks: (() => Promise<void>)[] = [];
	for (let year = fromYear; year <= toYear; year++) {
		const starts = monthStarts(year);
		const jan1 = toEpochDay(`${year}-01-01`);
		// Months whose last day is final; the rest stay NaN without a read.
		const finalMonths = starts.filter((s, m) => jan1 + s + daysInMonth(year, m + 1) - 1 <= finalDay).length;
		if (finalMonths === 0) continue;
		for (const g of groups) {
			tasks.push(async () => {
				const block = { y0: g.y0, x0: g.x0, h: g.y1 - g.y0 + 1, w: g.x1 - g.x0 + 1 };
				const lastDoy = starts[finalMonths - 1]! + daysInMonth(year, finalMonths) - 1;
				const { values } = await readFinalsBlock(f, year, 0, lastDoy, block);
				const plane = block.h * block.w;
				for (const i of g.cells) {
					const c = cells[i]!;
					const at = (c.y - block.y0) * block.w + (c.x - block.x0);
					const row = out[i]!;
					for (let m = 0; m < finalMonths; m++) {
						let sum = 0;
						const d0 = starts[m]!;
						const d1 = d0 + daysInMonth(year, m + 1);
						for (let d = d0; d < d1; d++) sum += values[d * plane + at]!;
						// NaN propagates: one missing day makes the month invalid.
						row[(year - fromYear) * 12 + m] = sum;
					}
				}
			});
		}
	}
	await pool(tasks, opts.concurrency ?? READ_CONCURRENCY, () => opts.deadline !== undefined && now() > opts.deadline);
	return out;
}

/** Below this share of the (land) weight with a valid value, a month is missing (extend.md § Step 3, A3). */
export const MONTH_COVERAGE = 0.9;

export interface AreaMonthly {
	/** Area mean per month index, `null` when valid cells carry less than MONTH_COVERAGE of the kept weight. */
	mm: (number | null)[];
	/** Indices (into the input) of the cells kept: those with at least one valid month. */
	kept: number[];
	/** Share of the input weight in cells removed as NaN throughout (sea, no data), %. */
	weightRemovedPct: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The weighted area mean per month (extend.md § Step 3). Cells NaN in every month are sea or no-data
 * cells: removed before any month is computed, their weight reported. The 90 % rule is taken over the
 * weight of the cells kept, so a coastal area keeps its months (R4-D1).
 */
export function areaMonthly(weights: readonly number[], totals: readonly Float64Array[]): AreaMonthly {
	if (weights.length !== totals.length) throw new RangeError('one weight per cell');
	const months = totals[0]?.length ?? 0;
	const all = weights.reduce((s, w) => s + w, 0);
	const kept: number[] = [];
	totals.forEach((t, i) => {
		if (t.some((v) => !Number.isNaN(v))) kept.push(i);
	});
	const keptWeight = kept.reduce((s, i) => s + weights[i]!, 0);
	const mm: (number | null)[] = [];
	for (let k = 0; k < months; k++) {
		let w = 0;
		let sum = 0;
		for (const i of kept) {
			const v = totals[i]![k]!;
			if (Number.isNaN(v)) continue;
			w += weights[i]!;
			sum += weights[i]! * v;
		}
		mm.push(keptWeight > 0 && w >= MONTH_COVERAGE * keptWeight * (1 - 1e-12) ? round3(sum / w) : null);
	}
	return { mm, kept, weightRemovedPct: all > 0 ? round3((100 * (all - keptWeight)) / all) : 0 };
}
