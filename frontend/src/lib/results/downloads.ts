/**
 * Result downloads: `.ANS` answer files in WRSM2000's layout (TT 689 §4.5,
 * docs/formats.md §11.2, via `answerFromSeries` + `writeAnswer`) and a CSV
 * with every run and the observed flows side by side.
 */

import { answerFromSeries, writeAnswer, type MonthlySeries, type RunMode } from '@pitman/wrsm';
import type { TargetAnalysis } from './analysis.js';
import { FLOW_UNIT, HYDRO_MONTHS, STORAGE_UNIT, calendarYear, runSlug } from './format.js';
import type { ResultTarget } from './targets.js';

export interface Download {
	readonly fileName: string;
	readonly mimeType: string;
	readonly text: string;
}

/**
 * `<net>RQ<route>.ANS` or `<net>RV<n>.ANS` (TT 689 §2.3.4). With several
 * runs the mode is appended (`SYRQ4-natural.ANS`) so the files don't
 * collide; WRSM2000's name rule (net code, RQ/RV, number) still reads it.
 */
export function answerFileName(networkCode: string, target: Pick<ResultTarget, 'kind' | 'number'>, mode: RunMode | null): string {
	const kind = target.kind === 'route' ? 'RQ' : 'RV';
	return `${networkCode.trim()}${kind}${target.number}${mode === null ? '' : `-${runSlug(mode)}`}.ANS`;
}

/**
 * One run's answer file for a target. Throws a RangeError (from the writer)
 * when a value does not fit WRSM2000's F8.2 columns.
 */
export function answerDownload(
	networkCode: string,
	target: Pick<ResultTarget, 'kind' | 'number'>,
	series: MonthlySeries,
	mode: RunMode,
	severalRuns: boolean
): Download {
	const file = answerFromSeries(target.kind === 'route' ? 'RQ' : 'RV', target.number, series);
	return {
		fileName: answerFileName(networkCode, target, severalRuns ? mode : null),
		mimeType: 'text/plain',
		text: writeAnswer(file)
	};
}

function csvField(text: string): string {
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvNumber(v: number | null | undefined): string {
	return v === null || v === undefined || !Number.isFinite(v) ? '' : String(v);
}

/**
 * The target's monthly values in every run, and the observed flows when
 * there is a gauge, one row per month. Values are written at full
 * precision; an empty cell is no value (missing observed month, or a run
 * without this target). CRLF line endings (RFC 4180).
 */
export function csvDownload(networkCode: string, a: TargetAnalysis): Download | null {
	if (a.timeline === null) return null;
	const unit = a.target.kind === 'route' ? FLOW_UNIT : STORAGE_UNIT;
	const header = ['hydrological_year', 'month', 'calendar_year', ...a.runs.map((r) => `${r.label} (${unit})`)];
	if (a.observed !== null) header.push(`Observed (${unit})`, 'observed_incomplete');
	const lines = [header.map(csvField).join(',')];
	for (let i = 0; i < 12 * a.timeline.years; i++) {
		const year = a.timeline.startYear + Math.floor(i / 12);
		const month = i % 12;
		const row = [String(year), HYDRO_MONTHS[month] as string, String(calendarYear(year, month)), ...a.runs.map((r) => csvNumber(r.values[i]))];
		if (a.observed !== null) row.push(csvNumber(a.observed.values[i]), a.observed.incomplete[i] ? 'yes' : '');
		lines.push(row.join(','));
	}
	const kind = a.target.kind === 'route' ? 'RQ' : 'RV';
	return {
		fileName: `${networkCode.trim()}${kind}${a.target.number}.csv`,
		mimeType: 'text/csv',
		text: lines.join('\r\n') + '\r\n'
	};
}
