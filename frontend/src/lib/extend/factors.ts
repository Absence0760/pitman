/**
 * The 12 editable bias factors (extend.md § Step 6): what the user typed,
 * what the engine thinks of it (`checkFactor`), the value in use, and what
 * stops an apply. The engine computes every factor; this module only keeps
 * the edits and turns the engine's verdicts into words.
 */

import type { ExtensionFit, FactorCheck, FactorFit, FactorFlag, Monthly12 } from '@pitman/wrsm';
import type { CheckFactor } from './engine.js';

/** Month names in hydrological-year order (index 0 = October), for sentences. */
export const MONTH_NAMES = ['October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'] as const;

/** Decimals a factor is shown and typed with (the worked example's precision). */
export const FACTOR_DECIMALS = 4;
/** A typed value within half a displayed digit of the computed one is the computed one. */
const SAME_AS_COMPUTED = 0.5 * 10 ** -FACTOR_DECIMALS;

/** One month's edit. */
export interface FactorEdit {
	/** The input's text. */
	readonly text: string;
	/** The user changed the input since the last reset. */
	readonly typed: boolean;
	/** The user confirmed a factor of 0 ("no rain in every appended …"). */
	readonly confirmedZero: boolean;
	/** The user's note on why they changed it (goes into the sidecar). */
	readonly note: string;
}

export function formatFactor(value: number): string {
	return value.toFixed(FACTOR_DECIMALS);
}

/** An untouched edit showing the computed value. */
export function resetEdit(fit: FactorFit): FactorEdit {
	return { text: formatFactor(fit.computed), typed: false, confirmedZero: false, note: '' };
}

export function initialEdits(fit: ExtensionFit): FactorEdit[] {
	return fit.factors.map(resetEdit);
}

/**
 * Edits that start from saved factors (re-extending, R4-E2): a month whose
 * saved factor differs from the computed one starts as typed, with its note.
 */
export function editsFromSaved(fit: ExtensionFit, used: readonly number[], notes: readonly string[] = []): FactorEdit[] {
	return fit.factors.map((f, k) => {
		const value = used[k];
		if (value === undefined || value === f.computed) return resetEdit(f);
		return { text: formatFactor(value), typed: true, confirmedZero: value === 0, note: notes[k] ?? '' };
	});
}

/**
 * A typed factor as a number: a decimal point or a decimal comma (as South
 * African locales write it), optional spaces; `NaN` for anything else.
 */
export function parseFactor(text: string): number {
	const t = text.trim().replace(/\s+/g, '');
	if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return Number.NaN;
	return Number(t.replace(',', '.'));
}

export interface FactorRow {
	readonly index: number;
	readonly month: string;
	readonly fit: FactorFit;
	readonly edit: FactorEdit;
	/** The value the apply uses, or `null` while what was typed can't be used. */
	readonly inUse: number | null;
	/** The engine's verdict on the value in use (on the typed text when it is refused). */
	readonly check: FactorCheck;
	/** In use and different from the computed value. */
	readonly edited: boolean;
	/** What the screen says next to the input ('' when nothing). */
	readonly message: string;
	/** The apply is blocked by this month until the user acts. */
	readonly blocking: boolean;
}

/** Why a computed factor is what it is, when the engine says nothing itself. */
export function flagLabel(flag: FactorFlag): string {
	switch (flag) {
		case 'computed':
			return 'Computed from the overlap';
		case 'dryBoth':
			return 'Dry in both: set to 1';
		case 'chirpsDry':
			return 'CHIRPS dry, the file is not: set to 1';
		case 'noOverlapMonths':
			return 'No CHIRPS value in the overlap: set to 1';
		case 'shortOverlap':
			return 'Overlap under 5 years: enter a value';
	}
}

/** One row per month: the edit, the engine's check and what to say. */
export function factorRows(fit: ExtensionFit, edits: readonly FactorEdit[], check: CheckFactor): FactorRow[] {
	return fit.factors.map((f, index) => {
		const edit = edits[index] ?? resetEdit(f);
		const month = MONTH_NAMES[index] as string;
		const typedValue = edit.typed ? parseFactor(edit.text) : f.computed;
		const value = edit.typed && Math.abs(typedValue - f.computed) < SAME_AS_COMPUTED ? f.computed : typedValue;
		const verdict = check(value);
		const usable = verdict !== 'refused';
		const inUse = usable ? value : null;
		let message = '';
		let blocking = false;
		if (!usable) {
			// R4-E1: a computed factor above the limit is never capped; the user edits it or narrows the overlap.
			if (!edit.typed) message = 'The computed factor is above 5, which the engine won’t accept: type a value, or narrow the overlap.';
			else message = Number.isFinite(value) ? 'Not allowed: a factor must be from 0 to 5.' : 'Type a number from 0 to 5.';
			blocking = true;
		} else if (verdict === 'confirmZero') {
			message = `Every appended ${month} will have no rain.`;
			blocking = !edit.confirmedZero;
		} else if (verdict === 'warn') {
			message = 'Far from 1: check the fit before applying.';
		}
		if (f.flag === 'shortOverlap' && !edit.typed) {
			message = 'The overlap is too short to compute this factor: type a value, or widen the overlap.';
			blocking = true;
		}
		return {
			index,
			month,
			fit: f,
			edit,
			inUse,
			check: verdict,
			edited: inUse !== null && inUse !== f.computed,
			message,
			blocking
		};
	});
}

/** The 12 values the apply uses, or `null` while any month blocks it. */
export function factorsInUse(rows: readonly FactorRow[]): Monthly12 | null {
	if (rows.length !== 12 || rows.some((r) => r.blocking || r.inUse === null)) return null;
	return rows.map((r) => r.inUse as number) as unknown as Monthly12;
}

/**
 * The factors for the charts and the preview: the value in use where there
 * is one, the computed value where the typed text can't be used yet.
 */
export function factorsForDisplay(rows: readonly FactorRow[]): Monthly12 {
	return rows.map((r) => r.inUse ?? r.fit.computed) as unknown as Monthly12;
}

/** The user's notes on edited months, by month index (0 = October), for the sidecar. */
export function factorNotes(rows: readonly FactorRow[]): Record<number, string> {
	const notes: Record<number, string> = {};
	for (const r of rows) {
		const note = r.edit.note.trim();
		if (r.edited && note !== '') notes[r.index] = note;
	}
	return notes;
}

/** What stops the apply, month by month, for the summary above the button. */
export function blockingMessages(rows: readonly FactorRow[]): { readonly index: number; readonly text: string }[] {
	return rows
		.filter((r) => r.blocking)
		.map((r) => ({
			index: r.index,
			text: `${r.month}: ${r.check === 'confirmZero' && !r.edit.confirmedZero ? `${r.message} Confirm it, or change the factor.` : r.message}`
		}));
}
