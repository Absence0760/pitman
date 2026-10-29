/**
 * Method A: extending a catchment rainfall file (.RAN, % of MAP) with CHIRPS
 * (docs/theory/extend.md, steps 4–8; issue #3 "Methods the user specified" A;
 * decision D5). Pure: the backend supplies the area's monthly CHIRPS totals
 * (`ChirpsMonthly`, steps 1–3), this module fits and applies the 12 bias
 * factors, and the writer (`src/io/rainfall.ts`) writes the file.
 *
 * Notation as extend.md: `y` a hydrological year, `k = 0…11` its month
 * (0 = October), `r[y][k]` the file's value (% of the model's MAP), `c[y][k]`
 * the CHIRPS area mean (mm), `p[y][k] = 100·c/MAP_c` (% of the CHIRPS MAP).
 */

import type {
	HydroYear,
	Monthly12,
	MonthlyRow,
	RainfallExtension,
	RainfallExtensionFactor,
	RainfallSeries,
	RunMessage,
	Twelve
} from '../types.js';
import type {
	ApplyRainfallExtension,
	ChirpsMonthly,
	ExtensionFit,
	FactorCheck,
	FactorFit,
	FitOptions,
	FitRainfallExtension,
	FitStatistics
} from './contract.js';

// ---------------------------------------------------------------------------
// Constants (extend.md open questions A3–A5, defaults accepted in decisions.md)
// ---------------------------------------------------------------------------

/** Dry threshold `ε`, % of MAP per year (A3). */
export const DRY_EPSILON_PCT = 0.05;
/** Below this many overlap years no factors are computed (A4). */
export const MIN_OVERLAP_YEARS = 5;
/** Below this many overlap years the factors are computed with a warning (A4). */
export const FEW_OVERLAP_YEARS = 15;
/** Hard factor range `[0, FACTOR_MAX]`; warned outside `[FACTOR_WARN_LOW, FACTOR_WARN_HIGH]` (A5). */
export const FACTOR_MAX = 5;
export const FACTOR_WARN_LOW = 0.5;
export const FACTOR_WARN_HIGH = 2;
/** Sea / no-data weight above which the screen warns, % (extend.md § Edge cases). */
export const COAST_WARN_PCT = 10;
/** Fewer cells than this: CHIRPS can't resolve rain inside the area (§ Edge cases). */
export const FEW_CELLS = 4;
/** CHIRPS3 data DOI (docs/data.md § CHIRPS, licence and attribution). */
export const CHIRPS3_DOI = '10.15780/G2JQ0P';

/** Short month names, October first, as the sidecar records them. */
export const HYDRO_MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'] as const;
const MONTH_NAMES = [
	'October',
	'November',
	'December',
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September'
] as const;

const name = (k: number) => MONTH_NAMES[k] as string;

function twelve<T>(f: (k: number) => T): Twelve<T> {
	return Array.from({ length: 12 }, (_, k) => f(k)) as unknown as Twelve<T>;
}

// ---------------------------------------------------------------------------
// Hydrological years and rounding
// ---------------------------------------------------------------------------

/**
 * The hydrological year and month index of a calendar month (extend.md
 * § Step 3; U-19, A1): October to December of `Y` and January to September
 * of `Y + 1` are hydrological year `Y`; `k = 0` is October.
 */
export function hydroMonth(calendarYear: number, month: number): { readonly year: HydroYear; readonly k: number } {
	return month >= 10 ? { year: calendarYear, k: month - 10 } : { year: calendarYear - 1, k: month + 2 };
}

/** The calendar year and month (1 = January) of hydrological year `year`, month `k`. */
export function calendarMonth(year: HydroYear, k: number): { readonly year: number; readonly month: number } {
	return k <= 2 ? { year, month: k + 10 } : { year: year + 1, month: k - 2 };
}

/**
 * Round to `decimals` places, half away from zero (extend.md § Step 7). The
 * value is first taken to 15 significant digits so that a product like
 * `1.005` that binary can't hold exactly rounds as its decimal reads.
 */
export function roundHalfAwayFromZero(x: number, decimals = 2): number {
	if (!Number.isFinite(x)) throw new RangeError(`${x} is not a finite number`);
	const scale = 10 ** decimals;
	const scaled = Number((Math.abs(x) * scale).toPrecision(15));
	const r = Math.round(scaled) / scale;
	return x < 0 ? -r : r;
}

