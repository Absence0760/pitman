/**
 * The Sami aquifer (WRSM2000 groundwater model 2, method 2): the monthly
 * pass-3 loop over the aquifer store. Recharge in from the soil side
 * (`soil.ts`), riparian evaporation, regional outflow, baseflow or
 * transmission losses, and abstraction out.
 *
 * Spec: docs/theory/sami.md §3.6, §3.8–3.12 (equations), §4.2 (order),
 * §5 (invariants), §6 (interface), §7 (worked example), with the OQ-S
 * defaults accepted as provisional in docs/decisions.md. Built from TT 690
 * ch.8 (book p.83–91) and TT 687 §2.7–2.12 only.
 *
 * Month i (§4.2):
 *   1. STORE += PERC + EXRECH; AQX = max(0, STORE − CAP)        TT 690 p.83 eq. 8.4, p.89 eq. 8.12
 *   2. ET = max(0, PETgw − RAIN)·(EVAREA/AREA)·clamp(f, 0, 1),
 *      f = (STORE − SWL)/(CAP − SWL)                             TT 690 p.86 eq. 8.6; TT 687 p.10 eq. 4
 *   3. HG = HGRAD·(STORE − SWL)/(CAP − SWL)                       TT 690 p.87 eq. 8.7; TT 687 p.11 eq. 5
 *      OUT = T·HG·Δt·W/(AREA·10⁶)·1000 mm, W = 4√(AREA·10⁶) m    reconstruction, OQ-S11
 *   4. HEAD = STORE − SWL − Q                                    TT 690 p.87 eq. 8.9; TT 687 p.12 eq. 7
 *      F = sign(HEAD)·(1 − e^{−|BPOW|·|HEAD|})·BFMAX              TT 690 p.87 eq. 8.8; TT 687 p.12 eq. 6 (OQ-S12)
 *      HEAD > 0: baseflow GWBF = F out of STORE; HEAD < 0: TL = min(−F, Q) into STORE
 *   5. Abstraction: t (days since pumping started), t' = 4Tt/(x²S),
 *      %GW = GWMAX/(1 + e^{k3 + k2·t'}),                          TT 690 p.89 eq. 8.13; TT 687 p.16 eq. 10
 *      t update by the PERC ratio                                  TT 690 p.90–91 eqs. 8.14–8.15; TT 687 p.18 eqs. 11–12
 *      DEP = (100 − %GW)/100·ABS·ratio                              TT 690 p.91 eq. 8.16; TT 687 p.18 eq. 13
 *      STORE −= ABS − DEP; DEP comes off GWBF, any excess off STORE  TT 690 p.91
 *
 * Units: every depth is mm over the RU catchment area AREA (km²). The
 * conversions are CAP = THICK (m) × Sy × 1000 (mm); the evaporation area
 * enters as the fraction EVAREA/AREA (both km²); OUT turns T (m²/d) × HG ×
 * Δt (d) × W (m) = m³ into mm by /(AREA·10⁶ m²)·1000; t' needs T in m²/d,
 * t in days and x in m. Abstraction volumes (Mm³) become mm over the
 * catchment as Mm³ × 1000 / AREA before they reach this module (the caller's
 * job: `SamiAquiferInput.abstraction` is already mm).
 *
 * The provisional choices that are cheap to switch are fields of
 * `SamiAquiferOptions` (R6-A1, R6-A2, OQ-S14); the rest are documented
 * where they are coded (R6-A3 … R6-A6). All are listed in
 * docs/theory/sami.md §8.
 */

import type { RunoffModule } from "../../types.js";
import type {
  Mm,
  SamiAquiferInitFn,
  SamiAquiferInput,
  SamiAquiferOutput,
  SamiAquiferParams,
  SamiAquiferState,
  SamiAquiferStepFn,
} from "./contract.js";

/** GWMAX, the maximum % of abstraction taken from storage: not in the file, fixed at 100 (TT 691 `D23_MaxFromGWperc`; sami.md §2.1). */
export const SAMI_GWMAX = 100;

/** Flow width of the regional outflow as a multiple of √AREA (OQ-S11 default: perimeter of the equivalent square). */
export const SAMI_OUTFLOW_WIDTH_FACTOR = 4;

/** Days per month in the outflow and the pumping clock (OQ-S11; the constant of TT 690 p.90 eq. 8.14). */
export const SAMI_DAYS_PER_MONTH = 30;

