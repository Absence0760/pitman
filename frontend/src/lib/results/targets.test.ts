import { describe, expect, it } from 'vitest';
import { bundle, natural, presentDay } from './fixtures.js';
import { defaultTarget, moduleLabel, observedFor, resultTargets, targetSeries } from './targets.js';

describe('resultTargets', () => {
	const groups = resultTargets(bundle, [presentDay, natural]);

	it('groups routes by the module they leave, in .NET order, reservoirs with their module', () => {
		expect(groups.map((g) => [g.label, g.targets.map((t) => t.label)])).toEqual([
			['RU 1 Upper', ['Route 1: RU 1 Upper to RV 2 Dam']],
			['RV 2 Dam', ['Reservoir RV 2 Dam: storage', 'Route 2: RV 2 Dam to CR 3']],
			['CR 3', ['Route 3: CR 3 to outside the network (gauge X1H001)']],
			['Flows from outside the network', ['Route 5: outside the network to RU 1 Upper']],
			['Not in the network file', ['Route 99']]
		]);
	});

	it('attaches the gauge and its observed flows (file names are upper-cased in the bundle)', () => {
		const route3 = groups.flatMap((g) => g.targets).find((t) => t.id === 'route-3');
		expect(route3?.gauge?.observedFile).toBe('x1h001.obs');
		expect(route3?.observed?.rows).toHaveLength(4);
	});

	it('opens on the first gauged route', () => {
		expect(defaultTarget(groups)?.id).toBe('route-3');
		expect(defaultTarget([])).toBeNull();
		expect(defaultTarget(resultTargets({ ...bundle, network: { ...bundle.network, gauges: [] } }, [presentDay]))?.id).toBe('route-1');
	});

	it('is empty without runs', () => {
		expect(resultTargets(bundle, [])).toEqual([]);
	});
});

describe('helpers', () => {
	it('labels modules by position', () => {
		expect(moduleLabel(bundle, 0)).toBe('outside the network');
		expect(moduleLabel(bundle, 3)).toBe('CR 3');
	});

	it('finds observed files with a directory or in another case', () => {
		const gauge = { route: 3, label: '', observedFile: 'C:\\Data\\X1h001.obs' };
		expect(observedFor(bundle, gauge)).not.toBeNull();
		expect(observedFor(bundle, { ...gauge, observedFile: 'none.obs' })).toBeNull();
	});

	it('reads a target series from a run', () => {
		expect(targetSeries(presentDay, { kind: 'reservoir', number: 2 })?.unit).toBe('Mm3');
		expect(targetSeries(presentDay, { kind: 'route', number: 42 })).toBeNull();
	});
});
