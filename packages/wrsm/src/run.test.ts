import { describe, expect, it } from 'vitest';
import { readBundle, writeBundle } from './io/bundle.js';
import { syntheticBundle } from './network/index.js';
import { run } from './run.js';
import type { RunMode } from './types.js';

const MODES: readonly RunMode[] = [{ kind: 'presentDay', year: 2025 }, { kind: 'natural' }, { kind: 'historical' }];

describe('run() with the real simulators', () => {
	const bundle = syntheticBundle();
	const { startYear, endYear } = bundle.network;
	const months = 12 * (endYear - startYear + 1);

	it.each(MODES)('runs the synthetic network in $kind mode', (mode) => {
		const result = run(bundle, mode);
		expect(result.mode).toEqual(mode);
		expect(result.messages.filter((m) => m.level === 'error')).toEqual([]);
		for (const route of bundle.network.routes) {
			const series = result.routeFlows[route.number];
			expect(series?.values).toHaveLength(months);
			for (const v of series!.values) expect(Number.isFinite(v) && v >= 0).toBe(true);
		}
		expect(result.reservoirStorage[5]?.values).toHaveLength(months);
	});

	it('natural mode removes the dam, so its spill carries all its inflow', () => {
		const natural = run(bundle, { kind: 'natural' });
		expect(natural.routeFlows[5]!.values).toEqual(natural.routeFlows[2]!.values);
	});

	// The app's save → reload: a network read from files, written and read back,
	// runs identically. (The in-memory synthetic bundle itself is not the
	// starting point: writers round to each format's decimals.)
	it('gives identical results after a network read from files is saved and reloaded', () => {
		const loaded = readBundle(writeBundle(bundle));
		expect(loaded.errors).toEqual([]);
		if (!loaded.ok) return;
		const reloaded = readBundle(writeBundle(loaded.bundle));
		expect(reloaded.errors).toEqual([]);
		if (!reloaded.ok) return;
		for (const mode of MODES) expect(run(reloaded.bundle, mode)).toEqual(run(loaded.bundle, mode));
	});
});
