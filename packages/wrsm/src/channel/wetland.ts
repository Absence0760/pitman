/**
 * The two wetland sub-models of a channel reach, one month at a time.
 *
 * Spec: docs/theory/channel.md §3 (basic wetland, TT 690 ch.9 pp.112–113,
 * eqs. 9.1–9.13) and §4 (comprehensive wetland, TT 690 ch.10 pp.114–117,
 * eqs. 10.1–10.7). Volumes and flows in million m³ (per month); depths in mm
 * for the basic model and in m for the comprehensive one, as the manual has
 * them. Open questions OQ-CR… are in the spec's §8.
 */

// ---------------------------------------------------------------------------
// Basic wetland (type 1), TT 690 ch.9
// ---------------------------------------------------------------------------

/** OQ-CR5: where √Qr sits in eq. 9.1. */
export type BasicRechargeForm = 'printed' | 'prose';

/** Parameters of the basic wetland: CR L.003 v2–v4. */
export interface BasicWetlandParameters {
	/** CHC1: wetland/aquifer storage when full, million m³ (> 0). */
	readonly chc1: number;
	/** CHC2: wetland/aquifer area when full, km² (≥ 0). */
	readonly chc2: number;
	/** CHC3: recharge coefficient, 0–1. */
	readonly chc3: number;
}

/** One month of the basic wetland. */
export interface BasicWetlandMonth {
	/** Qloss: reduction in river flow (eq. 9.2). Negative when the wetland drains back to the river (OQ-CR6). */
	readonly qloss: number;
	/** Qr after eq. 9.13: the river flow leaving the wetland. */
	readonly riverOut: number;
	/** SAVA: average storage used for evaporation (eqs. 9.6–9.8). */
	readonly averageStorage: number;
	/** ETA: net evaporation volume after eq. 9.11 (negative when rain exceeds evaporation). */
	readonly netEvaporation: number;
	/** WETS at month end (eqs. 9.10, 9.12). */
	readonly storageEnd: number;
}

/** Recharge R, eq. 9.1 (TT 690 p.112). `printed`: CHC3 × (CHC1 − WETS + √Qr). `prose`: CHC3 × (CHC1 − WETS) + √Qr (TT 691 p.156 note 2). */
export function basicRecharge(p: BasicWetlandParameters, wets: number, qr: number, form: BasicRechargeForm = 'printed'): number {
	const root = Math.sqrt(Math.max(qr, 0));
	return form === 'printed' ? p.chc3 * (p.chc1 - wets + root) : p.chc3 * (p.chc1 - wets) + root;
}

/** ETC, eq. 9.3 (TT 690 p.112): half the month's net evaporation as a fraction of storage. `enetMm` in mm. */
export function basicEvaporationConstant(p: BasicWetlandParameters, enetMm: number): number {
	return (0.001 * enetMm * p.chc2) / (2 * p.chc1);
}

/**
 * SAVA, eqs. 9.5–9.8 (TT 690 pp.112–113): the average storage over the month
 * with storage above CHC1 counted as CHC1, the path from WETS to SAE taken
 * as linear. The printed conditions of eqs. 9.6 and 9.7 omit "WETS > CHC1";
 * the heading "IF WETS > CHC1" supplies it (spec §3.2).
 */
export function basicAverageStorage(chc1: number, wets: number, sae: number): number {
	const savt = (wets + sae) / 2; // eq. 9.5
	if (wets > chc1) {
		if (sae > chc1) return chc1; // eq. 9.6
		return savt - (0.5 * (wets - chc1) ** 2) / (wets - sae); // eq. 9.7
	}
	if (sae > chc1) return savt - (0.5 * (sae - chc1) ** 2) / (sae - wets); // eq. 9.8
	return savt;
}

/**
 * One month of the basic wetland (TT 690 ch.9, eqs. 9.1–9.13). `qr` is the
 * river flow reaching the wetland, `wets` the storage at the start of the
 * month and `enetMm` the net evaporation (gross − rain), mm.
 */
