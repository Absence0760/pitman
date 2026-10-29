import type { NetworkBundle } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { syntheticBundle } from '#lib/network/synthetic.js';
import { originalSeries, rainfallFiles, usersLabel } from './files.js';
import { extensionOf } from './fixtures.test-helper.js';


describe('rainfallFiles', () => {
	it('lists each .RAN with its years and the modules that read it, case-insensitively', () => {
		const files = rainfallFiles(syntheticBundle());
		expect(files.map((f) => [f.key, f.name, f.code, f.firstYear, f.lastYear])).toEqual([
			['SYA.RAN', 'SYA.RAN', expect.any(String), 1990, 1999],
			['SYB.RAN', 'syb.RAN', expect.any(String), 1990, 1999]
		]);
		expect(usersLabel(files[0]?.users ?? [])).toBe('RU 1 (Synthetic 1), RU 2 (Synthetic 2), RR 6 (Synthetic irrigation), RV 5 (Synthetic dam)');
		expect(usersLabel(files[1]?.users ?? [])).toBe('RU 3 (Synthetic 3)');
		expect(files.every((f) => f.extension === undefined && f.originalEndYear === f.lastYear)).toBe(true);
	});

	it('says when no module reads a file', () => {
		expect(usersLabel([])).toBe('no module');
	});

	it('takes the original end year from an earlier extension in the sidecar', () => {
		const base = syntheticBundle();
		const bundle: NetworkBundle = { ...base, sidecar: { schema: 'pitman-sidecar', schemaVersion: 1, rainfallExtensions: { 'SYA.RAN': extensionOf('SYA.RAN', 1995, 1999) } } };
		const sya = rainfallFiles(bundle)[0];
		expect(sya?.extension?.originalEndYear).toBe(1995);
		expect(sya?.originalEndYear).toBe(1995);
	});
});

describe('originalSeries', () => {
	it('cuts an extended file back to its original record, keeping its source', () => {
		const series = syntheticBundle().rainfall['SYA.RAN']!;
		const withSource = { ...series, source: { lines: ['x'], finalNewline: true } };
		const cut = originalSeries(withSource, 1995);
		expect(cut.rows.map((r) => r.year)).toEqual([1990, 1991, 1992, 1993, 1994, 1995]);
		expect(cut.source).toBe(withSource.source);
		expect(originalSeries(series, 1999)).toBe(series);
	});
});
