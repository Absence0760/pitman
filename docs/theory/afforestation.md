# Afforestation and the SFR Parent/Child mechanism

Specification of WRSM2000's afforestation streamflow reductions (RU L.006–L.010)
and of the **SFR (streamflow reduction) Parent/Child** mechanism that applies
them. The Parent/Child part (§4–§6) is shared: alien vegetation (RU L.011–L.015,
`docs/theory/alien.md`, `src/landuse/alien.ts`) uses the same mechanism and only
supplies its own target reductions.

Code: `packages/wrsm/src/landuse/forest.ts` (the targets per algorithm, and the
free-module reduction in the `StreamflowReduction` shape) and
`packages/wrsm/src/landuse/sfr.ts` (the mechanism). Round 6, agent 6.3.

## Sources and evidence

| Ref | Report | Used for |
|---|---|---|
| TT 690 | WRSM/Pitman Theory Manual, ch.11 "Modelling of streamflow reductions", book pp.122–127 (PDF pp.135–140) | §11.1 Smoothed Gush: eq. 11.1, Table 11.1. §11.2 Parent/Child rules, the adjusted parameters, eqs. 11.2–11.3, the FT = 0 note |
| TT 689 | WRSM/Pitman User Manual | p.xvi (algorithm list), pp.13–14 (naturalised runs, Table 4.1 recharge/interflow combination), p.27 (naturalised box), p.38 (FF), §6.2.2 pp.125–141 (special areas, afforestation dialog, SFR areas, worked example, iteration limits, summary rules), pp.162–165 (KB articles 1–2, notes) |
| TT 691 | Programmer's Code Manual | p.39 FORESTALG codes, p.52–53 §7.4.2 SFR record (`ModSubType`, `MyChilds`, `NSFR`, `UD_TPRM`, `UD_TPRL`), pp.53–63 routine descriptions (`RU_CopyClimate`, `RU_CopyParameters`, `RU_GetSFReduction`, `RU_SetFF/PI/SL/ST/HGSL`, `RU_FOREST`, `RU_FRLOSS`, `RU_SMGush`, `RU_QRTPERCENTILE`) |
| ERR | The `WRSM2000.ERR` SFR child blocks of the **public** WR2012 Gouritz archive (`docs/formats.md` §14) | What the program printed while it ran: a black-box trace, never its code. Used only where the manuals are silent, and marked **[I]** |

Equations and tables in TT 690 are images; eq. 11.1, Table 11.1 and eqs.
11.2–11.3 were read from page renders (PDF pp.135–136, 139). Evidence labels:
**[M]** manual, **[F]** seen in files or logs, **[I]** inferred from the logs.
Each provisional choice has an ID `R6-F<n>` (§7) and an option in the code.

## 1. Inputs (RU L.006–L.010)

Field layout: `docs/formats.md` §5.1. Types: `Afforestation` in `types.ts`.

| Line | Field | Used by |
|---|---|---|
| L.006 v1–2 | NYRF; FORESTALG (0 Van der Zel, 1 CSIR, 2 Smoothed Gush/Pitman, 3 LUT Gush, 4 user defined; TT 691 p.39) | all |
| L.007–L.008 | year / afforested area, km² | the active area (§4.2) |
| L.009 | % pine, rotation; % eucalyptus, rotation; % wattle, rotation | Smoothed Gush (shares), CSIR (shares and rotations) |
| L.010 v1 | % optimal ("% Optimal Growth", TT 689 p.127) | CSIR only |
| L.010 v2–3 | required MAR reduction, required low-flow reduction, % (`UD_TPRM`, `UD_TPRL`, TT 691 p.52) | user defined only |

Rotation lengths and % optimal area feed only the CSIR tables (TT 689 p.127:
"lookup tables of appropriate values for annual and low flow reductions based on
the percentage of optimal area are used along with empirical equations"; TT 691
p.61 `RU_FRLOSS`: tables "based on tree-type, rotation period in years"). Neither
Smoothed Gush nor user-defined reductions use them.

## 2. Which algorithm where