// ---------------------------------------------------------------------------
// CHIRPS by hydrological year
// ---------------------------------------------------------------------------

/** A month of a CHIRPS hydrological year: mm, `null` = missing, `undefined` = not in the record yet. */
type ChirpsCell = number | null | undefined;

interface ChirpsYears {
	/** Every hydrological year whose October is in the record, ascending. */
	readonly years: readonly HydroYear[];
	readonly mm: ReadonlyMap<HydroYear, readonly ChirpsCell[]>;
}

/** Check the wire (contract § `ChirpsMonthly`) and regroup it by hydrological year. */
function chirpsByHydroYear(chirps: ChirpsMonthly): ChirpsYears {
	const months = chirps.months;
	if (months.length === 0) throw new Error('The CHIRPS series is empty: there is nothing to fit the file to.');
	let previous: { year: number; month: number } | undefined;
	for (const m of months) {
		if (!Number.isInteger(m.year) || !Number.isInteger(m.month) || m.month < 1 || m.month > 12) {
			throw new Error(`The CHIRPS series has an invalid month (${m.year}-${m.month}).`);
		}
		if (m.mm !== null && (!Number.isFinite(m.mm) || m.mm < 0)) {
			throw new Error(`The CHIRPS series has an invalid total for ${m.year}-${String(m.month).padStart(2, '0')} (${m.mm} mm).`);
		}
		if (previous !== undefined) {
			const next = previous.month === 12 ? { year: previous.year + 1, month: 1 } : { year: previous.year, month: previous.month + 1 };
			if (m.year !== next.year || m.month !== next.month) {
				throw new Error(
					`The CHIRPS series skips from ${previous.year}-${String(previous.month).padStart(2, '0')} to ${m.year}-${String(m.month).padStart(2, '0')}: months must follow on without gaps.`
				);
			}
		}
		previous = m;
	}
	// A2: a hydrological year whose October predates the record (January to
	// September 1981 for CHIRPS) is not used.
	const first = months[0] as { year: number; month: number };
	const firstYear = first.month <= 10 ? first.year : first.year + 1;
	const mm = new Map<HydroYear, ChirpsCell[]>();
	for (const m of months) {
		const { year, k } = hydroMonth(m.year, m.month);
		if (year < firstYear) continue;
		let row = mm.get(year);
		if (row === undefined) {
			row = new Array<ChirpsCell>(12).fill(undefined);
			mm.set(year, row);
		}
		row[k] = m.mm;
	}
	return { years: [...mm.keys()].sort((a, b) => a - b), mm };
}

const isComplete = (row: readonly ChirpsCell[] | undefined): row is readonly number[] =>
	row !== undefined && row.every((v) => typeof v === 'number');

/** Every month of the year is in the record (present or missing), i.e. the year isn't the partial last one. */
const inRecord = (row: readonly ChirpsCell[] | undefined): boolean => row !== undefined && row.every((v) => v !== undefined);

/**
 * `MAP_c` (extend.md § Step 4): the mean annual total over every complete
 * CHIRPS hydrological year, with the first and last of those years.
 */
function chirpsMap(c: ChirpsYears): { mm: number; startYear: HydroYear; endYear: HydroYear; count: number } {
	const complete = c.years.filter((y) => isComplete(c.mm.get(y)));
	if (complete.length === 0) {
		throw new Error(
			'CHIRPS holds no complete hydrological year (October to September with every month present) over this area, so its MAP cannot be computed.'
		);
	}
	const total = complete.reduce((s, y) => s + (c.mm.get(y) as number[]).reduce((a, b) => a + b, 0), 0);
	const mm = total / complete.length;
	if (!(mm > 0)) throw new Error('CHIRPS shows no rain at all over this area, so its MAP is zero and the file cannot be scaled to it.');
	return { mm, startYear: complete[0] as number, endYear: complete[complete.length - 1] as number, count: complete.length };
}

function percentOfMap(c: ChirpsYears, mapMm: number): ExtensionFit['chirpsPct'] {
	return c.years.map((year) => ({
		year,
		months: twelve((k) => {
			const v = (c.mm.get(year) as ChirpsCell[])[k];
			return typeof v === 'number' ? (100 * v) / mapMm : null;
		})
	}));
}

// ---------------------------------------------------------------------------
// Step 5: the factors
// ---------------------------------------------------------------------------

