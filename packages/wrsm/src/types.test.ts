import { describe, expect, expectTypeOf, it } from 'vitest';
import { RUN_MODE_KINDS } from './index.js';
import type {
	Module,
	Monthly12,
	Network,
	PitmanParameters,
	RunMode,
	RunoffModule,
	Sidecar,
	Twelve
} from './index.js';

// Compile-time checks that the contract describes a synthetic network the
// way later rounds will build one. Values are made up.

const twelve = (v: number): Monthly12 => [v, v, v, v, v, v, v, v, v, v, v, v];

const pitman: PitmanParameters = {
	POW: 2, SL: 0, ST: 150, FT: 20, GW: 5, ZMIN: 0, ZMAX: 300, PI: 1.5, TL: 0.25, GL: 2.5, R: 0.5, FF: 1
};

const runoff: RunoffModule = {
	kind: 'RU',
	number: 3,
	name: 'Synthetic basin',
	fileVersion: 7,
	fileVersionInFile: true,
	areaKm2: 120.5,
	mapMm: 640,
	rainfallFile: 'SYN.RAN',
	pitman,
	sPanMm: twelve(150),
	panFactors: twelve(0.9),
	afforestation: { algorithm: 1, algorithmInFile: true, areaKm2: [{ year: 1920, value: 0 }, { year: 2000, value: 4 }] },
	paved: { fraction: [] },
	outflows: [{ route: 10, percent: 100 }],
	inflowRoute: 0,
	upstreamGroundwaterModule: 0,
	groundwaterModel: 0,
	naturalised: false,
	sfrChildren: [31],
	aPanFactors: twelve(0.7)
};

const network: Network = {
	code: 'SYN',
	fileVersion: 1,
	inputDirectory: 'c:\\Synthetic\\',
	outputDirectory: 'c:\\Synthetic\\Out\\',
	debug: 'N',
	summaryFile: false,
	modules: [
		{ number: 3, type: 'RU', solve: true },
		{ number: 31, type: 'RU', solve: true }
	],
	gauges: [{ route: 10, label: 'G1', observedFile: 'G1.obs' }],
	startYear: 1920,
	endYear: 2009,
	routes: [{ number: 10, upstreamPosition: 1, downstreamPosition: 0, cost: 0 }],
	summaryLines: []
};

describe('contract', () => {
	it('accepts a synthetic runoff module and network', () => {
		const modules: Module[] = [runoff];
		expect(modules[0]?.kind).toBe('RU');
		expect(network.routes[0]?.upstreamPosition).toBe(1);
	});

	it('narrows modules on kind', () => {
		const m = runoff as Module;
		if (m.kind === 'RR') expectTypeOf(m.layout).toEqualTypeOf<'pitman' | 'wqt' | 'wqt4'>();
		if (m.kind === 'unparsed') expectTypeOf(m.moduleType).toEqualTypeOf<'RU' | 'RR' | 'RV' | 'CR' | 'MM'>();
	});

	it('has exactly twelve months', () => {
		expectTypeOf<Twelve<boolean>['length']>().toEqualTypeOf<12>();
		// @ts-expect-error eleven values are not a Monthly12
		const short: Monthly12 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
		expect(short).toHaveLength(11);
	});

	it('lists every run mode kind', () => {
		expectTypeOf<(typeof RUN_MODE_KINDS)[number]>().toEqualTypeOf<RunMode['kind']>();
		const modes: RunMode[] = [{ kind: 'presentDay', year: 2025 }, { kind: 'natural' }, { kind: 'historical' }];
		expect(modes.map((m) => m.kind)).toEqual([...RUN_MODE_KINDS]);
	});

	it('accepts a minimal sidecar', () => {
		const sidecar: Sidecar = { schema: 'pitman-sidecar', schemaVersion: 1 };
		expect(sidecar.schemaVersion).toBe(1);
	});
});
