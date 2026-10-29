/**
 * The fit numbers table (extend.md § Fit diagnostics, item 4), as text: the
 * engine's statistics before (`p`) and after (`f·p`, computed factors), and
 * per-month bias with the factors in use. A month whose factor was computed
 * has an after-bias of 0 by construction; the table says so rather than
 * showing a zero as if it were a finding.
 */

import type { ExtensionFit } from '@pitman/wrsm';
import { formatNumber } from '#lib/results/format.js';
import type { FactorRow } from './factors.js';

export interface StatRow {
	readonly label: string;
	readonly before: string;
	readonly after: string;
}

function signed(value: number | null, decimals = 2): string {
	if (value === null || !Number.isFinite(value)) return '—';
	const s = formatNumber(value, decimals);
	return value > 0 && s !== formatNumber(0, decimals) ? `+${s} %` : `${s} %`;
}

export function summaryStats(fit: ExtensionFit): StatRow[] {
	return [
		{ label: 'Monthly R² (all overlap months, pooled)', before: formatNumber(fit.before.monthlyR2, 4), after: formatNumber(fit.after.monthlyR2, 4) },
		{ label: 'Monthly NSE against the file', before: formatNumber(fit.before.monthlyNse, 4), after: formatNumber(fit.after.monthlyNse, 4) },
		{ label: 'Annual R²', before: formatNumber(fit.before.annualR2, 4), after: formatNumber(fit.after.annualR2, 4) },
		{ label: 'Annual bias', before: signed(fit.before.annualBiasPct), after: signed(fit.after.annualBiasPct) }
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

export function monthlyBias(fit: ExtensionFit, rows: readonly FactorRow[]): MonthBiasRow[] {
	return rows.map((r, k) => {
		const computedExact = r.fit.flag === 'computed';
		const afterComputed = computedExact ? '0 by construction' : signed(fit.after.monthlyBiasPct[k] ?? null);
		const inUse = r.edited ? signed(r.biasInUsePct) : afterComputed;
		return { month: r.month, before: signed(fit.before.monthlyBiasPct[k] ?? null), afterComputed, inUse };
	});
}