/** One overlap year: the file's row and CHIRPS % of MAP (`null` = missing). */
export interface OverlapYear {
	readonly year: HydroYear;
	readonly file: Monthly12;
	readonly chirps: Twelve<number | null>;
}

/**
 * The 12 factors by the ratio of the overlap totals, with the dry-month rules
 * (extend.md § Step 5) but not the short-overlap rule, which `fitRainfallExtension`
 * applies on top. `f_k = Σ_{O_k} r / Σ_{O_k} p`, `O_k` the years whose `p[y][k]`
 * is present.
 */
export function estimateFactors(overlap: readonly OverlapYear[]): Twelve<FactorFit> {
	return twelve((k): FactorFit => {
		let sumR = 0;
		let sumP = 0;
		let n = 0;
		for (const y of overlap) {
			const p = y.chirps[k];
			if (p === null || p === undefined) continue;
			sumR += y.file[k] as number;
			sumP += p;
			n++;
		}
		const means = { years: n, meanFilePct: n > 0 ? sumR / n : 0, meanChirpsPct: n > 0 ? sumP / n : 0 };
		if (n === 0) {
			return {
				computed: 1,
				flag: 'noOverlapMonths',
				note: `CHIRPS is missing every ${name(k)} of the overlap, so the factor can't be estimated and is set to 1.`,
				...means
			};
		}
		const dry = DRY_EPSILON_PCT * n;
		if (sumP < dry && sumR < dry) {
			return { computed: 1, flag: 'dryBoth', note: `${name(k)} is dry in both CHIRPS and the file; the factor is 1.`, ...means };
		}
		if (sumP < dry) {
			return {
				computed: 1,
				flag: 'chirpsDry',
				note: `CHIRPS shows almost no rain in ${name(k)} over the overlap, the model's file does; the factor can't be estimated and is set to 1.`,
				...means
			};
		}
		return { computed: sumR / sumP, flag: 'computed', note: '', ...means };
	});
}

// ---------------------------------------------------------------------------
// Fit diagnostics
// ---------------------------------------------------------------------------

function r2(xs: readonly number[], ys: readonly number[]): number {
	const n = xs.length;
	if (n < 2) return Number.NaN;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; i++) {
		const dx = (xs[i] as number) - mx;
		const dy = (ys[i] as number) - my;
		sxy += dx * dy;
		sxx += dx * dx;
		syy += dy * dy;
	}
	return sxx === 0 || syy === 0 ? Number.NaN : (sxy * sxy) / (sxx * syy);
}

function nse(simulated: readonly number[], observed: readonly number[]): number {
	const n = observed.length;
	if (n === 0) return Number.NaN;
	const mean = observed.reduce((a, b) => a + b, 0) / n;
	let sse = 0;
	let sst = 0;
	for (let i = 0; i < n; i++) {
		sse += ((simulated[i] as number) - (observed[i] as number)) ** 2;
		sst += ((observed[i] as number) - mean) ** 2;
	}
	return sst === 0 ? Number.NaN : 1 - sse / sst;
}

/**
 * Fit statistics of `factors · p` against `r` over the overlap (extend.md
 * § Fit diagnostics); all-ones factors give the "before" numbers. Monthly
 * numbers pool every overlap month with CHIRPS present; annual numbers use
 * the overlap years with all 12 CHIRPS months present. A statistic that is
 * undefined (no variance, too few points) is `NaN`.
 */
export function fitStatistics(overlap: readonly OverlapYear[], factors: Monthly12): FitStatistics {
	const xs: number[] = [];
	const ys: number[] = [];
	const sumX = new Array<number>(12).fill(0);
	const sumR = new Array<number>(12).fill(0);
	const annualX: number[] = [];
	const annualR: number[] = [];
	for (const y of overlap) {
		let ax = 0;
		let ar = 0;
		let complete = true;
		for (let k = 0; k < 12; k++) {
			const p = y.chirps[k];
			if (p === null || p === undefined) {
				complete = false;
				continue;
			}
			const x = (factors[k] as number) * p;
			const r = y.file[k] as number;
			xs.push(x);
			ys.push(r);
			sumX[k] = (sumX[k] as number) + x;
			sumR[k] = (sumR[k] as number) + r;
			ax += x;
			ar += r;
		}
		if (complete) {
			annualX.push(ax);
			annualR.push(ar);
		}
	}
	const totalX = annualX.reduce((a, b) => a + b, 0);
	const totalR = annualR.reduce((a, b) => a + b, 0);
	return {
		monthlyR2: r2(xs, ys),
		monthlyNse: nse(xs, ys),
		annualR2: r2(annualX, annualR),
		monthlyBiasPct: twelve((k) => ((sumR[k] as number) === 0 ? null : (100 * ((sumX[k] as number) - (sumR[k] as number))) / (sumR[k] as number))),
		annualBiasPct: totalR === 0 ? Number.NaN : (100 * (totalX - totalR)) / totalR
	};
}

