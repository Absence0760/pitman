/**
 * The WR2012 statistics table: the five TT 689 pp.61–62 statistics plus CV,
 * one column per run and one for the observed flows, with each run's % error
 * against the TT 689 p.177 guidelines when there is a gauge.
 */

import { WR2012_FIT_GUIDELINES, percentError, type FlowStatistics, type Wr2012Statistic } from './engine.js';
import type { TargetAnalysis } from './analysis.js';
import { ANNUAL_FLOW_UNIT, formatNumber, hydroYearLabel } from './format.js';

export interface StatisticsCell {
	readonly text: string;
	/** For error cells: whether |error| is within the TT 689 p.177 guideline. */
	readonly verdict?: 'within' | 'outside';
}

export interface StatisticsRow {
	readonly key: Wr2012Statistic | 'cv' | 'years';
	readonly label: string;
	readonly unit: string;
	readonly cells: readonly StatisticsCell[];
}

export interface StatisticsTable {
	readonly caption: string;
	readonly columns: readonly string[];
	readonly rows: readonly StatisticsRow[];
	readonly notes: readonly string[];
}

const ROWS: readonly { key: StatisticsRow['key']; label: string; unit: string; decimals: number }[] = [
	{ key: 'years', label: 'Years used', unit: 'hydrological years', decimals: 0 },
	{ key: 'marMm3', label: 'MAR', unit: ANNUAL_FLOW_UNIT, decimals: 2 },
	{ key: 'meanLog', label: 'Mean (log)', unit: 'log₁₀ of annual flow in million m³', decimals: 3 },
	{ key: 'sdMm3', label: 'Standard deviation', unit: ANNUAL_FLOW_UNIT, decimals: 2 },
	{ key: 'logSd', label: 'Log standard deviation', unit: 'log₁₀', decimals: 3 },
	{ key: 'seasonalIndex', label: 'Seasonal index', unit: '% MAR', decimals: 1 },
	{ key: 'cv', label: 'Coefficient of variation', unit: 'SD / MAR', decimals: 3 }
];

function valueOf(s: FlowStatistics | null, key: StatisticsRow['key']): number | null {
	if (s === null) return null;
	return key === 'years' ? s.years : s[key];
}

function errorCell(key: StatisticsRow['key'], sim: number | null, obs: number | null): StatisticsCell {
	if (key === 'years' || key === 'cv') return { text: '' };
	const error = percentError(sim, obs);
	if (error === null) return { text: '—' };
	const guideline = WR2012_FIT_GUIDELINES[key];
	const within = Math.abs(error) < guideline;
	const sign = error > 0 ? '+' : '';
	return { text: `${sign}${formatNumber(error, 1)} % (${within ? 'within' : 'outside'} ${guideline} %)`, verdict: within ? 'within' : 'outside' };
}

/** Build the statistics table for an analysed target, or `null` for a reservoir or an empty result. */
export function statisticsTable(a: TargetAnalysis): StatisticsTable | null {
	if (a.target.kind !== 'route' || a.period === null) return null;
	const gauged = a.runs.some((r) => r.gauge !== null);
	const columns = ['Statistic', 'Unit'];
	if (gauged) columns.push('Observed');
	for (const r of a.runs) {
		columns.push(gauged ? `${r.label} simulated` : r.label);
		if (gauged) columns.push(`${r.label} error vs observed`);
	}

	const rows = ROWS.map(({ key, label, unit, decimals }): StatisticsRow => {
		const cells: StatisticsCell[] = [];
		const obs = valueOf(a.observedStatistics, key);
		if (gauged) cells.push({ text: formatNumber(obs, decimals) });
		for (const r of a.runs) {
			const sim = valueOf(r.statistics, key);
			cells.push({ text: formatNumber(sim, decimals) });
			if (gauged) cells.push(errorCell(key, sim, obs));
		}
		return { key, label, unit, cells };
	});

	const notes: string[] = [];
	const { startYear, endYear } = a.period;
	const pairing = a.runs.find((r) => r.gauge !== null)?.gauge?.pairing;
	if (pairing !== undefined) {
		notes.push(
			`Simulated and observed flows compared over the same ${pairing.completeYears.length} complete hydrological years between ${hydroYearLabel(startYear)} and ${hydroYearLabel(endYear)}: years with all 12 observed months usable.`
		);
		if (pairing.dropped.missing > 0) notes.push(`${pairing.dropped.missing === 1 ? '1 missing observed month (a negative value) is' : `${pairing.dropped.missing} missing observed months (negative values) are`} not compared.`);
		if (pairing.dropped.incomplete > 0) notes.push(`${pairing.dropped.incomplete} incomplete observed months (+) are left out.`);
		if (pairing.completeYears.length === 0) notes.push('No observed year in this period is complete, so there are no annual statistics.');
		notes.push('Guidelines (TT 689 p.177): error in MAR and mean (log) under 4 %, standard deviations under 6 %, seasonal index under 8 %.');
	} else {
		notes.push(`Statistics of the simulated flows over hydrological years ${hydroYearLabel(startYear)} to ${hydroYearLabel(endYear)}.`);
	}
	const withoutLog = Math.max(a.observedStatistics?.yearsWithoutLog ?? 0, ...a.runs.map((r) => r.statistics?.yearsWithoutLog ?? 0));
	if (withoutLog > 0) notes.push(`Years with no flow are left out of the log statistics (up to ${withoutLog} in a column).`);

	return { caption: 'WR2012 flow statistics (TT 689 pp.61–62)', columns, rows, notes };
}
