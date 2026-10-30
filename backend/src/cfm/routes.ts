// POST /cfm/land-use (/api/cfm/land-use through CloudFront): `LandUseRequest` → `LandUseAnswer` (packages/wrsm/src/landuse).
// The fields and dams of one (sub-)catchment, cached per instance by (area hash, source). The request is geometry only
// (issue #3 rule 7), and the area's size is bounded before anything is read upstream.
import type { LandUseAnswer } from '@pitman/wrsm';
import { Hono } from 'hono';
import { damsInArea } from '../dams/inArea.js';
import { geometryAreaM2 } from '../geo/area.js';
import { parseArea } from '../http/area.js';
import { ResultCache } from '../http/cache.js';
import { ApiError, errorResponse } from '../http/errors.js';
import { clipFields } from './clip.js';
import { type LandUseSource, openLandUse } from './source.js';

/** The largest area one request reads, km²: a few of the largest quaternaries. */
export const CFM_MAX_AREA_KM2 = 10_000;
/** The most vertices an area may have here: clipping costs fields × vertices (cfm/clip.ts). */
export const CFM_MAX_AREA_VERTICES = 10_000;
/** How long one read may run before it stops (ms), under the Lambda's 30 s timeout. */
export const CFM_DEADLINE_MS = 25_000;
/** The largest answer (bytes of JSON): Lambda's synchronous response limit is 6 MB. */
export const MAX_LAND_USE_ANSWER_BYTES = 5 * 1024 * 1024;
/** Answers kept per instance: up to 5 MiB each, so 80 MiB at most. */
export const CFM_CACHE_ENTRIES = 16;

export interface LandUseRouteOptions {
	source: LandUseSource | { problem: string };
	deadlineMs?: number;
	cacheEntries?: number;
	maxAnswerBytes?: number;
	now?: () => number;
	/** Today's date, `YYYY-MM-DD` (`fetchedOn`). */
	today?: () => string;
}

export function landUseRoutes(opts: LandUseRouteOptions) {
	const cache = new ResultCache<string>(opts.cacheEntries ?? CFM_CACHE_ENTRIES);
	const now = opts.now ?? Date.now;
	const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
	const maxBytes = opts.maxAnswerBytes ?? MAX_LAND_USE_ANSWER_BYTES;
	const app = new Hono();
	app.post('/land-use', async (c) => {
		try {
			const body = await c.req.json().catch(() => {
				throw new ApiError(400, 'the body is not JSON');
			});
			const area = parseArea(body);
			const source = openLandUse(opts.source);
			const areaKm2 = (geometryAreaM2(area.geometry) ?? 0) / 1e6;
			if (areaKm2 > CFM_MAX_AREA_KM2) throw new ApiError(422, `the area is ${Math.round(areaKm2).toLocaleString('en-ZA')} km²; at most ${CFM_MAX_AREA_KM2.toLocaleString('en-ZA')} km² are read at once: choose a (sub-)catchment`);
			const vertices = area.geometry.coordinates.flat(area.geometry.type === 'Polygon' ? 1 : 2).length;
			if (vertices > CFM_MAX_AREA_VERTICES) throw new ApiError(422, `the area has ${vertices.toLocaleString('en-ZA')} vertices; at most ${CFM_MAX_AREA_VERTICES.toLocaleString('en-ZA')} are taken here: simplify it`);
			const started = now();
			const deadline = started + (opts.deadlineMs ?? CFM_DEADLINE_MS);
			// The date isn't part of the key: a cached answer keeps the day it was read.
			const json = await cache.get(`${area.hash}:${source.kind}:${source.dataset}`, async () => {
				const read = await source.read(area.geometry, { deadline, now });
				const { fields, failed } = clipFields(read.fields, area.geometry, () => {
					if (now() > deadline) throw new ApiError(504, 'clipping the fields took too long; try a smaller area');
				});
				const warnings = [...read.warnings, ...(failed > 0 ? [`${failed} field${failed === 1 ? '' : 's'} on the boundary could not be cut to the area and ${failed === 1 ? 'is' : 'are'} left out.`] : [])];
				const answer: LandUseAnswer = {
					fields,
					dams: damsInArea(read.dams, area.geometry),
					dataset: source.dataset,
					surveyYear: source.surveyYear,
					fetchedOn: today(),
					source: source.kind,
					...(warnings.length > 0 ? { warnings } : {})
				};
				const text = JSON.stringify(answer);
				if (text.length > maxBytes) throw new ApiError(422, `the area holds ${fields.length.toLocaleString('en-ZA')} fields, more than one answer carries; choose a smaller (sub-)catchment`);
				return text;
			});
			return c.body(json, 200, { 'content-type': 'application/json' });
		} catch (err) {
			return errorResponse(c, err);
		}
	});
	return Object.assign(app, { cache });
}
