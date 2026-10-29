/**
 * Where the numbers on the extension screen come from (issue #3 rule 8):
 * the CHIRPS product, the copy's revision and last final day, the cells and
 * the weight removed, the area, and when it was fetched. The screen shows
 * these beside every chart and table, and the sidecar keeps them.
 */

import type { ChirpsMonthly, ExtensionFit, RainfallExtension } from '@pitman/wrsm';
import { formatNumber, hydroYearLabel } from '#lib/results/format.js';

export interface Fact {
	readonly label: string;
	readonly value: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString('en-ZA')} ${n === 1 ? one : many}`;
}

/** The CHIRPS series' provenance, as label/value pairs. */
export function chirpsFacts(chirps: ChirpsMonthly, accessed: string): Fact[] {
	const first = chirps.months[0];
	return [
		{ label: 'Product', value: chirps.product },
		{ label: 'Copy', value: chirps.source === 's3' ? `IC-WBT rain data copy, revision ${chirps.revision}` : `Local synthetic copy (development), revision ${chirps.revision}` },
		{ label: 'Final data through', value: chirps.finalThrough },
		{ label: 'Months', value: first ? `${first.year}-${String(first.month).padStart(2, '0')} to ${chirps.finalThrough.slice(0, 7)} (${plural(chirps.months.length, 'month')})` : 'none' },
		{ label: 'Area', value: `${formatNumber(chirps.areaKm2, 1)} km²` },
		{ label: 'Cells', value: `${plural(chirps.cells, 'CHIRPS cell')} (0.05°), area-weighted` },
		{ label: 'Weight removed (sea or no data)', value: `${formatNumber(chirps.weightRemovedPct, 1)} %` },
		{ label: 'Fetched', value: accessed },
		{ label: 'Citation', value: 'Funk et al., CHIRPS, doi:10.15780/G2JQ0P' }
	];
}

/** The fit's own provenance: the CHIRPS MAP and the overlap. */
export function fitFacts(fit: ExtensionFit): Fact[] {
	const years = fit.overlap.endYear - fit.overlap.startYear + 1;
	return [
		{
			label: 'CHIRPS MAP',
			value: `${formatNumber(fit.chirpsMapMm, 1)} mm (mean of the complete hydrological years ${hydroYearLabel(fit.chirpsMapYears.startYear)} to ${hydroYearLabel(fit.chirpsMapYears.endYear)})`
		},
		{
			label: 'Overlap',
			value: `${hydroYearLabel(fit.overlap.startYear)} to ${hydroYearLabel(fit.overlap.endYear)}, ${plural(years, 'year')} (${fit.overlap.window === 'user' ? 'narrowed by you' : 'the whole overlap'})`
		}
	];
}

/** A file's earlier extension, from the sidecar, in one sentence. */
export function previousExtension(ext: RainfallExtension): string {
	const edited = ext.appliedFactors.filter((f, k) => f !== ext.computedFactors[k]).length;
	return (
		`Extended by Pitman from ${hydroYearLabel(ext.appendedYears.first)} to ${hydroYearLabel(ext.appendedYears.last)} with ${ext.chirps.dataset}` +
		` (fetched ${ext.chirps.fetchedOn}; overlap ${hydroYearLabel(ext.overlap.startYear)} to ${hydroYearLabel(ext.overlap.endYear)}` +
		`${edited > 0 ? `; ${plural(edited, 'factor')} edited` : ''}). The original record ends ${hydroYearLabel(ext.originalEndYear)}; extending again replaces the appended years.`
	);
}

/** The same, short, for the file list. */
export function extensionLabel(ext: RainfallExtension): string {
	return `Extended to ${hydroYearLabel(ext.appendedYears.last)} (${ext.chirps.dataset}, fetched ${ext.chirps.fetchedOn})`;
}
