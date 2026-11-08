// The answer of POST /chirps/monthly (/api/chirps/monthly through CloudFront) for one checked area (docs/data.md § CHIRPS steps 1–4,
// docs/theory/extend.md §§ Steps 1–3), in the wire shape of packages/wrsm/src/extend/contract.ts.
import type { ChirpsMonth, ChirpsMonthly } from '@pitman/wrsm';
import { geometryAreaM2 } from '../geo/area.js';
import type { Geometry } from '../geo/geojson.js';
import { boundaryCells } from './boundaryCells.js';
import { CHIRPS_MAX_CHUNKS } from './config.js';
import type { OpenedCopy } from './copy.js';
import { FeedFormatError } from './errors.js';
import { FINALS_CHUNK, FINALS_FIRST_YEAR } from './mirror/arrays.js';
import { cellsByChunk, chcCell, mirrorCell } from './mirror/grid.js';
import { areaMonthly, readMonthly } from './readMonthly.js';

/** The product as the sidecar records it (contract.ts ChirpsMonthly.product). */
export const CHIRPS_PRODUCT = 'CHIRPS v3 rnl (final)';

/** The area can't be answered as asked (too big, outside the copy, no data under it): a 422 with this message. */
export class AreaRefusedError extends FeedFormatError {}

export interface MonthlyOptions {
	deadline?: number;
	now?: () => number;
	concurrency?: number;
}

/** The area's monthly CHIRPS series from the opened copy. `g` has passed checkGeometry and is a (Multi)Polygon. */
export async function chirpsMonthly(copy: OpenedCopy, g: Geometry, opts: MonthlyOptions = {}): Promise<ChirpsMonthly> {
	const found = boundaryCells(g);
	if ('problem' in found) throw new AreaRefusedError(found.problem);
	const { finals, manifest } = copy;
	// Each cell to the copy's (y, x), in whole cells from its centre; a cell outside the copy's region is refused.
	const cells = found.cells.map((c) => {
		try {
			return mirrorCell(chcCell(c.lat, c.lon), finals.region);
		} catch (err) {
			if (err instanceof FeedFormatError) throw new AreaRefusedError(`the area reaches outside the CHIRPS copy: ${err.message}`);
			throw err;
		}
	});
	// One GET per chunk per year: an area spread over many chunks costs far more than its cells suggest (R4-D6).
	const chunks = cellsByChunk(cells, FINALS_CHUNK[2], FINALS_CHUNK[3]).length;
	if (chunks > CHIRPS_MAX_CHUNKS) {
		throw new AreaRefusedError(
			`the area is spread over ${chunks} of the CHIRPS copy's 1° × 1° blocks; one request reads at most ${CHIRPS_MAX_CHUNKS} (any compact area under the cell limit fits): extend the file over fewer quaternaries, or over quaternaries closer together`
		);
	}
	const finalThrough = manifest.finalThrough;
	const lastYear = Number(finalThrough.slice(0, 4));
	const lastMonth = Number(finalThrough.slice(5, 7));
	const totals = await readMonthly(finals, cells, FINALS_FIRST_YEAR, lastYear, { finalThrough, ...opts });
	const mean = areaMonthly(
		found.cells.map((c) => c.weight),
		totals
	);
	if (mean.kept.length === 0) throw new AreaRefusedError('the CHIRPS copy has no data under the area (all of it is sea, or outside the data the copy holds)');
	const count = (lastYear - FINALS_FIRST_YEAR) * 12 + lastMonth;
	const months: ChirpsMonth[] = mean.mm.slice(0, count).map((mm, k) => ({ year: FINALS_FIRST_YEAR + Math.floor(k / 12), month: (k % 12) + 1, mm }));
	return {
		months,
		cells: mean.kept.length,
		weightRemovedPct: mean.weightRemovedPct,
		areaKm2: Math.round((geometryAreaM2(g) ?? 0) / 1e3) / 1e3,
		product: CHIRPS_PRODUCT,
		revision: manifest.revision,
		finalThrough,
		source: copy.kind
	};
}
