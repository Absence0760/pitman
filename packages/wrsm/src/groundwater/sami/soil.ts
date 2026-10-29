/**
 * Sami groundwater model, method 2: the soil side (docs/theory/sami.md
 * §3.1–3.7, §6). Everything here depends only on the Pitman soil-moisture
 * series S, so it runs before the aquifer and independently of it:
 *
 * - pass 1: soil interflow SIF_i and potential recharge RE_i from S, then the
 *   whole-run mean REbar (§3.1–3.3);
 * - pass 2: the percolating store P, giving EXRECH_i and PERC_i, then the
 *   whole-run mean PERCbar (§3.4–3.5);
 * - after the aquifer pass: interflow INTERFLOW_i = SIF_i + AQX_i and its lag
 *   (§3.7), with the Pitman x = 0 Muskingum router of `runoff/lag.ts`.
 *
 * Depths are mm over the RU catchment area; months are indices into the run.
 * Built from TT 690 ch.8 and TT 687 §2 only; each equation cites its page.
 * The provisional choices are fields of `SamiSoilOptions` /
 * `SamiInterflowOptions` (pattern of `PitmanOptions`, R2-1), each with its
 * open question in docs/theory/sami.md §8.
 */

import { MuskingumRouter } from '../../runoff/lag.js';
import type { RunoffModule } from '../../types.js';
import type { Mm, SamiInterflowFn, SamiSoilParams, SamiSoilPass, SamiSoilPassFn } from './contract.js';

/** The provisional choices of the soil side. Defaults are `DEFAULT_SAMI_SOIL_OPTIONS`. */
export interface SamiSoilOptions {
	/**
	 * OQ-S5: threshold of the recharge curve (eq. 2 / 8.3). `HGSL` (default,
	 * TT 687 p.6 eq. 2 and Table 2, L.032 v6) or `SL` (TT 690 p.82 eq. 8.3 as
	 * printed, the 2005 spreadsheet's single threshold).
	 */
	readonly rechargeThreshold: 'HGSL' | 'SL';
	/**
	 * OQ-S6: the first MMA − 1 months of the trailing moving average REx.
	 * `available` (default): the mean of the months there are. `zeroPadded`:
	 * the sum over the window divided by MMA, months before the run counting
	 * as zero recharge.
	 */
	readonly rechargeAverageStart: 'available' | 'zeroPadded';
	/**
	 * OQ-S8: which P eq. 8.5 uses. `afterRecharge` (default): the month's P
	 * after adding RE_i and dumping EXRECH_i. `previous`: P at the end of the
	 * previous month (P₀ in month 1). Either way PERC is then capped at the
	 * store (TT 690 Fig 8.2 "PERC ≤ P").
	 */
	readonly percolationStorage: 'afterRecharge' | 'previous';
}

/** The accepted provisional defaults (docs/theory/sami.md §8, docs/decisions.md). */
export const DEFAULT_SAMI_SOIL_OPTIONS: SamiSoilOptions = {
	rechargeThreshold: 'HGSL', // OQ-S5
	rechargeAverageStart: 'available', // OQ-S6
	percolationStorage: 'afterRecharge' // OQ-S8
};

/** The provisional choices of the interflow lag. Defaults are `DEFAULT_SAMI_INTERFLOW_OPTIONS`. */
export interface SamiInterflowOptions {
	/**
	 * OQ-S17: the lag reservoir's state before month 0. `steady` (default):
	 * inflow = outflow = INTERFLOW₀, so QLAG₀ = INTERFLOW₀. `zero`: a dry
	 * start, as the classic Pitman default (OQ-24).
	 */
	readonly initialLagState: 'steady' | 'zero';
}

export const DEFAULT_SAMI_INTERFLOW_OPTIONS: SamiInterflowOptions = {
	initialLagState: 'steady' // OQ-S17
};

/**
 * The Pitman power curve both Sami soil fluxes use:
 * `max · ((S − threshold)/(ST − threshold))^power` for S > threshold, else 0.
 * The ratio is clamped to [0, 1] (S cannot rise above ST, TT 690 p.81); a
 * curve whose threshold is at or above ST gives `max` for any S above it.
 */
function powerCurve(S: Mm, threshold: Mm, ST: Mm, max: Mm, power: number): Mm {
	if (!(S > threshold)) return 0;
	const ratio = ST > threshold ? Math.min(1, (S - threshold) / (ST - threshold)) : 1;
	return max * ratio ** power;
}

/**
 * Interflow from the soil zone, one month (§3.1):
 * `SIF = FT · ((S − SL)/(ST − SL))^POW` if S > SL, else 0.
 * TT 690 p.80 eq. 8.2 and p.88 eq. 8.12 (first term); TT 687 p.5 eq. 1.
 */
