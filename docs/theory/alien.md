# Invasive alien vegetation and paved area

Implementable specification of WRSM2000's **CSIR alien vegetation** streamflow reduction (runoff module
lines L.011–L.015), its **riparian** deduction, how both apply to a free runoff module and to an **SFR
child**, and a check of the **paved-area** (impervious fraction) implementation against the manuals.
Code: `packages/wrsm/src/landuse/alien.ts`, `packages/wrsm/src/landuse/paved.ts`. Afforestation and the
parent/child calibration itself are `docs/theory/afforestation.md` / `src/landuse/sfr.ts`; alien
vegetation plugs into it as the `ChildTargetModel` `alienTargetModel` (§4.2). §6 says where alien
vegetation differs from afforestation there.

## Sources and citation style

| Ref | Report | Used for |
|---|---|---|
| TT 690 | WRSM/Pitman Theory Manual, ch.11 §11.2 (book pp.123–126), ch.12 (pp.127–140) | SFR concept and parameter adjustment (eqs. 11.2–11.3), biomass eqs. 12.3–12.5, flow-reduction eqs. 12.6–12.9, asymptotes §12.4.7, averaging §12.4.8, Tables 12.3–12.4, riparian eqs. 12.10–12.12; impervious runoff §1.5 p.3, §1.9 p.5 |
| TT 689 | User Manual, §6.2.2 (pp.125–142) | Inputs and checks (pp.127–129), SFR parents and children (pp.129–140), the Virgin MAR example (p.139), paved area (p.142), naturalised flows (p.27) |
| TT 691 | Programmer's Code Manual | VEGETATIONALG (p.40), APERC/AGE/APOT (p.43), NSFR, RipVegAreaPerc, RunRiparianVeg (pp.52–53), RU_GetSFReduction, RU_GetRipVegDemand (p.56), RU_ALIEN (p.62), RU_SPECIAL_AREA (p.63), line types L.011–L.018 (p.151), change log (pp.205, 211) |

Equations are cited as `TT 690 p.134 eq. 12.6` (book page; PDF page = book page + 13). TT 690's
equations are images; every one below was transcribed from page renders and its coefficients read at
200 dpi.

## 1. What the model is

The CSIR method (Le Maitre & Görgens, "Invasive alien vegetation and dam yields", reproduced as TT 690
ch.12; coded in WRSM2000 as `RU_ALIEN`, "based on program alveg by Pitman and Bailey", TT 691 p.62)
turns the **condensed area** of alien plants, split into three growth forms with an age each, into a
percentage reduction of **mean annual flow** and of **low flow**:

```
age ──(eqs 12.3–12.5)──▶ biomass (t/ha) ──(eqs 12.6–12.9)──▶ % reduction (annual, low flow)
```

The area is "condensed" (equivalent dense) area: 100 ha at 25 % canopy cover is 25 ha (TT 690 p.132
§12.3.4). The relationship between flow reduction and cover is taken as linear.

## 2. Inputs (RU L.011–L.015, TT 691 p.151; TT 689 pp.128–129)

| Line | Field | TT 691 name | Meaning | `AlienVegetation` |
|---|---|---|---|---|
| L.011 v1 | NYRA | NYRA | years of area data | `areaKm2.length` |
| L.011 v2 | algorithm | VEGETATIONALG (p.40) | 0 none, 1 CSIR, 2 "Riparian vegetation" | `algorithm` |
| L.011 v3 | riparian % | RipVegAreaPerc (p.53) | **% of the alien area** in the riparian zone (TT 689 p.129: "the percentage of alien vegetation that lies in the riparian zone"; the rest is "upland"). This settles U-21 | `riparianArea` |
| L.012–L.013 | year / area | Alien(MNRUAL) | alien (condensed) area, km² | `areaKm2` |
| L.014 | %, age × 3 | APERC(3), AGE(3) (p.43) | tall trees, medium trees, tall shrubs: % of the alien area and age, years | `composition` |
| L.015 | optimal % | APOT | "% of alien vegetation area considered to be optimal" | `optimalPercent` |

