import { describe, expect, it } from "vitest";
import { seededRandom, syntheticNetwork } from "../../synthetic/synthetic.js";
import type { RunoffModule, SamiParameters } from "../../types.js";
import {
  DEFAULT_SAMI_AQUIFER_OPTIONS,
  makeSamiAquiferStep,
  SAMI_DAYS_PER_MONTH,
  SAMI_GWMAX,
  SAMI_OUTFLOW_WIDTH_FACTOR,
  samiAquiferInit,
  samiAquiferParams,
  samiAquiferStep,
  samiAquiferStepDetail,
  samiCapacity,
  type SamiAquiferOptions,
  type SamiAquiferParamsWithArea,
  type SamiAquiferStepResult,
} from "./aquifer.js";
import type {
  SamiAquiferInput,
  SamiAquiferParams,
  SamiAquiferState,
  SamiParts,
} from "./contract.js";

// Hand-worked parameter set: AREA 100 km², CAP = 20 m × 0.005 × 1000 = 100 mm,
// SWL 60 mm (so CAP − SWL = 40), EVAREA 1 km² (1 % of AREA), x = 100 m so
// t' = 4·10·t/(100²·0.005) = 0.8·t.
const P: SamiAquiferParamsWithArea = Object.freeze({
  thicknessM: 20,
  storativity: 0.005,
  store0: 90,
  SWL: 60,
  BFMAX: 2,
  BPOW: -0.05,
  HGRAD: 0.001,
  T_m2d: 10,
  evapAreaKm2: 1,
  k2: 0.1,
  k3: -3,
  distM: 100,
  GWMAX: 100,
  outflowWidthFactor: 4,
  daysPerMonth: 30,
  areaKm2: 100,
});

/** A month with nothing happening; override what the test exercises. */
const QUIET: SamiAquiferInput = Object.freeze({
  aquiferInflow: 0,
  perc: 0,
  percBar: 1,
  runoffForHead: 0,
  rain: 100,
  petGw: 100,
  abstraction: 0,
});

const state = (
  store: number,
  tDays = 0,
  pumping = false,
): SamiAquiferState => ({ store, tDays, pumping });
const step = (
  s: SamiAquiferState,
  i: Partial<SamiAquiferInput>,
  p: Partial<SamiAquiferParamsWithArea> = {},
  o?: SamiAquiferOptions,
) => samiAquiferStepDetail(s, { ...QUIET, ...i }, { ...P, ...p }, o);

describe("Sami aquifer: parameters and initial state", () => {
  it("CAP = thickness × storativity × 1000 (TT 690 p.83; TT 689 p.43)", () => {
    expect(samiCapacity(P)).toBeCloseTo(100, 12);
  });

  it("starts from STORE₀ with the pumping clock at 0 (OQ-S17, OQ-S14)", () => {
    expect(samiAquiferInit(P)).toEqual({ store: 90, tDays: 0, pumping: false });
  });

  it("refuses CAP ≤ SWL, as WRSM2000 does (TT 691 p.209 item 83)", () => {
    expect(() => samiAquiferInit({ ...P, SWL: 100 })).toThrow(RangeError);
    expect(() =>
      samiAquiferStep(state(90), QUIET, { ...P, storativity: 0.002 }),
    ).toThrow(RangeError);
  });

  it("needs the catchment area, which the contract params lack", () => {
    const { areaKm2: _, ...noArea } = P;
    expect(() => samiAquiferInit(noArea as SamiAquiferParams)).toThrow(
      /areaKm2/,
    );
    const zeroArea: SamiAquiferParamsWithArea = { ...P, areaKm2: 0 };
    expect(() => samiAquiferStep(state(90), QUIET, zeroArea)).toThrow(
      RangeError,
    );
  });

  it("maps a runoff module Sami block (L.031–L.034) without unit conversions", () => {
    const base = syntheticNetwork().runoff[0]!;
    const sami = {
      aquiferThicknessM: 17,
      storativity: 0.009,
      initialAquiferStorage: 142,
      staticWaterLevelM: 126,
      unsaturatedStorage: 9,
      initialUnsaturatedStorage: 5,
      PPOW: 0.2,
      GPOW: 1,
      maxDischarge: 2,
      gwSwPower: -0.05,
      HGSL: 180,
      HGGW: 4.5,
      maxHydraulicGradient: 0.001,
      transmissivity: 10,
      boreholeDistanceToRiver: 20,
      gwEvaporationArea: 12,
      K2: 0.1,
      K3: -3,
      interflowLag: 0,
      rechargeAveragingMonths: 2,
      abstractionMode: 0,
      pitman: base.pitman,
      abstractions: [],
    } satisfies SamiParameters;
    const module: RunoffModule = {
      ...base,
      areaKm2: 406,
      groundwaterModel: 2,
      sami,
    };
    expect(samiAquiferParams(module)).toEqual({
      thicknessM: 17,
      storativity: 0.009,
      store0: 142,
      SWL: 126,
      BFMAX: 2,
      BPOW: -0.05,
      HGRAD: 0.001,
      T_m2d: 10,
      evapAreaKm2: 12,
      k2: 0.1,
      k3: -3,
      distM: 20,
      GWMAX: SAMI_GWMAX,
      outflowWidthFactor: SAMI_OUTFLOW_WIDTH_FACTOR,
      daysPerMonth: SAMI_DAYS_PER_MONTH,
      areaKm2: 406,
    });
    expect([
      SAMI_GWMAX,
      SAMI_OUTFLOW_WIDTH_FACTOR,
      SAMI_DAYS_PER_MONTH,
    ]).toEqual([100, 4, 30]);
    expect(() => samiAquiferParams(base)).toThrow(/no Sami parameters/);
  });

  it("fits the composition contract", () => {
    const parts: Pick<SamiParts, "aquiferInit" | "aquiferStep"> = {
      aquiferInit: samiAquiferInit,
      aquiferStep: samiAquiferStep,
    };
    expect(
      parts.aquiferStep(parts.aquiferInit(P), QUIET, P).out.store,
    ).toBeGreaterThan(0);
  });
});

