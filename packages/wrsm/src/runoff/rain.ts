/**
 * Rainfall within a month for the classic Pitman runoff module: the
 * synthetic S-shaped mass curve that splits the month's rain over the time
 * steps, and the monthly interception loss.
 *
 * Spec: docs/theory/pitman.md §2.1 and §2.3 (TT 690 ch.1 §1.2 and §1.4,
 * pp.1–3, eqs. 1.1–1.3 and 1.5–1.7). Depths in mm, x and y as fractions of
 * the month and of its rain.
 */

/**
 * Maximum deviation W of cumulative rain from the average rate, mm
 * (TT 690 p.1 eq. 1.1). `P` is the month's total rain, mm.
 */
export function rainfallDeviation(P: number): number {
	return -2 + 1.3732 * (P + 1.6) ** 0.8;
}

/**
 * Exponent n of the mass curve for a month with `P` mm of rain
 * (TT 690 p.2 eq. 1.3, printed with a capital N; it is eq. 1.2's n).
 * Only meaningful for P > 0: W/P is 0/0 at P = 0 (OQ-2).
 */
export function sCurveExponent(P: number): number {
	return 1.28 / (1.02 - rainfallDeviation(P) / P) ** 1.49;
}

/**
 * Cumulative fraction of the month's rain that has fallen by fraction `x`
 * of the month (TT 690 p.1 eq. 1.2). Symmetric: y(½) = ½ for every n.
 */
export function sCurve(x: number, n: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const a = x ** n;
	return a / (a + (1 - x) ** n);
}

/**
 * OQ-1: how the mass curve is sampled into the steps.
 * - `cumulative` (default): differences of y at x = j/steps, which sum to 1 exactly.
 * - `midpointDensity`: the curve's slope dy/dx at each step's mid-point,
 *   normalised to sum to 1 (the alternative reading (b)).
 */
export type SCurveSampling = 'cumulative' | 'midpointDensity';

/**
 * The share of a month's rain that falls in each of `steps` equal time
 * steps (TT 690 p.5, "synthesize mass curve of rainfall for the month and
 * calculate rainfall for each time step"). The mass curve uses the gross
 * catchment rain `P` (OQ-2). `P ≤ 0` gives all zeros (no rain to split).
 */
export function sCurveFractions(P: number, steps = 4, sampling: SCurveSampling = 'cumulative'): number[] {
	const fractions = new Array<number>(steps).fill(0);
	if (!(P > 0)) return fractions;
	const n = sCurveExponent(P);
	if (sampling === 'cumulative') {
		// OQ-1 (a)
		let previous = 0;
		for (let j = 1; j <= steps; j++) {
			const y = sCurve(j / steps, n);
			fractions[j - 1] = y - previous;
			previous = y;
		}
		return fractions;
	}
	// OQ-1 (b): dy/dx = n x^(n−1) (1 − x)^(n−1) / (x^n + (1 − x)^n)², at mid-points.
	let total = 0;
	for (let j = 0; j < steps; j++) {
		const x = (j + 0.5) / steps;
		const d = x ** n + (1 - x) ** n;
		const slope = (n * x ** (n - 1) * (1 - x) ** (n - 1)) / (d * d);
		fractions[j] = slope;
		total += slope;
	}
	return fractions.map((f) => f / total);
}

/** Interception constants a (mm) and b_I (1/mm) for storage `PI` mm (TT 690 p.3 eqs. 1.6, 1.7). */
export function interceptionConstants(PI: number): { readonly a: number; readonly b: number } {
	return { a: 13.08 * PI ** 1.14, b: 0.00099 * PI ** 0.75 - 0.011 };
}

/**
 * Total interception for a month with `P` mm of rain on vegetated ground
 * with interception storage `PI` mm (TT 690 p.2 eq. 1.5): a (1 − e^(b_I P)).
 * Zero for P ≤ 0. The impervious fraction and the cap I ≤ P' are applied by
 * the caller (OQ-3, OQ-17).
 */
export function monthlyInterception(P: number, PI: number): number {
	if (!(P > 0)) return 0;
	const { a, b } = interceptionConstants(PI);
	return a * (1 - Math.exp(b * P));
}
