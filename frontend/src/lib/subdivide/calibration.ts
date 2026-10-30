/**
 * Showing the D2 loop (subdivide.md § Calibration): the iteration log as a
 * table and the rule that an unconverged factor is only ever applied by an
 * explicit choice, recorded as such.
 */

import type { ApplySplitOptions, CalibrationResult, CalibrationTarget, IterationStep } from '@pitman/wrsm';
import { formatNumber } from '#lib/results/format.js';

/** D2: the natural MAR must match the target within this. */
export const TOLERANCE_PCT = 2;

const STEP_WORDS: Readonly<Record<IterationStep, string>> = {
	start: 'Start: the grid MAPs as they are',
	ratio: 'Ratio: target ÷ MAR',
	secant: 'Secant: from the last two tries',
	bisect: 'Bisection: halfway between two tries',
	clamped: 'Held at a limit'
};

export const stepWords = (step: IterationStep): string => STEP_WORDS[step];

/** `+25.46 %`, `−41.38 %`: the sign is part of the number. */
export function formatPercent(value: number, decimals = 2): string {
	const text = formatNumber(Math.abs(value), decimals);
	if (text === '—') return text;
	if (Number(text) === 0) return `${text} %`;
	return `${value < 0 ? '−' : '+'}${text} %`;
}

export const formatScale = (s: number): string => formatNumber(s, 4);
export const formatMar = (mar: number | null | undefined): string => formatNumber(mar, 3);

export interface IterationRow {
	/** The engine's `n`, from 0, as the sidecar keeps it. */
	readonly n: number;
	/** Counted from 1, so the table agrees with "converged in 4 tries". */
	readonly attempt: number;
	readonly step: string;
	readonly factor: string;
	readonly mar: string;
	readonly error: string;
	readonly maps: readonly string[];
	/** Said in words, not only shown. */
	readonly mark: '' | 'Accepted' | 'Best';
}

export function iterationRows(result: CalibrationResult): IterationRow[] {
	return result.iterations.map((it) => ({
		n: it.n,
		attempt: it.n + 1,
		step: stepWords(it.step),
		factor: formatScale(it.s),
		mar: formatMar(it.marMm3),
		error: formatPercent(it.errorPct),
		maps: it.maps.map((m) => formatNumber(m, 0)),
		mark: result.best?.n === it.n ? (result.status === 'converged' ? 'Accepted' : 'Best') : ''
	}));
}

/** What the wizard holds after a calibration, and what Apply hands the engine. */
export interface CalibrationOutcome {
	readonly result: CalibrationResult;
	readonly target: CalibrationTarget;
	readonly crossCheck: CalibrationTarget;
	/** "Use the best factor": only ever set by that button. */
	readonly acceptNotConverged: boolean;
}

/** Whether Apply is on offer: converged, or not converged with the user's explicit choice. Refused never. */
export function mayApply(outcome: CalibrationOutcome | undefined): boolean {
	if (outcome === undefined) return false;
	if (outcome.result.status === 'converged') return true;
	return outcome.result.status === 'not_converged' && outcome.acceptNotConverged && outcome.result.best !== null;
}

export function applyOptions(outcome: CalibrationOutcome): ApplySplitOptions {
	const { result: calibration, target, crossCheck, acceptNotConverged } = outcome;
	return { calibration, target, crossCheck, ...(acceptNotConverged && { acceptNotConverged: true }) };
}

/** The state of a calibration, in a sentence. */
export function outcomeSentence(outcome: CalibrationOutcome): string {
	const { result, acceptNotConverged } = outcome;
	const best = result.best;
	const tries = `${result.iterations.length} ${result.iterations.length === 1 ? 'try' : 'tries'}`;
	if (result.status === 'refused') return `No factor can be found. ${result.message ?? ''}`.trim();
	if (result.status === 'converged' && best) return `Converged in ${tries}: factor ${formatScale(best.s)}, ${formatPercent(best.errorPct)} from the target (the limit is ${TOLERANCE_PCT} %).`;
	const prefix = acceptNotConverged ? `Not converged after ${tries}. You chose the best factor, and it is recorded as not converged` : `Not converged after ${tries}`;
	const bestText = best ? `: the best factor is ${formatScale(best.s)}, ${formatPercent(best.errorPct)} from the target.` : '.';
	return `${prefix}${bestText} ${result.message ?? ''}`.trim();
}

/** Rounding the MAPs can push a tiny MAR out of tolerance; that is reported, not hidden (subdivide.md § Rounding). */
export function roundingWarning(result: CalibrationResult, target: CalibrationTarget): string | null {
	if (result.status !== 'converged' || result.finalMarMm3 === null) return null;
	const error = (100 * (result.finalMarMm3 - target.marMm3)) / target.marMm3;
	if (Math.abs(error) <= TOLERANCE_PCT) return null;
	return `Rounded to whole mm, the MAPs give ${formatMar(result.finalMarMm3)} million m³/year (${formatPercent(error)}), outside ${TOLERANCE_PCT} % of the target. The factor itself converged; the MAR is too small for whole-mm MAPs to hold it.`;
}