describe("Sami aquifer: one equation at a time (hand-worked)", () => {
  it("eq. 8.4 / 8.12: recharge above CAP spills to interflow (AQX), AQRECH is the rest", () => {
    const r = step(state(95), { aquiferInflow: 10, perc: 10 }, { HGRAD: 0 });
    expect(r.detail.storeAfterInflow).toBe(100);
    expect(r.out.excessToInterflow).toBeCloseTo(5, 12);
    expect(r.out.aquiferRecharge).toBeCloseTo(5, 12);
    const below = step(state(80), { aquiferInflow: 10, perc: 10 });
    expect(below.out.excessToInterflow).toBe(0);
    expect(below.out.aquiferRecharge).toBe(10);
  });

  it("eq. 8.6: ET = (PET − RAIN)·(EVAREA/AREA)·(STORE − SWL)/(CAP − SWL)", () => {
    // (150 − 50) · (1/100) · (80 − 60)/40 = 100 · 0.01 · 0.5 = 0.5
    const r = step(state(80), { petGw: 150, rain: 50 });
    expect(r.detail.evapFactor).toBeCloseTo(0.5, 12);
    expect(r.out.et).toBeCloseTo(0.5, 12);
    // Rain above PET: no groundwater ET (TT 690 p.86).
    expect(step(state(80), { petGw: 50, rain: 150 }).out.et).toBe(0);
    // Below SWL the factor clamps to 0 ("does not become negative", TT 690 p.86).
    expect(step(state(50), { petGw: 150, rain: 50 }).out.et).toBe(0);
    // At capacity it is 1.
    expect(step(state(100), { petGw: 150, rain: 50 }).out.et).toBeCloseTo(
      1,
      12,
    );
  });

  it("eq. 8.7 + OQ-S11: OUT = T·HG·30 d·4√A/A in mm, negative below SWL", () => {
    // HG = 0.001·20/40 = 0.0005; T·HG·Δt = 10·0.0005·30 = 0.15 m²; W = 4·√1e8 = 40 000 m;
    // 0.15·40 000 = 6 000 m³ over 1e8 m² = 6e-5 m = 0.06 mm.
    const r = step(state(80), {});
    expect(r.detail.gradient).toBeCloseTo(0.0005, 15);
    expect(r.out.outflow).toBeCloseTo(0.06, 12);
    // STORE 50: HG = 0.001·(−10)/40 = −0.00025, OUT = −0.03 (inflow from neighbours, TT 690 p.87).
    const low = step(state(50), {});
    expect(low.detail.gradient).toBeCloseTo(-0.00025, 15);
    expect(low.out.outflow).toBeCloseTo(-0.03, 12);
    // The reconstruction constants are parameters (exposed for the comparison harness).
    expect(
      step(state(80), {}, { outflowWidthFactor: 1, daysPerMonth: 15 }).out
        .outflow,
    ).toBeCloseTo(0.0075, 12);
  });

  it("eqs. 8.8–8.9: effluent head gives baseflow (1 − e^{BPOW·HEAD})·BFMAX", () => {
    // HGRAD 0 so STORE is 80 at the head: HEAD = 80 − 60 − 0 = 20, GWBF = (1 − e^{−1})·2.
    const r = step(state(80), {}, { HGRAD: 0 });
    expect(r.detail.head).toBeCloseTo(20, 12);
    expect(r.out.baseflow).toBeCloseTo((1 - Math.exp(-1)) * 2, 12);
    expect(r.out.transmissionLoss).toBe(0);
    expect(r.out.store).toBeCloseTo(80 - (1 - Math.exp(-1)) * 2, 12);
    // Runoff raises the surface-water head: HEAD = 80 − 60 − 10 = 10.
    const wet = step(state(80), { runoffForHead: 10 }, { HGRAD: 0 });
    expect(wet.detail.head).toBeCloseTo(10, 12);
    expect(wet.out.baseflow).toBeCloseTo((1 - Math.exp(-0.5)) * 2, 12);
  });

  it("eqs. 8.8–8.9 (OQ-S12): influent head gives a TL into STORE, capped at Q", () => {
    // HEAD = 80 − 60 − 30 = −10 → TL = (1 − e^{−0.5})·2 = 0.78694, ≤ Q = 30.
    const r = step(state(80), { runoffForHead: 30 }, { HGRAD: 0 });
    const tl = (1 - Math.exp(-0.5)) * 2;
    expect(r.detail.head).toBeCloseTo(-10, 12);
    expect(r.out.transmissionLoss).toBeCloseTo(tl, 12);
    expect(r.out.baseflow).toBe(0);
    expect(r.out.store).toBeCloseTo(80 + tl, 12);
    // Below SWL with little runoff: HEAD = 50 − 60 − 0.3 = −10.3, F = 0.80 > Q, so TL = Q.
    const capped = step(state(50), { runoffForHead: 0.3 }, { HGRAD: 0 });
    expect(capped.out.transmissionLoss).toBe(0.3);
    // HEAD = 0: neither.
    const level = step(state(70), { runoffForHead: 10 }, { HGRAD: 0 });
    expect([level.out.baseflow, level.out.transmissionLoss]).toEqual([0, 0]);
  });

  it("R6-A5: a negative runoff (literal lag) counts as 0 for the head and the TL cap", () => {
    const r = step(state(50), { runoffForHead: -2 }, { HGRAD: 0 });
    expect(r.detail.head).toBeCloseTo(-10, 12);
    expect(r.out.transmissionLoss).toBe(0);
  });

  it("R6-A6: the curve uses −|BPOW|, so a positive BPOW still saturates at BFMAX", () => {
    const neg = step(state(80), {}, { HGRAD: 0 });
    const pos = step(state(80), {}, { HGRAD: 0, BPOW: 0.05 });
    expect(pos.out.baseflow).toBe(neg.out.baseflow);
  });

  it("R6-A2: TL may lift STORE above CAP; the option caps it at CAP − STORE", () => {
    // Reach HEAD < 0 at STORE 99.5 with a big flood: HEAD = 99.5 − 60 − 200 → TL ≈ 2.
    const literal = step(state(99.5), { runoffForHead: 200 }, { HGRAD: 0 });
    expect(literal.out.store).toBeGreaterThan(100);
    const capped = step(
      state(99.5),
      { runoffForHead: 200 },
      { HGRAD: 0 },
      {
        ...DEFAULT_SAMI_AQUIFER_OPTIONS,
        transmissionLossCap: "runoffAndCapacity",
      },
    );
    expect(capped.out.transmissionLoss).toBeCloseTo(0.5, 12);
    expect(capped.out.store).toBeCloseTo(100, 12);
    // Next month the literal surplus spills as AQX and AQRECH goes negative.
    const next = samiAquiferStepDetail(literal.state, { ...QUIET }, P);
    expect(next.out.excessToInterflow).toBeCloseTo(literal.out.store - 100, 12);
    expect(next.out.aquiferRecharge).toBeLessThan(0);
  });

  it("eqs. 8.13–8.14, 8.16: t, t′, %GW and depletion in a dry month", () => {
    // ratio = 0.5/1 → t = 0 + 0.5·30 = 15 d; t′ = 0.8·15 = 12;
    // %GW = 100/(1 + e^{−3 + 1.2}) = 85.8149; DEP = 0.141851·2·0.5 = 0.141851.
    const r = step(state(80), { perc: 0.5, abstraction: 2 }, { HGRAD: 0 });
    const pct = 100 / (1 + Math.exp(-1.8));
    const dep = ((100 - pct) / 100) * 2 * 0.5;
    const gross = (1 - Math.exp(-1)) * 2;
    expect(r.state.tDays).toBeCloseTo(15, 12);
    expect(r.detail.tPrime).toBeCloseTo(12, 12);
    expect(r.out.pctFromGw).toBeCloseTo(pct, 10);
    expect(pct).toBeCloseTo(85.8149, 4);
    expect(r.out.depletion).toBeCloseTo(dep, 12);
    expect(r.out.baseflow).toBeCloseTo(gross - dep, 12);
    expect(r.out.fromStorage).toBeCloseTo(2 - dep, 12);
    expect(r.out.store).toBeCloseTo(80 - gross - (2 - dep), 12);
  });

  it("eq. 8.15: a wet month winds the clock back, never below 0", () => {
    expect(
      step(state(80, 45, true), { perc: 1.5, abstraction: 1 }).state.tDays,
    ).toBeCloseTo(30, 12);
    expect(
      step(state(80, 45, true), { perc: 3, abstraction: 1 }).state.tDays,
    ).toBe(0);
    // t = 0 → t′ = 0 → %GW = 100/(1 + e^{−3}) = 95.257 % from storage.
    expect(
      step(state(80), { perc: 3, abstraction: 1 }).out.pctFromGw,
    ).toBeCloseTo(95.2574, 4);
  });

  it("TT 690 p.91: depletion beyond the baseflow comes from STORE", () => {
    // t = 1000 + 15 d → t′ = 812, %GW ≈ 0; DEP = 4·0.5 = 2 > GWBF 1.2642.
    const r = step(
      state(80, 1000, true),
      { perc: 0.5, abstraction: 4 },
      { HGRAD: 0 },
    );
    const gross = (1 - Math.exp(-1)) * 2;
    expect(r.out.depletion).toBeCloseTo(2, 10);
    expect(r.out.baseflow).toBe(0);
    expect(r.out.fromStorage).toBeCloseTo(4 - gross, 10);
    expect(r.out.store).toBeCloseTo(80 - gross - (4 - 2) - (2 - gross), 10);
  });

  it("R6-A1: in a wet month depletion may exceed ABS and rewater STORE; the option caps it", () => {
    // t = 1000 − 30 → %GW ≈ 0; ratio 2: DEP = 0.5·2 = 1.0 > ABS 0.5, < GWBF.
    const r = step(
      state(80, 1000, true),
      { perc: 2, abstraction: 0.5 },
      { HGRAD: 0 },
    );
    const gross = (1 - Math.exp(-1)) * 2;
    expect(r.out.depletion).toBeCloseTo(1, 10);
    expect(r.out.fromStorage).toBeCloseTo(-0.5, 10);
    expect(r.out.store).toBeCloseTo(80 - gross + 0.5, 10);
    const capped = step(
      state(80, 1000, true),
      { perc: 2, abstraction: 0.5 },
      { HGRAD: 0 },
      { ...DEFAULT_SAMI_AQUIFER_OPTIONS, depletionCap: "abstraction" },
    );
    expect(capped.out.depletion).toBeCloseTo(0.5, 12);
    expect(capped.out.fromStorage).toBeCloseTo(0, 12);
  });

  it("OQ-S13: PERCbar = 0 gives ratio 0 (no depletion, the clock runs)", () => {
    const r = step(state(80), { perc: 1, percBar: 0, abstraction: 2 });
    expect(r.detail.ratio).toBe(0);
    expect(r.out.depletion).toBe(0);
    expect(r.state.tDays).toBe(30);
  });
});

