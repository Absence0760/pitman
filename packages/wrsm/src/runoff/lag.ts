/**
 * Muskingum routing with weighting factor x = 0 ("reservoir-type routing"),
 * the time delay the classic Pitman module applies to its runoff
 * components (docs/theory/pitman.md §2.6; TT 690 §1.7, pp.4–5, eqs.
 * 1.14–1.16). Generic over the series: the Sami module reuses it.
 *
 *   O2 = O1 + C1 (I1 − O1) + C2 (I2 − I1)
 *   C1 = Δt / (k + 0.5 Δt)
 *   C2 = 0.5 Δt / (k + 0.5 Δt)
 *
 * Subscript 1 is the previous interval and 2 the current one. TT 690 prints
 * `− C2 (I2 − I1)`; the plus sign is the standard x = 0 Muskingum form and
 * the only one that gives O = I for k = 0 (OQ-21, docs/decisions.md).
 *
 * I and O may be rates or depths per interval: the recursion is linear and
 * homogeneous, so either works as long as both use the same one. k and Δt
 * share a unit (months in the Pitman module).
 *
 * Mass: the scheme conserves the trapezoidal volume, so from a state with
 * I0 = O0 = 0 after N intervals
 *   Σ O = Σ I − I_N / 2 + O_N / 2 − (k / Δt) O_N
 * and Σ O → Σ I once the inflow stops and the outflow has decayed. For
 * k < Δt / 2 the coefficient on O1 is negative and the outflow can go
 * negative (OQ-22; the literal form is kept, docs/decisions.md).
 */

/** The router's carried state: the previous interval's inflow and outflow. */
export interface MuskingumState {
	readonly inflow: number;
	readonly outflow: number;
}

/** Routing coefficients C1, C2 (TT 690 p.4 eqs. 1.15, 1.16). */
export function muskingumCoefficients(k: number, dt: number): { readonly C1: number; readonly C2: number } {
	const d = k + 0.5 * dt;
	return { C1: dt / d, C2: (0.5 * dt) / d };
}

/** Options for a `MuskingumRouter`. */
export interface MuskingumOptions {
	/** Lag k, in the same unit as `dt`. k ≥ 0. */
	readonly k: number;
	/** Routing interval Δt (> 0). */
	readonly dt: number;
	/** Starting state; zero inflow and outflow when absent (OQ-24 default). */
	readonly initial?: MuskingumState;
	/**
	 * Applied to the outflow before it is stored, e.g. `Math.fround` for a
	 * 32-bit run (OQ-25). Identity when absent.
	 */
	readonly round?: (value: number) => number;
}

/** A stateful x = 0 Muskingum router: feed it one interval's inflow at a time. */
export class MuskingumRouter {
	readonly k: number;
	readonly dt: number;
	private readonly C1: number;
	private readonly C2: number;
	private readonly round: ((value: number) => number) | undefined;
	private I1: number;
	private O1: number;

	constructor(options: MuskingumOptions) {
		if (!(options.k >= 0)) throw new RangeError(`Muskingum lag k must be ≥ 0, got ${options.k}`);
		if (!(options.dt > 0)) throw new RangeError(`Muskingum interval dt must be > 0, got ${options.dt}`);
		this.k = options.k;
		this.dt = options.dt;
		({ C1: this.C1, C2: this.C2 } = muskingumCoefficients(options.k, options.dt));
		this.round = options.round;
		this.I1 = options.initial?.inflow ?? 0;
		this.O1 = options.initial?.outflow ?? 0;
	}

	/** The previous interval's inflow and outflow. */
	get state(): MuskingumState {
		return { inflow: this.I1, outflow: this.O1 };
	}

	/** Replace the carried state (e.g. a steady start, OQ-24 (b)). */
	reset(state: MuskingumState): void {
		this.I1 = state.inflow;
		this.O1 = state.outflow;
	}

	/** Route one interval's inflow and return its outflow. */
	step(inflow: number): number {
		// OQ-22 (d): k = 0 is no lag. The recursion gives the same when I1 = O1.
		let O2 = this.k === 0 ? inflow : this.O1 + this.C1 * (this.I1 - this.O1) + this.C2 * (inflow - this.I1);
		if (this.round) O2 = this.round(O2);
		this.I1 = inflow;
		this.O1 = O2;
		return O2;
	}
}

/** Route a whole series through a fresh router. */
export function routeSeries(inflow: readonly number[], options: MuskingumOptions): number[] {
	const router = new MuskingumRouter(options);
	return inflow.map((value) => router.step(value));
}

/** Options for a `ShiftRouter`. */
export interface ShiftOptions {
	/** Lag k in months (k ≥ 0). */
	readonly k: number;
	/** The inflow assumed for every month before the first; 0 when absent (OQ-24 (a)). */
	readonly initialInflow?: number;
	/** Applied to the outflow, e.g. `Math.fround` (OQ-25). Identity when absent. */
	readonly round?: (value: number) => number;
}

/**
 * The time delay WRSM2000's outputs show (OQ-22 reading (e), R6-R9): each
 * month's runoff is shifted later by k months, spread uniformly over the
 * month, so with k = n + f (n whole, 0 ≤ f < 1)
 *
 *   O_t = (1 − f) I_{t−n} + f I_{t−n−1}
 *
 * k = 0.25 keeps ¾ of a month's runoff in that month and moves ¼ into the
 * next. Not the Muskingum form TT 690 p.4 eqs. 1.14–1.16 print: the
 * reference `ncr.MTS` series give this two-term kernel for TL = 0.2, 0.25,
 * 0.35 and 0.5 with no recession tail (docs/theory/pitman.md OQ-22). It
 * conserves mass (Σ O = Σ I less what is still in transit at the end) and
 * never goes negative for I ≥ 0.
 */
export class ShiftRouter {
	readonly k: number;
	private readonly whole: number;
	private readonly fraction: number;
	private readonly round: ((value: number) => number) | undefined;
	/** The last `whole + 1` inflows, newest last. */
	private readonly history: number[];

	constructor(options: ShiftOptions) {
		if (!(options.k >= 0) || !Number.isFinite(options.k)) throw new RangeError(`lag k must be finite and ≥ 0, got ${options.k}`);
		this.k = options.k;
		this.whole = Math.floor(options.k);
		this.fraction = options.k - this.whole;
		this.round = options.round;
		this.history = new Array<number>(this.whole + 1).fill(options.initialInflow ?? 0);
	}

	/** Replace the months before the first with a constant inflow (a steady start, OQ-24 (b)). */
	reset(inflow: number): void {
		this.history.fill(inflow);
	}

	/** Route one month's inflow and return its outflow. */
	step(inflow: number): number {
		this.history.push(inflow);
		// history now holds I_{t−n−1} … I_t; drop the oldest after use.
		const older = this.history.shift()!; // I_{t−n−1}
		const newer = this.history[0]!; // I_{t−n}
		const O = this.fraction === 0 ? newer : (1 - this.fraction) * newer + this.fraction * older;
		return this.round ? this.round(O) : O;
	}
}