export function samiSoilInterflow(S: Mm, p: Pick<SamiSoilParams, 'FT' | 'SL' | 'ST' | 'POW'>): Mm {
	return powerCurve(S, p.SL, p.ST, p.FT, p.POW);
}

/**
 * Potential recharge, one month (§3.2):
 * `RE = HGGW · ((S − HGSL)/(ST − HGSL))^GPOW` if S > HGSL, else 0.
 * TT 687 p.6 eq. 2; TT 690 p.82 eq. 8.3 (printed with GW and SL, OQ-S5).
 */
export function samiRecharge(
	S: Mm,
	p: Pick<SamiSoilParams, 'HGGW' | 'HGSL' | 'SL' | 'ST' | 'GPOW'>,
	options: Pick<SamiSoilOptions, 'rechargeThreshold'> = DEFAULT_SAMI_SOIL_OPTIONS
): Mm {
	const threshold = options.rechargeThreshold === 'SL' ? p.SL : p.HGSL;
	return powerCurve(S, threshold, p.ST, p.HGGW, p.GPOW);
}

/**
 * Trailing moving average of recharge over `months` months including month i
 * (§3.4; TT 690 p.84 eq. 8.5 "REx = moving average of recharge RE for x
 * months (1–120 months)"; TT 687 p.8 eq. 3). Start-up per OQ-S6.
 */
export function samiMovingAverage(
	re: readonly Mm[],
	months: number,
	start: SamiSoilOptions['rechargeAverageStart'] = DEFAULT_SAMI_SOIL_OPTIONS.rechargeAverageStart
): Mm[] {
	assertMonths(months);
	const out: Mm[] = [];
	let windowSum = 0;
	for (let i = 0; i < re.length; i++) {
		windowSum += re[i]!;
		if (i >= months) windowSum -= re[i - months]!;
		const terms = start === 'available' ? Math.min(i + 1, months) : months;
		out.push(windowSum / terms);
	}
	return out;
}

/** Pass 2 without the averages: the percolating store over the run. */
export interface SamiPercolation {
	readonly reX: Mm[];
	readonly exrech: Mm[];
	readonly perc: Mm[];
	readonly p: Mm[];
}

/**
 * The percolating store, every month (§3.5; TT 690 p.84–85 §8.3.6 eq. 8.5;
 * TT 687 p.8 §2.6 eq. 3):
 *
 *   P ← P + RE_i
 *   EXRECH_i = max(0, P − PMAX);  P ← P − EXRECH_i     (excess dumped to the aquifer, TT 690 p.85)
 *   PERC_i   = REx_i · (P/PMAX)^PPOW · (REx_i / REbar)  (eq. 8.5)
 *   PERC_i   = min(PERC_i, P);    P ← P − PERC_i         (TT 690 Fig 8.2, TT 687 Fig 1 "PERC < P")
 *
 * `reBar` is a parameter so a caller can supply a published mean (the §7
 * worked example uses B82B's); `samiSoilPass` passes the run's own. REbar ≤ 0
 * gives PERC = 0 (all RE is then 0 anyway). PMAX = 0 means no percolating
 * store: every RE leaves as EXRECH and PERC = 0 (R6-S1).
 */
