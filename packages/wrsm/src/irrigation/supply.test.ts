import { describe, expect, it } from 'vitest';
import type { IrrigationModule, RunMode } from '../types.js';
import { irrigationDemand } from './demand.js';
import { pitmanBlock, rainfallOf, twelve, variedRainfall, wqt4Block, wqtBlock } from './fixtures.js';
import { effectiveStoreMonth, nonEffectiveStoreMonth, settleIrrigation, type IrrigationSettlement } from './supply.js';

const HISTORICAL: RunMode = { kind: 'historical' };
const flatRain = (pc = 5) => rainfallOf([[2000, pc]]);
const full = (module: IrrigationModule, rain = flatRain()) => {
	const demand = irrigationDemand(module, rain, HISTORICAL, 2000, 2000);
	return { demand, settled: settleIrrigation(module, demand, demand.gross.values) };
};

/** Residual of the block's water balance per month (spec §10). */
function residual(s: IrrigationSettlement): number[] {
	return s.supply.values.map((supply, t) => {
		const before = t === 0 ? s.initialSoilStorage : s.soilStorage.values[t - 1]!;
		const gain = supply + s.rainOnLand.values[t]! + s.landTransfer.values[t]!;
		const loss =
			s.returnFlow.values[t]! + s.conveyanceLoss.values[t]! + s.efficiencyLoss.values[t]! + s.evapotranspiration.values[t]! + s.deepPercolation.values[t]! + s.catchmentRunoff.values[t]! + (s.soilStorage.values[t]! - before);
		return gain - loss;
	});
}

describe('the Pitman return flow, TT 690 eq. 3.4', () => {
	it('returns RRPERC % of what was supplied, not of what was demanded', () => {
		const module = pitmanBlock();
		const demand = irrigationDemand(module, flatRain(), HISTORICAL, 2000, 2000);
		const half = demand.gross.values.map((v) => v / 2);
		const s = settleIrrigation(module, demand, half);
		expect(s.returnFlow.values[0]).toBeCloseTo(0.1 * half[0]!, 12);
		expect(s.evapotranspiration.values[0]).toBeCloseTo(0.9 * half[0]!, 12);
	});
});

describe('the effective store, TT 690 eqs. 4.15–4.29', () => {
	it('closes below the target (eqs. 4.20, 4.24, with the sign of RF corrected)', () => {
		const m = effectiveStoreMonth(200, 100, 30, 2, 120, 180, 250, 400, 0.02);
		const hm = 0.5 * (200 + m.hef);
		expect(m.ete).toBeCloseTo((120 / 250) * hm, 10);
		expect(m.re).toBeCloseTo(2 + hm * 0.02, 10);
		expect(m.hef).toBeCloseTo(200 + 100 + 30 - m.ete - m.re, 10); // eq. 4.15 with −ETE
		expect(hm).toBeLessThan(250);
	});

	it('closes above the target with PEL over TCD (eqs. 4.21, 4.25)', () => {
		const m = effectiveStoreMonth(300, 200, 30, 0, 120, 180, 250, 400, 0.02);
		const hm = 0.5 * (300 + m.hef);
		expect(hm).toBeGreaterThan(250);
		expect(m.ete).toBeCloseTo(120 + ((hm - 250) / 150) * 60, 10);
		expect(m.hef).toBeCloseTo(300 + 200 + 30 - m.ete - m.re, 10);
	});

	it('closes above the target with PEL under TCD (eqs. 4.22, 4.26)', () => {
		const m = effectiveStoreMonth(300, 200, 30, 0, 120, 100, 250, 400, 0.02);
		expect(m.ete).toBe(120);
		expect(m.hef).toBeCloseTo(300 + 200 + 30 - 120 - m.re, 10);
	});

	it('spills the excess over HSU into the seepage (eq. 4.28)', () => {
		const m = effectiveStoreMonth(390, 300, 300, 0, 100, 100, 250, 400, 0.02);
		expect(m.hef).toBe(400);
		expect(390 + 600 - m.ete - m.re).toBeCloseTo(400, 10);
		expect(m.re).toBeGreaterThan(100);
	});

	it('is continuous where Figure 4.2 bends: no jump in HEF across the target', () => {
		const at = (din: number) => effectiveStoreMonth(250, din, 0, 0, 120, 180, 250, 400, 0.02).hef;
		for (let din = 100; din < 160; din += 0.5) expect(Math.abs(at(din + 0.5) - at(din))).toBeLessThan(1);
	});

	it('stays dry rather than going negative, taking the shortfall from ET (R7-I11)', () => {
		const m = effectiveStoreMonth(1, 0, 0, 0, 500, 500, 10, 400, 0.02);
		expect(m.hef).toBe(0);
		expect(m.ete + m.re).toBeCloseTo(1, 10);
		expect(m.ete).toBeGreaterThanOrEqual(0);
	});

	it('copes with a zero target (no division)', () => {
		expect(Number.isFinite(effectiveStoreMonth(100, 50, 10, 0, 40, 50, 0, 400, 0.02).hef)).toBe(true);
	});
});

