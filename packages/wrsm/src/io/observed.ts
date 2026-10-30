/**
 * Observed-flow files (.obs, and any file a .NET gauge names, `.nat`
 * included): monthly flow at a gauge, million m³ (docs/formats.md §11.4).
 *
 * Read with WRSM2000's fixed columns `(4X,I4,1X,12(F7.0,1A))` (§11.1), so a
 * misaligned row reads the way WRSM2000 reads it: rows appended in a
 * `4X,I4,1X,12F8.3` layout come out truncated to two decimals with their third
 * decimal in the flag column. Past column 105 WRSM2000 reads nothing; we
 * keep an annual total there when one is written (`F10.2,A1` in most files).
 *
 * - A negative value means **missing** (U-16: `-99.999` and `-199.998` are
 *   seen). It is returned as read; callers must not compare those months.
 * - A `+` flag marks an incomplete month. Other flag characters (`A`, `E`,
 *   `M`, `*`, `#`, digits from misaligned rows) are not kept as values but
 *   survive a rewrite through `source`.
 * - Years may have gaps (a gauge record is often broken) but must ascend.
 */

import type { ObservedFlow, ObservedRow, SeriesSource, Twelve } from '../types.js';
import { formatF, formatI, readFlowLines, rewriteRows, sameMonths, type FlowLine, type SourceRows } from './series.js';

// The annual total after column 105: a real, then an optional flag (one
// file puts it several blanks later).
const ANNUAL = /^ *([+-]?(?:\d+\.?\d*|\.\d+)) *([^\d. ]?) *$/;

function toRow(line: FlowLine): ObservedRow {
	let annualTotal: number | null = null;
	let annualIncomplete = false;
	if (line.rest.trim() !== '') {
		// WRSM2000 never reads past column 105, so text there that is not an
		// annual total is ignored (and kept through `source`), not an error.
		const m = ANNUAL.exec(line.rest);
		if (m !== null) {
			annualTotal = Number(m[1]);
			annualIncomplete = m[2] === '+';
		}
	}
	return {
		year: line.year,
		months: line.months,
		incomplete: line.flags.map((f) => f === '+') as unknown as Twelve<boolean>,
		annualTotal,
		annualIncomplete
	};
}

function parseRows(source: SeriesSource, fileName: string): SourceRows<ObservedRow> {
	const read = readFlowLines(source.lines.join('\n') + (source.finalNewline ? '\n' : ''), fileName, true);
	return { rows: read.rows.map((line) => toRow(line)), lineIndex: read.rows.map((line) => line.index) };
}

/** Read an observed-flow file. Errors name the file, line, column and field. */
export function readObserved(text: string, fileName: string): ObservedFlow {
	const read = readFlowLines(text, fileName, true);
	return { rows: read.rows.map((line) => toRow(line)), source: read.source };
}

function sameRow(a: ObservedRow, b: ObservedRow): boolean {
	return (
		a.year === b.year &&
		sameMonths(a.months, b.months) &&
		a.incomplete.every((f, k) => f === b.incomplete[k]) &&
		a.annualTotal === b.annualTotal &&
		a.annualIncomplete === b.annualIncomplete
	);
}

/**
 * Format one row as `4X,I4,1X,12(F7.2,A1),F10.2,A1` (116 columns), or
 * without the annual total (104 columns) when it is `null`.
 */
function formatRow(row: ObservedRow): string {
	let s = `    ${formatI(row.year, 4, 'year')} `;
	row.months.forEach((v, k) => {
		s += formatF(v, 7, 2, `year ${row.year} month ${k + 1}`) + (row.incomplete[k] ? '+' : ' ');
	});
	if (row.annualTotal === null) return s.trimEnd();
	return s + formatF(row.annualTotal, 10, 2, `year ${row.year} annual`) + (row.annualIncomplete ? '+' : ' ');
}

/**
 * Write an observed-flow file. We only ever rewrite the user's own files
 * (§11.4), so unchanged rows and the lines after them are copied from
 * `source`; changed or new rows use the 116-column layout above.
 */
export function writeObserved(flow: ObservedFlow): string {
	return rewriteRows(flow.rows, flow.source, (s) => parseRows(s, 'source'), sameRow, formatRow, {
		canonical: () => [],
		changed: (s, end) => s.lines.slice(end)
	});
}