describe("Sami aquifer: abstraction switching (OQ-S14)", () => {
  const run = (abs: readonly number[], options?: SamiAquiferOptions) => {
    const s0 = samiAquiferInit(P);
    const states: SamiAquiferState[] = [];
    const outs: SamiAquiferStepResult[] = [];
    abs.reduce((s, a) => {
      const r = samiAquiferStepDetail(
        s,
        { ...QUIET, perc: 0.5, abstraction: a },
        P,
        options,
      );
      states.push(r.state);
      outs.push(r);
      return r.state;
    }, s0);
    return { states, outs };
  };

  it("the clock starts with the first abstraction and keeps running without a reset (default)", () => {
    const { states, outs } = run([0, 0, 2, 0, 0, 2]);
    expect(states.map((s) => s.pumping)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(states.map((s) => s.tDays)).toEqual([0, 0, 15, 30, 45, 60]);
    // Before pumping no %GW is reported; while pumping with ABS = 0 there is no depletion.
    expect(outs[0]!.out.pctFromGw).toBe(0);
    expect(outs[3]!.out.depletion).toBe(0);
    expect(outs[3]!.out.fromStorage).toBe(0);
    expect(outs[3]!.out.pctFromGw).toBeGreaterThan(0);
  });

  it("resetWhenIdle stops the clock in a month without abstraction", () => {
    const { states } = run([0, 2, 2, 0, 2], {
      ...DEFAULT_SAMI_AQUIFER_OPTIONS,
      pumpingClock: "resetWhenIdle",
    });
    expect(states.map((s) => s.pumping)).toEqual([
      false,
      true,
      true,
      false,
      true,
    ]);
    expect(states.map((s) => s.tDays)).toEqual([0, 15, 30, 0, 15]);
  });

  it("the default options are frozen and literal", () => {
    expect(DEFAULT_SAMI_AQUIFER_OPTIONS).toEqual({
      depletionCap: "none",
      transmissionLossCap: "runoff",
      pumpingClock: "noReset",
    });
    expect(Object.isFrozen(DEFAULT_SAMI_AQUIFER_OPTIONS)).toBe(true);
  });
});

describe("Sami aquifer: worked example (sami.md §7, TT 690 Fig 8.13 B82B parameters)", () => {
  const area = 406;
  const p: SamiAquiferParamsWithArea = {
    thicknessM: 17,
    storativity: 0.009,
    store0: 142,
    SWL: 126,
    BFMAX: 2,
    BPOW: -0.05,
    HGRAD: 0.001,
    T_m2d: 10,
    evapAreaKm2: 12,
    k2: 0.1,
    k3: -3,
    distM: 20,
    GWMAX: 100,
    outflowWidthFactor: 4,
    daysPerMonth: 30,
    areaKm2: area,
  };
  const percBar = 18.58 / 12;
  const abs = (0.8 * 1000) / area; // 0.8 Mm³ over 406 km² = 1.9704 mm
  // The §7 soil table: aquiferInflow = PERC (EXRECH = 0 every month).
  const months = [
    { perc: 3.6406, rain: 60, pet: 150, q: 3, abs: 0 },
    { perc: 4.6012, rain: 110, pet: 140, q: 9, abs: 0 },
    { perc: 6.0485, rain: 150, pet: 145, q: 40, abs: 0 },
    { perc: 3.3387, rain: 120, pet: 140, q: 14, abs },
    { perc: 1.7419, rain: 70, pet: 120, q: 4, abs },
    { perc: 1.0985, rain: 25, pet: 105, q: 2, abs },
  ];
  // STORE after inflow, AQX, f, ET, HG, OUT, HEAD, GWBF gross, TL, t, %GW, DEP, STORE end, GWBF net.
  const table = [
    [
      145.6406, 0, 0.7274, 1.935, 0.000656, 0.0391, 14.6665, 1.0394, 0, 0, 0, 0,
      142.6271, 1.0394,
    ],
    [
      147.2283, 0, 0.7862, 0.6972, 0.00076, 0.0453, 11.4859, 0.8738, 0, 0, 0, 0,
      145.6121, 0.8738,
    ],
    [
      151.6606, 0, 0.9504, 0, 0.00095, 0.0566, -14.396, 0, 1.0263, 0, 0, 0,
      152.6303, 0,
    ],
    [
      153, 2.969, 1, 0.5911, 0.000978, 0.0583, 12.3506, 0.9215, 0, 0, 95.26,
      0.2015, 149.6602, 0.7199,
    ],
    [
      151.4021, 0, 0.9408, 1.3904, 0.000889, 0.053, 19.9588, 1.2627, 0, 0,
      95.26, 0.1051, 146.8308, 1.1576,
    ],
    [
      147.9293, 0, 0.8122, 1.9205, 0.000741, 0.0441, 17.9647, 1.1854, 0, 8.72,
      0.12, 1.3962, 143.9942, 0,
    ],
  ] as const;

  const results: SamiAquiferStepResult[] = [];
  months.reduce((s, m) => {
    const r = samiAquiferStepDetail(
      s,
      {
        aquiferInflow: m.perc,
        perc: m.perc,
        percBar,
        runoffForHead: m.q,
        rain: m.rain,
        petGw: m.pet,
        abstraction: m.abs,
      },
      p,
    );
    results.push(r);
    return r.state;
  }, samiAquiferInit(p));

  it("CAP = 17 × 0.009 × 1000 = 153 mm", () => {
    expect(samiCapacity(p)).toBeCloseTo(153, 10);
  });

  months.forEach((_, m) => {
    it(`month ${m + 1} matches the §7 table to the printed precision`, () => {
      const r = results[m]!;
      const row = table[m]!;
      const near = (got: number, want: number, tol: number) =>
        expect(Math.abs(got - want)).toBeLessThanOrEqual(tol);
      near(r.detail.storeAfterInflow, row[0], 2e-4);
      near(r.out.excessToInterflow, row[1], 2e-4);
      near(r.detail.evapFactor, row[2], 1e-4);
      near(r.out.et, row[3], 1e-4);
      near(r.detail.gradient, row[4], 1e-6);
      near(r.out.outflow, row[5], 1e-4);
      near(r.detail.head, row[6], 2e-4);
      near(r.detail.grossBaseflow, row[7], 1e-4);
      near(r.out.transmissionLoss, row[8], 1e-4);
      near(r.state.tDays, row[9], 0.01);
      near(r.out.pctFromGw, row[10], 0.01);
      near(r.out.depletion, row[11], 1e-4);
      near(r.out.store, row[12], 2e-4);
      near(r.out.baseflow, row[13], 1e-4);
    });
  });

  it("closes the month-by-month aquifer balance (§5)", () => {
    let prev = p.store0;
    months.forEach((m, k) => {
      const o = results[k]!.out;
      expect(o.store - prev).toBeCloseTo(
        o.aquiferRecharge -
          o.et -
          o.outflow -
          o.baseflow +
          o.transmissionLoss -
          m.abs,
        10,
      );
      prev = o.store;
    });
  });
});

// ---------------------------------------------------------------------------
// §5 invariants over random synthetic inputs
// ---------------------------------------------------------------------------

function randomParams(random: () => number): SamiAquiferParamsWithArea {
  const u = (lo: number, hi: number) => lo + (hi - lo) * random();
  const thicknessM = u(5, 50);
  const storativity = u(0.001, 0.02);
  const cap = thicknessM * storativity * 1000;
  const areaKm2 = u(10, 2000);
  return {
    thicknessM,
    storativity,
    store0: u(0, cap),
    SWL: cap * u(0.3, 0.95),
    BFMAX: u(0.5, 10),
    BPOW: -u(0.01, 0.2),
    HGRAD: u(0, 0.01),
    T_m2d: u(1, 1000),
    evapAreaKm2: areaKm2 * u(0, 0.05),
    k2: u(0.05, 0.5),
    k3: -u(1, 8),
    distM: u(20, 2000),
    GWMAX: 100,
    outflowWidthFactor: 4,
    daysPerMonth: 30,
    areaKm2,
  };
}

function randomInput(
  random: () => number,
  abstraction: boolean,
): SamiAquiferInput {
  const u = (lo: number, hi: number) => lo + (hi - lo) * random();
  const inflow = random() < 0.3 ? 0 : u(0, 15);
  return {
    aquiferInflow: inflow,
    perc: inflow * u(0, 1),
    percBar: u(0.5, 3),
    runoffForHead: random() < 0.2 ? 0 : u(0, 60),
    rain: u(0, 200),
    petGw: u(0, 250),
    abstraction: abstraction && random() < 0.7 ? u(0, 5) : 0,
  };
}

/** Run `months` months; call `check` on each with the state before it. */
function simulate(
  seed: number,
  months: number,
  abstraction: boolean,
  check: (
    before: SamiAquiferState,
    i: SamiAquiferInput,
    r: SamiAquiferStepResult,
    p: SamiAquiferParamsWithArea,
  ) => void,
  params?: (random: () => number) => SamiAquiferParamsWithArea,
  options: SamiAquiferOptions = DEFAULT_SAMI_AQUIFER_OPTIONS,
) {
  const random = seededRandom(seed);
  const p = Object.freeze((params ?? randomParams)(random));
  let s = Object.freeze(samiAquiferInit(p));
  for (let m = 0; m < months; m++) {
    // Frozen before the call: a mutation in the step would throw (ES module strict mode).
    const i = Object.freeze(randomInput(random, abstraction));
    const r = samiAquiferStepDetail(s, i, p, options);
    check(s, i, r, p);
    s = Object.freeze(r.state);
  }
}

/** Every combination of the switchable options. */
const ALL_OPTIONS: readonly SamiAquiferOptions[] = (
  ["none", "abstraction"] as const
).flatMap((depletionCap) =>
  (["runoff", "runoffAndCapacity"] as const).flatMap((transmissionLossCap) =>
    (["noReset", "resetWhenIdle"] as const).map((pumpingClock) => ({
      depletionCap,
      transmissionLossCap,
      pumpingClock,
    })),
  ),
);

const EPS = 1e-9;

describe("Sami aquifer: §5 invariants every month", () => {
  const seeds = Array.from({ length: 20 }, (_, k) => k + 1);

  it.each(ALL_OPTIONS)(
    "aquifer mass balance (both the §5 form and the output-only form), options %o",
    (options) => {
      for (const seed of seeds) {
        for (const abstraction of [false, true]) {
          simulate(
            seed,
            240,
            abstraction,
            (before, i, r) => {
              const { out, detail } = r;
              const abs = r.state.pumping ? i.abstraction : 0;
              const g = detail.grossBaseflow;
              const dep = out.depletion;
              const delta = out.store - before.store;
              const scale = 1 + Math.abs(before.store);
              // §5: ΔSTORE = PERC + EXRECH − AQX − ET − OUT − GWBF_gross + TL − (ABS − DEP) − max(0, DEP − GWBF_gross)
              const s5 =
                i.aquiferInflow -
                out.excessToInterflow -
                out.et -
                out.outflow -
                g +
                out.transmissionLoss -
                (abs - dep) -
                Math.max(0, dep - g);
              expect(Math.abs(delta - s5)).toBeLessThan(EPS * scale);
              // Depletion only moves water between baseflow and the abstraction.
              const net =
                out.aquiferRecharge -
                out.et -
                out.outflow -
                out.baseflow +
                out.transmissionLoss -
                abs;
              expect(Math.abs(delta - net)).toBeLessThan(EPS * scale);
              // R6-A3: ABS = fromStorage + the baseflow it removed.
              expect(
                Math.abs(abs - (out.fromStorage + (g - out.baseflow))),
              ).toBeLessThan(EPS * scale);
            },
            undefined,
            options,
          );
        }
      }
    },
  );

  it.each(ALL_OPTIONS)(
    "bounds: 0 ≤ TL ≤ Q, 0 ≤ GWBF ≤ BFMAX, ET ≥ 0, STORE ≤ CAP after step 1, AQX ≥ 0, options %o",
    (options) => {
      for (const seed of seeds) {
        for (const abstraction of [false, true]) {
          simulate(
            seed,
            240,
            abstraction,
            (_, i, r, p) => {
              const { out, detail } = r;
              expect(out.transmissionLoss).toBeGreaterThanOrEqual(0);
              expect(out.transmissionLoss).toBeLessThanOrEqual(
                Math.max(0, i.runoffForHead),
              );
              expect(detail.grossBaseflow).toBeGreaterThanOrEqual(0);
              expect(detail.grossBaseflow).toBeLessThanOrEqual(p.BFMAX);
              expect(out.baseflow).toBeGreaterThanOrEqual(0);
              expect(out.baseflow).toBeLessThanOrEqual(detail.grossBaseflow);
              expect(out.et).toBeGreaterThanOrEqual(0);
              expect(detail.storeAfterInflow).toBeLessThanOrEqual(
                detail.capacity + EPS,
              );
              expect(out.excessToInterflow).toBeGreaterThanOrEqual(0);
              // Baseflow and TL are exclusive.
              expect(Math.min(detail.grossBaseflow, out.transmissionLoss)).toBe(
                0,
              );
              expect(r.state.tDays).toBeGreaterThanOrEqual(0);
              expect(out.pctFromGw).toBeGreaterThanOrEqual(0);
              expect(out.pctFromGw).toBeLessThanOrEqual(p.GWMAX);
              if (options.depletionCap === "abstraction")
                expect(out.depletion).toBeLessThanOrEqual(i.abstraction);
              if (
                options.transmissionLossCap === "runoffAndCapacity" &&
                out.transmissionLoss > 0
              ) {
                expect(out.store).toBeLessThanOrEqual(detail.capacity + EPS);
              }
              if (
                options.pumpingClock === "resetWhenIdle" &&
                i.abstraction === 0
              )
                expect(r.state.tDays).toBe(0);
            },
            undefined,
            options,
          );
        }
      }
    },
  );

  it("natural mode (ABS ≡ 0) has no abstraction effect", () => {
    for (const seed of seeds) {
      simulate(seed, 240, false, (_, __, r) => {
        expect(r.state.pumping).toBe(false);
        expect(r.state.tDays).toBe(0);
        expect(r.out.depletion).toBe(0);
        expect(r.out.fromStorage).toBe(0);
        expect(r.out.pctFromGw).toBe(0);
        expect(r.out.baseflow).toBe(r.detail.grossBaseflow);
      });
    }
  });

  it("soft check: STORE stays ≥ SWL once above it, when no step can overshoot", () => {
    // The condition (sami.md §5): no abstraction, HGRAD ≥ 0, BFMAX·|BPOW| ≤ 1
    // (GWBF ≤ HEAD), the largest ET coefficient (PET − RAIN)⁺·EVAREA/AREA ≤ CAP − SWL
    // and the largest OUT, at HG = HGRAD, ≤ CAP − SWL.
    const safe = (random: () => number): SamiAquiferParamsWithArea => {
      const p = randomParams(random);
      const range = samiCapacity(p) - p.SWL;
      const maxEt = 250 * (p.evapAreaKm2 / p.areaKm2);
      const maxOut =
        ((p.T_m2d *
          p.HGRAD *
          p.daysPerMonth *
          p.outflowWidthFactor *
          Math.sqrt(p.areaKm2 * 1e6)) /
          (p.areaKm2 * 1e6)) *
        1000;
      return {
        ...p,
        store0: p.SWL + range * random(),
        BFMAX: Math.min(p.BFMAX, 1 / Math.abs(p.BPOW)),
        evapAreaKm2:
          maxEt > range ? (p.evapAreaKm2 * range) / maxEt : p.evapAreaKm2,
        HGRAD: maxOut > range ? (p.HGRAD * range) / maxOut : p.HGRAD,
      };
    };
    for (const seed of seeds) {
      simulate(
        seed,
        240,
        false,
        (_, __, r, p) =>
          expect(r.out.store).toBeGreaterThanOrEqual(p.SWL - EPS),
        safe,
      );
    }
  });

  it("soft check is not an invariant: BFMAX·|BPOW| > 1 can overshoot SWL", () => {
    // HEAD = 61 − 60 = 1, GWBF = (1 − e^{−0.5})·50 = 19.7 > 1.
    const r = step(state(61), {}, { HGRAD: 0, BFMAX: 50, BPOW: -0.5 });
    expect(r.out.store).toBeLessThan(P.SWL);
  });

  it("zero recharge: the aquifer only recedes towards SWL (no abstraction, no runoff)", () => {
    let s = samiAquiferInit(P);
    for (let m = 0; m < 600; m++) {
      const r = samiAquiferStep(s, { ...QUIET, petGw: 150, rain: 0 }, P);
      expect(r.out.store).toBeLessThanOrEqual(s.store);
      expect(r.out.store).toBeGreaterThanOrEqual(P.SWL);
      s = r.state;
    }
    expect(s.store).toBeLessThan(P.SWL + 0.5);
  });
});

describe("Sami aquifer: R6-A7 and R6-A8", () => {
  it("R6-A7: heavy abstraction can take STORE below 0 (no floor; STORE ≥ 0 is not an invariant)", () => {
    let s = samiAquiferInit(P);
    let min = Infinity;
    for (let m = 0; m < 60; m++) {
      s = samiAquiferStep(s, { ...QUIET, perc: 0.5, abstraction: 5 }, P).state;
      min = Math.min(min, s.store);
    }
    expect(min).toBeLessThan(0);
  });

  it("R6-A8: a negative or non-finite abstraction throws", () => {
    expect(() =>
      samiAquiferStep(state(80), { ...QUIET, abstraction: -1 }, P),
    ).toThrow(RangeError);
    expect(() =>
      samiAquiferStep(state(80), { ...QUIET, abstraction: Number.NaN }, P),
    ).toThrow(RangeError);
  });

  it("R6-A8: storativity and distance must be > 0, the evaporation area within the catchment", () => {
    const bad: SamiAquiferParamsWithArea[] = [
      { ...P, distM: 0 },
      { ...P, evapAreaKm2: 101 },
      { ...P, evapAreaKm2: -1 },
    ];
    for (const p of bad) expect(() => samiAquiferInit(p)).toThrow(RangeError);
  });
});

describe("Sami aquifer: determinism and purity", () => {
  it("the same inputs give bit-identical outputs, and inputs are not mutated", () => {
    const once = () => {
      const records: unknown[] = [];
      simulate(7, 120, true, (_, __, r) => {
        records.push(r);
      });
      return records;
    };
    expect(once()).toEqual(once());
  });

  it("the contract step is the detailed step without `detail`", () => {
    const s = state(85, 20, true);
    const i: SamiAquiferInput = {
      ...QUIET,
      aquiferInflow: 3,
      perc: 2,
      abstraction: 1,
      petGw: 160,
      rain: 30,
      runoffForHead: 4,
    };
    const full = samiAquiferStepDetail(s, i, P);
    expect(samiAquiferStep(s, i, P)).toEqual({
      state: full.state,
      out: full.out,
    });
    expect(makeSamiAquiferStep(DEFAULT_SAMI_AQUIFER_OPTIONS)(s, i, P)).toEqual({
      state: full.state,
      out: full.out,
    });
  });
});
