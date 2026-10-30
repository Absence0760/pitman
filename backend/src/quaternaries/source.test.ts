import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURE_GEO_DIR } from '../__tests__/fakeS3.js';
import { CopyUnavailableError } from '../chirps/copy.js';
import { MAX_QUATERNARY_ANSWER_BYTES, parseQuaternaries, QuaternaryStore, quaternarySourceFromEnv } from './source.js';

const FIXTURE = join(FIXTURE_GEO_DIR, 'quaternaries.synthetic.geojson');
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
function file(text: string) {
	const dir = mkdtempSync(join(tmpdir(), 'pitman-q-'));
	tmp.push(dir);
	const path = join(dir, 'q.geojson');
	writeFileSync(path, text);
	return path;
}
const square = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

describe('quaternarySourceFromEnv', () => {
	it('is not configured when unset, and says so (D-1)', () => {
		expect(quaternarySourceFromEnv({})).toEqual({ problem: expect.stringContaining('QUATERNARIES_SOURCE is not set') });
		expect(quaternarySourceFromEnv({ QUATERNARIES_SOURCE: ' ' })).toEqual({ problem: expect.stringContaining('D-1') });
	});
	it('takes only local, with a file', () => {
		expect(quaternarySourceFromEnv({ QUATERNARIES_SOURCE: 's3://b/k' })).toEqual({ problem: expect.stringContaining('must be local') });
		expect(quaternarySourceFromEnv({ QUATERNARIES_SOURCE: 'local' })).toEqual({ problem: expect.stringContaining('QUATERNARIES_LOCAL_FILE') });
	});
	it('credits the file by name when no credit is set', () => {
		expect(quaternarySourceFromEnv({ QUATERNARIES_SOURCE: 'local', QUATERNARIES_LOCAL_FILE: 'a/b.geojson' })).toMatchObject({ credit: 'b.geojson' });
		expect(quaternarySourceFromEnv({ QUATERNARIES_SOURCE: 'local', QUATERNARIES_LOCAL_FILE: 'a/b.geojson', QUATERNARIES_CREDIT: 'Invented' })).toMatchObject({ credit: 'Invented' });
	});
});

describe('parseQuaternaries', () => {
	it('sends only the code, area and MAP, whatever else the file holds', () => {
		const q = parseQuaternaries({ features: [{ properties: { code: 'Z01A', areaKm2: 5, mapMm: 600, marMm3: 9, source: 'x' }, geometry: square }] }, 'credit');
		expect(q).toEqual({ type: 'FeatureCollection', source: 'credit', features: [{ type: 'Feature', properties: { code: 'Z01A', areaKm2: 5, mapMm: 600 }, geometry: square }] });
	});
	it('leaves out a value that is not a positive number', () => {
		const q = parseQuaternaries({ features: [{ properties: { code: 'Z01A', areaKm2: 0, mapMm: 'x' }, geometry: square }] }, 'c');
		expect((q as Exclude<typeof q, string>).features[0]?.properties).toEqual({ code: 'Z01A' });
	});
	it('refuses a file it cannot use, saying which feature', () => {
		expect(parseQuaternaries({ features: [] }, 'c')).toBe('it holds no features');
		expect(parseQuaternaries({ features: [{ properties: { code: 'nope' }, geometry: square }] }, 'c')).toBe('feature 1 has no quaternary code');
		expect(parseQuaternaries({ features: [{ properties: { code: 'Z01A' }, geometry: { type: 'Point', coordinates: [0, 0] } }] }, 'c')).toBe('Z01A is not a Polygon or MultiPolygon');
		expect(parseQuaternaries(null, 'c')).toBe('it holds no features');
	});
});

describe('QuaternaryStore', () => {
	it('reads the committed synthetic region', () => {
		const q = JSON.parse(new QuaternaryStore({ file: FIXTURE, credit: 'Invented' }).body()) as { source: string; features: { properties: Record<string, unknown> }[] };
		expect(q.source).toBe('Invented');
		expect(q.features.length).toBeGreaterThan(1);
		for (const f of q.features) {
			expect(f.properties['code']).toMatch(/^Z/);
			expect(Object.keys(f.properties).sort()).toEqual(['areaKm2', 'code', 'mapMm']);
		}
	});
	it('throws what the 503 says when nothing is configured or the file is missing or bad', () => {
		expect(() => new QuaternaryStore({ problem: 'nope' }).body()).toThrow(CopyUnavailableError);
		expect(() => new QuaternaryStore({ file: '/nonexistent/q.geojson', credit: 'c' }).body()).toThrow('no quaternary boundary file');
		expect(() => new QuaternaryStore({ file: file('not json'), credit: 'c' }).body()).toThrow('not JSON');
		expect(() => new QuaternaryStore({ file: file('{"features":[]}'), credit: 'c' }).body()).toThrow('holds no features');
	});
	it('refuses a file larger than one answer, in words', () => {
		const huge = JSON.stringify({ features: [{ properties: { code: 'Z01A' }, geometry: { type: 'Polygon', coordinates: new Array(MAX_QUATERNARY_ANSWER_BYTES / 2).fill(0) } }] });
		expect(() => new QuaternaryStore({ file: file(huge), credit: 'c' }).body()).toThrow('larger than one answer');
	});
});
