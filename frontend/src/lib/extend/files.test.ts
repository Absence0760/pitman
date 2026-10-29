import type { NetworkBundle } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { syntheticBundle } from '#lib/network/synthetic.js';
import { rainfallFiles, usersLabel } from './files.js';
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
