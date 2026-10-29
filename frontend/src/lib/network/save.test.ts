import { describe, expect, it } from 'vitest';
import { readBundle } from './engine.js';
import { fakeRun } from './fake-run.test-helper.js';
import { engineBundle, openNetwork } from './open.js';
import { saveFileName, saveFiles, saveZip, stampSidecar } from './save.js';
import { readSources } from './sources.js';
import { syntheticBundle, syntheticNetworkFiles, syntheticNetworkZip } from './synthetic.js';
import { unpackZip } from './zip.js';

const now = new Date('2026-10-29T08:00:00Z');
const options = { writtenBy: 'Pitman 0.0.1', now };

function loaded(files: Record<string, string>) {
	const outcome = openNetwork(files);
	if (outcome.kind !== 'loaded') throw new Error(JSON.stringify(outcome));
	return outcome.bundle;
}

describe('stampSidecar', () => {
	it('creates a sidecar when the network had none', () => {
		expect(stampSidecar(syntheticBundle(), options).sidecar).toEqual({
			schema: 'pitman-sidecar',
			schemaVersion: 1,
			writtenBy: 'Pitman 0.0.1',
			savedAt: '2026-10-29T08:00:00.000Z'
		});
	});

	it('keeps everything an existing sidecar holds', () => {
		const bundle = { ...syntheticBundle(), sidecar: { schema: 'pitman-sidecar' as const, schemaVersion: 1 as const, values: [] } };
		expect(stampSidecar(bundle, options).sidecar).toMatchObject({ values: [], writtenBy: 'Pitman 0.0.1' });
	});
});

describe('saveFiles / saveZip', () => {
	it('writes every loaded file back unchanged, plus pitman.json beside the .NET', () => {
		const files = syntheticNetworkFiles({ folder: 'SY' });
		const saved = saveFiles(loaded(files), options);
		expect(Object.keys(saved).sort()).toEqual([...Object.keys(files), 'SY/pitman.json'].sort());
		for (const [path, text] of Object.entries(files)) expect(saved[path], path).toBe(text);
		expect(JSON.parse(saved['SY/pitman.json']!)).toMatchObject({ schema: 'pitman-sidecar', savedAt: now.toISOString() });
	});

	it('keeps files no reader used (Out/, diagrams) in the zip', () => {
		const files = { ...syntheticNetworkFiles(), 'Out/SYRQ4.ANS': 'old output\r\n', 'diagram.pdf': '%PDF\x00\xff' };
		expect(unpackZip(saveZip(loaded(files), options))).toMatchObject({ 'Out/SYRQ4.ANS': 'old output\r\n', 'diagram.pdf': '%PDF\x00\xff' });
	});

	it('names the zip after what was loaded, else the network code', () => {
		const bundle = syntheticBundle();
		expect(saveFileName(bundle, 'H00 updated')).toBe('H00 updated.zip');
		expect(saveFileName(bundle, 'network')).toBe('SY.zip');
		expect(saveFileName(bundle)).toBe('SY.zip');
		expect(saveFileName(bundle, 'a/b:c')).toBe('a_b_c.zip');
	});
});

describe('the round trip the exit test checks: load → run → save → reload → same results', () => {
	it('gives identical networks and identical results from the saved zip', async () => {
		const zip = syntheticNetworkZip();
		const first = loaded(await readSources([{ path: 'SY.zip', size: zip.length, bytes: async () => zip }]));
		const modes = [{ kind: 'presentDay' as const, year: 2025 }, { kind: 'natural' as const }, { kind: 'historical' as const }];
		const before = modes.map((m) => fakeRun(engineBundle(first), m));

		const saved = saveZip(first, options);
		const second = loaded(await readSources([{ path: 'SY.zip', size: saved.length, bytes: async () => saved }]));
		const after = modes.map((m) => fakeRun(engineBundle(second), m));

		expect(engineBundle(second)).toEqual({ ...engineBundle(first), sidecar: second.sidecar });
		expect(after).toEqual(before);
		// And a second save of the reloaded network is the same zip.
		expect(saveZip(second, options)).toEqual(saved);
	});

	it('the saved zip reads with no errors or warnings', () => {
		const result = readBundle(unpackZip(saveZip(syntheticBundle(), options)));
		expect([result.ok, result.errors, result.warnings]).toEqual([true, [], []]);
	});
});