Class → biomass equation (TT 690 Table 12.3 pp.137–138, "Biomass Equation No."): 3 = tall trees
(Pinus, Eucalyptus …, eq. 12.3), 2 = medium trees (eq. 12.4), 1 = tall shrubs (Hakea …, eq. 12.5).
The class shares "should add up to 100%, but the program will check that" (TT 689 p.128).

## 3. Equations

### 3.1 Age → biomass, t/ha (TT 690 p.133 §12.4.3)

| Eq. | Class | Biomass B(age) |
|---|---|---|
| 12.3 | tall trees (pine) | `300 / (1 + e^3.67947 · age^−1.4109)` (r² 0.96, n 9) |
| 12.4 | medium trees | `96.0732 · log10(age) − 4.8081` (r² 0.98, n 4) |
| 12.5 | tall shrubs | `76 / (1 + e^3.1868 · age^−1.35973)` (r² 0.68, n 12) |

Eq. 12.4 is negative below age ≈ 1.12; it is floored at 0 (R6-V5). Age ≤ 0 gives 0 biomass.

### 3.2 Biomass → % flow reduction (TT 690 pp.134–135 §12.4.5–12.4.7)

| Eq. | Curve | As printed | Asymptote used (§12.4.7) |
|---|---|---|---|
| 12.6 | long lag, annual | `75 / (1 + e^14.2216 · B^−2.9194)` | 115 |
| 12.7 | long lag, low flow | `100 / (1 + e^10.0252 · B^−2.0927)` | 122 |
| 12.8 | short lag, annual | `100 / (1 + e^2.2958 · e^(−0.02388 B))` | 103 |
| 12.9 | short lag, low flow | `100 / (1 + e^1.9677 · e^(−0.02474 B))` | 102 |

§12.4.7: "These models can be scaled by adjusting the asymptote (numerator) … To reach the percentage
reductions suggested in Table 12.4 these functions need to be scaled using the following values for the
asymptote: Long lag annual 115, long lag low flow 122, short-lag annual 103, short lag low flow 102."
The scaled curves pass 100 % for old tall trees (eq. 12.6 at 115 gives 105 % at age 200), so each curve
is capped at 100 % (R6-V5). Long-lag curves give 0 at B = 0; short-lag curves give 9.4 % (annual) and
12.5 % (low) at B = 0, as printed.