export function basicWetlandMonth(
	p: BasicWetlandParameters,
	wets: number,
	qr: number,
	enetMm: number,
	form: BasicRechargeForm = 'printed'
): BasicWetlandMonth {
	const r = basicRecharge(p, wets, qr, form); // eq. 9.1
	const qloss = Math.min(r, qr); // eq. 9.2
	const etc = basicEvaporationConstant(p, enetMm); // eq. 9.3
	if (!(1 + etc > 0)) {
		throw new RangeError(`basic wetland: net rain on the wetland (ETC = ${etc.toFixed(4)}) is too large for eq. 9.4 (OQ-CR7)`);
	}
	const sae = (qloss + wets * (1 - etc)) / (1 + etc); // eq. 9.4
	const sava = basicAverageStorage(p.chc1, wets, sae); // eqs. 9.5–9.8
	let eta = (p.chc2 * enetMm * 0.001 * sava) / p.chc1; // eq. 9.9
	let end = wets + qloss - eta; // eq. 9.10
	if (end < 0) {
		eta += end; // eq. 9.11
		end = 0; // eq. 9.12
	}
	return { qloss, riverOut: qr - qloss /* eq. 9.13 */, averageStorage: sava, netEvaporation: eta, storageEnd: end };
}

// ---------------------------------------------------------------------------
// Comprehensive wetland (type 2), TT 690 ch.10
// ---------------------------------------------------------------------------

/** Parameters of the comprehensive wetland: CR L.012 and L.013. */
export interface ComprehensiveWetlandParameters {
	/** Anom: area at bankfull level, km² (≥ 0). */
	readonly anom: number;
	/** Snom: volume at bankfull level, million m³ (> 0). */
	readonly snom: number;
	/** b: power of the area–volume relationship A = a·S^b (> 0). */
	readonly b: number;
	/** Qbf: channel capacity above which flow spills into the wetland, million m³/month. */
	readonly qbf: number;
	/** Kin: proportion of flow above Qbf that enters the wetland, 0–1. */
	readonly kin: number;
	/** Kout: proportion of storage above Snom returned to the channel per month, 0–1. */
	readonly kout: number;
	/** Qdiv: cap on the channel-to-wetland link; `Infinity` for a natural wetland (OQ-CR9). */
	readonly qdiv: number;
}

/** The constant a in A = a·S^b, eq. 10.5 (TT 690 p.117). */
export function areaConstant(p: Pick<ComprehensiveWetlandParameters, 'anom' | 'snom' | 'b'>): number {
	return p.anom / p.snom ** p.b;
}

/** Qin, eq. 10.2 (TT 690 p.116): flow from the channel into the wetland. */
export function wetlandInflow(p: ComprehensiveWetlandParameters, qus: number): number {
	if (qus < p.qbf) return 0;
	return Math.min(p.qdiv, p.kin * (qus - p.qbf));
}

/** Qout, eq. 10.3 (TT 690 p.116): flow from the wetland back to the channel. */
export function wetlandReturn(p: ComprehensiveWetlandParameters, save: number): number {
	return save < p.snom ? 0 : p.kout * (save - p.snom);
}

/** Aave = a·Save^b (TT 690 p.116, §10.6), km². */
export function wetlandArea(a: number, b: number, save: number): number {
	return save <= 0 ? 0 : a * save ** b;
}

/** Inputs for one month of the comprehensive wetland. */
export interface ComprehensiveMonthInput {
	/** S1: storage at the start of the month. */
	readonly s1: number;
	/** Qus: river flow upstream of the wetland. */
	readonly qus: number;
	/** Qloc: local inflow straight into the wetland. */
	readonly qloc: number;
	/** Qabs: abstraction demanded from the wetland. */
	readonly qabs: number;
	/** Enet: net evaporation (gross − rain), **m**. */
	readonly enetM: number;
}

/** One month of the comprehensive wetland. */
export interface ComprehensiveMonth {
	readonly qin: number;
	readonly qout: number;
	/** Qevap = Enet × Aave (eq. 10.4), after any cut that keeps S2 ≥ 0. */
	readonly qevap: number;
	/** Qabs supplied. */
	readonly qabs: number;
	/** Part of the demanded Qabs that the wetland could not supply. */
	readonly qabsShort: number;
	readonly save: number;
	/** Aave, km². */
	readonly area: number;
	/** S2, month end. */
	readonly s2: number;
	/** Qds = Qus − Qin + Qout (eq. 10.7). */
	readonly qds: number;
	/** Iterations the solution of §10.7.1 took (0 when it fell back to bisection). */
	readonly iterations: number;
}