export function samiPercolation(
	re: readonly Mm[],
	reBar: Mm,
	p: Pick<SamiSoilParams, 'PMAX' | 'P0' | 'PPOW' | 'MMA'>,
	options: Pick<SamiSoilOptions, 'rechargeAverageStart' | 'percolationStorage'> = DEFAULT_SAMI_SOIL_OPTIONS
): SamiPercolation {
	if (!(p.PMAX >= 0)) throw new RangeError(`Sami PMAX must be ≥ 0 mm, got ${p.PMAX}`);
	if (!(p.P0 >= 0)) throw new RangeError(`Sami initial percolating storage P0 must be ≥ 0 mm, got ${p.P0}`);
	const reX = samiMovingAverage(re, p.MMA, options.rechargeAverageStart);
	const exrech: Mm[] = [];
	const perc: Mm[] = [];
	const store: Mm[] = [];
	let P = p.P0;
	for (let i = 0; i < re.length; i++) {
		const previous = P;
		P += re[i]!;
		const excess = Math.max(0, P - p.PMAX);
		P -= excess;
		const Peq = options.percolationStorage === 'previous' ? previous : P;
		let percolation = 0;
		if (p.PMAX > 0 && reBar > 0) {
			const x = reX[i]!;
			percolation = x * (Peq / p.PMAX) ** p.PPOW * (x / reBar);
		}
		percolation = Math.min(percolation, P);
		P -= percolation;
		exrech.push(excess);
		perc.push(percolation);
		store.push(P);
	}
	return { reX, exrech, perc, p: store };
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Sami soil passes 1–2 (§4.1 steps 2–3): RE and SIF from S, REbar, the
 * percolating store, PERCbar. Input: Pitman S per month, mm (OQ-S4).
 * Means are over the whole run (TT 691 p.51 three-pass note; OQ-S6, OQ-S13).
 * Throws `RangeError` on an invalid parameter or a non-finite S (R2-2).
 */
export const samiSoilPass: SamiSoilPassFn &
	((S: readonly Mm[], p: SamiSoilParams, options?: SamiSoilOptions, recharge?: readonly Mm[]) => SamiSoilPass) = (
	S: readonly Mm[],
	p: SamiSoilParams,
	options: SamiSoilOptions = DEFAULT_SAMI_SOIL_OPTIONS,
	recharge?: readonly Mm[]
): SamiSoilPass => {
	S.forEach((value, i) => {
		if (!Number.isFinite(value)) throw new RangeError(`Sami soil moisture S must be finite, got ${value} in month ${i}`);
	});
	// Pass 1.
	// OQ-S2 (b): the recharge the Pitman core already took out of S, when the composition passes it.
	if (recharge && recharge.length !== S.length) throw new RangeError(`Sami recharge has ${recharge.length} months; S has ${S.length}`);
	const re = recharge ? [...recharge] : S.map((value) => samiRecharge(value, p, options));
	const soilInterflow = S.map((value) => samiSoilInterflow(value, p));
	const reBar = mean(re);
	// Pass 2.
	const { reX, exrech, perc, p: store } = samiPercolation(re, reBar, p, options);
	return { re, soilInterflow, reX, exrech, perc, p: store, reBar, percBar: mean(perc) };
};

/**
 * Interflow and its lag (§3.7): INTERFLOW_i = SIF_i + AQX_i (TT 690 p.88
 * eq. 8.12; TT 687 p.15 eq. 8), routed by k = F28_Lag months through the
 * x = 0 Muskingum of TT 690 p.4 eqs. 1.14–1.16 with Δt = 1 month (TT 687
 * p.15 eq. 9 as corrected, OQ-S10). k = 0 passes INTERFLOW through. Returns
 * QLAG_i.
 */
export const samiInterflow: SamiInterflowFn &
	((soilInterflow: readonly Mm[], excessToInterflow: readonly Mm[], lag: number, options?: SamiInterflowOptions) => Mm[]) = (
	soilInterflow: readonly Mm[],
	excessToInterflow: readonly Mm[],
	lag: number,
	options: SamiInterflowOptions = DEFAULT_SAMI_INTERFLOW_OPTIONS
): Mm[] => {
	if (soilInterflow.length !== excessToInterflow.length) {
		throw new RangeError(
			`Sami interflow: ${soilInterflow.length} months of soil interflow but ${excessToInterflow.length} of aquifer excess`
		);
	}
	const raw = soilInterflow.map((value, i) => value + excessToInterflow[i]!);
	if (raw.length === 0) return [];
	const first = options.initialLagState === 'steady' ? raw[0]! : 0;
	const router = new MuskingumRouter({ k: lag, dt: 1, initial: { inflow: first, outflow: first } });
	return raw.map((value) => router.step(value));
};

function assertMonths(months: number): void {
	if (!(Number.isInteger(months) && months >= 1)) {
		throw new RangeError(`Sami recharge averaging months (MMA) must be an integer ≥ 1, got ${months}`);
	}
}

/**
 * The soil-side parameters of an RU module's Sami block (§2): L.035 for
 * POW/SL/ST/FT, L.031 v5 PMAX, L.032 P₀/PPOW/GPOW/HGSL/HGGW, L.034 v3 lag and
 * v4 MMA. MMA is an F7.2 field written as a whole number in practice; it is
 * read as the nearest integer (R6-S2). Throws if the module has no Sami block.
 */
export function samiSoilParams(module: Pick<RunoffModule, 'number' | 'sami'>): SamiSoilParams {
	const sami = module.sami;
	if (!sami) throw new RangeError(`Runoff module ${module.number} has no Sami parameters (L.031–L.035)`);
	const { POW, SL, ST, FT } = sami.pitman;
	return {
		POW,
		SL,
		ST,
		FT,
		HGSL: sami.HGSL,
		HGGW: sami.HGGW,
		GPOW: sami.GPOW,
		PPOW: sami.PPOW,
		P0: sami.initialUnsaturatedStorage,
		PMAX: sami.unsaturatedStorage,
		MMA: Math.round(sami.rechargeAveragingMonths),
		lag: sami.interflowLag
	};
}
