/**
 * Sharing a month's water between a reservoir's drafts (docs/theory/reservoir.md
 * §3.3; TT 689 ch.8 pp.169–170; TT 690 p.9 eq. 2.2 and the dry-dam rule).
 *
 * Two priority classes:
 * 1. **defined** drafts: routes with a defined-flow file (a time series of
 *    demands, TT 690 p.10 draft type 2);
 * 2. **calculated** drafts: irrigation abstraction routes (type 1) and
 *    monthly defined abstractions (`'*'`, type 3), shared in proportion to
 *    their demands (TT 689 p.169).
 *
 * Defined drafts are met first; what remains goes to the calculated drafts;
 * the spill is whatever is left above full supply (TT 689 p.89).
 */

/** Which ERR-style case a month fell into (docs/formats.md §14, "Deficit messages"). */
export type DeficitCase =
	/** Every draft supplied in full. */
	| 'none'
	/** Defined drafts met, calculated drafts reduced in proportion ("Calculated outflows were reduced"). */
	| 'calculatedReduced'
	/** Defined drafts got all the water, shared in proportion; calculated set to zero. */
	| 'definedReduced'
	/** No water at all: every draft set to zero ("The reservoir was dry"). */
	| 'dry';

export interface Allocation {
	/** Supply per defined draft, in the order given. */
	readonly defined: readonly number[];
	/** Supply per calculated draft, in the order given. */
	readonly calculated: readonly number[];
	readonly deficitCase: DeficitCase;
	/** Total demand not supplied, million m³ (defined, calculated). */
	readonly definedDeficit: number;
	readonly calculatedDeficit: number;
}

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

/** Each demand × available / total demand (TT 689 p.170's worked example). */
export function shareInProportion(demands: readonly number[], available: number): number[] {
	const total = sum(demands);
	if (total <= 0 || available <= 0) return demands.map(() => 0);
	if (available >= total) return [...demands];
	return demands.map((d) => (d * available) / total);
}

/**
 * Supplies for one month from `available` = S₁ + I − E, the water the
 * reservoir could release before it dries up (TT 690 eq. 2.2 with S₂ = 0).
 * Demands must be non-negative.
 */
export function allocateDrafts(available: number, definedDemands: readonly number[], calculatedDemands: readonly number[]): Allocation {
	const dDef = sum(definedDemands);
	const dCalc = sum(calculatedDemands);
	if (available >= dDef + dCalc) {
		return { defined: [...definedDemands], calculated: [...calculatedDemands], deficitCase: 'none', definedDeficit: 0, calculatedDeficit: 0 };
	}
	if (available >= dDef) {
		const calculated = shareInProportion(calculatedDemands, available - dDef);
		return {
			defined: [...definedDemands],
			calculated,
			deficitCase: 'calculatedReduced',
			definedDeficit: 0,
			calculatedDeficit: dCalc - sum(calculated)
		};
	}
	const zeros = calculatedDemands.map(() => 0);
	if (available > 0) {
		const defined = shareInProportion(definedDemands, available);
		return { defined, calculated: zeros, deficitCase: 'definedReduced', definedDeficit: dDef - sum(defined), calculatedDeficit: dCalc };
	}
	return { defined: definedDemands.map(() => 0), calculated: zeros, deficitCase: 'dry', definedDeficit: dDef, calculatedDeficit: dCalc };
}
