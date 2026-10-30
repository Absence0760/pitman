/**
 * Irrigation supply (agent 7.2; docs/theory/irrigation.md §7–§9): what a
 * block does with the water its supplier gave it. The counterpart of
 * WRSM2000's "re-simulate" message (TT 689 p.85; TT 691 p.72 RR_AdjRetFlow),
 * run once, always, with the supply the route actually carries.
 *
 *   1 Pitman        return = RRPERC % of the supply (TT 690 eq. 3.4)
 *   2, 3 WQT        effective + non-effective soil stores (eqs. 4.7–4.31, 4.55–4.56)
 *   4 WQT type 4    one pseudo tank (eqs. 6.30–6.49)
 *
 * The water balance closes every month for every method (spec §10):
 *
 *   supply + rain on the land + land transfer
 *     = return flow + conveyance loss + efficiency loss + evapotranspiration
 *       + deep percolation + catchment runoff + Δ soil storage
 */

import type { IrrigationModule, IrrigationWqt4Layout, IrrigationWqtLayout, MonthlySeries, RunMessage } from '../types.js';
import { IrrigationRunError, type IrrigationDemand } from './demand.js';

/** A supply above demand by more than this is reported, million m³ (rounding is not). */
const OVER_SUPPLY_TOLERANCE_MM3 = 1e-9;

/** What a block did over the run; every series is million m³/month unless noted. */
export interface IrrigationSettlement {
	/** Water the abstraction route brought (QIG as supplied). */
	readonly supply: MonthlySeries;
	/** Reaching the land: QIS (eq. 6.30a); supply less canal losses for types 2–3; the supply for type 1. */
	readonly application: MonthlySeries;
	/** QIR (eq. 6.49), RET (eq. 4.56) or RF (eq. 3.4). What the return route carries when the module has one. */
	readonly returnFlow: MonthlySeries;
	/** Canal water that left the system: evaporation and deep seepage (QTLOS − RC; QTLE + QTLD). */
	readonly conveyanceLoss: MonthlySeries;
	/** Water applied beyond DIN (eq. 4.3); its fate is not modelled (TT 690 p.38). Types 2–3. */
	readonly efficiencyLoss: MonthlySeries;
	/** ETE + ETNE; E + QE for type 4; everything not returned for type 1. */
	readonly evapotranspiration: MonthlySeries;
	/** QDEEP (eq. 6.40). */
	readonly deepPercolation: MonthlySeries;
	/** Rain falling on the block's soil stores (PP; RAIN unless QIS = 0, eq. 6.36a). */
	readonly rainOnLand: MonthlySeries;
	/** Natural runoff the store gave up but a 'net' return leaves with the runoff module (QC × area, R7-I13). */
	readonly catchmentRunoff: MonthlySeries;
	/** Soil water that came with land joining the block (+) or left with land leaving it (−). */
	readonly landTransfer: MonthlySeries;
	/** Soil water at each month's end. */
	readonly soilStorage: MonthlySeries;
	/** Soil water at the start of the run, million m³. */
	readonly initialSoilStorage: number;
	/** AEFF (eq. 4.7); the whole area for types 1 and 4, km². */
	readonly effectiveAreaKm2: readonly number[];
	/** ANEFF (eq. 4.9), km². */
	readonly nonEffectiveAreaKm2: readonly number[];
	/** Depth in the effective (type 4: only) store at month end, mm. */
	readonly soilMoistureMm: MonthlySeries;
	readonly messages: readonly RunMessage[];
}

/** One month of the effective store's solve, mm. */
export interface EffectiveMonth {
	readonly hef: number;
	readonly ete: number;
	readonly re: number;
}

/**
 * The effective store over a month: eq. 4.15 (as corrected) with 4.17 and
 * 4.20–4.22, solved by 4.24–4.26, spilled by 4.28. HE sits in one of three
 * linear pieces of Figure 4.2, so each is tried in turn on the average depth.
 * R7-I11: an empty store stays empty and takes what it has from ET.
 */
