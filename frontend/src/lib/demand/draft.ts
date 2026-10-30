/**
 * What the demand form holds and what it may become. The form keeps text, so a
 * half-typed value stays as typed; `checkDraft` reads it into a `DemandSpec` or
 * says, in a sentence per field, why it can't yet. The engine's own guard
 * (`demandSpecProblems`) sits behind this; a user reads these sentences first.
 *
 * The form asks for a base year and its volume, then later years. `DemandSpec`
 * has no base-year field: the base year is the growth table's first row, so
 * `growth` holds every year the user gave and a flat demand is one row (R7-X2).
 *
 * Each value carries where it came from (`Sourced`), so an untouched value keeps
 * its recorded source and a changed one becomes hand-typed with today's date.
 */

import { DEMAND_SHARE_TOLERANCE, type DemandSeries, type DemandSources, type DemandSpec, type Monthly12, type Network, type ValueSource } from '@pitman/wrsm';
import { parseNumber } from '#lib/calibrate/validate.js';
import { MONTH_NAMES } from '#lib/extend/factors.js';

/** The year every demand is brought up to (issue #3, goal 4; the run's default present day, D1). */
export const OFFERED_YEAR = 2025;
/** Years the form accepts: a file row is `I4`, and an anchor past this is a typing slip. */
const YEAR_RANGE = { min: 1800, max: 2100 };

/** The text in a box, what it started as, and that start's source. */
export interface Sourced {
	readonly text: string;
	readonly note: string;
	readonly start: string;
	readonly origin?: ValueSource;
}

export interface GrowthDraft extends Sourced {
	/** Stable across edits, so a row keeps its focus while its year changes. */
	readonly id: number;
	readonly year: string;
}

export interface DemandDraft {
	readonly baseYear: string;
	readonly annual: Sourced;
	/** 12 boxes, October first. */
	readonly shares: readonly string[];
	readonly sharesStart: readonly string[];
	readonly sharesNote: string;
	readonly sharesOrigin?: ValueSource;
	readonly growth: readonly GrowthDraft[];
}

const sourced = (text: string, origin?: ValueSource): Sourced => ({ text, start: text, note: origin?.note ?? '', ...(origin !== undefined && { origin }) });

let nextId = 1;
const growthRow = (year: string, text: string, origin?: ValueSource): GrowthDraft => ({ ...sourced(text, origin), id: nextId++, year });

/** A row for the offered year, blank until it has a volume, unless the years given already reach it. */
function offerYear(rows: readonly GrowthDraft[], baseYear: number): readonly GrowthDraft[] {
	if (baseYear >= OFFERED_YEAR || rows.some((r) => r.year === String(OFFERED_YEAR))) return rows;
	return [...rows, growthRow(String(OFFERED_YEAR), '')];
}

/** Even shares, to four decimals: what the boxes show is what the sidecar keeps. */
export function evenShares(): readonly string[] {
	return Array<string>(12).fill((100 / 12).toFixed(4));
}

/** The form for a new demand: a flat base at the run's first year, with the offered year open. */
export function newDraft(network: Pick<Network, 'startYear'>): DemandDraft {
	const shares = evenShares();
	return { baseYear: String(network.startYear), annual: sourced(''), shares, sharesStart: shares, sharesNote: '', growth: offerYear([], network.startYear) };
}

/** The form for a saved spec, each value with the source the sidecar gives it. */
export function draftFromSpec(spec: DemandSpec, sources: Partial<DemandSources>, network: Pick<Network, 'startYear'>): DemandDraft {
	const [base, ...later] = spec.growth;
	const shares = spec.monthlyDistributionPercent.map(String);
	const baseYear = base?.year ?? network.startYear;
	return {
		baseYear: String(baseYear),
		annual: sourced(String(base?.value ?? spec.annualVolumeMm3), sources.annualVolume),
		shares,
		sharesStart: shares,
		sharesNote: sources.monthlyDistribution?.note ?? '',
		...(sources.monthlyDistribution !== undefined && { sharesOrigin: sources.monthlyDistribution }),
		growth: offerYear(
			later.map((g) => growthRow(String(g.year), String(g.value), sources.growth?.[g.year])),
			baseYear
		)
	};
}