const ONES: Monthly12 = twelve(() => 1);

// ---------------------------------------------------------------------------
// Step 7: what can be appended
// ---------------------------------------------------------------------------

interface Appendable {
	readonly years: readonly HydroYear[];
	readonly stoppedAt: { readonly year: HydroYear; readonly month: number } | null;
	/** The partial last year that ended the extension, and how many of its months CHIRPS holds. */
	readonly partial: { readonly year: HydroYear; readonly months: number } | null;
}

/**
 * The years after `lastYear` that can be appended (extend.md § Step 7): each
 * year in turn while it is a complete CHIRPS year. A missing month stops the
 * extension there (`stoppedAt`, month 0 = October); so does the partial
 * last year, which is never appended.
 */
function appendableYears(c: ChirpsYears, lastYear: HydroYear): Appendable {
	const years: HydroYear[] = [];
	for (let y = lastYear + 1; ; y++) {
		const row = c.mm.get(y);
		if (row === undefined) return { years, stoppedAt: null, partial: null };
		if (isComplete(row)) {
			years.push(y);
			continue;
		}
		const missing = row.findIndex((v) => v === null);
		const firstAbsent = row.findIndex((v) => v === undefined);
		if (missing >= 0 && (firstAbsent < 0 || missing < firstAbsent)) return { years, stoppedAt: { year: y, month: missing }, partial: null };
		return { years, stoppedAt: null, partial: { year: y, months: row.filter((v) => v !== undefined).length } };
	}
}

// ---------------------------------------------------------------------------
// Fit (steps 4–5) and apply (steps 7–8)
// ---------------------------------------------------------------------------

function rowsByYear(ran: RainfallSeries): Map<HydroYear, MonthlyRow> {
	return new Map(ran.rows.map((row) => [row.year, row]));
}

function lastRow(ran: RainfallSeries): MonthlyRow {
	const last = ran.rows[ran.rows.length - 1];
	if (last === undefined) throw new Error(`The rainfall file '${ran.code}' has no rows to extend.`);
	return last;
}

/** A recorded `MAP_c` (sidecar `chirpsMap`) to use instead of recomputing it. */
interface RecordedMap {
	readonly mm: number;
	readonly years: readonly [HydroYear, HydroYear];
}