export function effectiveStoreMonth(hes: number, din: number, pp: number, qc: number, tcd: number, pel: number, ht: number, hsu: number, rf: number): EffectiveMonth {
	const input = din + pp - qc;
	let hef: number;
	const below = ht > 0 ? (hes * (1 - tcd / ht / 2 - rf / 2) + input) / (1 + tcd / ht / 2 + rf / 2) : Infinity; // eq. 4.24
	if (0.5 * (hes + below) < ht) hef = below;
	else if (pel > tcd && hsu > ht) {
		const fact = (pel - tcd) / (hsu - ht);
		hef = (hes * (1 - rf / 2 - fact / 2) + input - tcd + fact * ht) / (1 + rf / 2 + fact / 2); // eq. 4.25
	} else hef = (hes * (1 - rf / 2) + input - tcd) / (1 + rf / 2); // eq. 4.26
	return closeStore(hes, din + pp, hef, qc, rf, hsu, (bar) => {
		if (ht > 0 && bar < ht) return (tcd / ht) * bar; // eq. 4.20
		return pel > tcd && hsu > ht ? tcd + ((bar - ht) / (hsu - ht)) * (pel - tcd) : tcd; // eqs. 4.21–4.22
	});
}

/** The non-effective store: eq. 4.16 with 4.19, 4.23, solved by 4.27, spilled by 4.29. */
export function nonEffectiveStoreMonth(hnes: number, pp: number, qc: number, pel: number, hsu: number, rf: number): EffectiveMonth {
	const rate = hsu > 0 ? pel / hsu : 0;
	const hnef = (hnes * (1 - rate / 2 - rf / 2) + pp - qc) / (1 + rate / 2 + rf / 2); // eq. 4.27
	return closeStore(hnes, pp, hnef, qc, rf, hsu, (bar) => rate * bar); // eq. 4.23
}

/** RE, ET and the spill over HSU, from the depth a store ended at; closes the store when it would end below zero (R7-I11). */
function closeStore(start: number, inflow: number, end: number, qc: number, rf: number, hsu: number, et: (bar: number) => number): EffectiveMonth {
	if (end < 0) {
		const available = start + inflow;
		const re = Math.min(available, qc + (start / 2) * rf);
		return { hef: 0, ete: available - re, re };
	}
	const bar = 0.5 * (start + end);
	const re = qc + bar * rf; // eqs. 4.17, 4.19
	return end > hsu ? { hef: hsu, ete: et(bar), re: re + (end - hsu) } : { hef: end, ete: et(bar), re }; // eqs. 4.28–4.29
}

/**
 * Settle one RR against `supplyMm3`, the abstraction route's flow.
 * `unitRunoffMm` is QC (eq. 4.18), the runoff per unit area of the runoff
 * module the block lies in; absent means 0 (types 2–3 only). Throws
 * `IrrigationRunError` when the series don't match.
 */