/** Solver settings for §10.7.1 (OQ-CR10). */
export interface WetlandSolver {
	/** Stop when successive estimates of Save differ by less than this, million m³. */
	readonly tolerance: number;
	/** Successive approximations before falling back to bisection. */
	readonly maxIterations: number;
}

export const DEFAULT_WETLAND_SOLVER: WetlandSolver = { tolerance: 1e-9, maxIterations: 200 };

/**
 * One month of the comprehensive wetland (TT 690 ch.10). Save is found by
 * successive approximation (§10.7.1): guess Save, compute Qout (10.3) and
 * Qevap (10.4), S2 from the water balance (10.1), and Save = (S1 + S2)/2,
 * until two estimates agree within `solver.tolerance`. If that fails to
 * converge, bisection on the same equation. When S2 would still be
 * negative the wetland empties: Save = S1/2, and the abstraction, then the
 * return flow, then evaporation are cut until S2 = 0 (OQ-CR11).
 */
export function comprehensiveWetlandMonth(
	p: ComprehensiveWetlandParameters,
	input: ComprehensiveMonthInput,
	solver: WetlandSolver = DEFAULT_WETLAND_SOLVER
): ComprehensiveMonth {
	const a = areaConstant(p);
	const qin = wetlandInflow(p, input.qus);
	const supply = input.s1 + input.qloc + qin;
	const fluxes = (save: number) => {
		const qout = wetlandReturn(p, save);
		const qevap = input.enetM * wetlandArea(a, p.b, save);
		return { qout, qevap, s2: supply - qout - qevap - input.qabs };
	};
	// h(Save) = Save − (S1 + S2(Save))/2; the root is the consistent Save.
	const h = (save: number) => save - (input.s1 + fluxes(save).s2) / 2;

	let save = input.s1;
	let iterations = 0;
	let converged = false;
	for (let k = 1; k <= solver.maxIterations; k++) {
		const next = Math.max(0, (input.s1 + fluxes(save).s2) / 2);
		if (Math.abs(next - save) < solver.tolerance) {
			save = next;
			iterations = k;
			converged = true;
			break;
		}
		save = next;
	}
	if (!converged) {
		save = bisect(h, input.s1 + supply, solver.tolerance);
		iterations = 0;
	}

	let { qout, qevap, s2 } = fluxes(save);
	let qabs = input.qabs;
	if (s2 < 0) {
		// OQ-CR11: the wetland empties during the month. Storage falls from S1
		// to 0, so Save = S1/2 sets the return flow and evaporation; then the
		// abstraction is cut, then the return flow, then evaporation.
		save = input.s1 / 2;
		({ qout, qevap, s2 } = fluxes(save));
		let deficit = Math.max(0, -s2);
		const cutAbs = Math.min(deficit, qabs);
		qabs -= cutAbs;
		deficit -= cutAbs;
		const cutOut = Math.min(deficit, qout);
		qout -= cutOut;
		deficit -= cutOut;
		const cutEvap = Math.min(deficit, Math.max(qevap, 0));
		qevap -= cutEvap;
		deficit -= cutEvap;
		s2 = Math.max(0, s2 + cutAbs + cutOut + cutEvap);
		if (deficit > 1e-9) throw new RangeError(`comprehensive wetland: storage would go negative by ${deficit} million m³`);
	}
	return {
		qin,
		qout,
		qevap,
		qabs,
		qabsShort: input.qabs - qabs,
		save,
		area: wetlandArea(a, p.b, save),
		s2,
		qds: input.qus - qin + qout, // eq. 10.7
		iterations
	};
}

/** Root of an increasing-at-the-root `h` on [0, hi], widening `hi` until h(hi) > 0. h(0) ≥ 0 means the wetland empties: 0. */
function bisect(h: (x: number) => number, hi0: number, tolerance: number): number {
	if (h(0) >= 0) return 0;
	let hi = Math.max(hi0, 1);
	for (let k = 0; h(hi) <= 0; k++) {
		if (k > 60) throw new RangeError('comprehensive wetland: no average storage balances the month (OQ-CR10)');
		hi *= 2;
	}
	let lo = 0;
	for (let k = 0; k < 200 && hi - lo > tolerance; k++) {
		const mid = (lo + hi) / 2;
		if (h(mid) > 0) hi = mid;
		else lo = mid;
	}
	return (lo + hi) / 2;
}