Long lag is the Jonkershoek / Cathedral Peak behaviour ("a long lag before a significant reduction in
flow"), short lag the Mokobulaan / Westfalia one (TT 690 p.134 §12.4.4).

Table 12.4 (p.138) gives, per study catchment, a "suggested asymptote" of 83–100 % (landscape) and
mean ages of 7.5–20 years. No RU field holds it; `maxReductionPercent` (R6-V4, default 100) scales all
four asymptotes by it. The riparian rows' asymptotes in mm (§12.4.8 p.136) are not used: WRSM2000's
riparian treatment is §12.5 instead (§5).

### 3.3 One class, one age (R6-V1, R6-V2)

TT 689 p.128: "Long lag and short lag relationships are dealt with as well as with the percentage of
optimal area for determining annual and low flow reductions in flow for each type of lag by means of
empirical equations." With w = optimal % / 100:

```
annual(c, age) = w · cap(eq 12.8 (B)) + (1 − w) · cap(eq 12.6 (B))     B = biomass_c(age)
low(c, age)    = w · cap(eq 12.9 (B)) + (1 − w) · cap(eq 12.7 (B))
```

**R6-V1** puts the optimal share on the short-lag curves (the Westfalia *Eucalyptus grandis* stand is
the fast-growing, optimal case). Every reference child has optimal = 50 %, where the direction makes no
difference, so the reference can't confirm it.

**R6-V2** evaluates the curves **at the stated age**. TT 690 §12.4.8 p.135 instead averages the
age-specific reductions over the age classes of a stand with uniform ages ("if the mean age is 20 years
… the mean of the age-specific annual or low flow reductions for stands of 1-40 years"). WRSM2000's
TPRM matches the single-age evaluation to 4 decimals for children with only tall and medium trees
(§7), and the 1–40 average is about 13 % lower, so `single` is the default and `ageClassMean` (ages 1 …
round(2 × age)) the option.

**R6-V3** The age is a constant of the run: the file holds one age per class and WRSM2000 reports one
TPRM per child per run. The stand does not age year by year (a uniform-age stand at steady state keeps
its mean age, which is what §12.4.8's averaging assumes).

### 3.4 Targets (TT 691 p.56 RU_GetSFReduction; NSFR = 5)

```
TPRM = Σ_c (share_c / 100) · annual(c, age_c)          (condensed areas add linearly, §12.3.4)
TPRL = max(TPRM, Σ_c (share_c / 100) · low(c, age_c))  (R6-V7)
```

Both within 0–100. Algorithm 0, no L.014, or a class share or optimal % outside 0–100 give 0 (the last
two as errors). Warnings: shares not adding to 100 (TT 689 p.128); any class with share > 0 younger
than 10 years ("Added warning about alien veg of less than 10 years of age producing iteration
problems", TT 691 p.211 change 107).

**R6-V7** WRSM2000's TPRL is **never below its TPRM** and never above our low-flow curve value; in 10
of 25 reference children it equals TPRM exactly. The rest lie between, so WRSM2000 realises TPRL
from a flow series in a way the manuals don't describe. Default: the curve value raised to TPRM;
option `tprm` makes them equal. Mean absolute error 4.0 percentage points (§7). TPRL only steers the
child's low-flow target in the iteration (eq. 11.3).

## 4. How it applies (TT 690 pp.123–126; TT 689 pp.129–140)

### 4.1 Free module, FT = 0

TT 689 p.140: "A Parent catchment may not have afforested or alien vegetation areas other than in its
children, unless it has a calibration parameter FT = 0 in which case it must not be a Parent and can
then have afforestation and/or alien vegetation." TT 690 p.126: where FT = 0 "it will also be necessary
to model the impacts on streamflow without a Child module", the old way of TT 690 p.123: "calculate
the amount of water that the vegetation would use and reduce the final outflow of the catchment by that
amount". The manuals don't say how the reduction is spread over months. Default (**R6-V11**
`proportional`):

```
reduction(t) = min(1, A_alien(y) / AREA) · TPRM/100 · Q(t)        Q(t) > 0, else 0
```

Option `lowFlowMonths`: months at or below the run's lowest-quartile flow lose TPRL % instead. Then
the riparian deduction (§5) on what is left **of the alien area's own runoff**,
`share · Q(t) − reduction(t)`: eq. 12.12's TotalOutflow is the alien ("Child") area's flow (TT 690
p.139; TT 689 p.129 "the residual runoff from the portion of catchment … covered by alien
vegetation"), so the riparian loss never takes runoff from the rest of the module. A historical run
whose alien years don't cover the run gets a warning (TT 689 p.128), as paved does (R3-N20). A free module with FT > 0 and alien vegetation gets an
info message pointing at TT 689 p.140. "The user cannot obtain either groundwater plots or groundwater
time series" in this case (TT 690 p.126): the reduction is taken off the total outflow, not split.

### 4.2 SFR child (algorithm "CSIR ALIEN Vegetation")

Order for one parent, per TT 689 pp.137–140 and the run log (`docs/formats.md` §14):

1. **Virgin run.** "When a Parent Module is run, it first instructs all of its Child Modules to run"
   (p.140). The child runs on the parent's climate and parameters ("Climate copied", "Parameters
   copied" in the log), natural (no reduction), on its **active area**: "the active area of a Child
   Module is only that area that is afforested, covered with Alien Vegetation … as specified by means of
   the year/area pairs in the Child Module" (p.140). Its MAR is the **Virgin MAR** (VMAR), its
   lowest-quartile mean the VLQT (p.138).
2. **Targets.** `alienReductionTargets(child.alienVegetation)` → TPRM, TPRL. Required
   `QMAR = VMAR · (1 − TPRM/100)`, `QLQT = VLQT · (1 − TPRL/100)` (the log prints both; QMAR = VMAR · (1 − TPRM/100) holds
   to the log's 4 decimals in all 33 public reference child blocks, every SFR type).
3. **Parameter iteration** (`sfr.ts`): adjust PI, FF, SL, ST (and HGSL) with TT 690 eqs. 11.2–11.3 until
   the child's MAR and low flow reach QMAR and QLQT ("within 1% … if this is not reached within 10
   iterations, it increases the closing error … (40 iterations allowed in total)", TT 689 p.139).
   Before the iteration the log prints "Riparian vegetation deductions off."; after it, for a child
   with riparian % > 0, "Riparian vegetation deductions on."
4. **Riparian deduction** on the child's final outflow (§5), using that final run's evaporation — "the
   calculations are performed after the effect of alien vegetation is determined as if all is in the
   non-riparian zone" (TT 690 p.139).
5. **Parent.** The parent runs on AREA minus the active child areas month by month and adds the
   children's outflows to its own (TT 689 p.140).

**Interface.** `alienTargetModel(options)` is a `ChildTargetModel` (`sfr.ts`):
`runSfrGroup({ …, targets: { alien: alienTargetModel() } })`. It returns `{ marPercent: TPRM,
lowFlowPercent: TPRL }` for the whole run (R6-V3), label "CSIR ALIEN Vegetation", and, when the
riparian % is above 0, an `adjustOutflow` that applies step 4 to the calibrated outflow. Step 4 needs
the calibrated run's EAVE: `RunoffDiagnostics` has no such series yet, so the model reads
`diagnostics.actualEvaporationMm` (`EvaporationDiagnostics` in `alien.ts`, interception + soil
evaporation, mm/month) or the `actualEvaporationMm` option, and without either skips the deduction with
a warning. **The runner must add that series** (`runRunoffModule`: `sim.months.map(m => m.E +
m.interception)`; the Sami/Hughes runners likewise). PEACT comes from the calibrated child's FF.

**One SFR per child (R6-F11).** TT 691 p.207 change 45c: "For slave modules, if afforestation then grey
out alien veg and vice versa", so a child holds one or the other (TT 691 p.52 NSFR is one code). Which
wins when a file has both isn't stated; `sfr.ts`'s default (afforestation, alien ignored with a warning)
stands. No reference child has both.

`alienVegetationReduction` with `parent` set returns `targets`, `virginMarMm3` and, as a reduction,
TPRM % of the virgin series month by month, whose annual mean is exactly VMAR − QMAR. That is the
right volume with the wrong distribution (no groundwater split, no low-flow shaping); the runner should
prefer the iteration and use this only where the iteration is unavailable.

### 4.3 Run modes (D1)

- **Natural**: no reduction, no riparian deduction (TT 689 p.27: "ignore all man-made module data such
  as Paved areas, Afforestation and Alien Vegetation"; a child "cannot run … for Naturalised Flows",
  p.134). `applyRunMode` already empties the area table; `alienAreaByMonth` also returns 0.
- **Present day**: the area held at its value in the chosen year (`holdYearTable`, R3-N10); ages and
  so TPRM/TPRL don't change with time anyway (R6-V3).
- **Historical**: the area per hydrological year, linear between listed years and flat beyond
  (`yearTableValue`, OQ-17; TT 689 p.128: "determined for every given year"; data must cover the run or
  "the module will issue a warning").

Checks: the alien area may not exceed AREA (TT 689 p.128; error, held at AREA); afforestation + alien +
paved ≤ AREA (`specialAreaMessages`, §8).

## 5. Riparian zone (TT 690 §12.5 pp.139–140; TT 689 p.129)

The riparian part "has access to additional water, i.e. seepage to or from the stream channel"; its
unmet crop demand comes off the streamflow. Each month (TT 690 p.139, p.140):

```
ETDEF = AMAX1(0, PEACT − EAVE)                  mm        (12.10)
ETVOL = 0.001 × ETDEF × PRIP × AREA             10⁶ m³    (12.11)
TotalOutflow = AMAX1(0, TotalOutflow − ETVOL)   10⁶ m³    (12.12)
```

- **PEACT** "the Potential evaporation for the month in mm": the run's `FF · S-pan · pan factor`
  (`potentialEvaporation`), with the child's adjusted FF.
- **EAVE** "Actual evaporation (mm) for month": **R6-V10** interception plus soil evaporation (the
  user manual calls it "actual evapotranspiration", p.129), as `PitmanMonth.interception + E`.
- **PRIP** "Proportion of alien vegetation area in riparian zone" = RipVegAreaPerc / 100. Units check:
  mm × km² = 10³ m³, so 0.001 × mm × km² is 10⁶ m³ only with PRIP a proportion.
- **AREA** "the area of the 'Child' module representing all the alien vegetation": **R6-V9** the
  active alien area that year (TT 689 p.129: "when applied to the current area of alien veg in the
  riparian zone"); option `module` uses AREA (L.002).
- ETVOL is WRSM2000's riparian demand series (TT 691 TS_RipVegDemand, RU_GetRipVegDemand p.56).

**R6-V8** The deduction runs whenever RipVegAreaPerc > 0 and the algorithm is not 0. All 19 distinct
reference children use algorithm 1; the log turns "Riparian vegetation deductions on." after the
iteration for the 17 with a riparian % above 0 and never for the 2 at 0. Algorithm 2 is never observed and is run like 1, with an info
message.

TT 689 p.139 (the "Gush/Pitman" example): without the riparian %, the child's outflow MAR was
0.52 × 10⁶ m³/a; with 2.2 % riparian it was 0.16, so the riparian loss can be most of a dry child's
flow. Eq. 12.12 caps it at the outflow.

## 6. Alien vegetation vs afforestation in the parent/child mechanism

The mechanism (iteration on PI, FF, SL, ST; children free of paved areas; one 100 % outflow to a zero
sink) is shared. What differs for an alien child:

1. **Target source.** TPRM/TPRL come from §3.4, constant over the run, from the child's own L.014–L.015,
   not from a MAP-based table (Smoothed Gush) or a user value. The log names it "CSIR ALIEN
   Vegetation" (NSFR = 5, TT 691 p.52).
2. **Riparian deduction after the iteration** (§5, step 4 of §4.2). Afforestation has none.
3. **Young stands.** Ages under 10 make the iteration struggle (TT 691 p.211); warned.
4. **TT 691 p.205 change 22** notes PI errors "for alien veg and afforestation when an area of less
   than 0.4 is entered" and that a message was added and "the variable = 0" set; which variable is not
   said (open, R6-V13).
5. Free-module use with FT = 0 is the same rule as for afforestation (TT 690 p.126).

The interface `sfr.ts` uses is `alienTargetModel` (§4.2), built on `alienReductionTargets` (step 2)
and `riparianDeduction` (step 4).

## 7. Reference check (local only, `alien.reference.test.ts`)

Every child the reference run logs report as "CSIR ALIEN Vegetation": 25 (19 distinct; one local
network folder repeats a public archive network). Our TPRM/TPRL from the child's RU file against the
log's:

| | exact to 4 dp | mean \|error\| | max \|error\| |
|---|---|---|---|
| TPRM, manual eq. 12.5 (c = 3.1868) | 4 / 25 | 0.71 % | 3.53 % |
| TPRM, fitted c = 3.4165 (R6-V6) | 8 / 25 | 0.17 % | 0.69 % |
| TPRL (R6-V7) | 10 / 25 equal to TPRM in WRSM2000 | 4.0 points | |

- The residual error with the manual constant grows with the **tall-shrub** share. Solving for the
  shrub contribution gives the same value in every catchment (to 4 dp at age 10 in all 4 such
  children), and a single change of eq. 12.5's constant from 3.1868 to **3.4165** (exponent unchanged)
  reproduces it at ages 10 and 20. Nothing in the manuals gives 3.4165; it may be a misprint in TT 690
  or a pre-adjustment value of the fynbos model. **R6-V6**: default the printed 3.1868; the
  `TALL_SHRUB_C_REFERENCE_FIT` option matches WRSM2000. Recommend the orchestrator records the choice
  (departure if the manual value stays).
- The remaining 0.1–0.7 % TPRM differences appear only in children of networks run with a flow series
  that differs per catchment (identical inputs give slightly different TPRM in two catchments), so
  WRSM2000 adds a flow-dependent step after the curves that the manuals don't describe.
- **Virgin MAR**: per km² of mean active area, an alien child and an afforestation child under the same
  parent have the same virgin MAR within 0–2.8 % (5 distinct pairs; the rest are rounding of a 4-dp
  log value and area-weighting of a growing forest). This supports step 1 of §4.2 (parent natural
  depth × active area). A direct check of VMAR needs the parent's Sami run and waits for agents 6.1/6.2
  and `sfr.ts`.

## 8. Paved area (RU L.016–L.018)

**What the manuals say.**

- TT 690 p.3 §1.5: surface runoff has two parts; "The first component is easily computed by multiplying
  catchment rainfall by the area of catchment that is impervious. In the original model the impervious
  fraction (AI) was fixed, but this has been amended so that a time-varying AI can be entered to reflect
  the growth of urbanized areas."
- TT 690 p.5 §1.9: the monthly procedure is "Compute runoff from impervious area; Determine
  interception loss; …", so impervious runoff is taken from the gross rain before interception. (TT 690
  p.160, which multiplies "the rainfall available for infiltration and runoff", after interception, is
  the **daily** model of ch.14 and doesn't apply.)
- TT 691 p.40 and p.151: "Paved area years with the area as proportion of the catchment"; L.018 F6.3.
- TT 689 p.142: data "must cover the entire simulation period" or a warning; "determined for every
  given year"; paved + afforestation + alien ≤ AREA; and "with paved areas the soil moisture (Pitman S)
  is lower than without, because they prevent some of the rain infiltrating".
- TT 689 p.140: "A Parent catchment may have paved areas. A Child catchment may not contain paved
  areas." TT 689 p.27: naturalised runs ignore paved areas.
- TT 691 p.51: TS_PavedOutflow is kept separately; TS_SurfaceOutflow is "paved area runoff and component
  f".

**Verdict on `src/runoff/pitman.ts`.** For a free module the implementation agrees with all of the
above: AI(y) by hydrological year from `yearTableValue`, `R_imp = AI·P` first, pervious rain
`P − AI·P` (so S drops, as TT 689 p.142 requires), interception scaled by (1 − AI), no interception or
lag on the impervious part (OQ-17 … OQ-19), the separate `pavedFlow` diagnostic, an error for AI
outside 0–1, the coverage warning in historical mode (R3-N20), removal in natural mode and holding in
present-day mode (`applyRunMode`). No change is needed for free modules.

**Changes needed once SFR children run (for agent 6.5 / `sfr.ts`; not made here).**

1. **R6-P1, a parent's paved fraction of its active area.** The fraction is of the catchment (AREA),
   and the parent runs on AREA minus its active children. Keeping the paved km² (default
   `conserveArea`): `AI_active(t) = min(1, AI(y) · AREA / A_active(t))`
   (`activeAreaPavedFraction`). In `runRunoffModule`, replace the per-year lookup

   ```ts
   const AI = module.paved ? yearTableValue(module.paved.fraction, year) : 0;
   ```

   with a per-month override when the caller gives one, e.g. a new
   `options.imperviousFraction?: readonly number[]` (12 per run year) used as
   `imperviousFraction.push(options.imperviousFraction?.[12 * (year - startYear) + m] ?? AI)`, and
   convert to volume with the month's active area instead of `module.areaKm2` (a matching
   `options.activeAreaKm2?: readonly number[]`). Option `asFraction` applies AI to the active area
   unchanged. Untestable against the reference: no reference parent has paved data.
2. **R6-P2, a child with paved data** ignores it with a warning (`pavedFractionByMonth(…, { isChild:
   true })`); the child's run must pass zero AI.
3. **R6-P3, the special-area check** (`specialAreaMessages`): afforestation + alien + paved km² + the
   children's active areas > AREA is an error, as `RU_SPECIAL_AREA` does (TT 691 p.63). It takes the
   run mode: nothing to check in natural mode, tables read at `mode.year` in present day.

## 9. Invariants (unit tests)

- Each equation at independent values (eqs. 12.3–12.12); biomass rises with age and stays under its
  asymptote; every curve rises with biomass; the long-lag curves are 0 at zero biomass and far below the
  short-lag ones for a young stand.
- 0 ≤ TPRM ≤ TPRL ≤ 100 for random inputs.
- 0 ≤ reduction(t) ≤ max(0, Q(t)); zero area ⇒ zero reduction; natural ⇒ zero; present day ⇒ the same
  area and the same proportion every month.
- Child: the reduced MAR equals VMAR (1 − TPRM/100).
- Riparian: the extra reduction equals min(the alien area's left-over flow, ETVOL) month by month on a
  simulated Pitman run, and never more than the alien area's runoff; through `runSfrGroup` the
  calibrated child loses exactly min(flow, ETVOL) and its calibration is unchanged by the riparian %.
- Paved: per-month AI per mode, the child rule, the active-area rescale and the special-area check.

## 10. Open questions and provisional choices

| ID | Question | Default | Option |
|---|---|---|---|
| R6-V1 | Which curves the optimal % selects | optimal → short lag, rest → long lag | – (all reference children at 50 %) |
| R6-V2 | Single age vs §12.4.8 age-class mean | single (reference) | `ageClassMean` |
| R6-V3 | Do stands age through the run? | no: age constant | – |
| R6-V4 | Table 12.4 maximum % | 100 | `maxReductionPercent` |
| R6-V5 | Curves above 100 %, eq. 12.4 below 0 | cap at 100, floor at 0 | – |
| R6-V6 | Eq. 12.5 constant | 3.1868 (manual) | `TALL_SHRUB_C_REFERENCE_FIT` 3.4165 (reference) |
| R6-V7 | TPRL | curve, raised to TPRM | `tprm` |
| R6-V8 | When the riparian deduction runs; algorithm 2 | riparian % > 0 and algorithm ≠ 0; 2 as 1 | – |
| R6-V9 | AREA in eq. 12.11 | active alien area | `module` |
| R6-V10 | EAVE | interception + soil evaporation | (soil only: pass `E`) |
| R6-V11 | Free-module monthly spread | proportional TPRM | `lowFlowMonths` |
| R6-V12 | Lowest-quartile count | round(n/4), ≥ 1 | – |
| R6-V13 | TT 691 p.205: "area of less than 0.4" sets which variable to 0? | not applied | – |
| R6-P1 | Parent's paved fraction of its active area | `conserveArea` | `asFraction` |
| R6-P2 | Child with paved data | ignored, warning | – |
| R6-P3 | Special areas over AREA | error | – |
| U-21 | Units of L.011 v3 | **resolved**: % of the alien area (TT 689 p.129, TT 691 p.53) | – |