function fitWithMap(ran: RainfallSeries, chirps: ChirpsMonthly, options: FitOptions, recorded?: RecordedMap): ExtensionFit {
	const last = lastRow(ran);
	const first = ran.rows[0] as MonthlyRow;
	const c = chirpsByHydroYear(chirps);
	const map = recorded === undefined ? chirpsMap(c) : { mm: recorded.mm, startYear: recorded.years[0], endYear: recorded.years[1] };
	const mapMm = map.mm;
	if (!(Number.isFinite(mapMm) && mapMm > 0)) throw new Error(`The recorded CHIRPS MAP (${mapMm} mm) is not a positive number.`);
	const chirpsPct = percentOfMap(c, mapMm);
	const pct = new Map(chirpsPct.map((row) => [row.year, row.months]));
	const messages: RunMessage[] = [];

	// The overlap (D5): file years that CHIRPS's record covers in full (missing
	// months allowed: they drop out of O_k for that month only).
	const chirpsFirst = c.years[0] as number;
	const recordYears = c.years.filter((y) => inRecord(c.mm.get(y)));
	const chirpsLast = recordYears.length > 0 ? (recordYears[recordYears.length - 1] as number) : chirpsFirst - 1;
	let startYear = Math.max(first.year, chirpsFirst);
	let endYear = Math.min(last.year, chirpsLast);
	if (startYear > endYear) {
		throw new Error(
			last.year < chirpsFirst
				? `The file '${ran.code}' ends in ${last.year}/${String((last.year + 1) % 100).padStart(2, '0')}, before CHIRPS begins (${chirpsFirst}/${String((chirpsFirst + 1) % 100).padStart(2, '0')}): there is no overlap to calibrate CHIRPS to the file.`
				: `The file '${ran.code}' and CHIRPS share no complete hydrological year, so there is no overlap to calibrate CHIRPS to the file.`
		);
	}
	let window: 'default' | 'user' = 'default';
	if (options.overlap !== undefined) {
		const w = options.overlap;
		if (!Number.isInteger(w.startYear) || !Number.isInteger(w.endYear) || w.startYear > w.endYear) {
			throw new Error(`The overlap window ${w.startYear}–${w.endYear} is not a range of hydrological years.`);
		}
		const s = Math.max(startYear, w.startYear);
		const e = Math.min(endYear, w.endYear);
		if (s > e) {
			throw new Error(`The overlap window ${w.startYear}–${w.endYear} lies outside the overlap of the file and CHIRPS (${startYear}–${endYear}).`);
		}
		if (s !== w.startYear || e !== w.endYear) {
			messages.push({ level: 'info', text: `The overlap window was narrowed to ${s}–${e}, the years the file and CHIRPS share.` });
		}
		window = 'user';
		startYear = s;
		endYear = e;
	}
	const rows = rowsByYear(ran);
	const overlap: OverlapYear[] = [];
	for (let y = startYear; y <= endYear; y++) {
		overlap.push({ year: y, file: (rows.get(y) as MonthlyRow).months, chirps: pct.get(y) as Twelve<number | null> });
	}

	// Factors, then the short-overlap rule on top (A4).
	let factors = estimateFactors(overlap);
	const years = overlap.length;
	if (years < MIN_OVERLAP_YEARS) {
		const note = `The overlap is only ${years} year${years === 1 ? '' : 's'}: too few to estimate the factors. Enter them, or widen the overlap window, then fit again.`;
		factors = twelve((k) => ({ ...(factors[k] as FactorFit), computed: 1, flag: 'shortOverlap' as const, note }));
		messages.push({ level: 'warning', text: note });
	} else {
		if (years < FEW_OVERLAP_YEARS) {
			messages.push({ level: 'warning', text: `The factors rest on only ${years} overlap years (${startYear}–${endYear}); treat them with care.` });
		}
		factors.forEach((f, k) => {
			if (f.flag === 'chirpsDry' || f.flag === 'noOverlapMonths') messages.push({ level: 'warning', text: f.note, at: { year: startYear, month: k } });
			else if (f.flag === 'dryBoth') messages.push({ level: 'info', text: f.note });
			else if (checkFactor(f.computed) === 'refused') {
				messages.push({
					level: 'warning',
					at: { year: startYear, month: k },
					text: `The computed ${name(k)} factor (${f.computed.toFixed(2)}) is above ${FACTOR_MAX}, the most the engine accepts: check the area and the fit, then edit it or narrow the overlap window, then fit again.`
				});
			} else if (checkFactor(f.computed) === 'warn') {
				messages.push({ level: 'warning', at: { year: startYear, month: k }, text: `The computed ${name(k)} factor (${f.computed.toFixed(2)}) is far from 1: check the fit.` });
			}
		});
	}
	const missingInOverlap = overlap.flatMap((y) =>
		y.chirps.flatMap((v, k) => (v === null ? [`${HYDRO_MONTHS[k]} ${calendarMonth(y.year, k).year}`] : []))
	);
	if (missingInOverlap.length > 0) {
		messages.push({
			level: 'warning',
			text: `CHIRPS is missing ${missingInOverlap.length} month${missingInOverlap.length === 1 ? '' : 's'} inside the overlap (${missingInOverlap.join(', ')}); each drops out of that month's factor only.`
		});
	}

	// The area (§ Edge cases).
	if (chirps.weightRemovedPct > COAST_WARN_PCT) {
		messages.push({
			level: 'warning',
			text: `${chirps.weightRemovedPct.toFixed(1)} % of the area's weight lies on sea or no-data CHIRPS cells and was left out of the mean.`
		});
	}
	if (chirps.cells < FEW_CELLS) {
		messages.push({
			level: 'info',
			text: `The area touches only ${chirps.cells} CHIRPS cell${chirps.cells === 1 ? '' : 's'}: CHIRPS can't resolve rain inside it.`
		});
	}

	// What would be appended (step 7).
	const add = appendableYears(c, last.year);
	const appendable = add.years.length > 0 ? { firstYear: add.years[0] as number, lastYear: add.years[add.years.length - 1] as number } : null;
	if (add.stoppedAt !== null) {
		const at = calendarMonth(add.stoppedAt.year, add.stoppedAt.month);
		messages.push({
			level: 'warning',
			at: add.stoppedAt,
			text: `CHIRPS is missing ${name(add.stoppedAt.month)} ${at.year}, so the extension stops before ${add.stoppedAt.year}/${String((add.stoppedAt.year + 1) % 100).padStart(2, '0')}; later years can't be appended because a .RAN file can't hold a gap.`
		});
	}
	if (add.partial !== null) {
		messages.push({
			level: 'info',
			text: `CHIRPS holds ${add.partial.months} month${add.partial.months === 1 ? '' : 's'} of ${add.partial.year}/${String((add.partial.year + 1) % 100).padStart(2, '0')}; a partial hydrological year is never appended.`
		});
	}
	if (appendable === null && add.stoppedAt === null) {
		messages.push({ level: 'info', text: `The file already reaches the last complete CHIRPS hydrological year: there is nothing to append.` });
	}

	const computed = twelve((k) => (factors[k] as FactorFit).computed);
	return {
		chirpsMapMm: mapMm,
		chirpsMapYears: { startYear: map.startYear, endYear: map.endYear },
		chirpsPct,
		overlap: { startYear, endYear, window },
		factors,
		before: fitStatistics(overlap, ONES),
		after: fitStatistics(overlap, computed),
		appendable,
		stoppedAt: add.stoppedAt,
		messages
	};
}

