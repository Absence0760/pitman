/**
 * The network's demand and defined-flow files as the panel lists them: what
 * each attaches to, the years it holds, and what stands in the way of using
 * it. One row per file, whatever spellings the modules give its name.
 */

import { demandAttachments, demandFileKeys, demandSpecOf, specGenerates, type DemandAttachment, type DemandRemovalPlan, type DemandSpec, type HydroYear, type NetworkBundle, type ValueSource } from '@pitman/wrsm';
import { hydroYearLabel } from '#lib/results/format.js';

export interface DemandFileRow {
	readonly key: string;
	readonly name: string;
	readonly attachments: readonly DemandAttachment[];
	readonly firstYear: HydroYear;
	readonly lastYear: HydroYear;
	/** Mean of the file's yearly totals, million m³/a. */
	readonly meanAnnualMm3: number;
	/** From the sidecar; `undefined` when the file can only be viewed or replaced. */
	readonly spec: DemandSpec | undefined;
	/** The spec no longer generates the rows: the file changed outside Pitman. */
	readonly specStale: boolean;
	/** Why the file falls short of the run; `null` when it covers it. */
	readonly shortfall: string | null;
}

/** `RV 5 Synthetic dam, route 10 to the zero sink`. */
export function attachmentLabel(a: DemandAttachment): string {
	const module = `${a.module.type} ${a.module.number}${a.name === '' ? '' : ` ${a.name}`}`;
	return a.direction === 'out' ? `${module}, route ${a.route} to ${a.other}` : `Inflow to ${module}, route ${a.route} from ${a.other}`;
}

/** A file has to cover the run for a historical run (TT 689 p.150); other modes take one row or none. */
function shortfall(first: HydroYear, last: HydroYear, start: HydroYear, end: HydroYear): string | null {
	if (first <= start && last >= end) return null;
	const held = `It holds ${hydroYearLabel(first)} to ${hydroYearLabel(last)}`;
	return `${held}, and the run is ${hydroYearLabel(start)} to ${hydroYearLabel(end)}: a historical run stops at the first missing year.`;
}

/** Every file once, demands before defined inflows, then by name. */
export function demandFiles(bundle: NetworkBundle): DemandFileRow[] {
	const seen = new Set<string>();
	const rows: DemandFileRow[] = [];
	for (const [key, series] of Object.entries(bundle.flowFiles)) {
		if (seen.has(key)) continue;
		for (const k of demandFileKeys(bundle, key)) seen.add(k);
		const years = series.rows.map((r) => r.year);
		const firstYear = Math.min(...years);
		const lastYear = Math.max(...years);
		const total = series.rows.reduce((sum, row) => sum + row.months.reduce((a, b) => a + b, 0), 0);
		const spec = demandSpecOf(bundle, key);
		rows.push({
			key,
			name: series.fileName.trim(),
			attachments: demandAttachments(bundle, key),
			firstYear,
			lastYear,
			meanAnnualMm3: series.rows.length === 0 ? 0 : total / series.rows.length,
			spec,
			specStale: spec !== undefined && !specGenerates(spec, series.rows),
			shortfall: shortfall(firstYear, lastYear, bundle.network.startYear, bundle.network.endYear)
		});
	}
	const inflowOnly = (r: DemandFileRow) => (r.attachments.length > 0 && r.attachments.every((a) => a.direction === 'in') ? 1 : 0);
	return rows.sort((a, b) => inflowOnly(a) - inflowOnly(b) || a.name.localeCompare(b.name));
}

/** Which routes a removal takes the file off: `CR 4 route 9, RV 5 route 12`. */
export function removalRoutes(plan: DemandRemovalPlan): string {
	return plan.routes.map(({ attachment: a }) => `${a.module.type} ${a.module.number} route ${a.route}`).join(', ');
}

/** Everything a removal does, a sentence each, as the confirmation says it. */
export function removalConsequences(plan: DemandRemovalPlan): string[] {
	const out = plan.routes.map((r) => r.effect);
	if (!plan.fileGoes) out.push(`The file stays, on ${plan.stays.map(attachmentLabel).join('; ')}.`);
	else if (plan.stillInZip) out.push(`It stops being a demand here. ${plan.stillInZip}`);
	else out.push('The file leaves the working copy and the next saved zip.');
	if (plan.specGoes) out.push('Its spec and sources leave pitman.json.');
	if (plan.needsReason) out.push(plan.fileGoes ? 'This is one of the network’s own files, with no spec to make it again from. Your reason stays in pitman.json. Undo brings the file back until the network next changes; after that only the zip you loaded can.' : 'Your reason stays in pitman.json.');
	return out;
}

/** A value's source in words (issue #3 rule 8). */
export function sourceLabel(source: ValueSource | undefined): string {
	if (source === undefined) return 'No source recorded';
	const note = source.note?.trim() ?? '';
	const date = source.date ? ` on ${source.date.slice(0, 10)}` : '';
	switch (source.kind) {
		case 'manual':
			return `Typed in${date}${note === '' ? ', no reference given' : `: ${note}`}`;
		case 'networkFile':
			return `From the network file${note === '' ? '' : `: ${note}`}`;
		default:
			return `${source.kind}${date}${note === '' ? '' : `: ${note}`}`;
	}
}
