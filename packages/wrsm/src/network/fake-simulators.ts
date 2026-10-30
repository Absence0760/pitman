/**
 * Pass-through fake simulators for tests of the network runner and its
 * callers (the app's worker, the CLI) before the real ones are wired: simple
 * enough that a test can account for every m³ they move.
 *
 * - Reservoir: a bucket of capacity `capacity[0]` (0 in natural mode, so
 *   the dam is removed and inflow passes to the spill route, contract.ts),
 *   starting at `initialStorageMm3`; meets a calculated demand from storage
 *   as far as it goes; spills what's above capacity down the spill route;
 *   other outflows carry zero.
 * - Channel: sums its simulated inflows and its defined inflows
 *   (`definedFlowSeries` in the run mode), loses up to `bedLossMm3PerMonth`
 *   each month, meets defined outflows and then calculated demands from
 *   what's left, and passes the rest down the principal route; other
 *   outflows carry zero.
 *
 * Every loss and every initial storage is recorded in `ledger`.
 */

import { definedFlowSeries, zeroSeries, type ModuleRunContext, type ModuleSimulators, type RouteFlows } from './contract.js';
import type { ChannelModule, MonthlySeries, ReservoirModule } from '../types.js';

export interface Ledger {
	/** Initial storage per reservoir module number, million m³. */
	readonly initialStorage: Map<number, number>;
	/** Losses per month (summed over modules), million m³. */
	readonly lossPerMonth: number[];
	readonly calls: string[];
}

function sumInflows(inflows: RouteFlows, length: number): number[] {
	const out = new Array<number>(length).fill(0);
	for (const s of Object.values(inflows)) s.values.forEach((v, i) => (out[i]! += v));
	return out;
}

const series = (ctx: ModuleRunContext, values: number[]): MonthlySeries => ({ startYear: ctx.startYear, values, unit: 'Mm3' });

export function fakeSimulators(): { simulators: ModuleSimulators; ledger: Ledger } {
	const ledger: Ledger = { initialStorage: new Map(), lossPerMonth: [], calls: [] };
	const addLoss = (i: number, v: number) => {
		while (ledger.lossPerMonth.length <= i) ledger.lossPerMonth.push(0);
		ledger.lossPerMonth[i]! += v;
	};
	const reservoir = (m: ReservoirModule, inflows: RouteFlows, ctx: ModuleRunContext, demands: RouteFlows = {}) => {
		ledger.calls.push(`RV${m.number}`);
		const length = zeroSeries(ctx.startYear, ctx.endYear).values.length;
		const natural = ctx.mode.kind === 'natural';
		const capacity = natural ? 0 : (m.capacity[0]?.fullSupplyVolumeMm3 ?? 0);
		let storage = natural ? 0 : (m.initialStorageMm3 ?? capacity / 2);
		ledger.initialStorage.set(m.number, storage);
		const inflow = sumInflows(inflows, length);
		const spill: number[] = [];
		const stored: number[] = [];
		const drafts = Object.entries(demands).map(([route, s]) => ({ route: Number(route), demand: s.values, supply: [] as number[] }));
		for (let i = 0; i < length; i++) {
			storage += inflow[i]!;
			for (const d of drafts) {
				const take = Math.min(storage, d.demand[i]!);
				d.supply.push(take);
				storage -= take;
			}
			const s = Math.max(0, storage - capacity);
			storage -= s;
			spill.push(s);
			stored.push(storage);
		}
		const outflows: Record<number, MonthlySeries> = {};
		for (const o of m.outflows) outflows[o.route] = zeroSeries(ctx.startYear, ctx.endYear);
		for (const d of drafts) outflows[d.route] = series(ctx, d.supply);
		outflows[m.spillRoute] = series(ctx, spill);
		return { outflows, storage: series(ctx, stored), messages: [] };
	};
	const channel = (m: ChannelModule, inflows: RouteFlows, ctx: ModuleRunContext, demands: RouteFlows = {}) => {
		ledger.calls.push(`CR${m.number}`);
		const length = zeroSeries(ctx.startYear, ctx.endYear).values.length;
		const total = sumInflows(inflows, length);
		const read = (name: string) => definedFlowSeries(ctx.flowFile(name)!, ctx.mode, ctx.startYear, ctx.endYear).series.values;
		for (const c of m.inflows) if (c.definedFlowFile) read(c.definedFlowFile).forEach((v, i) => (total[i]! += v));
		const outflows: Record<number, MonthlySeries> = {};
		const defined = m.outflows.filter((o) => o.definedFlowFile).map((o) => ({ route: o.route, demand: read(o.definedFlowFile!), supply: [] as number[] }));
		for (const [route, s] of Object.entries(demands)) defined.push({ route: Number(route), demand: [...s.values], supply: [] });
		const principal: number[] = [];
		for (let i = 0; i < length; i++) {
			const loss = Math.min(total[i]!, m.bedLossMm3PerMonth);
			addLoss(i, loss);
			let left = total[i]! - loss;
			for (const d of defined) {
				const take = Math.min(left, d.demand[i]!);
				d.supply.push(take);
				left -= take;
			}
			principal.push(left);
		}
		for (const o of m.outflows) outflows[o.route] = zeroSeries(ctx.startYear, ctx.endYear);
		for (const d of defined) outflows[d.route] = series(ctx, d.supply);
		outflows[m.principalOutflowRoute] = series(ctx, principal);
		return { outflows, messages: [] };
	};
	return { simulators: { reservoir, channel }, ledger };
}
