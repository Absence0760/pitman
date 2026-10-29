/**
 * The fit numbers table (extend.md § Fit diagnostics, item 4), as text: the
 * engine's statistics before (`p`) and after (`f·p`, computed factors), and
 * the same with the factors in use (the engine's `fitStatistics`). A month whose factor was computed
 * has an after-bias of 0 by construction; the table says so rather than
 * showing a zero as if it were a finding.
 */

import type { ExtensionFit, FitStatistics } from '@pitman/wrsm';
import { formatNumber } from '#lib/results/format.js';
import type { FactorRow } from './factors.js';

export interface StatRow {
	readonly label: string;
	readonly before: string;
	readonly after: string;
	/** With the factors in use; '' when none is edited (then it equals `after`). */
	readonly inUse: string;
}

function signed(value: number | null, decimals = 2): string {
	if (value === null || !Number.isFinite(value)) return '—';
	const s = formatNumber(value, decimals);
	return value > 0 && s !== formatNumber(0, decimals) ? `+${s} %` : `${s} %`;
}

/** `inUse`: the engine's statistics with the factors in use (`fitStatistics`), when any factor is edited. */
export function summaryStats(fit: ExtensionFit, inUse: FitStatistics | null = null): StatRow[] {
	const r = (s: FitStatistics | null, get: (s: FitStatistics) => number) => (s === null ? '' : formatNumber(get(s), 4));
	return [
		{ label: 'Monthly R² (all overlap months, pooled)', before: r(fit.before, (s) => s.monthlyR2), after: r(fit.after, (s) => s.monthlyR2), inUse: r(inUse, (s) => s.monthlyR2) },
		{ label: 'Monthly NSE against the file', before: r(fit.before, (s) => s.monthlyNse), after: r(fit.after, (s) => s.monthlyNse), inUse: r(inUse, (s) => s.monthlyNse) },
		{ label: 'Annual R²', before: r(fit.before, (s) => s.annualR2), after: r(fit.after, (s) => s.annualR2), inUse: r(inUse, (s) => s.annualR2) },
		{
			label: 'Annual bias',
			before: signed(fit.before.annualBiasPct),
			after: signed(fit.after.annualBiasPct),
			inUse: inUse === null ? '' : signed(inUse.annualBiasPct)
		}
	];
}

export interface MonthBiasRow {
	readonly month: string;
	readonly before: string;
	/** With the computed factors (the engine's `after`). */
	readonly afterComputed: string;
	/** With the factors in use, when any differs from the computed one. */
	readonly inUse: string;
}

export function monthlyBias(fit: ExtensionFit, rows: readonly FactorRow[], inUseStats: FitStatistics | null = null): MonthBiasRow[] {
	return rows.map((r, k) => {
		const computedExact = r.fit.flag === 'computed';
		const afterComputed = computedExact ? '0 by construction' : signed(fit.after.monthlyBiasPct[k] ?? null);
		const inUse = r.edited && inUseStats !== null ? signed(inUseStats.monthlyBiasPct[k] ?? null) : afterComputed;
		return { month: r.month, before: signed(fit.before.monthlyBiasPct[k] ?? null), afterComputed, inUse };
	});
}