const twoDecimals = (v: number) => (Math.round(v * 100) / 100).toString();

/**
 * A starting point for replacing a file with no spec: its first and last year's
 * totals and its mean monthly shares. These are estimates and say so; the file's
 * real inputs can't be read back from its monthly rows.
 */
export function draftFromFile(series: DemandSeries): DemandDraft {
	const name = series.fileName.trim();
	const origin: ValueSource = { kind: 'networkFile', note: `estimated from the rows of ${name}, not its original inputs` };
	const totals = series.rows.map((row) => row.months.reduce((a, b) => a + b, 0));
	const sum = totals.reduce((a, b) => a + b, 0);
	const first = series.rows[0];
	const last = series.rows[series.rows.length - 1];
	if (first === undefined || last === undefined) throw new Error(`${name}: no rows`);
	const shares =
		sum === 0
			? evenShares()
			: (scaledShares(MONTH_NAMES.map((_, k) => String(series.rows.reduce((a, row) => a + (row.months[k] ?? 0), 0)))) ?? evenShares());
	const lastTotal = totals[totals.length - 1] ?? 0;
	const later = last.year > first.year && twoDecimals(lastTotal) !== twoDecimals(totals[0] ?? 0) ? [growthRow(String(last.year), twoDecimals(lastTotal), origin)] : [];
	return {
		baseYear: String(first.year),
		annual: sourced(twoDecimals(totals[0] ?? 0), origin),
		shares,
		sharesStart: shares,
		sharesNote: origin.note ?? '',
		sharesOrigin: origin,
		growth: offerYear(later, first.year)
	};
}

/** The shares scaled to sum to 100, four decimals; `null` when they can't be (a box isn't a number, or they sum to nothing). */
export function scaledShares(shares: readonly string[]): readonly string[] | null {
	const values = shares.map(parseNumber);
	if (values.some((v) => v === null || v < 0)) return null;
	const sum = values.reduce<number>((a, b) => a + (b ?? 0), 0);
	if (sum <= 0) return null;
	return values.map((v) => (((v ?? 0) * 100) / sum).toFixed(4));
}

/** A new row for the form. */
export function addGrowthRow(draft: DemandDraft, year = ''): DemandDraft {
	return { ...draft, growth: [...draft.growth, growthRow(year, '')] };
}

export interface DraftCheck {
	/** Set when every field reads. */
	readonly spec: DemandSpec | null;
	/** By field: `baseYear`, `annual`, `shares`, `share-<k>`, `year-<id>`, `volume-<id>`. */
	readonly messages: Readonly<Record<string, string>>;
	/** The boxes' sum while they all read as numbers. */
	readonly sum: number | null;
	/** Growth rows with a year and no volume: left out until filled. */
	readonly blankRows: readonly number[];
}

function yearProblem(text: string): string | null {
	const n = parseNumber(text);
	if (n === null) return 'Enter a year, such as 2025.';
	if (!Number.isInteger(n)) return 'Enter a whole year, such as 2025.';
	if (n < YEAR_RANGE.min || n > YEAR_RANGE.max) return `Enter a year from ${YEAR_RANGE.min} to ${YEAR_RANGE.max}.`;
	return null;
}

function volumeProblem(n: number | null): string | null {
	if (n === null) return 'Enter a number, in million m³ a year.';
	return n < 0 ? 'A volume can’t be negative.' : null;
}

/** The sum as the form says it. */
export function sumLabel(sum: number | null): string {
	if (sum === null) return 'Sum: fix the boxes above';
	const gap = 100 - sum;
	if (Math.abs(gap) < DEMAND_SHARE_TOLERANCE) return 'Sum: 100.00 %';
	return `Sum: ${sum.toFixed(2)} %, ${Math.abs(gap).toFixed(2)} ${gap > 0 ? 'short of' : 'over'} 100`;
}