| FORESTALG | Free module | SFR child | How it acts | Published? |
|---|---|---|---|---|
| 0 Van der Zel | yes (default for file version 0) | yes | reduces rain "by the amount that is intercepted by the afforestation", "at source" (TT 689 p.127, p.165) | **no** curves |
| 1 CSIR | yes (the default for new modules) | yes (NSFR 1 "CSIR forests") | free: reduces the module's final outflow (TT 689 p.163 KB 2, p.165 note 3); child: target reductions | **no** tables (Scott & Smith 1997, Water SA 23(2), via `affdem3`, TT 691 p.61) |
| 2 Smoothed Gush/Pitman | no | yes | target reductions (§3.1) | yes, TT 690 pp.122–123 |
| 3 LUT Gush | no | not active | "not yet been implemented" (TT 689 p.xvi, p.127, p.136) | n/a |
| 4 User defined | no | yes | target reductions = L.010 vars 2–3 (§3.2) | yes |

"You will, no doubt, notice that you have more afforestation options in a Child
Module than in a Free module. In addition to Van der Zel and CSIR, you now have
two additional choices" (TT 689 p.136). A parent may not hold afforestation or
alien vegetation of its own (TT 689 p.134, p.140).

In the reference set: every afforested module is a child; 17 use Smoothed Gush
(2) and 1 uses CSIR (1). One free module (an orphaned former child that still
routes to the zero sink) has Smoothed Gush. No module uses Van der Zel,
LUT Gush or user defined **[F]**.

## 3. Target reductions per algorithm (`forest.ts`)

A child's algorithm gives two targets (TT 691 p.55 `RU_GetSFReduction`):
**TPRM**, the % reduction of the child's MAR, and **TPRL**, the % reduction of
its low flow (§4.4). They are not applied to flows directly: the calibration
(§4.6) makes the child's own runoff show them.

### 3.1 Smoothed Gush/Pitman (TT 690 §11.1)

From the Gush Table's 843 quaternaries (MAP > 650 mm), reductions were averaged
over three soil depths and regressed on MAP per genus (TT 690 p.122):

    Flow reduction (%) = a − b × MAP                                  TT 690 p.122 eq. 11.1

held at or above the table's minimum ("used to prevent unrealistically low (or
negative) reductions when extrapolating to very high MAP") and at or below 100 %
("the maximum reduction cannot exceed 100%"), TT 690 p.122.

TT 690 p.123 Table 11.1 (`SMOOTHED_GUSH_TABLE`):

| Genus | Line | a | b | Minimum |
|---|---|---|---|---|
| Pine | Median (MAR) | 112.92 | 0.070 | 6.0 |
| Pine | Low flow | 119.34 | 0.078 | 2.9 |
| Eucalypt | Median (MAR) | 120.60 | 0.064 | 9.6 |
| Eucalypt | Low flow | 128.03 | 0.054 | 36.4 |
| Wattle | Median (MAR) | 120.85 | 0.079 | 8.2 |
| Wattle | Low flow | 123.02 | 0.067 | 24.8 |

"Median" is the MAR line: Fig. 11.1 is titled "Reductions in mean flow", and
`RU_SMGush` gives "% reduction (MAR & low flow)" (TT 691 p.62). MAP is the
child's after it has copied the parent's climate, i.e. the **parent's** MAP
("PMean" in the log). The genus shares of L.009 weight the per-genus values:

    TPRM = Σ_g (pct_g / 100) · clamp(a_g,MAR − b_g,MAR · MAP, min_g,MAR, 100)
    TPRL = Σ_g (pct_g / 100) · clamp(a_g,low − b_g,low · MAP, min_g,low, 100)

The manual says only that Smoothed Gush "only requires the percentages of the
area that is covered by the three main tree types" (TT 689 p.137); the weighting
is R6-F1, confirmed by the logs (§8: 16 of 16).

**Worked example** (synthetic): MAP 800 mm, 60 % pine, 30 % eucalyptus, 10 %
wattle. Per genus MAR: 56.92, 69.40, 57.65; low flow: 56.94, 84.83, 69.42.
TPRM = 0.6·56.92 + 0.3·69.40 + 0.1·57.65 = **60.737 %**; TPRL = 0.6·56.94 +
0.3·84.83 + 0.1·69.42 = **66.555 %** (`forest.test.ts`).

