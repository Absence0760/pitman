/**
 * Simple Sami parts that obey the contract (`contract.ts`) and conserve
 * mass exactly, for testing the composition (`index.ts`) and the
 * comparison harness without the real soil and aquifer sides. They are
 * not the Sami equations: each flux is a fixed fraction of a store.
 *
 * - soil: RE = rechargeFraction·S, SIF = interflowFraction·S; the
 *   percolating store P takes RE, dumps the excess over PMAX (EXRECH) and
 *   passes half of what is left on (PERC). ΔP = RE − EXRECH − PERC.
 * - aquifer: STORE takes the inflow, rejects the excess over CAP (AQX),
 *   loses 1 % to ET and 0.5 % of (STORE − SWL) to outflow, then gives
 *   10 % of a positive head as baseflow (capped at BFMAX) or takes 5 % of a
 *   negative head as transmission loss (capped at Q), and finally the
 *   whole abstraction from storage. ΔSTORE = inflow − AQX − ET − OUT −
 *   GWBF + TL − ABS.
 * - interflow: SIF + AQX through the shared x = 0 Muskingum (`runoff/lag.ts`).
 *
 * `calls` records every call, in order, for the composition-order test.
 */

import { MuskingumRouter } from '../../runoff/lag.js';
import type { SamiAquiferOutput, SamiAquiferParams, SamiAquiferState, SamiParts, SamiSoilPass } from './contract.js';

export interface FakeSamiParts extends SamiParts {
	readonly calls: string[];
}

export function fakeSamiParts(options: { readonly rechargeFraction?: number; readonly interflowFraction?: number } = {}): FakeSamiParts {
	const { rechargeFraction = 0.01, interflowFraction = 0.02 } = options;
	const calls: string[] = [];
	const mean = (xs: readonly number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
	return {
		calls,
		soilPass(S, p): SamiSoilPass {
			calls.push('soilPass');
			const re = S.map((s) => rechargeFraction * Math.max(0, s));
			const soilInterflow = S.map((s) => interflowFraction * Math.max(0, s));
			let P = p.P0;
			const exrech: number[] = [];
			const perc: number[] = [];
			const store: number[] = [];
			for (const r of re) {
				P += r;
				const x = Math.max(0, P - p.PMAX);
				P -= x;
				const pc = 0.5 * P;
				P -= pc;
				exrech.push(x);
				perc.push(pc);
				store.push(P);
			}
			return { re, soilInterflow, reX: re, exrech, perc, p: store, reBar: mean(re), percBar: mean(perc) };
		},
		interflow(sif, aqx, lag) {
			calls.push('interflow');
			const router = new MuskingumRouter({ k: lag, dt: 1 });
			return sif.map((v, i) => router.step(v + aqx[i]!));
		},
		aquiferInit(p: SamiAquiferParams): SamiAquiferState {
			calls.push('aquiferInit');
			return { store: p.store0, tDays: 0, pumping: false };
		},
		aquiferStep(s, i, p) {
			calls.push('aquiferStep');
			const cap = p.thicknessM * p.storativity * 1000;
			let store = s.store + i.aquiferInflow;
			const aqx = Math.max(0, store - cap);
			store -= aqx;
			const et = 0.01 * Math.max(0, store);
			store -= et;
			const outflow = 0.005 * (store - p.SWL);
			store -= outflow;
			const head = store - p.SWL - i.runoffForHead;
			let baseflow = 0;
			let tl = 0;
			if (head > 0) baseflow = Math.min(p.BFMAX, 0.1 * head);
			else tl = Math.min(Math.max(0, i.runoffForHead), -0.05 * head);
			store += tl - baseflow - i.abstraction;
			const out: SamiAquiferOutput = {
				excessToInterflow: aqx,
				aquiferRecharge: i.aquiferInflow - aqx,
				et,
				outflow,
				baseflow,
				transmissionLoss: tl,
				depletion: 0,
				fromStorage: i.abstraction,
				pctFromGw: 100,
				store
			};
			return { state: { store, tDays: s.tDays, pumping: s.pumping || i.abstraction > 0 }, out };
		}
	};
}