/** Read the form. Nothing is judged until there is something to judge: a blank volume asks for one. */
export function checkDraft(draft: DemandDraft): DraftCheck {
	const messages: Record<string, string> = {};
	const fail = (field: string, text: string | null) => {
		if (text !== null) messages[field] = text;
	};

	fail('baseYear', yearProblem(draft.baseYear));
	const baseYear = parseNumber(draft.baseYear);
	const annual = parseNumber(draft.annual.text);
	fail('annual', volumeProblem(annual));

	const shares = draft.shares.map(parseNumber);
	shares.forEach((v, k) => {
		if (v === null) fail(`share-${k}`, `Enter ${MONTH_NAMES[k]}’s share as a number; use 0 for none.`);
		else if (v < 0) fail(`share-${k}`, `${MONTH_NAMES[k]}’s share can’t be negative.`);
	});
	const sum = shares.every((v) => v !== null) ? shares.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
	if (sum !== null && Math.abs(sum - 100) >= DEMAND_SHARE_TOLERANCE) fail('shares', `The 12 shares must add up to 100 %. ${sumLabel(sum).replace('Sum: ', 'They come to ')}.`);

	const seen = new Set<string>([draft.baseYear.trim()]);
	const blankRows: number[] = [];
	const table: { year: number; value: number }[] = [];
	for (const row of draft.growth) {
		const yearText = row.year.trim();
		const volumeText = row.text.trim();
		if (yearText === '' && volumeText === '') continue;
		if (volumeText === '') {
			blankRows.push(row.id);
			continue;
		}
		const yearIssue = yearProblem(yearText);
		const year = parseNumber(yearText);
		if (yearIssue !== null) fail(`year-${row.id}`, yearIssue);
		else if (seen.has(yearText)) fail(`year-${row.id}`, `${yearText} is listed twice.`);
		else if (baseYear !== null && year !== null && year < baseYear) fail(`year-${row.id}`, `The growth years come after the base year (${baseYear}). Start from an earlier base year instead.`);
		seen.add(yearText);
		const value = parseNumber(volumeText);
		fail(`volume-${row.id}`, volumeProblem(value));
		if (year !== null && value !== null) table.push({ year, value });
	}

	if (annual !== null && annual === 0 && table.every((g) => g.value === 0) && Object.keys(messages).length === 0) {
		fail('annual', 'The demand is zero in every year. Enter a volume.');
	}
	const valid = Object.keys(messages).length === 0 && annual !== null && baseYear !== null;
	const spec: DemandSpec | null = valid
		? {
				annualVolumeMm3: annual,
				monthlyDistributionPercent: shares as unknown as Monthly12,
				growth: [{ year: baseYear, value: annual }, ...table].sort((a, b) => a.year - b.year)
			}
		: null;
	return { spec, messages, sum, blankRows };
}

function valueSource(value: Sourced, date: string): ValueSource {
	const note = value.note.trim();
	if (value.origin !== undefined && value.text.trim() === value.start.trim() && note === (value.origin.note ?? '').trim()) return value.origin;
	return { kind: 'manual', date, ...(note !== '' && { note }) };
}

/** What each value's source is as the form stands, stamped `date` where it is the user's. */
export function draftSources(draft: DemandDraft, date: string): DemandSources {
	const annualVolume = valueSource(draft.annual, date);
	const shares: Sourced = {
		text: draft.shares.join(' '),
		start: draft.sharesStart.join(' '),
		note: draft.sharesNote,
		...(draft.sharesOrigin !== undefined && { origin: draft.sharesOrigin })
	};
	const growth: Record<number, ValueSource> = {};
	const base = parseNumber(draft.baseYear);
	if (base !== null) growth[base] = annualVolume;
	for (const row of draft.growth) {
		const year = parseNumber(row.year);
		if (year !== null) growth[year] = valueSource(row, date);
	}
	return { annualVolume, monthlyDistribution: valueSource(shares, date), growth };
}