/** Fit CHIRPS to a `.RAN` series (extend.md steps 4–5); see `FitRainfallExtension`. */
export const fitRainfallExtension: FitRainfallExtension = (ran, chirps, options = {}) => fitWithMap(ran, chirps, options);

/** The overlap years of a fit, for `fitStatistics` with edited factors (the screen's "after"). */
export function overlapYears(ran: RainfallSeries, fit: ExtensionFit): OverlapYear[] {
	const rows = rowsByYear(ran);
	const pct = new Map(fit.chirpsPct.map((row) => [row.year, row.months]));
	const out: OverlapYear[] = [];
	for (let y = fit.overlap.startYear; y <= fit.overlap.endYear; y++) {
		const row = rows.get(y);
		const p = pct.get(y);
		if (row === undefined || p === undefined) throw new Error(`The fit's overlap year ${y} is not in the file or the CHIRPS series: fit again.`);
		out.push({ year: y, file: row.months, chirps: p });
	}
	return out;
}

/**
 * How the engine treats a factor (extend.md § Step 6, A5): refused when not
 * finite, negative or above 5; `confirmZero` at 0; `warn` below 0.5 or above
 * 2; `ok` otherwise.
 */
export function checkFactor(f: number): FactorCheck {
	if (!Number.isFinite(f) || f < 0 || f > FACTOR_MAX) return 'refused';
	if (f === 0) return 'confirmZero';
	if (f < FACTOR_WARN_LOW || f > FACTOR_WARN_HIGH) return 'warn';
	return 'ok';
}

const COPY_NAMES: Readonly<Record<ChirpsMonthly['source'], string>> = {
	s3: 'IC-WBT rain data copy',
	local: 'local synthetic copy'
};

/**
 * Append the CHIRPS-derived years (extend.md § Step 7) and build the sidecar
 * entry (§ Step 8). `p` is taken with the fit's `chirpsMapMm`, so a fit from
 * `refitFromSidecar` re-applies saved factors against the recorded `MAP_c`.
 */
