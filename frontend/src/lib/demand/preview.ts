/**
 * What the preview says about a plan, in words: what Apply would change, and
 * what the file's format does to the volumes (docs/formats.md §12). Only words:
 * the numbers on screen are the plan's own, the ones that get written.
 */

import { DEMAND_ROUNDING_LIMIT_PERCENT, moduleLabel, type DemandPlan, type DemandTarget, type DemandYearCheck } from '@pitman/wrsm';
import { formatNumber, hydroYearLabel } from '#lib/results/format.js';
import { plural } from '#lib/network/format.js';

/** What Apply would change, one line per file touched. */
export function planChanges(plan: DemandPlan, network: { readonly code: string }): string[] {
	const rows = plan.series.rows.length;
	const period = `${hydroYearLabel(plan.firstYear)} to ${hydroYearLabel(plan.lastYear)}`;
	const lines: string[] = [`${plan.request.file === undefined ? 'Writes' : 'Rewrites'} ${plan.fileName}: ${plural(rows, 'row')}, ${period}, in million m³ a month.`];
	if (plan.renamedFrom !== undefined) lines.push(`It takes the new route’s name; ${plan.renamedFrom.trim()} goes.`);
	const { attach, detach } = plan;
	if (detach !== undefined) lines.push(`Route ${detach.route} of ${moduleLabel(detach.module)} no longer reads a file.`);
	if (attach !== undefined) {
		const module = moduleLabel(attach.module);
		lines.push(`${network.code}${attach.module.type}${attach.module.number}.DAT: route ${attach.route} of ${module} names ${plan.fileName}.`);
		if (attach.newRoute) lines.push(`${network.code}.NET: adds route ${attach.route}, from ${module} to the zero sink.`);
	}
	lines.push('pitman.json: records the annual volume, the shares, the growth years and the source of each.');
	return lines;
}

/** The year rounding moved most. */
export function worstRounding(years: readonly DemandYearCheck[]): DemandYearCheck | null {
	let worst: DemandYearCheck | null = null;
	for (const y of years) if (worst === null || Math.abs(y.differencePercent) > Math.abs(worst.differencePercent)) worst = y;
	return worst;
}

/** The warning when rounding to the file's decimals moves a year past §12's limit; `null` under it. */
export function roundingWarning(years: readonly DemandYearCheck[]): string | null {
	const worst = worstRounding(years);
	if (worst === null || Math.abs(worst.differencePercent) <= DEMAND_ROUNDING_LIMIT_PERCENT) return null;
	const over = years.filter((y) => Math.abs(y.differencePercent) > DEMAND_ROUNDING_LIMIT_PERCENT).length;
	return (
		`Rounding moves ${plural(over, 'year')} by more than ${DEMAND_ROUNDING_LIMIT_PERCENT} %, ${formatNumber(Math.abs(worst.differencePercent), 2)} % at worst ` +
		`(${hydroYearLabel(worst.year)}: asked ${formatNumber(worst.askedMm3, 3)}, the file holds ${formatNumber(worst.writtenMm3, 2)} million m³). ` +
		'A demand file keeps 0.001 million m³ a month, which is 1,000 m³, so a very small demand moves in steps. Compare Total with Asked below before you apply; for a flat demand, shares that land on whole 0.01s bring them closer.'
	);
}

/** Refused: nothing would reach the file. */
export function emptyFileProblem(years: readonly DemandYearCheck[]): string | null {
	if (years.some((y) => y.askedMm3 > 0 && y.writtenMm3 === 0) && years.every((y) => y.writtenMm3 === 0)) {
		return 'Every month rounds to 0.000, so the file would hold no demand. A demand file keeps 0.001 million m³ a month; the volume needs to be larger, or fall in fewer months.';
	}
	return null;
}

/** From which year the volume stops changing: the last year a growth row gives. */
export function flatFrom(plan: DemandPlan): number | null {
	const last = plan.request.spec.growth.at(-1)?.year;
	return last === undefined ? null : last;
}

/** Decode the form's module and route choices. */
export function targetFrom(moduleChoice: string, routeChoice: string): DemandTarget | undefined {
	const match = /^(RV|CR)(\d+)$/.exec(moduleChoice);
	if (match === null || routeChoice === '') return undefined;
	const module = { type: match[1] as 'RV' | 'CR', number: Number(match[2]) };
	return routeChoice === 'new' ? { kind: 'newRoute', module } : { kind: 'route', module, route: Number(routeChoice) };
}
