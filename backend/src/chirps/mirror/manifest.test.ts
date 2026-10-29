// The hand-written manifest check (manifest.ts, IC-WBT's zod rules for the finals products): the
// fixture's manifest passes, and each rule refuses with a message naming it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_MIRROR_DIR } from '../../__tests__/fakeS3.js';
import { finalsCoverage, MirrorManifestError, parseManifest, readManifest } from './manifest.js';
import { openStore } from './store.js';

const raw = () => JSON.parse(readFileSync(join(FIXTURE_MIRROR_DIR, 'rnl/manifest.json'), 'utf8')) as Record<string, unknown> & { files: { url: string }[] };
const url = (y: number, m: number) => `https://x/chirps-v3.0.${y}.${String(m).padStart(2, '0')}.days_p05.nc`;

describe('parseManifest', () => {
	it('takes the committed fixture copy’s rnl manifest', async () => {
		const m = (await readManifest(openStore(`file://${FIXTURE_MIRROR_DIR}`), 'rnl'))!;
		expect(m).toMatchObject({ product: 'rnl', revision: 1, finalThrough: '2025-12-31', years: { first: 2023, last: 2025 } });
		expect(m.files).toHaveLength(36);
	});

	it('refuses a finalThrough past the contiguous months the files hold', () => {
		const m = raw();
		m.files = m.files.filter((f) => !f.url.includes('2024.06'));
		expect(() => parseManifest(m, 'rnl')).toThrow(/finalThrough runs past the months the files hold contiguously \(through 2024-05-31\)/);
	});

	it('refuses preliminary days on rnl, a wrong grid origin, a file from a later revision, another product, and non-JSON', async () => {
		expect(() => parseManifest({ ...raw(), prelimThrough: '2025-12-31' }, 'rnl')).toThrow(/rnl has no preliminary days/);
		expect(() => parseManifest({ ...raw(), grid: { origin: { lat: -35.5, lon: 10 }, step: 0.05 } }, 'rnl')).toThrow(/grid origin/);
		const later = raw();
		(later.files[0] as unknown as { revision: number }).revision = 2;
		expect(() => parseManifest(later, 'rnl')).toThrow(/later revision/);
		expect(() => parseManifest({ ...raw(), product: 'era5l' }, 'rnl')).toThrow(MirrorManifestError);
		expect(() => parseManifest(raw(), 'sat')).toThrow(/names product rnl/);
		const store = { get: async () => new TextEncoder().encode('{not json') };
		await expect(readManifest(store, 'rnl')).rejects.toThrow(/not valid JSON/);
	});

	it('reads a missing manifest as a product not held yet', async () => {
		expect(await readManifest({ get: async () => undefined }, 'rnl')).toBeNull();
	});
});

describe('finalsCoverage', () => {
	it('runs from the first month through the end of the contiguous run, a later month after a gap not counting', () => {
		expect(finalsCoverage([{ url: url(2024, 1) }, { url: url(2024, 2) }, { url: url(2024, 4) }])).toEqual({ from: '2024-01-01', through: '2024-02-29' });
		expect(finalsCoverage([{ url: url(2023, 12) }, { url: url(2024, 1) }])).toEqual({ from: '2023-12-01', through: '2024-01-31' });
		expect(finalsCoverage([{ url: 'nothing' }])).toBeNull();
	});
});