describe('the non-effective store, TT 690 eqs. 4.16, 4.19, 4.23, 4.27', () => {
	it('closes on PP alone, ET proportional to depth', () => {
		const m = nonEffectiveStoreMonth(200, 30, 2, 180, 400, 0.02);
		const hm = 0.5 * (200 + m.hef);
		expect(m.ete).toBeCloseTo((180 / 400) * hm, 10);
		expect(m.re).toBeCloseTo(2 + hm * 0.02, 10);
		expect(m.hef).toBeCloseTo(200 + 30 - m.ete - m.re, 10);
	});

	it('spills over HSU (eq. 4.29)', () => {
		const m = nonEffectiveStoreMonth(399, 500, 0, 10, 400, 0.02);
		expect(m.hef).toBe(400);
	});
});

describe('WQT types 2 and 3 on the land', () => {
	it('at full supply the whole target area is effective and DIN reaches the store (eqs. 4.3, 4.7)', () => {
		const { demand, settled } = full(wqtBlock({ canalFlowLoss: 0.1 }));
		expect(settled.effectiveAreaKm2[0]).toBe(10);
		expect(settled.nonEffectiveAreaKm2[0]).toBe(0);
		expect(settled.application.values[0]).toBeCloseTo(demand.gross.values[0]! * 0.9, 12);
		expect(settled.efficiencyLoss.values[0]).toBeCloseTo(demand.gross.values[0]! * 0.9 * 0.2, 12);
	});

	it('shrinks the effective area to the supply and leaves the rest non-effective (eqs. 4.7, 4.9)', () => {
		const module = wqtBlock();
		const demand = irrigationDemand(module, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(module, demand, demand.gross.values.map((v) => v * 0.25));
		expect(s.effectiveAreaKm2[0]).toBeCloseTo(2.5, 10);
		expect(s.nonEffectiveAreaKm2[0]).toBeCloseTo(7.5, 10);
		// The water left reaches its smaller area at the full unit demand.
		expect(s.soilMoistureMm.values[0]).toBeCloseTo(full(module).settled.soilMoistureMm.values[0]!, 10);
	});

	it('gives no effective area on no supply, and the block lives on rain', () => {
		const module = wqtBlock();
		const demand = irrigationDemand(module, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(module, demand, new Array<number>(12).fill(0));
		expect(s.effectiveAreaKm2[0]).toBe(0);
		expect(s.application.values[0]).toBe(0);
		expect(residual(s).every((r) => Math.abs(r) < 1e-10)).toBe(true);
	});

	it('moves depth with the land when the effective area changes (eqs. 4.10–4.14)', () => {
		const module = wqtBlock();
		const demand = irrigationDemand(module, flatRain(), HISTORICAL, 2000, 2000);
		const supply = demand.gross.values.map((v, t) => (t === 1 ? 0 : v));
		const s = settleIrrigation(module, demand, supply);
		// Land moved but the block's area did not: no soil water comes or goes with it.
		expect(s.landTransfer.values.every((v) => Math.abs(v) < 1e-12)).toBe(true);
		expect(residual(s).every((r) => Math.abs(r) < 1e-10)).toBe(true);
	});

	it('brings soil water in with new land and sends it out with lost land', () => {
		const module = wqtBlock({ areaKm2: [{ year: 2000, value: 10 }, { year: 2001, value: 20 }, { year: 2002, value: 5 }] });
		const rain = rainfallOf([[2000, 5], [2001, 5], [2002, 5]]);
		const demand = irrigationDemand(module, rain, HISTORICAL, 2000, 2002);
		const s = settleIrrigation(module, demand, demand.gross.values);
		expect(s.landTransfer.values[12]).toBeGreaterThan(0);
		expect(s.landTransfer.values[24]).toBeLessThan(0);
		expect(residual(s).every((r) => Math.abs(r) < 1e-10)).toBe(true);
	});

	it('sends out the store\'s depth with land that leaves the block', () => {
		const module = wqtBlock({ areaKm2: [{ year: 2000, value: 20 }, { year: 2001, value: 10 }] });
		const demand = irrigationDemand(module, rainfallOf([[2000, 5], [2001, 5]]), HISTORICAL, 2000, 2001);
		const s = settleIrrigation(module, demand, demand.gross.values);
		expect(s.landTransfer.values[12]).toBeCloseTo((-s.soilMoistureMm.values[11]! * 10) / 1000, 12);
	});

	it('adds the canal seepage back into the return (eqs. 4.55, 4.56)', () => {
		const without = full(wqtBlock({ canalFlowLoss: 0.2, canalSeepageToReturn: 0 })).settled;
		const withIt = full(wqtBlock({ canalFlowLoss: 0.2, canalSeepageToReturn: 0.5 })).settled;
		const supply = withIt.supply.values[0]!;
		expect(withIt.returnFlow.values[0]! - without.returnFlow.values[0]!).toBeCloseTo(0.5 * 0.2 * supply, 12);
		expect(withIt.conveyanceLoss.values[0]).toBeCloseTo(0.5 * 0.2 * supply, 12);
	});

	it('leaves QC with the runoff module for a net return, carries it for a total one (TT 689 p.106, R7-I13)', () => {
		const qc = new Array<number>(12).fill(3);
		const net = wqtBlock();
		const total = wqtBlock({ netReturnFlows: false });
		const dn = irrigationDemand(net, flatRain(), HISTORICAL, 2000, 2000);
		const sn = settleIrrigation(net, dn, dn.gross.values, qc);
		const st = settleIrrigation(total, dn, dn.gross.values, qc);
		expect(sn.catchmentRunoff.values[0]).toBeCloseTo(0.03, 12); // 3 mm over 10 km²
		expect(st.catchmentRunoff.values[0]).toBe(0);
		expect(st.returnFlow.values[0]! - sn.returnFlow.values[0]!).toBeCloseTo(0.03, 12);
		expect(residual(sn).every((r) => Math.abs(r) < 1e-10)).toBe(true);
		expect(residual(st).every((r) => Math.abs(r) < 1e-10)).toBe(true);
	});

	it('uses the same soil balance for SAPWAT', () => {
		const block = wqtBlock({ modelType: 3, crops: [{ factors: twelve(150), percent: 100, description: 'r' }] });
		expect(full(block).settled.soilMoistureMm.values[0]).toBeGreaterThan(0);
		expect(residual(full(block).settled).every((r) => Math.abs(r) < 1e-10)).toBe(true);
	});
});

describe('WQT type 4 canal, spill and application, TT 690 §6.6.6', () => {
	const block = wqt4Block({ canalFlowLoss: 0.2, canalTransmissionLoss: 0.25, canalSeepageToReturn: 0.5, canalEndSpill: 0.1, returnFlowFactor: 0 });

	it('splits the supply as eqs. 6.30–6.35 and 6.30a do', () => {
		const demand = irrigationDemand(block, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(block, demand, new Array<number>(12).fill(1.1));
		const qig = 1.1;
		const qis = (qig * 0.8) / 1.1; // eq. 6.30a
		expect(s.application.values[0]).toBeCloseTo(qis, 12);
		// QTLE = 0.055, QTLS = 0.165, QTLR = 0.0825, QTLD = 0.0825
		expect(s.conveyanceLoss.values[0]).toBeCloseTo(0.055 + 0.0825, 12);
		expect(s.returnFlow.values[0]).toBeCloseTo(0.0825 + qis * 0.1, 12); // QTLR + QEND, no soil return with RRLF = 0
	});

	it('the canal terms add back to the supply', () => {
		const demand = irrigationDemand(block, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(block, demand, new Array<number>(12).fill(1.1));
		const qend = s.application.values[0]! * 0.1;
		expect(s.application.values[0]! + qend + s.conveyanceLoss.values[0]! + 0.0825).toBeCloseTo(1.1, 12);
	});
});

describe('the WQT type 4 tank, TT 690 §6.6.7', () => {
	const tank = (over = {}) =>
		wqt4Block({ returnFlowFactor: 0.02, returnFlowUpperZone: 0.75, returnFlowLowerZone: 0.15, soilMoistureInitialMm: 250, panFactors: twelve(0.5), ...over });

	it('solves S2 by eq. 6.42 and returns by eqs. 6.37–6.39', () => {
		const module = tank();
		const demand = irrigationDemand(module, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(module, demand, new Array<number>(12).fill(1));
		// F = 0.02 × 0.9 + 100 / 700; QIS = 1 million m³ = 100 mm on 10 km²; RAIN = 30 mm.
		const f = 0.018 + 100 / 700;
		const s2 = (250 * (1 - 0.5 * f) + 30 + 100) / (1 + 0.5 * f);
		expect(s.soilMoistureMm.values[0]).toBeCloseTo(s2, 10);
		const qiout = (0.5 * (250 + s2) * 0.02 * 10) / 1000;
		expect(s.returnFlow.values[0]).toBeCloseTo(qiout * 0.9, 12);
	});

	it('takes rain out of the tank in a month with no irrigation (eq. 6.36a)', () => {
		const module = tank();
		const demand = irrigationDemand(module, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(module, demand, new Array<number>(12).fill(0));
		expect(s.rainOnLand.values[0]).toBe(0);
		const f = 0.018 + 100 / 700;
		expect(s.soilMoistureMm.values[0]).toBeCloseTo((250 * (1 - 0.5 * f)) / (1 + 0.5 * f), 10);
	});

	it('sends deep percolation down with the return, in proportion (eq. 6.40)', () => {
		const module = tank({ deepSeatedGroundwater: 0.1 });
		const demand = irrigationDemand(module, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(module, demand, new Array<number>(12).fill(1));
		expect(s.deepPercolation.values[0]! / s.returnFlow.values[0]!).toBeCloseTo(0.1 / 0.9, 10);
	});

	it('stops the tank at RRHMAX, the excess evaporating (eqs. 6.44a–b)', () => {
		const module = tank({ maxUpperZoneStorageMm: 300, soilMoistureInitialMm: 290 });
		const demand = irrigationDemand(module, flatRain(50), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(module, demand, new Array<number>(12).fill(2));
		expect(s.soilMoistureMm.values[0]).toBe(300);
		expect(residual(s).every((r) => Math.abs(r) < 1e-10)).toBe(true);
	});

	it('stops the tank at RRHMIN and closes it, the outflows giving way (eqs. 6.43a–b, R7-I11)', () => {
		const module = tank({ minUpperZoneStorageMm: 50, maxUpperZoneStorageMm: 60, soilMoistureInitialMm: 55, returnFlowFactor: 0.5 });
		const demand = irrigationDemand(module, flatRain(0), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(module, demand, new Array<number>(12).fill(0));
		expect(s.soilMoistureMm.values.every((v) => v >= 50)).toBe(true);
		expect(s.evapotranspiration.values.every((v) => v >= 0)).toBe(true);
		expect(s.returnFlow.values.every((v) => v >= 0)).toBe(true);
		expect(residual(s).every((r) => Math.abs(r) < 1e-10)).toBe(true);
	});

	it('at RRHMIN evaporation gives way and the return stays as eq. 6.37 has it (eq. 6.43a, pp.53–54)', () => {
		// F = 0.02 × 0.9 + 120 / 50 = 2.418: S2 comes out below RRHMIN.
		const module = tank({ minUpperZoneStorageMm: 50, maxUpperZoneStorageMm: 100, soilMoistureInitialMm: 100, panFactors: twelve(1), panMm: twelve(120) });
		const demand = irrigationDemand(module, flatRain(0), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(module, demand, new Array<number>(12).fill(0));
		expect(s.soilMoistureMm.values[0]).toBe(50);
		expect(s.returnFlow.values[0]).toBeCloseTo((25 * 0.02 * 0.9 * 10) / 1000, 12); // 0.0045
		expect(s.evapotranspiration.values[0]).toBeCloseTo(0.5 - 0.0045, 12); // the 50 mm the tank lost, less the return
	});

	it('keeps eqs. 6.37 and 6.41 exact between the limits: nothing is left for QE to hide', () => {
		const module = tank();
		const demand = irrigationDemand(module, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(module, demand, new Array<number>(12).fill(0.5)); // 50 + 30 mm a month: settles near 500 mm
		let s1 = 250;
		for (let t = 0; t < 12; t++) {
			const s2 = s.soilMoistureMm.values[t]!;
			expect(s2).toBeGreaterThan(0);
			expect(s2).toBeLessThan(700);
			const bar = 0.5 * (s1 + s2);
			expect(s.evapotranspiration.values[t]).toBeCloseTo(((bar * 100) / 700 / 1000) * 10, 10);
			expect(s.returnFlow.values[t]).toBeCloseTo(((bar * 0.02 * 0.9) / 1000) * 10, 10);
			s1 = s2;
		}
	});

	it('moves depth × the change in area with the land', () => {
		const module = tank({ areaKm2: [{ year: 2000, value: 10 }, { year: 2001, value: 20 }] });
		const demand = irrigationDemand(module, rainfallOf([[2000, 5], [2001, 5]]), HISTORICAL, 2000, 2001);
		const s = settleIrrigation(module, demand, demand.gross.values);
		expect(s.landTransfer.values[12]).toBeCloseTo((s.soilMoistureMm.values[11]! * 10) / 1000, 12);
		expect(s.landTransfer.values.filter((v) => v !== 0)).toHaveLength(1);
	});

	it('refuses a tank with no range, and clamps a start outside it', () => {
		const flat = tank({ maxUpperZoneStorageMm: 50, minUpperZoneStorageMm: 50 });
		const demand = irrigationDemand(flat, flatRain(), HISTORICAL, 2000, 2000);
		expect(() => settleIrrigation(flat, demand, demand.gross.values)).toThrow(/L\.038/);
		const out = tank({ minUpperZoneStorageMm: 300 });
		const d2 = irrigationDemand(out, flatRain(), HISTORICAL, 2000, 2000);
		expect(settleIrrigation(out, d2, d2.gross.values).messages.some((m) => /initial storage/.test(m.text))).toBe(true);
	});

	it('leaves QC out altogether: type 4 is always net (R7-I13)', () => {
		const module = tank({ netReturnFlows: false });
		const demand = irrigationDemand(module, flatRain(), HISTORICAL, 2000, 2000);
		const a = settleIrrigation(module, demand, demand.gross.values);
		const b = settleIrrigation(module, demand, demand.gross.values, new Array<number>(12).fill(50));
		expect(b.returnFlow.values).toEqual(a.returnFlow.values);
	});
});

describe('invariants, every method, every month', () => {
	const areas = [{ year: 1950, value: 0 }, { year: 1955, value: 6 }, { year: 1962, value: 14 }, { year: 1970, value: 9 }];
	const rain = variedRainfall(1950, 1975);
	const blocks: readonly [string, IrrigationModule][] = [
		['Pitman', pitmanBlock({ areaKm2: areas })],
		['WQT net', wqtBlock({ areaKm2: areas, canalFlowLoss: 0.15, canalSeepageToReturn: 0.3, maxAllocationMm3PerYear: 40, effectiveRainfallLimits: [100, 10] })],
		['WQT total', wqtBlock({ areaKm2: areas, netReturnFlows: false, canalFlowLoss: 0.1, droughtReduction: true })],
		['SAPWAT', wqtBlock({ modelType: 3, areaKm2: areas, droughtReduction: true, crops: [{ factors: twelve(140), percent: 100, description: 'r' }] })],
		['type 4', wqt4Block({ areaKm2: areas, canalFlowLoss: 0.15, canalTransmissionLoss: 0.4, canalSeepageToReturn: 0.3, canalEndSpill: 0.05, deepSeatedGroundwater: 0.1, minUpperZoneStorageMm: 30, maxAllocationMm3PerYear: 60 })]
	];
	const supplies: readonly [string, (q: number, t: number) => number][] = [
		['full supply', (q) => q],
		['half supply', (q) => q / 2],
		['intermittent', (q, t) => (t % 7 < 3 ? 0 : q)],
		['no supply', () => 0]
	];
	const unit = Array.from({ length: 26 * 12 }, (_, t) => 2 + 2 * Math.sin(t / 3));

	for (const [name, block] of blocks) {
		for (const [how, supply] of supplies) {
			it(`${name}, ${how}: closes, and nothing goes negative`, () => {
				const demand = irrigationDemand(block, rain, HISTORICAL, 1950, 1975);
				const s = settleIrrigation(block, demand, demand.gross.values.map(supply), unit);
				expect(Math.max(...residual(s).map(Math.abs))).toBeLessThan(1e-9);
				for (const series of [s.application, s.returnFlow, s.conveyanceLoss, s.efficiencyLoss, s.evapotranspiration, s.deepPercolation, s.rainOnLand, s.catchmentRunoff, s.soilStorage]) {
					expect(Math.min(...series.values)).toBeGreaterThanOrEqual(-1e-12);
				}
			});
		}

		it(`${name}: application plus canal terms never exceed the supply`, () => {
			const demand = irrigationDemand(block, rain, HISTORICAL, 1950, 1975);
			const s = settleIrrigation(block, demand, demand.gross.values);
			s.application.values.forEach((v, t) => expect(v).toBeLessThanOrEqual(s.supply.values[t]! + 1e-12));
		});

		it(`${name}: less supply never returns more from the same store history`, () => {
			const demand = irrigationDemand(block, rain, HISTORICAL, 1950, 1975);
			const a = settleIrrigation(block, demand, demand.gross.values, unit);
			const b = settleIrrigation(block, demand, demand.gross.values.map((q) => q / 2), unit);
			const sum = (v: readonly number[]) => v.reduce((x, y) => x + y, 0);
			expect(sum(b.returnFlow.values)).toBeLessThanOrEqual(sum(a.returnFlow.values) + 1e-9);
		});
	}

	it('demand does not change when the supply does: it is computed once, before the supplier', () => {
		const block = wqtBlock({ areaKm2: areas });
		const before = irrigationDemand(block, rain, HISTORICAL, 1950, 1975).gross.values.slice();
		const demand = irrigationDemand(block, rain, HISTORICAL, 1950, 1975);
		settleIrrigation(block, demand, new Array<number>(26 * 12).fill(0));
		expect(demand.gross.values).toEqual(before);
	});

	it('refuses a supply of the wrong length or a negative one', () => {
		const block = pitmanBlock();
		const demand = irrigationDemand(block, flatRain(), HISTORICAL, 2000, 2000);
		expect(() => settleIrrigation(block, demand, [1])).toThrow(/1 months/);
		expect(() => settleIrrigation(block, demand, new Array<number>(12).fill(-1))).toThrow(/carries -1/);
	});

	it('reports a shortfall as a share of the demand, for the screens', () => {
		const block = pitmanBlock();
		const demand = irrigationDemand(block, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(block, demand, demand.gross.values.map((v) => v / 2));
		expect(s.messages).toContainEqual(expect.objectContaining({ level: 'info', text: expect.stringContaining('50.0 % of the demand') }));
	});

	it('warns when a route forces more than the demand into the block (R7-I16)', () => {
		const block = pitmanBlock();
		const demand = irrigationDemand(block, flatRain(), HISTORICAL, 2000, 2000);
		const s = settleIrrigation(block, demand, demand.gross.values.map((v) => v * 3));
		expect(s.messages).toContainEqual(expect.objectContaining({ level: 'warning', route: 7, text: expect.stringContaining('more than the block demanded') }));
		expect(residual(s).every((r) => Math.abs(r) < 1e-10)).toBe(true);
	});
});