export const applyRainfallExtension: ApplyRainfallExtension = (ran, chirps, fit, factors, provenance) => {
	if (factors.length !== 12) throw new Error(`Expected 12 factors, one per month, but got ${factors.length}.`);
	factors.forEach((f, k) => {
		if (checkFactor(f) === 'refused') {
			throw new Error(`The ${name(k)} factor (${f}) is refused: a factor must be a number from 0 to ${FACTOR_MAX}.`);
		}
	});
	const last = lastRow(ran);
	const c = chirpsByHydroYear(chirps);
	const add = appendableYears(c, last.year);
	const expectedFirst = fit.appendable?.firstYear ?? null;
	const firstYear = add.years[0] ?? null;
	if (expectedFirst !== firstYear || (fit.appendable?.lastYear ?? null) !== (add.years[add.years.length - 1] ?? null)) {
		throw new Error('The fit was made for a different file or CHIRPS series: fit again before applying.');
	}
	if (add.years.length === 0) {
		throw new Error(`The file '${ran.code}' already reaches the last complete CHIRPS hydrological year: there is nothing to append.`);
	}
	const mapMm = fit.chirpsMapMm;
	const appended: MonthlyRow[] = add.years.map((year) => {
		const mm = c.mm.get(year) as number[];
		return { year, months: twelve((k) => roundHalfAwayFromZero((factors[k] as number) * ((100 * (mm[k] as number)) / mapMm), 2)) };
	});
	const series: RainfallSeries =
		ran.source === undefined ? { code: ran.code, rows: [...ran.rows, ...appended] } : { code: ran.code, rows: [...ran.rows, ...appended], source: ran.source };
	const factorEntries = twelve((k): RainfallExtensionFactor => {
		const fitK = fit.factors[k] as FactorFit;
		const used = factors[k] as number;
		const edited = used !== fitK.computed;
		const entry = { month: HYDRO_MONTHS[k] as string, computed: fitK.computed, used, note: edited ? (provenance.factorNotes?.[k] ?? '') : fitK.note };
		return edited ? { ...entry, edited: true } : entry;
	});
	const extension: RainfallExtension = {
		method: 'extend-1',
		file: provenance.file.toUpperCase(),
		area: {
			quaternaries: [...provenance.quaternaries],
			areaKm2: chirps.areaKm2,
			cells: chirps.cells,
			weightRemovedPct: chirps.weightRemovedPct
		},
		chirps: {
			product: chirps.product,
			copy: COPY_NAMES[chirps.source],
			manifestRevision: chirps.revision,
			finalThrough: chirps.finalThrough,
			doi: CHIRPS3_DOI,
			accessed: provenance.accessed
		},
		chirpsMap: { mm: mapMm, years: [fit.chirpsMapYears.startYear, fit.chirpsMapYears.endYear] },
		overlap: { from: fit.overlap.startYear, to: fit.overlap.endYear, window: fit.overlap.window },
		factors: factorEntries,
		appended: { from: add.years[0] as number, to: add.years[add.years.length - 1] as number, rows: add.years.length },
		originalEndYear: last.year,
		stoppedAt: add.stoppedAt
	};
	return { series, extension };
};

// ---------------------------------------------------------------------------
// Re-extending a file that carries a sidecar entry
// ---------------------------------------------------------------------------

/**
 * The file as it was before `extension` appended to it: the rows up to
 * `originalEndYear`, the source text kept, so the original rows still write
 * back byte for byte.
 */
export function stripExtension(series: RainfallSeries, extension: RainfallExtension): RainfallSeries {
	const rows = series.rows.filter((row) => row.year <= extension.originalEndYear);
	if (rows.length === 0) throw new Error(`The file '${series.code}' has no rows up to ${extension.originalEndYear}, the end recorded before its extension.`);
	return series.source === undefined ? { code: series.code, rows } : { code: series.code, rows, source: series.source };
}

/**
 * Re-extend a file from its sidecar entry, e.g. after CHIRPS gains months
 * (extend.md § Step 4): strips the appended rows, refits on the recorded
 * overlap with the **recorded** `MAP_c`, and returns the factors used last
 * time, so `applyRainfallExtension(ran, chirps, fit, factors, …)` gives the
 * same values for the years appended before (unless the copy revised them)
 * and continues past them.
 */
export function refitFromSidecar(
	series: RainfallSeries,
	chirps: ChirpsMonthly,
	extension: RainfallExtension
): { readonly ran: RainfallSeries; readonly fit: ExtensionFit; readonly factors: Monthly12 } {
	const ran = stripExtension(series, extension);
	const options: FitOptions = extension.overlap.window === 'user' ? { overlap: { startYear: extension.overlap.from, endYear: extension.overlap.to } } : {};
	const fit = fitWithMap(ran, chirps, options, extension.chirpsMap);
	return { ran, fit, factors: twelve((k) => (extension.factors[k] as RainfallExtensionFactor).used) };
}
