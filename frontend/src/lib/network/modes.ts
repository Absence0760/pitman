/**
 * The run-mode picker (decision D1): present day at a chosen year (2025 by
 * default), natural, historical. Several can be ticked so their results
 * compare side by side.
 */

import { RUN_MODE_KINDS, type RunMode } from '@pitman/wrsm';

/** What the picker holds; `presentDayYear` is the text in the year box. */
export interface ModeChoice {
	readonly presentDay: boolean;
	readonly presentDayYear: string;
	readonly natural: boolean;
	readonly historical: boolean;
}

/** Present day (2025) and natural ticked: the comparison issue #3 is about. */
export const DEFAULT_MODE_CHOICE: ModeChoice = { presentDay: true, presentDayYear: '2025', natural: true, historical: false };

/** Range accepted for the present-day year (a hydrological year label, docs/formats.md §10.1). */
export const PRESENT_DAY_YEARS = { min: 1900, max: 2100 } as const;

export type ModesFromChoice = { readonly ok: true; readonly modes: readonly RunMode[] } | { readonly ok: false; readonly error: string; readonly field: 'year' | 'modes' };

/** The modes to run, in the order the engine lists them, or what is wrong with the choice. */
export function modesFromChoice(choice: ModeChoice): ModesFromChoice {
	const modes: RunMode[] = [];
	for (const kind of RUN_MODE_KINDS) {
		if (kind === 'presentDay' && choice.presentDay) {
			const text = choice.presentDayYear.trim();
			const year = Number(text);
			if (!/^\d{4}$/.test(text) || year < PRESENT_DAY_YEARS.min || year > PRESENT_DAY_YEARS.max) {
				return { ok: false, field: 'year', error: `Present-day year must be a year from ${PRESENT_DAY_YEARS.min} to ${PRESENT_DAY_YEARS.max}.` };
			}
			modes.push({ kind: 'presentDay', year });
		} else if (kind === 'natural' && choice.natural) {
			modes.push({ kind: 'natural' });
		} else if (kind === 'historical' && choice.historical) {
			modes.push({ kind: 'historical' });
		}
	}
	if (modes.length === 0) return { ok: false, field: 'modes', error: 'Choose at least one mode to run.' };
	return { ok: true, modes };
}

/** `Present day (2025)`, `Natural`, `Historical`. */
export function modeLabel(mode: RunMode): string {
	switch (mode.kind) {
		case 'presentDay':
			return `Present day (${mode.year})`;
		case 'natural':
			return 'Natural';
		case 'historical':
			return 'Historical';
	}
}

/** A stable id for a mode, for keys and test selectors: `presentDay-2025`, `natural`. */
export function modeId(mode: RunMode): string {
	return mode.kind === 'presentDay' ? `presentDay-${mode.year}` : mode.kind;
}

/** Whether a stored value is a `ModeChoice` (for the restored working copy). */
export function isModeChoice(value: unknown): value is ModeChoice {
	const v = value as Partial<ModeChoice> | null;
	return (
		typeof v === 'object' &&
		v !== null &&
		typeof v.presentDay === 'boolean' &&
		typeof v.presentDayYear === 'string' &&
		typeof v.natural === 'boolean' &&
		typeof v.historical === 'boolean'
	);
}