export function settleIrrigation(module: IrrigationModule, demand: IrrigationDemand, supplyMm3: readonly number[], unitRunoffMm?: readonly number[]): IrrigationSettlement {
	const label = `RR ${module.number}${module.name.trim() ? ` (${module.name.trim()})` : ''}`;
	const n = demand.gross.values.length;
	if (supplyMm3.length !== n) throw new IrrigationRunError(`${label}: the abstraction route has ${supplyMm3.length} months; the demand has ${n}`);
	if (unitRunoffMm && unitRunoffMm.length !== n) throw new IrrigationRunError(`${label}: the runoff series has ${unitRunoffMm.length} months; the demand has ${n}`);
	const ref = { type: 'RR', number: module.number } as const;
	const messages: RunMessage[] = [];
	const zeros = () => new Array<number>(n).fill(0);
	const s = {
		supply: zeros(), application: zeros(), returnFlow: zeros(), conveyanceLoss: zeros(), efficiencyLoss: zeros(), evapotranspiration: zeros(),
		deepPercolation: zeros(), rainOnLand: zeros(), catchmentRunoff: zeros(), landTransfer: zeros(), soilStorage: zeros(), soilMm: zeros(),
		effective: zeros(), nonEffective: zeros()
	};
	supplyMm3.forEach((v, t) => {
		if (!Number.isFinite(v) || v < -1e-9) throw new IrrigationRunError(`${label}: the abstraction route carries ${v} in month ${t + 1}`);
		s.supply[t] = Math.max(0, v);
	});

	let initial = 0;
	if (demand.modelType === 1) settlePitman(module, demand, s);
	else if (demand.modelType === 4) initial = settleWqt4(module as IrrigationWqt4Layout, demand, s, label, messages, ref);
	else initial = settleWqt(module as IrrigationWqtLayout, demand, s, unitRunoffMm);

	// What a screen needs: how well the source met the block, and any forced flow (R7-I16).
	const demanded = demand.gross.values.reduce((sum, v) => sum + v, 0);
	const supplied = s.supply.reduce((sum, v) => sum + v, 0);
	let short = 0;
	let over = 0;
	for (let t = 0; t < n; t++) {
		const q = demand.gross.values[t]!;
		if (s.supply[t]! < q - OVER_SUPPLY_TOLERANCE_MM3) short++;
		else if (s.supply[t]! > q + OVER_SUPPLY_TOLERANCE_MM3) over++;
	}
	if (short > 0) {
		messages.push({ level: 'info', module: ref, text: `${label}: supply fell short of demand in ${short} of ${n} months; ${demanded > 0 ? ((100 * supplied) / demanded).toFixed(1) : '0'} % of the demand was supplied` });
	}
	if (over > 0) {
		messages.push({ level: 'warning', module: ref, route: module.abstractionRoute, text: `${label}: abstraction route ${module.abstractionRoute} carried more than the block demanded in ${over} of ${n} months; all of it entered the block (R7-I16; TT 689 p.80)` });
	}

	const series = (values: number[]): MonthlySeries => ({ startYear: demand.startYear, values, unit: 'Mm3' });
	return {
		supply: series(s.supply),
		application: series(s.application),
		returnFlow: series(s.returnFlow),
		conveyanceLoss: series(s.conveyanceLoss),
		efficiencyLoss: series(s.efficiencyLoss),
		evapotranspiration: series(s.evapotranspiration),
		deepPercolation: series(s.deepPercolation),
		rainOnLand: series(s.rainOnLand),
		catchmentRunoff: series(s.catchmentRunoff),
		landTransfer: series(s.landTransfer),
		soilStorage: series(s.soilStorage),
		initialSoilStorage: initial,
		effectiveAreaKm2: s.effective,
		nonEffectiveAreaKm2: s.nonEffective,
		soilMoistureMm: { startYear: demand.startYear, values: s.soilMm, unit: 'mm' },
		messages
	};
}

interface Books {
	readonly supply: number[];
	readonly application: number[];
	readonly returnFlow: number[];
	readonly conveyanceLoss: number[];
	readonly efficiencyLoss: number[];
	readonly evapotranspiration: number[];
	readonly deepPercolation: number[];
	readonly rainOnLand: number[];
	readonly catchmentRunoff: number[];
	readonly landTransfer: number[];
	readonly soilStorage: number[];
	readonly soilMm: number[];
	readonly effective: number[];
	readonly nonEffective: number[];
}

/** Eq. 3.4: "return flow as percentage of application", with V as supplied. No store: what doesn't return is used (TT 690 p.11). */
function settlePitman(module: IrrigationModule, demand: IrrigationDemand, b: Books): void {
	const share = Math.min(1, Math.max(0, module.returnFlowPercent / 100));
	for (let t = 0; t < b.supply.length; t++) {
		const v = b.supply[t]!;
		b.application[t] = v;
		b.returnFlow[t] = share * v;
		b.evapotranspiration[t] = v - b.returnFlow[t]!;
		b.effective[t] = demand.areaKm2[t]!;
	}
}

