import { describe, expect, it } from 'vitest';
import { readBundle } from './engine.js';
import { syntheticBundle, syntheticNetworkFiles, syntheticNetworkZip } from './synthetic.js';
import { unpackZip } from './zip.js';

describe('the synthetic network zip', () => {
	it('has a file for every .NET module and loads without errors or warnings', () => {
		const result = readBundle(syntheticNetworkFiles());
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.ok && result.bundle.modules.map((m) => `${m.kind}${m.number}`)).toEqual(['RU1', 'RU2', 'RU3', 'CR4']);
	});

	it('the channel reach takes routes 2 and 3 and sends route 4 out', () => {
		const cr = syntheticBundle().modules[3];
		expect(cr).toMatchObject({ kind: 'CR', principalOutflowRoute: 4, wetlandRainfallFile: null });
		if (cr?.kind === 'CR') expect(cr.inflows.map((r) => r.route)).toEqual([2, 3]);
	});

	it('unzips to the same files, in a folder when asked', () => {
		expect(unpackZip(syntheticNetworkZip())).toEqual(syntheticNetworkFiles());
		expect(Object.keys(syntheticNetworkFiles({ folder: 'SY' })).every((p) => p.startsWith('SY/'))).toBe(true);
	});

	it('is deterministic and follows the seed', () => {
		expect(syntheticNetworkZip()).toEqual(syntheticNetworkZip());
		expect(syntheticNetworkFiles({ seed: 2 })['SYA.RAN']).not.toBe(syntheticNetworkFiles({ seed: 1 })['SYA.RAN']);
	});
});