### 3.2 User defined

TPRM and TPRL are L.010 vars 2–3, entered as percentages ("You can enter your
percentage reduction there, and the program will do its best to produce these
reductions", TT 689 p.137). They may come from the full Gush Table, converted
from mm to % reductions, Gush's low flow being "the average flow for the driest
3 months" (TT 689 pp.137–138). With both at 0 % the child produces its
naturalised flows over its varying area (TT 689 p.162, KB article 1), which is
the area-conservation test in `sfr.test.ts`.

### 3.3 CSIR, Van der Zel, LUT Gush: not modelled

Their curves and tables are not in TT 687–691, so they cannot be built from the
manuals (ground rule 1). Defaults:

- **CSIR child** (R6-F2): use the Smoothed Gush targets for the same genus
  shares, with a warning (`csirChild: 'smoothedGush'`); `'none'` runs the child
  virgin instead.
- **CSIR or Van der Zel in a free module** (R6-F3): no reduction, with a
  warning. (TT 689 p.165: CSIR in a free module "reduce[s] the final outflows";
  `RU_QRTPERCENTILE`, "the value … equaled or exceeded 25% of time", TT 691
  p.63, feeds it. Van der Zel discounts flows "at source".)
- **LUT Gush** (R6-F4): never implemented in WRSM2000; no reduction, with a
  warning.
- **A child-only algorithm in a free module** (R6-F5): no reduction, with a
  warning.

`forestReduction` is the free-module model in the Round 6 contract's shape
(`StreamflowReduction`): a reduction of the final outflow, ≥ 0 and ≤ the
unreduced runoff. Today it is always zero, with the warning above.

## 4. The SFR Parent/Child mechanism (`sfr.ts`)

### 4.1 Roles and rules

A runoff module is **Free**, a **Parent** or a **Child** (TT 691 p.52
`ModSubType` 0/1/2). The rules (TT 690 pp.125–126; TT 689 pp.130, 133, 139–141):

- A parent lists its children (L.038–L.039, `sfrChildren`); a child does not
  name its parent. A child has one parent; a child cannot be a parent.
- "A Child takes on parameters of its Parent only. A Child only runs when told
  to do so by its Parent. A Child contributes its Runoff to the outflow of the
  Parent" (TT 690 p.126).
- A child has exactly one outflow route, carrying 100 % to a zero module, "or
  the flows will be counted twice" (TT 689 p.133). Validation already checks
  this (`docs/theory/network.md` §2.3).
- A parent may have paved area; a child may not (TT 689 p.140). A parent may not
  have afforestation or alien vegetation outside its children (p.140).
- "When a Parent Module is run, it first instructs all of its Child Modules to
  run their simulation. The position of the Child Module in the Network is
  therefore immaterial" (TT 689 p.140).
- The parameter equations "were derived from analyses of catchments suitable for
  afforestation … If FT is zero the equations definitely do not apply" (TT 690
  p.127). `runSfrGroup` warns for an SFR parent with FT = 0.

### 4.2 Areas

"During simulation, the active area of a Child Module is only that area that is
afforested, covered with Alien Vegetation … as specified by means of the
year/area pairs in the Child Module … The portion of the Child catchment that is
not afforested (etc.) in the given month is ignored – it is 'given' to the
Parent catchment. When the Parent catchment is simulated, its area is reduced by
the active Child areas of every one of the Child-catchment for every specific
month" (TT 689 p.140). The child's own L.002 area is only a check: "the maximum
area that will be covered" (p.139).

- Child *c*'s active area in hydrological year *y*: `A_c(y)` = its afforestation
  (or alien vegetation) year table, interpolated linearly between listed years
  and held flat beyond them (OQ-17, R3-N10), constant through the year (R6-F12).
- Parent's own area: `A_p(y) = AREA_p − Σ_c A_c(y)`. Below 0 is an error ("the
  total area covered by Afforestation, Alien Vegetation and Paved area may also
  not exceed the total area of the catchment", TT 689 p.127); the parent's own
  area is then taken as 0.
