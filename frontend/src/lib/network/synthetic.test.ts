import { describe, expect, it } from 'vitest';
import { readBundle } from './engine.js';
import { syntheticBundle, syntheticNetworkFiles, syntheticNetworkZip } from './synthetic.js';
import { unpackZip } from './zip.js';

describe('the synthetic network zip', () => {
	it('has a file for every .NET module and loads without errors or warnings', () => {
		const result = readBundle(syntheticNetworkFiles());
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.ok && result.bundle.modules.map((m) => `${m.kind}${m.number}`)).toEqual(['RU1', 'RU2', 'RU3', 'RR6', 'RV5', 'CR4']);
	});

	it('has a reservoir, a channel reach and a gauge with observed flow', () => {
		const bundle = syntheticBundle();
		expect(bundle.modules.find((m) => m.kind === 'CR')).toMatchObject({ principalOutflowRoute: 4 });
		expect(bundle.modules.find((m) => m.kind === 'RV')).toMatchObject({ spillRoute: 5 });
		expect(bundle.network.gauges.map((g) => g.route)).toEqual([4]);
		expect(Object.values(bundle.observed)[0]?.rows.length).toBeGreaterThan(0);
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
