// The synthetic local copy (synthetic.ts, the dev server's default data): the real copy's layout and a
// valid manifest, read back by the same reader; deterministic for a seed; the invented coast NaN
// throughout; leap-year slots; whole months only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChirpsCopy, chirpsCopyConfig } from './copy.js';
import { openFinals, readFinalsBlock } from './mirror/arrays.js';
import { openStore } from './mirror/store.js';
import { lastCompleteMonthEnd, SYNTHETIC_BLOCK, SYNTHETIC_SEA_ROWS, writeSyntheticChirps } from './synthetic.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), 'pitman-synth-'));
	tmp.push(d);
	return d;
};

describe('writeSyntheticChirps', () => {
	it('writes a copy the reader opens, with a valid manifest from 1981-01 to `through`', async () => {
		const d = dir();
		const m = await writeSyntheticChirps({ dir: d, through: '1984-02-29' });
		expect(m).toMatchObject({ product: 'rnl', revision: 1, finalThrough: '1984-02-29', years: { first: 1981, last: 1984 } });
		expect(m.files).toHaveLength(3 * 12 + 2);
		const opened = await new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 'local', CHIRPS_LOCAL_DIR: d })).open();
		expect(opened.manifest.finalThrough).toBe('1984-02-29');
		expect(opened.finals.region).toEqual({ w: 10, s: -35.5, e: 41, n: -8 });
	});

	it('is the same for the same seed, and different for another', async () => {
		const read = async (seed: number) => {
			const d = dir();
			await writeSyntheticChirps({ dir: d, through: '1981-12-31', seed });
			const f = (await openFinals(openStore(`file://${d}/`), 'rnl'))!;
			return (await readFinalsBlock(f, 1981, 0, 364, SYNTHETIC_BLOCK)).values;
		};
		const [a, b, c] = [await read(1), await read(1), await read(2)];
		expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
		expect(Buffer.from(a.buffer).equals(Buffer.from(c.buffer))).toBe(false);
	});

	it('leaves the invented coast NaN every day and land rain ≥ 0, slot 365 only in a leap year', async () => {
		const d = dir();
		await writeSyntheticChirps({ dir: d, through: '1984-12-31' });
		const f = (await openFinals(openStore(`file://${d}/`), 'rnl'))!;
		const b = SYNTHETIC_BLOCK;
		const sea = await readFinalsBlock(f, 1983, 0, 364, { ...b, h: SYNTHETIC_SEA_ROWS });
		expect(sea.values.every(Number.isNaN)).toBe(true);
		const land = await readFinalsBlock(f, 1984, 0, 365, { ...b, y0: b.y0 + SYNTHETIC_SEA_ROWS, h: b.h - SYNTHETIC_SEA_ROWS });
		expect(land.values.every((v) => v >= 0)).toBe(true);
		expect(land.values.some((v) => v > 0)).toBe(true);
		const plain = await readFinalsBlock(f, 1983, 365, 365, { ...b, y0: b.y0 + SYNTHETIC_SEA_ROWS, h: 1 });
		expect(plain.values.every(Number.isNaN)).toBe(true);
	});

	it('refuses a `through` that isn’t the last day of a month, or before 1981', async () => {
		await expect(writeSyntheticChirps({ dir: dir(), through: '1984-02-28' })).rejects.toThrow(/last day of a month/);
		await expect(writeSyntheticChirps({ dir: dir(), through: '1980-12-31' })).rejects.toThrow(/1981 or later/);
	});
});

describe('lastCompleteMonthEnd', () => {
	it('is the last day of the month before today', () => {
		expect(lastCompleteMonthEnd(new Date('2026-10-29T12:00:00Z'))).toBe('2026-09-30');
		expect(lastCompleteMonthEnd(new Date('2024-03-01T00:00:00Z'))).toBe('2024-02-29');
		expect(lastCompleteMonthEnd(new Date('2026-01-15T00:00:00Z'))).toBe('2025-12-31');
	});
});