/** @deprecated The contract's `SamiAquiferParams` now carries `areaKm2`; kept as an alias. */
export type SamiAquiferParamsWithArea = SamiAquiferParams;

/** The provisional choices of the aquifer step that can be switched without touching the code. */
export interface SamiAquiferOptions {
  /**
   * R6-A1: may baseflow depletion exceed the abstraction? Eq. 8.16 scales
   * DEP by the PERC ratio, so in a wet month (ratio > 1) late in pumping
   * (%GW small) DEP > ABS, and `STORE −= ABS − DEP` puts the difference
   * back into storage: the "rewatering" TT 690 p.91 describes ("allows the
   * portion of recharge above the mean monthly value to replenish the
   * accumulated aquifer storage deficit"). `none` (default, literal) or
   * `abstraction` (DEP ≤ ABS).
   */
  readonly depletionCap: "none" | "abstraction";
  /**
   * R6-A2: transmission losses can lift STORE above CAP (TT 690 p.87 adds
   * them to STORE with no cap); the surplus then spills to interflow as
   * AQX at the start of the next month, so that month's AQRECH can be
   * negative. `runoff` (default, literal: TL ≤ Q only) or
   * `runoffAndCapacity` (TL ≤ min(Q, CAP − STORE)).
   */
  readonly transmissionLossCap: "runoff" | "runoffAndCapacity";
  /**
   * OQ-S14: the pumping clock t. `noReset` (default): t = 0 until the
   * first month with ABS > 0, then it evolves by eqs. 8.14/8.15 every
   * month, ≥ 0, never reset. `resetWhenIdle`: a month with ABS = 0 stops
   * pumping and sets t = 0.
   */
  readonly pumpingClock: "noReset" | "resetWhenIdle";
}

export const DEFAULT_SAMI_AQUIFER_OPTIONS: SamiAquiferOptions = Object.freeze({
  depletionCap: "none",
  transmissionLossCap: "runoff",
  pumpingClock: "noReset",
});

/** Intermediate values of one month, for diagnostics and the §5 / §7 tests. */
export interface SamiAquiferDetail {
  /** CAP, mm. */
  readonly capacity: Mm;
  /** STORE after step 1 (inflow in, AQX out); ≤ CAP. */
  readonly storeAfterInflow: Mm;
  /** Storage factor f of eq. 8.6, clamped to [0, 1]. */
  readonly evapFactor: number;
  /** Hydraulic gradient HG (eq. 8.7), may be < 0. */
  readonly gradient: number;
  /** HEAD (eq. 8.9), mm. */
  readonly head: Mm;
  /** GWBF before depletion, mm. */
  readonly grossBaseflow: Mm;
  /** PERC / PERCbar (0 when PERCbar = 0; OQ-S13). */
  readonly ratio: number;
  /** Dimensionless time t' (eq. 8.13); 0 when not pumping. */
  readonly tPrime: number;
}

export interface SamiAquiferStepResult {
  readonly state: SamiAquiferState;
  readonly out: SamiAquiferOutput;
  readonly detail: SamiAquiferDetail;
}

/** CAP = THICK × Sy × 1000, mm (TT 690 p.83; TT 689 p.43). */
export function samiCapacity(p: SamiAquiferParams): Mm {
  return p.thicknessM * p.storativity * 1000;
}

function areaOf(p: SamiAquiferParams): number {
  const area = p.areaKm2;
  if (typeof area !== "number" || !(area > 0) || !Number.isFinite(area)) {
    throw new RangeError(
      `Sami aquifer: params need a catchment areaKm2 > 0 (got ${String(area)})`,
    );
  }
  return area;
}

function checkParams(p: SamiAquiferParams): {
  readonly cap: Mm;
  readonly area: number;
} {
  const area = areaOf(p);
  const cap = samiCapacity(p);
  // R6-A4: WRSM2000 refuses CAP ≤ SWL, since the storage factor divides
  // by CAP − SWL (TT 691 p.209 item 83).
  if (!(cap > p.SWL)) {
    throw new RangeError(
      `Sami aquifer: capacity ${cap} mm (thickness × storativity × 1000) must exceed the static water level ${p.SWL} mm`,
    );
  }
  // R6-A8: the other parameters an equation divides by or scales with.
  if (!(p.storativity > 0) || !(p.distM > 0)) {
    throw new RangeError(
      `Sami aquifer: storativity (${p.storativity}) and the borehole distance (${p.distM} m) must be > 0 (eq. 8.13 divides by x²·S)`,
    );
  }
  if (!(p.evapAreaKm2 >= 0 && p.evapAreaKm2 <= area)) {
    throw new RangeError(
      `Sami aquifer: the groundwater evaporation area ${p.evapAreaKm2} km² must lie in [0, catchment area ${area} km²]`,
    );
  }
  return { cap, area };
}