/** TT 690 ch.4: the effective and non-effective stores, for types 2 and 3. Returns the initial soil water. */
function settleWqt(module: IrrigationWqtLayout, demand: IrrigationDemand, b: Books, unitRunoffMm?: readonly number[]): number {
	const hsu = module.soilMoistureCapacityUpperMm;
	const ht = module.soilMoistureTargetMm;
	const loss = module.canalFlowLoss;
	const seepageBack = module.canalSeepageToReturn; // Fc, eq. 4.55
	let he = module.soilMoistureInitialMm;
	let hne = module.soilMoistureInitialMm;
	let rrae = 0;
	let rrane = 0;
	let initial = 0;

	for (let t = 0; t < b.supply.length; t++) {
		const area = demand.areaKm2[t]!;
		const target = demand.targetAreaKm2[t]!;
		const q = demand.gross.values[t]!;
		const supply = b.supply[t]!;
		const aeff = q > 0 && supply < q ? (target * supply) / q : target; // eq. 4.7
		const aneff = Math.max(0, area - aeff); // eq. 4.9
		if (t === 0) {
			rrae = aeff;
			rrane = aneff;
			initial = (he * rrae + hne * rrane) / 1000;
		}

		// Eqs. 4.10–4.14: the depths when land moves between the stores.
		const before = (he * rrae + hne * rrane) / 1000;
		let daeff = 0;
		if (aeff > rrae) he = (he * rrae + (aeff - rrae) * hne) / aeff;
		else daeff = rrae - aeff;
		if (aneff > rrane) {
			const daneff = aneff - rrane;
			hne = daneff <= daeff ? (hne * rrane + daneff * he) / aneff : (hne * (aneff - daeff) + daeff * he) / aneff;
		}
		b.landTransfer[t] = (he * aeff + hne * aneff) / 1000 - before;

		// Canal (eqs. 4.5, 4.55), then the field (eq. 4.3): DIN arrives, the rest is the efficiency loss.
		const qtlos = supply * loss;
		const rc = seepageBack * qtlos;
		const arrive = supply - qtlos;
		const field = aeff > 0 ? arrive * demand.efficiency[t]! : 0;
		const din = aeff > 0 ? (field * 1000) / aeff : 0;
		const qc = unitRunoffMm?.[t] ?? 0;
		const pp = demand.rainMm[t]!;
		const pel = demand.openWaterEvaporationMm[t]!;
		const rf = demand.returnFlowFactor[t]!;
		const eff = effectiveStoreMonth(he, din, pp, qc, demand.cropDemandMm[t]!, pel, ht, hsu, rf);
		const non = nonEffectiveStoreMonth(hne, pp, qc, pel, hsu, rf);

		// Eq. 4.56. A 'net' return leaves QC with the runoff module; a 'total' one carries it (TT 689 p.106, R7-I13).
		const ret = rc + (eff.re * aeff + non.re * aneff) / 1000;
		const natural = (Math.min(eff.re, qc) * aeff + Math.min(non.re, qc) * aneff) / 1000;
		const net = module.netReturnFlows;
		b.application[t] = arrive;
		b.returnFlow[t] = net ? ret - natural : ret;
		b.catchmentRunoff[t] = net ? natural : 0;
		b.conveyanceLoss[t] = qtlos - rc;
		b.efficiencyLoss[t] = arrive - field;
		b.evapotranspiration[t] = (eff.ete * aeff + non.ete * aneff) / 1000;
		b.rainOnLand[t] = (pp * area) / 1000;
		b.soilStorage[t] = (eff.hef * aeff + non.hef * aneff) / 1000;
		b.soilMm[t] = eff.hef;
		b.effective[t] = aeff;
		b.nonEffective[t] = aneff;
		he = eff.hef;
		hne = non.hef;
		rrae = aeff;
		rrane = aneff;
	}
	return initial;
}

