// The ArcGIS REST `query` call behind POST /cfm/land-use (D3, docs/data.md § Cape Farm Mapper), paged and bounded.
// The credential is sent in a POST form body, never a URL, so it stays out of every access log, and no error or log line
// here carries it or an upstream body. It is only ever the operator's token from CFM_TOKEN: Pitman never calls
// the Cape Farm Mapper web app's own token endpoint (docs/data.md).
import type { AreaGeometry } from '@pitman/wrsm';
import { CopyUnavailableError } from '../chirps/copy.js';
import type { Position } from '../geo/geojson.js';
import { ApiError } from '../http/errors.js';
import type { LayerFeature } from './adapter.js';
import { logUnexpected } from '../http/logError.js';

/** Records per page: under ArcGIS Server's default maxRecordCount (2 000), and a page shorter than this doesn't end the read. */
export const CFM_PAGE_SIZE = 1_000;
/** Pages per layer, so one area costs at most this many upstream calls and 20 000 records. */
export const CFM_MAX_PAGES = 20;
/** The bytes one area may read from upstream, over all its pages. */
export const CFM_MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;
/** One page's time limit. */
export const CFM_REQUEST_TIMEOUT_MS = 10_000;
/** Past this the query sends the area's box, not its outline (a long polygon fails upstream); `clip.ts` clips either way. */
export const CFM_MAX_QUERY_VERTICES = 2_000;

export interface QueryOptions {
	/** The layer's URL, ending at its number. */
	layerUrl: string;
	token: string;
	area: AreaGeometry;
	outFields: string;
	/** Ordered by this, so paging neither repeats nor skips a record. */
	orderBy: string;
	/** Time (`now()` scale) to stop by. */
	deadline: number;
	now: () => number;
	fetch: typeof fetch;
}

/** A ring turned to `clockwise` (planar sign; Esri's outer rings are clockwise, holes anticlockwise). */
function turned(ring: readonly Position[], clockwise: boolean): Position[] {
	let sum = 0;
	for (let i = 0; i < ring.length - 1; i++) sum += (ring[i + 1]![0] - ring[i]![0]) * (ring[i + 1]![1] + ring[i]![1]);
	return sum > 0 === clockwise ? [...ring] : [...ring].reverse();
}

/** The `geometry` and `geometryType` of the query: Esri JSON, the outline, or its box when the outline is too long. */
export function esriGeometry(area: AreaGeometry): { geometry: string; geometryType: string } {
	const polygons = (area.type === 'Polygon' ? [area.coordinates] : area.coordinates) as unknown as Position[][][];
	const rings = polygons.flatMap((polygon) => polygon.map((ring, i) => turned(ring, i === 0)));
	const spatialReference = { wkid: 4326 };
	if (rings.reduce((n, r) => n + r.length, 0) <= CFM_MAX_QUERY_VERTICES) {
		return { geometry: JSON.stringify({ rings, spatialReference }), geometryType: 'esriGeometryPolygon' };
	}
	const all = rings.flat();
	const xs = all.map((p) => p[0]);
	const ys = all.map((p) => p[1]);
	const box = { xmin: Math.min(...xs), ymin: Math.min(...ys), xmax: Math.max(...xs), ymax: Math.max(...ys), spatialReference };
	return { geometry: JSON.stringify(box), geometryType: 'esriGeometryEnvelope' };
}

/** Every feature of the layer intersecting the area, or a refusal: a partial read never goes out as a whole one. */
export async function queryLayer(o: QueryOptions): Promise<LayerFeature[]> {
	const features: LayerFeature[] = [];
	const { geometry, geometryType } = esriGeometry(o.area);
	let bytes = 0;
	for (let page = 0; page < CFM_MAX_PAGES; page++) {
		const left = o.deadline - o.now();
		if (left <= 0) throw new ApiError(504, 'Cape Farm Mapper took too long to answer; try a smaller area');
		const form = new URLSearchParams({
			f: 'geojson',
			where: '1=1',
			geometry,
			geometryType,
			inSR: '4326',
			spatialRel: 'esriSpatialRelIntersects',
			outFields: o.outFields,
			returnGeometry: 'true',
			outSR: '4326',
			orderByFields: o.orderBy,
			resultOffset: String(features.length),
			resultRecordCount: String(CFM_PAGE_SIZE),
			token: o.token
		});
		let text: string;
		try {
			const response = await o.fetch(`${o.layerUrl.replace(/\/+$/, '')}/query`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/geo+json, application/json' },
				body: form,
				signal: AbortSignal.timeout(Math.min(left, CFM_REQUEST_TIMEOUT_MS))
			});
			if (!response.ok) {
				console.error(JSON.stringify({ event: 'cfm.query_failed', status: response.status }));
				throw new CopyUnavailableError(`Cape Farm Mapper answered HTTP ${response.status}; try again shortly`);
			}
			text = await response.text();
		} catch (err) {
			if (err instanceof CopyUnavailableError) throw err;
			logUnexpected('cfm.query_failed', err);
			throw new CopyUnavailableError('Cape Farm Mapper is not answering; try again shortly');
		}
		bytes += text.length;
		if (bytes > CFM_MAX_UPSTREAM_BYTES) throw new ApiError(422, 'the area holds more land-use data than one request can read; choose a smaller area');
		let body: { features?: unknown; error?: { code?: unknown } };
		try {
			body = JSON.parse(text) as typeof body;
		} catch {
			throw new CopyUnavailableError('Cape Farm Mapper sent an answer Pitman can’t read');
		}
		// ArcGIS reports its own errors in a 200, an expired token (498, 499) among them.
		if (body.error !== undefined) {
			const code = body.error?.code;
			console.error(JSON.stringify({ event: 'cfm.query_refused', ...(typeof code === 'number' ? { code } : {}) }));
			const token = code === 498 || code === 499;
			throw new CopyUnavailableError(token ? 'Cape Farm Mapper refused Pitman’s token; the operator needs to renew it' : 'Cape Farm Mapper refused the query; try again shortly');
		}
		if (!Array.isArray(body.features)) throw new CopyUnavailableError('Cape Farm Mapper sent an answer Pitman can’t read');
		// Only an empty page ends the read: a layer whose maxRecordCount is under the page size answers short pages.
		if (body.features.length === 0) return features;
		features.push(...(body.features as LayerFeature[]));
	}
	throw new ApiError(422, `the area holds more than ${CFM_MAX_PAGES * CFM_PAGE_SIZE} land-use records; choose a smaller area`);
}
