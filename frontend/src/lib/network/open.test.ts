import { describe, expect, it } from 'vitest';
import { engineBundle, openNetwork, summarise } from './open.js';
import { syntheticNetworkFiles } from './synthetic.js';

describe('openNetwork', () => {
	it('loads a valid network', () => {
		const outcome = openNetwork(syntheticNetworkFiles());
		expect(outcome.kind).toBe('loaded');
	});

	it('asks which network when the folder holds several', () => {
		const files = syntheticNetworkFiles();
		const outcome = openNetwork({ ...files, 'SY2.NET': files['SY.NET']! });
		expect(outcome).toEqual({ kind: 'choose', networks: ['SY.NET', 'SY2.NET'] });
		expect(openNetwork({ ...files, 'SY2.NET': files['SY.NET']! }, 'SY2.NET').kind).toBe('loaded');
	});

	it('returns every error of an invalid network', () => {
		const files: Record<string, string> = syntheticNetworkFiles();
		delete files['SYA.RAN'];
		delete files['SYCR4.DAT'];
		const outcome = openNetwork(files);
		expect(outcome.kind).toBe('invalid');
		if (outcome.kind === 'invalid') expect(outcome.errors.map((e) => e.file).sort()).toEqual(['SYCR4.DAT', 'SYRU1.DAT']);
	});
});

describe('summarise / engineBundle', () => {
	const outcome = openNetwork(syntheticNetworkFiles());
	if (outcome.kind !== 'loaded') throw new Error('synthetic network did not load');

	it('counts modules by type, routes and files', () => {
		expect(summarise(outcome.bundle)).toEqual({
			code: 'SY',
			startYear: 1990,
			endYear: 1999,
			modules: [
				{ type: 'RU', label: 'runoff', count: 3 },
				{ type: 'CR', label: 'channel reach', count: 1 }
			],
			routes: 4,
			gauges: 0,
			rainfallFiles: 2,
			flowFiles: 0,
			notModelled: [],
			hasSidecar: false
		});
	});

	it('drops the file index for the worker', () => {
		const plain = engineBundle(outcome.bundle);
		expect('files' in plain).toBe(false);
		expect(plain.modules).toBe(outcome.bundle.modules);
	});
});