/** TT 690 §6.6.6–6.6.7: canal, spill and the one pseudo tank. Returns the initial soil water. */
function settleWqt4(
	module: IrrigationWqt4Layout,
	demand: IrrigationDemand,
	b: Books,
	label: string,
	messages: RunMessage[],
	ref: { readonly type: 'RR'; readonly number: number }
): number {
	// Type 4 is always 'net' (R7-I13): QGI and QSI are flow neutral and leave with the runoff module, so QC never enters.
	const hmin = module.minUpperZoneStorageMm;
	const hmax = module.maxUpperZoneStorageMm;
	if (!(hmax > hmin)) throw new IrrigationRunError(`${label}: maximum upper-zone storage ${hmax} (L.038) must be above the minimum ${hmin} (L.039), or eq. 6.41 divides by zero`);
	const canalLoss = module.canalFlowLoss;
	const toEvaporation = module.canalTransmissionLoss; // RRTLPE, L.036
	const toReturn = module.canalSeepageToReturn; // RRPTLR, L.014
	const spillShare = module.canalEndSpill; // RRPEND, L.040
	const proportions = module.returnFlowUpperZone + module.returnFlowLowerZone + module.deepSeatedGroundwater;

	let s1 = Math.min(hmax, Math.max(hmin, module.soilMoistureInitialMm));
	if (s1 !== module.soilMoistureInitialMm) {
		messages.push({ level: 'info', module: ref, text: `${label}: initial storage ${module.soilMoistureInitialMm} mm (L.016) lies outside L.039–L.038; ${s1} mm is used (R7-I11)` });
	}
	let previousArea = demand.areaKm2[0]!;
	const initial = (s1 * previousArea) / 1000;

	for (let t = 0; t < b.supply.length; t++) {
		const qig = b.supply[t]!;
		const airr = demand.areaKm2[t]!;
		b.landTransfer[t] = (s1 * (airr - previousArea)) / 1000;
		previousArea = airr;

		const qis1 = qig * (1 - canalLoss); // eq. 6.30
		const qis = qis1 / (1 + spillShare); // eq. 6.30a
		const qend = qis * spillShare; // eq. 6.35
		const qtle = qig * canalLoss * toEvaporation; // eq. 6.31
		const qtls = qig * canalLoss * (1 - toEvaporation); // eq. 6.32
		const qtlr = qtls * toReturn; // eq. 6.33
		const qtld = qtls - qtlr; // eq. 6.34

		b.application[t] = qis;
		b.conveyanceLoss[t] = qtle + qtld;
		b.effective[t] = airr;
		if (!(airr > 0)) {
			// No land: what arrives can't be stored. Only forced flow reaches this (R7-I16).
			b.evapotranspiration[t] = qis;
			b.returnFlow[t] = qtlr + qend;
			b.soilMm[t] = s1;
			continue;
		}

		const toDepth = 1000 / airr;
		const rain = qis > 0 ? demand.rainMm[t]! : 0; // eq. 6.36a: no irrigation, no rain in the tank (TT 690 p.50)
		const pe = demand.openWaterEvaporationMm[t]!; // PE × APANF
		const rrlf = demand.returnFlowFactor[t]!;
		const f = rrlf * proportions + pe / (hmax - hmin); // eq. 6.42a
		const applied = qis * toDepth;
		let s2 = (s1 * (1 - 0.5 * f) + hmin * f + rain + applied) / (1 + 0.5 * f); // eq. 6.42
		s2 = Math.min(hmax, Math.max(hmin, s2)); // eqs. 6.43b, 6.44b

		// Eqs. 6.37–6.41 on the final S2, as p.54 says. QE closes the tank above RRHMAX; below RRHMIN the outflows give way (R7-I11).
		const excess = Math.max(0, 0.5 * (s1 + s2) - hmin);
		let qiout = excess * rrlf; // eq. 6.37, mm
		let e = (excess * pe) / (hmax - hmin); // eq. 6.41
		const available = Math.max(0, s1 + rain + applied - s2);
		const out = qiout * proportions + e;
		let qe = 0;
		if (out > available) {
			const k = out > 0 ? available / out : 0;
			qiout *= k;
			e *= k;
		} else qe = available - out; // eq. 6.44a

		const qup = (qiout * module.returnFlowUpperZone) / toDepth; // eq. 6.38
		const qlow = (qiout * module.returnFlowLowerZone) / toDepth; // eq. 6.39
		const qdeep = (qiout * module.deepSeatedGroundwater) / toDepth; // eq. 6.40
		b.returnFlow[t] = qtlr + qend + qup + qlow; // eq. 6.49 without QGI and QSI (R7-I13)
		b.deepPercolation[t] = qdeep;
		b.evapotranspiration[t] = (e + qe) / toDepth;
		b.rainOnLand[t] = rain / toDepth;
		b.soilStorage[t] = s2 / toDepth;
		b.soilMm[t] = s2;
		s1 = s2;
	}
	return initial;
}
