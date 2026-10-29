/**
 * Synthetic results for the results-screen tests (issue #3 rule 2: no
 * client data). Not imported by the app.
 *
 * Network `SY`: RU 1 → route 1 → RV 2 → route 2 → CR 3 → route 3 → out,
 * route 5 from outside into RU 1, and a gauge `X1H001` on route 3. Runs
 * start in 2000 and last 3 years; route 99 is in the runs but not the network.
 */

import type { Module, MonthlySeries, NetworkBundle, ObservedRow, RunMode, RunResult, Twelve } from '@pitman/wrsm';

export const flow = (startYear: number, values: readonly number[]): MonthlySeries => ({ startYear, values, unit: 'Mm3PerMonth' });

/** 12 × years values: base + year index + month / 100. */
export function ramp(base: number, years: number): number[] {
	return Array.from({ length: 12 * years }, (_, i) => base + Math.floor(i / 12) + (i % 12) / 100);
}

const flags = (on: readonly number[] = []) => Array.from({ length: 12 }, (_, k) => on.includes(k)) as unknown as Twelve<boolean>;
export function observedRow(year: number, months: readonly number[], incomplete: readonly number[] = []): ObservedRow {
	return { year, months: months as unknown as Twelve<number>, incomplete: flags(incomplete), annualTotal: null, annualIncomplete: false };
}

const twelve = (v: number) => new Array<number>(12).fill(v);
const missing = twelve(4);
missing[2] = -99.999;

export const bundle: NetworkBundle = {
	network: {
		code: 'SY',
		fileVersion: 1,
		inputDirectory: 'C:\\SY\\',
		outputDirectory: 'C:\\SY\\Out\\',
		debug: 'N',
		summaryFile: false,
		modules: [
			{ number: 1, type: 'RU', solve: true },
			{ number: 2, type: 'RV', solve: true },
			{ number: 3, type: 'CR', solve: true }
		],
		gauges: [{ route: 3, label: 'X1H001    ', observedFile: 'x1h001.obs' }],
		startYear: 2000,
		endYear: 2002,
		routes: [
			{ number: 1, upstreamPosition: 1, downstreamPosition: 2, cost: 0 },
			{ number: 2, upstreamPosition: 2, downstreamPosition: 3, cost: 0 },
			{ number: 3, upstreamPosition: 3, downstreamPosition: 0, cost: 0 },
			{ number: 5, upstreamPosition: 0, downstreamPosition: 1, cost: 0 }
		],
		summaryLines: []
	},
	modules: [
		{ kind: 'RU', number: 1, name: 'Upper' } as unknown as Module,
		{ kind: 'RV', number: 2, name: 'Dam    ' } as unknown as Module
	],
	rainfall: {},
	observed: {
		'X1H001.OBS': { rows: [observedRow(1999, twelve(9)), observedRow(2000, twelve(3)), observedRow(2001, missing), observedRow(2002, twelve(5), [4])] }
	},
	flowFiles: {}
};

export function runResult(mode: RunMode, scale: number): RunResult {
	const s = (v: readonly number[]) => v.map((x) => x * scale);
	return {
		mode,
		startYear: 2000,
		endYear: 2002,
		routeFlows: {
			1: flow(2000, s(ramp(1, 3))),
			2: flow(2000, s(ramp(2, 3))),
			3: flow(2000, s(ramp(3, 3))),
			5: flow(2000, s(ramp(0.5, 3))),
			99: flow(2000, s(ramp(1, 3)))
		},
		reservoirStorage: { 2: { startYear: 2000, values: s(ramp(10, 3)), unit: 'Mm3' } },
		messages: []
	};
}

export const presentDay = runResult({ kind: 'presentDay', year: 2025 }, 1);
export const natural = runResult({ kind: 'natural' }, 1.5);