/** Initial state: STORE₀ as read, no pumping (OQ-S17: no warm-up; OQ-S14: t = 0). */
export const samiAquiferInit: SamiAquiferInitFn = (p) => {
  checkParams(p);
  return { store: p.store0, tDays: 0, pumping: false };
};

/** One month of the aquifer with its intermediate values (§4.2 steps 1–5). */
export function samiAquiferStepDetail(
  s: SamiAquiferState,
  i: SamiAquiferInput,
  p: SamiAquiferParams,
  options: SamiAquiferOptions = DEFAULT_SAMI_AQUIFER_OPTIONS,
): SamiAquiferStepResult {
  const { cap, area } = checkParams(p);
  const range = cap - p.SWL;

  // 1. Recharge in, excess over capacity to interflow (§3.6).
  let store = s.store + i.aquiferInflow;
  const aqx = Math.max(0, store - cap);
  store -= aqx;
  const storeAfterInflow = store;
  const aquiferRecharge = i.aquiferInflow - aqx;

  // 2. Riparian evaporation (§3.8).
  const evapFactor = Math.min(1, Math.max(0, (store - p.SWL) / range));
  const et =
    Math.max(0, i.petGw - i.rain) * (p.evapAreaKm2 / area) * evapFactor;
  store -= et;

  // 3. Regional outflow (§3.9). HG and OUT are not clamped: below SWL
  // they turn negative and draw water in (TT 690 p.87).
  const gradient = (p.HGRAD * (store - p.SWL)) / range;
  const areaM2 = (p.outflowAreaKm2 && p.outflowAreaKm2 > 0 ? p.outflowAreaKm2 : area) * 1e6;
  const widthM = p.outflowWidthFactor * Math.sqrt(areaM2);
  const outflow =
    ((p.T_m2d * gradient * p.daysPerMonth * widthM) / areaM2) * 1000;
  store -= outflow;

  // 4. Baseflow or transmission loss (§3.10). R6-A5: a negative runoff
  // (the literal Muskingum lag can produce one, OQ-22) counts as 0 for the
  // head and the TL cap, so TL stays in [0, Q]. R6-A6: the curve uses
  // −|BPOW| (TT 689 p.44: BPOW "should always be −0.05"), so a positive
  // BPOW cannot flip baseflow into an unbounded loss.
  const runoff = Math.max(0, i.runoffForHead);
  const head = store - p.SWL - runoff;
  const magnitude =
    (1 - Math.exp(-Math.abs(p.BPOW) * Math.abs(head))) * p.BFMAX;
  let grossBaseflow = 0;
  let transmissionLoss = 0;
  if (head > 0) {
    grossBaseflow = magnitude;
    store -= grossBaseflow;
  } else if (head < 0) {
    transmissionLoss = Math.min(magnitude, runoff);
    // R6-A10: nor more than the runoff it comes out of (TT 687 p.12–13:
    // "transmission losses cannot exceed runoff"). HEAD's runoff (OQ-S3 (i),
    // Pitman total Q) can exceed it, so without this Qfinal goes negative.
    if (i.runoffForLoss && transmissionLoss > 0) {
      transmissionLoss = Math.min(transmissionLoss, Math.max(0, i.runoffForLoss(aqx)));
    }
    if (options.transmissionLossCap === "runoffAndCapacity") {
      transmissionLoss = Math.max(0, Math.min(transmissionLoss, cap - store));
    }
    store += transmissionLoss;
  }

  // 5. Abstraction (§3.11).
  const abstraction = i.abstraction;
  // R6-A8: ABS is a demand, never a supply.
  if (!(abstraction >= 0) || !Number.isFinite(abstraction)) {
    throw new RangeError(
      `Sami aquifer: abstraction must be a finite depth ≥ 0 mm (got ${abstraction})`,
    );
  }
  const ratio = i.percBar > 0 ? i.perc / i.percBar : 0; // OQ-S13
  let pumping = s.pumping || abstraction > 0;
  let tDays = s.tDays;
  if (options.pumpingClock === "resetWhenIdle" && !(abstraction > 0)) {
    pumping = false;
    tDays = 0;
  }
  let tPrime = 0;
  let pctFromGw = 0;
  let depletion = 0;
  let fromStorage = 0;
  let baseflow = grossBaseflow;
  if (pumping) {
    // Eqs. 8.14 (ratio < 1) and 8.15 (ratio ≥ 1) are one expression. The
    // clock already moves in the first pumping month, before %GW (OQ-S14).
    // R6-A7: nothing floors STORE; heavy abstraction can take it below 0
    // (TT 690 p.91 is silent, eq. 14's curtailment is off by OQ-S15).
    tDays = Math.max(0, tDays + (1 - ratio) * p.daysPerMonth);
    tPrime =
      tDays > 0
        ? (4 * p.T_m2d * tDays) / (p.distM * p.distM * p.storativity)
        : 0;
    pctFromGw = p.GWMAX / (1 + Math.exp(p.k3 + p.k2 * tPrime));
    depletion = ((100 - pctFromGw) / 100) * abstraction * ratio;
    if (options.depletionCap === "abstraction")
      depletion = Math.min(depletion, abstraction);
    store -= abstraction - depletion;
    if (depletion <= grossBaseflow) {
      baseflow = grossBaseflow - depletion;
    } else {
      store -= depletion - grossBaseflow;
      baseflow = 0;
    }
    // R6-A3: everything the abstraction takes from STORE; the rest of
    // ABS is the baseflow it actually removed, so
    // ABS = fromStorage + (grossBaseflow − baseflow).
    fromStorage = abstraction - (grossBaseflow - baseflow);
  }

  return {
    state: { store, tDays, pumping },
    out: {
      excessToInterflow: aqx,
      aquiferRecharge,
      et,
      outflow,
      baseflow,
      transmissionLoss,
      depletion,
      fromStorage,
      pctFromGw,
      store,
    },
    detail: {
      capacity: cap,
      storeAfterInflow,
      evapFactor,
      gradient,
      head,
      grossBaseflow,
      ratio,
      tPrime,
    },
  };
}