- A child whose active area exceeds its L.002 area gets a warning (p.139).

A module is run once at its largest area and scaled to `A(y)/A_max` year by
year (R6-F16): exact for classic Pitman depths and for any constant area. Sami
depths do depend on the area: the regional outflow OUT = T·HG·30·W/AREA with
W = 4·√AREA (OQ-S11) is a depth ∝ 1/√AREA, so a child of 1 km² loses 10× the
OUT depth of a 100 km² parent, and the groundwater evaporation area is a share
of the area (R6-R5). For a year-varying area the scaling is therefore an
approximation for Sami. Which area OUT is taken over is `samiOutflowArea`:
`'own'` (default, the area the member runs on) or `'owner'` (the parent's
W/AREA, so the OUT depth is the parent's). The logged virgin MARs favour
`'own'` (25 child blocks: median |error| 2.5 % against 3.6 % for `'owner'`).

**What a parent's `ncr.MTS` holds.** On the 11 public parents with an
`<net>RU<n>ncr.MTS`, the file matches the parent's *own* runoff depth × its
full L.002 area, not the flow its routes carry (own area + children): read as
the route flow it looks 8–40 % low wherever the children are a large share of
the area; read as depth × AREA it agrees within −4 … +4 % (2026-10-29, before
R6-R9/R10). The `ncr.MTS` replay check below uses it that way.

### 4.3 What a child inherits

"As soon as the Network Runs, the Parent will overwrite all the Climate data and
the Simulation Parameters of the Children with the values that it (the Parent)
has" (TT 689 p.138; TT 691 p.53 `RU_CopyClimate`, p.54 `RU_CopyParameters`).
The groundwater model follows the parent (p.138). The log prints "Climate copied
for a Child n" and "Parameters copied for a Child n" **[F]**.

`inheritFromParent` copies MAP, the rainfall file, S-pan, pan factors, A-pan
factors, the L.003 parameters, the groundwater model and the Hughes and Sami
parameter sets. It keeps the child's number, name, L.002 area, land-use tables
and outflow route. It drops paved area (not allowed), the RTIN inflow and the
upstream-groundwater link (the parent's), and the Sami groundwater abstractions,
which are volumes for the parent's catchment (R6-F13).

### 4.4 Virgin MAR and low flow

The child is first run with the inherited (unadjusted) parameters over its
active area. Its mean annual volume is **"Virgin MAR"** (VMAR, million m³/a) and
the mean of its lowest 25 % of monthly volumes is **"Virgin LQT"** (VLQT):
"the average of the 25% lowest monthly flows. The computer does this
calculation by ranking all monthly flows, selecting the 25% lowest and
calculating the mean of this set" (TT 689 p.138). TT 689 p.139 example 1 checks
VMAR as the parent's natural unit runoff × the child's average area. Pitman
reports VLQT in million m³/month; the log's unit is not stated (U-17), and the
calibration only uses it as a ratio.

`RunResult.virginMarMm3[child]` is this VMAR (absent in natural mode).

### 4.5 Targets

The child's kind decides its target model (`ChildTargetModel`): afforestation →
`forestTargetModel` (§3); alien vegetation → `alien.ts` (agent 6.4); neither (no
area above 0) → no reduction. A child with both runs as afforestation and the
alien vegetation is ignored with a warning (R6-F11: TT 691 p.52 `NSFR` is one
code per child).

    QMAR = VMAR · (1 − TPRM/100)        QLQT = VLQT · (1 − TPRL/100)

When VMAR is 0 the logs print TPRM = TPRL = 0 after the algorithm's own values
**[F]**; Pitman does the same.

### 4.6 Calibration: adjusting PI, FF, SL, ST

"The method used to determine the impact on the hydrological cycle is by the
adjustment of certain model parameters": PI (interception), FF ("the factor by
which potential evapotranspiration is increased"), SL and ST (TT 690 p.126),
for "increased interception due to greater leaf area … deeper penetration of
tree roots and increased evapotranspiration (analogous to crop factor effect)".
In Sami and Hughes children HGSL changes too (TT 689 p.138). FF is the PE
multiplier of `docs/theory/pitman.md` OQ-14; it is 1.00 in every parent and in
every file (the adjusted values are never saved, TT 689 p.38) **[F]**.

    MAR reduction (%)       = A·ΔPI + B·ΔFF + C·ΔSL                   TT 690 p.126 eq. 11.2
    Low flow reduction (%)  = X·ΔPI + Y·ΔFF + Z·ΔSL                   TT 690 p.126 eq. 11.3

"A predetermined relationship between ΔPI and ΔFF was assumed and it was also
assumed that ΔSL and ΔST were the same. The constants A,B,C and X,Y,Z are
different for each catchment and depend on MAP and ST. As the above equations
do not give an exact result they are used to perform a number of iterations
until the closing error is within acceptable limits" (TT 690 p.126). "The model
tries to get within 1% of the target flow reduction but if this is not reached
within 10 iterations, it increases the closing error until closure is achieved
(40 iterations allowed in total)" (TT 689 p.139).

The manual gives neither the ΔPI–ΔFF relationship nor the formulas for A…Z.
The run logs print each step (PRE-ITERATION, ITERATION n, constants, DSL, DPI,
DFF, PIA, FFA, SLA, STA, HGSLA, QMAR, QLQT, ERRM, ERRL) **[F]**, which fixes
the structure. Pitman's algorithm (`runSfrGroup`):

1. `p₀` = the inherited PI, FF, SL, ST, HGSL. Unknowns `u = ΔFF` (with
   `ΔPI = k·u`, R6-F6) and `v = ΔSL = ΔST`.
2. **Constants (R6-F10).** The manual says only that A…Z "depend on MAP and
   ST". The run logs print them for every child: across the 19 distinct sets
   (MAP 373–930 mm, ST 90–250 mm) A, B, X, Y are linear in MAP and C, Z in ST,
   and `sfrConstants` reproduces every printed value within one unit of its 4th
   decimal **[I]**:
   A = 14.4753 − 0.00836·MAP, B = 275.2365 − 0.16114·MAP,
   X = 7.3665 − 0.00244·MAP, Y = 200.1673 − 0.09435·MAP,
   C = 0.6913 − 0.00181·ST, Z = 1.54 − 0.00389·ST
   (MAP = the parent's, "PMean"; ST = the original ST). J = [(A·k + B, C),
   (X·k + Y, Z)] is fixed for the whole calibration **[F]**: the logged steps
   solve with the original constants even after ST has moved. `constants:
   'estimated'` keeps the earlier two-run estimate (reductions at `u = 0.1` and
   `v = 10 mm`).
3. **Pre-iteration**: solve `J·(u, v) = (TPRM, TPRL)` and step.
4. **Iteration i = 1 … 40**: run the child; `ERRM = TPRM − 100(1 − MAR/VMAR)`,
   `ERRL = TPRL − 100(1 − LQT/VLQT)` (% points; the log's ERRM/ERRL match this
   definition **[F]**). Stop when `|ERRM| ≤ tol(i)` and `|ERRL| ≤ tol(i)`
   (R6-F9). Otherwise solve `J·(u, v) = (ERRM, ERRL)` and step. When VLQT = 0,
   ERRL is 0. When J is singular, FF/PI alone steer the MAR.
5. **Step** (`applySfrStep`): FF += u, PI += k·u, SL and ST += `f(n)·v`,
   HGSL moves with SL (R6-F14). `f(n)` is 0.7 for the pre-iteration and updates
   1–10, 0.35 after (R6-F7 **[I]**). If SL would go below 0: SL = 0 and ST
   grows by twice the overshoot (R6-F8 **[I]**, 488 of 488 logged cases), and
   u is re-solved from the MAR equation alone with the SL change that happens,
   `u = (ERRM − C·(−SL)) / (A·k + B)` (R6-F19 **[I]**). PI floors at 0, FF at
   0.01 (R6-F15). With these rules the logged constants replay 475 of the 501
   logged updates to within 0.005 in every parameter (public logs; 585 of 613 over every local log); the rest are 3 updates
   where WRSM2000 put PI and FF back to their original values when FF would
   fall below 1 (not reproduced; R6-F15 open), 5 updates at the step-factor
   change (update 11) with SL > 0 whose ΔFF is smaller than the solve gives,
   and print rounding.
6. After 40 iterations without closure: keep the last run and warn, as WRSM2000
   does ("The SFR iteration did not converge after 40 iterations … Check the
   data of the module, especially the rotation periods if this is a CSIR-forest
   SFR" **[F]**).

The child's flow is the final run. A zero-target child (or a VMAR of 0) is not
calibrated: its flow is the virgin run (the log shows one iteration with zero
errors **[F]**).

Because A…Z are estimated rather than WRSM2000's own, Pitman's path to the
targets differs from WRSM2000's, and so may the end point inside the closing
error. Both meet the same targets to within `tol`; the reference comparison will
show whether the difference matters (a departure if so).

### 4.7 After calibration

A target model may return `adjustOutflow`, applied to the calibrated child's
flows. It exists for the riparian alien-vegetation deduction, which is
"subtracted from the residual runoff from the portion of catchment in the
riparian zone" after the child is modelled "as if not in riparian zone" (TT 689
p.129; p.139 example 1: target MAR 0.569, achieved 0.529, route 0.16 with 2.2 %
riparian). The hook gets the final run (and its diagnostics, for the actual vs
potential ET it needs).

### 4.8 Combining

"Once the simulation is complete, we add the outflows from the SFR Child
catchments to the flows from the Parent catchment, and that is the final
outflow of the catchment" (TT 689 p.140); "the outflows in the Route(s) from the
Parent Module will be the flows that are generated by the Parent Module itself
AND the outflows of the Child Modules … the flows that emerged from your Child
Module … are saved as usual in the outflow routes that you specified" (p.138).

    parent generated runoff(t) = own run over A_p(y) + Σ_c child flow_c(t)
    child route(t)            = child flow_c(t)          (to the zero sink)

The parent's RTIN inflow is then added and the total split over its L.020
routes, as for any runoff module (`docs/theory/network.md` §2.2, R3-N8).

**Reductions are not subtractions.** The afforestation effect on the parent's
route is (natural parent run) − (parent's own + children), as TT 689 p.138
prescribes for WRYM input; the child's route is not the reduction (p.139).

### 4.9 Diagnostics

Per TT 689 pp.13–14: aquifer recharge and total recharge (mm) of parent and
children combine by area weighting; interflow and the other volumes add. "The
Groundwater Storage State in the Parent Module is an Area-weighted average of
all the Groundwater Storage States – in the Parent and in the Child areas"
(p.140); "Weighted Pitman S is the weighted value of Pitman S for the parent
plus its child modules" (p.121). `runSfrGroup` returns each run (`parentRun`,
`children[i].run`) and the areas; the runner forms these.

## 5. Run modes (D1)

| | historical | present day (year Y) | natural |
|---|---|---|---|
| Child active area | year table, by year | held at its value in Y | 0 |
| Parent's own area | AREA − Σ children, by year | AREA − Σ children at Y | AREA |
| Child calibration | yes | yes, with the held areas | none |
| Child route | calibrated child flow | same | 0 (R6-F17) |
| Virgin MAR reported | yes | yes | no |

Natural follows "child modules have no effect as afforestation and alien
vegetation are ignored" (TT 689 p.13) and the naturalised box (p.27). The
targets of Smoothed Gush and user-defined children don't depend on the year; a
model whose targets do (alien vegetation's age) gets `mode` in its input.

## 6. Interface for the runner

```ts
import { runSfrGroup, type SfrSimulator } from './landuse/sfr.js';

runSfrGroup(
  {
    parent,                 // RunoffModule, after applyRunMode(…, mode)
    children,               // RunoffModule[] for parent.sfrChildren, after applyRunMode
    mode, startYear, endYear,
    simulate,               // SfrSimulator: (module) => { outflow: MonthlySeries (Mm³/month for module.areaKm2), diagnostics?, messages }
    targets: { alien },     // agent 6.4's ChildTargetModel; afforestation defaults to forestTargetModel()
  },
  options?: Partial<SfrOptions>,
): SfrGroupResult            // { outflowMm3, parentOwnMm3, parentAreaKm2ByYear, parentRun, children[], virginMarMm3, messages }
```

What the runner does:

1. **Find the groups.** A parent is a module with `sfrChildren`; its children are
   those modules. When the runner first meets a parent **or** one of its
   children in the sequence, it runs the whole group once and caches the
   result (TT 689 p.140: the child's position is immaterial).
2. **`simulate`** is the module runner with the rainfall and period bound:
   classic Pitman, Hughes or Sami as `module.groundwaterModel` says, with the
   module's afforestation and alien vegetation treated as absent and SFR
   children ignored. It returns the module's *generated* runoff for
   `module.areaKm2` (it is called with the area set), before RTIN and before
   the L.020 split. Sami runs entirely inside it: the SFR mechanism changes the
   child's parameters *before* Sami runs, not Sami's output after.
3. **Parent's routes**: `outflowMm3` (own + children) + RTIN, split by L.020.
4. **Each child's single route**: `children[i].outflowMm3`.
5. **`RunResult.virginMarMm3`**: merge `virginMarMm3`.
6. **Messages**: append `messages`.
7. **Diagnostics** (§4.9) from `parentRun` and `children[i].run`.
8. **Free modules** with afforestation: apply `forestReduction` (the contract's
   `StreamflowReduction`) to the generated runoff before RTIN and the split. It
   returns zero with a warning today (§3.3).

**Does the starting contract fit?** For a free module, yes (`forestReduction`).
For children, no: a child's reduction is not a function of an unreduced series.
It needs the runoff model itself (the virgin run, then up to 42 more runs with
changed parameters), and the parent's area changes with the children's. So the
mechanism takes an injected `SfrSimulator` and returns the parent's combined
series instead of a reduction. `ReductionInput.parent` is therefore unused, and
`ReductionOutput.virginMarMm3` is replaced by `SfrGroupResult.virginMarMm3`.

## 7. Open questions (with defaults)

| ID | Question | Default | Evidence |
|---|---|---|---|
| R6-F1 | How L.009 shares weight Table 11.1 | Σ pct/100 × reduction, as written (`speciesWeighting: 'normalised'` divides by the sum) | 16 of 16 logged targets match **[F]** |
| R6-F2 | CSIR child (tables unpublished) | Smoothed Gush targets for the same shares, warned (`csirChild: 'none'`) | TT 689 p.127, TT 691 p.61 |
| R6-F3 | CSIR / Van der Zel in a free module | no reduction, warned | no curves or tables in TT 687–691; none in the reference set |
| R6-F4 | LUT Gush | no reduction, warned | TT 689 p.xvi: not implemented |
| R6-F5 | Smoothed Gush / user defined in a free module | no reduction, warned | child-only (TT 689 p.136); 1 orphan in the reference set routes to the zero sink |
| R6-F6 | ΔPI = k·ΔFF | k = 34 (`piPerFf`) | **[I]** DPI/DFF in 590 logged steps (33.0–35.1, rounding) |
| R6-F7 | Step factor on ΔSL | 0.7 to update 10, 0.35 after (`slStepFactor`) | **[I]** 376 + 235 logged steps |
| R6-F8 | SL below 0 | SL = 0, ST += 2·overshoot (`slFloor: 'clamp'` moves ST by ΔSL) | **[I]** 488 of 488 logged cases |
| R6-F9 | Closing error | 1 % to iteration 8, then 2 (9–16), 4 (17–24), 8 (25–32), 16 (33–40) (`tolerance`) | TT 689 p.139 says "within 10 iterations"; the logs **[I]**: these bands reproduce 613 of 613 logged stop-or-continue decisions; "10" misses the four logged stops at iteration 9 with 1 < \|ERRL\| ≤ 2 |
| R6-F10 | Constants A…Z of eqs. 11.2–11.3 | `constants: 'logged'`: the linear forms in MAP and ST (§4.5 step 2), fixed for the calibration; `'estimated'` from two runs (`jacobianStep`) | TT 690 p.126: "depend on MAP and ST", formulas not given; **[I]** 19 of 19 distinct logged constant sets within 0.0001 |
| R6-F11 | Child with both afforestation and alien vegetation | afforestation; alien ignored, warned | TT 691 p.52: one NSFR per child |
| R6-F12 | Active area within a year | constant, the year table's value for the hydrological year | TT 689 p.126 "determined for every given year"; p.140 "every specific month" |
| R6-F13 | Child's Sami abstractions | none (the parent's volumes are not copied) | abstractions are not climate or calibration parameters (TT 691 pp.53–54); every reference L.036 is 0 |
| R6-F14 | HGSL | moves with SL, floored at 0 | logs: HGSLA = SLA in 501 of 501 steps, but original HGSL = SL in all 33 blocks, so "= SL" and "moves with SL" can't be told apart |
| R6-F15 | Parameter floors | PI ≥ 0, FF ≥ 0.01 | none |
| R6-F16 | Year-varying areas | run once at the largest area, scale by year | exact for classic Pitman and constant areas; approximate for Sami with a varying area (OUT ∝ 1/√AREA, GW evaporation area, abstractions) |
| R6-F19 | ΔFF when SL hits 0 | re-solved from the MAR equation with the SL change that happens (`slFloorResolve`) | **[I]** the logged updates (§4.5 step 5) |
| R6-F20 | Area of a Sami member's regional outflow | `samiOutflowArea: 'own'` | logged virgin MARs: 'own' median \|error\| 2.5 %, 'owner' 3.6 % (25 blocks) |
| R6-F17 | Child route in natural mode | 0 | the route ends at the zero sink, so totals don't depend on it |

Also open, for the orchestrator: whether Scott & Smith (1997, Water SA 23(2)),
which TT 691 p.61 names as the CSIR source, may be used as a published source;
it would replace R6-F2 and R6-F3 for CSIR.

## 8. Local reference checks

`src/landuse/sfr.reference.test.ts` (skipped unless `WRSM_REFERENCE_DIR` is set)
reads the `WRSM2000.ERR` child blocks (2026-10-29):

- **Smoothed Gush targets**: 16 of 16 logged "After SMGush" TPRM/TPRL pairs
  match `smoothedGushTargets` at the logged PMean to the printed 4 decimals
  (100 %). One more block's child is no longer a child in the current files.
- **Virgin MAR**: with a replay simulator returning the parent's `ncr.MTS` depth
  for every module (so this tests the VMAR definition and the area
  bookkeeping, not the runoff model), 39 child blocks compared (+2 zero in
  both, 1 skipped): 21 % within 1 %, 74 % within 5 %, 95 % within 10 %, median
  |error| 2.6 %. The `.MTS` and `.ERR` need not come from the same run
  (`docs/formats.md` §14), and the `.MTS` is the parent's runoff as saved,
  which includes paved flow; the check against Pitman's own virgin runs needs
  the Sami runner (integration).

- **Calibration steps**: the logged parameter updates replayed with
  `sfrConstants` and `sfrUpdate` (no runoff model: each logged ERRM/ERRL in,
  the next logged PIA … HGSLA out): 475 of 501 public updates within 0.005
  (95 %); every constant set within 0.0001.
- **Final QMAR** (whole-network probe, Sami, 2026-10-29 on the R6-R9/R10
  defaults; 32 public child blocks whose log belongs to the folder's network):
  MAR reduction achieved within 1 % point of the logged one in 27 (was 14 with
  the estimated constants and the 10-iteration bands); Final QMAR within 2 % in
  20 (was 14), median |error| 1.8 % (was 2.3 %), most of it the virgin MAR
  (median |error| 1.3 %). The final low-flow reduction is within 2 points in 7:
  at the same parameters Pitman's Sami child responds differently from
  WRSM2000's (alien children reduce more, afforested ones less), which the
  calibration path then follows; not explained yet.