/** The step with the given options, in the contract's shape. */
export function makeSamiAquiferStep(
  options: SamiAquiferOptions = DEFAULT_SAMI_AQUIFER_OPTIONS,
): SamiAquiferStepFn {
  return (s, i, p) => {
    const { state, out } = samiAquiferStepDetail(s, i, p, options);
    return { state, out };
  };
}

/** One month of the aquifer with the default options. */
export const samiAquiferStep: SamiAquiferStepFn = makeSamiAquiferStep();

/**
 * Aquifer parameters from a runoff module's Sami block (L.031–L.034;
 * sami.md §2.1). No unit conversions are needed: the file holds THICK in m,
 * STORE₀, SWL and BFMAX in mm (mm/month), T in m²/d, x in m and EVAREA in
 * km² (TT 689 p.43–44). `staticWaterLevelMm` is mm (TT 689
 * p.43: "a default of 60 mm"). GWMAX and the OQ-S11 constants are fixed.
 */
export function samiAquiferParams(
  module: RunoffModule,
): SamiAquiferParamsWithArea {
  const sami = module.sami;
  if (!sami)
    throw new RangeError(
      `Sami aquifer: runoff module ${module.number} has no Sami parameters (L.031–L.037)`,
    );
  return {
    thicknessM: sami.aquiferThicknessM,
    storativity: sami.storativity,
    store0: sami.initialAquiferStorage,
    SWL: sami.staticWaterLevelMm,
    BFMAX: sami.maxDischarge,
    BPOW: sami.gwSwPower,
    HGRAD: sami.maxHydraulicGradient,
    T_m2d: sami.transmissivity,
    evapAreaKm2: sami.gwEvaporationArea,
    k2: sami.K2,
    k3: sami.K3,
    distM: sami.boreholeDistanceToRiver,
    GWMAX: SAMI_GWMAX,
    outflowWidthFactor: SAMI_OUTFLOW_WIDTH_FACTOR,
    daysPerMonth: SAMI_DAYS_PER_MONTH,
    areaKm2: module.areaKm2,
    ...(sami.outflowAreaKm2 !== undefined ? { outflowAreaKm2: sami.outflowAreaKm2 } : {}),
  };
}
