# Reservoir module

Spec for the WRSM2000 **reservoir module** (RV), which serves both a single dam
and the lumped "farm dam" form. It is written so that `packages/wrsm/src/reservoir/`
(Round 3, agent 3.2) can be coded and checked without opening the PDFs.

## Sources and how to cite them

| Short name | Report | Used for |
|---|---|---|
| TT 690 | WRC TT 690/16, *WRSM/Pitman Theory Manual*, ch.2 "Reservoir module (unchanged from WR2005 to WR2012 studies)", book pp.9–10 (PDF pp.22–23) | every equation below |
| TT 689 | WRC TT 689/16, *User Manual*: p.xv (module overview, naturalised flows), §4.6–4.8 demand, supply and shortage files (pp.15–17), §6.1.21 reservoir dialogs (pp.87–92), §6.2.4 monthly defined abstractions and restrictions (pp.149–151), ch.8 deficit handling (pp.169–171) | draft types, priorities, capacity table rules, run messages |
| TT 691 | WRC TT 691/16, *Programmer's Code Manual*: §7.6 `Dam_Type` (pp.77–80), §12.3 reservoir file (pp.157–158) | variable names, failure codes, the `'*'` line, initial storage |

Citations use **book** pages (`TT 690 p.9 eq. 2.2`). PDF page = book page + 13
for TT 690 and + 21 for TT 689. TT 690's equations are images; every equation
here was read from page renders (110 dpi) of PDF pp.22–23.

The file layout (line types L.001–L.015) is in [`docs/formats.md` §6](../formats.md#6-reservoir-module-netrvndat);
this spec cites its line numbers.

## What the module does, in one paragraph

Each month the reservoir adds up its inflows, works out its drafts (the
demands on its outflow routes), and does one mass balance: storage at the start
of the month, plus inflow, minus drafts, minus net evaporation from the water
surface (gross lake evaporation less rain on the surface, both on the area at
the start of the month). Water above full supply spills down the spill route.
If the balance goes below zero, the drafts are cut back, defined drafts last,
and the reservoir ends the month empty. Full supply volume and area can change
year by year (a dam built, raised or silted up, or farm dams added). Before a
dam is built (capacity 0) the module passes its inflow on like a channel.

---

## 1. Symbols, units, file fields and TT 691 names

| Symbol | Meaning | Units | RV `.DAT` field | TT 691 §7.6 name |
|---|---|---|---|---|
| `S` | storage state; `S₁` start of month, `S₂` end | million m³ | L.015 for the initial value | `SNOW`, `SPMNTH`, `RVSTIN` |
| `CAP` | (live) capacity, the full supply volume in force that year | million m³ | L.003 count, L.004 years, L.005 volumes | `RVS(…)`, `SFULL` |
| `FSA` | surface area at full supply that year | km² | L.006 | `RVA(…)`, `AFULL` |
| `b` | power of the area–storage curve | – | L.002 v3 | `RVPOW` |
| `a` | coefficient of the area–storage curve, from `FSA` and `CAP` | km²/(million m³)^b | derived | – |
| `A` | surface area; `A₁` at the start of the month | km² | derived | `ANOW` |
| `I` | total inflow | million m³ | the inflow routes, L.010–L.011 | `JRTIR` |
| `D` | total draft (controlled releases) | million m³ | the outflow routes, L.012–L.014 | `JRTOR` |
| `P` | rainfall on the reservoir surface | mm | % MAP from the L.002 v2 `.RAN` × L.002 v1 MAP | `RVMAP`, `NPR` |
| `G` | average gross (lake) evaporation | mm | L.007 pan × L.008 pan factor | `RPAN`, `RPF`, `RVE` |
| `E` | net evaporation loss | million m³ | derived | – |
| `SPILL` | uncontrolled spillage | million m³ | spill route, L.009 | `JOUTR` |
| `Dm` | demand for the month on a monthly-abstraction route | million m³ | L.014 v1–v12 | – |
| `Sr` | trigger storage below which `Dm` is reduced | million m³ | L.014 v13 | `RVRES` |
| `Fr` | restriction (reduction) factor | – | L.014 v14 | `RVRF` |

Month index `m` = 0 for October … 11 for September (hydrological year). All
volumes in million m³ per month, as everywhere in WRSM2000 (TT 690 p.9: "All
volumes are in million cubic metres and the reservoir surface area is in
square km").

---

## 2. Equations (TT 690 ch.2, transcribed)

### 2.1 Mass balance (§2.1, TT 690 p.9)

Net evaporation, "based on the area at the start of the month":

```
E = A₁ × (G − P) / 1000                                   (2.1)
```

`A₁` in km² times a depth in mm gives thousands of m³; `/1000` makes it
million m³. `E` is negative when rain on the surface exceeds evaporation.

"The mass balance is first done assuming the dam neither dries up nor spills":

```
S₂ = S₁ + I − D − E                                       (2.2)
```

Then the spill test:

```
If S₂ < CAP:  SPILL = 0
If S₂ > CAP:  SPILL = S₂ − CAP   and  S₂ = CAP
```

(the page prints "SPILL S₂ – CAP", the `=` lost), and the dry test, which
"determine[s] whether the full draft D can be supplied, otherwise D is reduced":

```
If S₂ < 0:    D = D + S₂   and  S₂ = 0
```

### 2.2 Area–storage relationship (§2.2, TT 690 pp.9–10)

```
A = a × S^b                                               (2.3)
```

"The value of 'a' is calculated by putting A = FSA and S = CAP into the above
equation", so `a = FSA / CAP^b`. `b` comes from the reservoir's area–capacity
table; without one, 0.6 ("the average for all reservoirs in South Africa";
TT 689 p.92 repeats the 0.6 default and says `b` is constant over the run).

### 2.3 Controlled releases or draft (§2.3, TT 690 p.10)

Three types of draft:

1. "Supplies to an irrigation module, which are first calculated by that module";
2. "A time series of demands, covering the period to be simulated" (a
   defined-flow file on the outflow route);
3. "A set of 12 demands, one for each calendar month, with the option of
   reducing demand when the storage state S falls below a prescribed level"
   (a `'*'` route with its L.014 line).

For type 3, with `Dm` the month's demand, `Sr` the trigger level and `Fr` the
reduction factor:

```
If S > Sr:  D = Dm                                        (2.4)
If S < Sr:  D = Fr × Dm                                   (2.5)
```

TT 691 p.158 says which `S`: "the reduction factor by which the demand will be
reduced if the storage state of the reservoir **at the beginning of the month**
is less than the minimum storage state", so `S = S₁`.

---

## 3. Calculation procedure

TT 690 gives the balance; TT 689 and TT 691 give the rest. Each step names its
source; the open choices are in §7.

### 3.1 Inflow `I`

`I` is the sum over the inflow routes (L.010–L.011, at most 5):

- a route with a blank file name carries the flow simulated by its upstream
  module (`inflows[route]`, solved before this module, R3-1);
- a route with a file name carries that file's flows (TT 691 p.157 L.011 v2:
  "a file with flow data for the route if the route has defined flow"), read
  per run mode with `definedFlowSeries` (R3-2). The file wins over any
  simulated flow on the same route (R3-RV22).

### 3.2 Drafts `D` per outflow route

Each outflow route (L.012–L.013, at most 5) is one of:

| L.013 file | Kind | Demand in month *t* | Priority (§3.3) |
|---|---|---|---|
| a file name | **defined** (type 2) | the file's value, per mode (R3-2) | first |
| `'*'` + L.014 | **monthly** (type 3) | `Dm(m)` if `S₁ ≥ Sr`, else `min(Fr, 1) · Dm(m)` (eqs. 2.4–2.5, R3-RV8, R3-RV12) | second, with calculated |
| blank | **calculated** (type 1) | the demand set by the module downstream, e.g. an irrigation abstraction; 0 when none is given (R3-RV13) | second |

The spill route (L.009) must be one of the outflow routes ("Illegal spillage
route", TT 689 p.88). It normally has a blank file name and so no demand;
if it has a defined file, the spill is **added** to the defined release on that
route (TT 689 p.89 and p.169: "spillages are ADDED to the defined releases").

An unbuilt dam (`CAP = 0`) has storage 0, so its `'*'` routes are restricted
until storage climbs above `Sr` (TT 689 pp.170–171: "monthly defined
abstractions (if specified) will be reduced by the restriction factor until
the water in the reservoir has accumulated to more than the defined minimum
storage level").

The GUI's route codes `N`, `F`, `I` and `M` (TT 689 p.89) map to: blank, a file,
blank on an irrigation abstraction route, and `'*'`.

### 3.3 Deficit priorities (TT 689 ch.8, pp.169–170)

"In the event that too little water is available":

- "defined routes are satisfied, if at all possible";
- "water is sent to non-defined (i.e. calculated) irrigation abstraction routes
  and monthly defined abstraction routes, in amounts proportional to the
  demand. Irrigation blocks have preference over outflow and spillage routes,
  unless these are defined flow routes";
- (irrigation return flows are recomputed by the irrigation module; not the
  reservoir's job).

"If a module has both defined and non-defined routes, the amount of water
available for redistribution to non-defined routes is first calculated by
subtracting the flows to the defined routes from the total amount available.
The outflow to non-defined routes is set to the proportion of the demand that
is available" (worked example: 2.5 and 3.0 demanded, 3.5 available → 1.59 and
1.91). If even the defined routes can't be met, "the amount that could be
supplied to the routes is shared out proportional to the demand", and the
calculated routes get 0.

So with `W = S₁ + I − E`, the water the reservoir could release before drying
up (eq. 2.2 with `S₂ = 0`), `Ddef` the defined demands and `Dcalc` the
calculated + monthly demands:

| Case | Condition | Defined supply | Calculated supply | `S₂` | WRSM2000.ERR wording (docs/formats.md §14) |
|---|---|---|---|---|---|
| none | `W ≥ Ddef + Dcalc` | full | full | `W − D` (then the spill test) | – |
| calculated reduced | `Ddef ≤ W < Ddef + Dcalc` | full | `d·(W − Ddef)/Dcalc` each | 0 | "There was not enough water to satisfy calculated demands. Calculated outflows were reduced." |
| defined reduced | `0 < W < Ddef` | `d·W/Ddef` each | 0 | 0 | "The defined demands were greater than the total storage + supply. Calculated outflows were set to zero." |
| dry | `W ≤ 0` | 0 | 0 | 0 | "The reservoir was dry. Defined outflows were set to zero." |

This is TT 690's `D = D + S₂` with the reduction shared out by TT 689's rules.
The spill gets only what is left above `CAP`, so it is always last.

**Defined routes are cut when the reservoir can't supply them** (R3-RV9).
TT 689 p.169 says "the flows in DEFINED routes are NEVER adjusted downwards
… that route will carry the full defined flow", but in the same chapter (p.170)
it computes "the maximum possible flow that could be supplied to these defined
routes", TT 689 p.17 says that for a reservoir "the '.ANS' file will show the
reduced supply", p.16 says a route's `.ANS` holds "the flows that were
supplied", and real `.ERR` files report "Defined outflows were set to zero".
The route therefore carries the supply; the demand and the shortage are
reported (§9). This also keeps the mass balance closed.

### 3.4 Rainfall on the surface `P`

`P(t) = %MAP(t) / 100 × MAP`, with `%MAP` from the reservoir's own `.RAN` (L.002
v2) and `MAP` its own L.002 v1 (TT 689 p.90: "both a Rainfile and an MAP must
be supplied for every Reservoir … different modules may share a Rainfile, even
though the MAP may be different"; the % MAP convention is TT 690 §1.3, as for
the runoff module). The file must cover every simulated year; a missing year or
a negative value is an error (R3-RV16, as R2-2 for runoff).

### 3.5 Gross evaporation `G`

`G(m) = pan(m) × factor(m)`, L.007 × L.008. TT 691 p.157: "The type of pan used
is left to the user. Used in conjunction with line type 8, the result should be
lake evaporation." TT 689 p.90 suggests Symons-pan values with WR90 Appendix
3.3.1 lake factors. The same 12 values are used every year.

### 3.6 Capacity by year

The L.004–L.006 table gives `(year, CAP, FSA)` triplets, at most 10, "in
chronological sequence" (TT 689 pp.91–92). Rules from TT 689 pp.91–92:

- "the first triplet must have a year-value that is either in (or before) the
  first year of simulation, and the last year must be in (or after) the last
  year of the simulation. If the entire simulation period is not covered, the
  program will not be able to calculate the values for area and volume for the
  years that lie outside your data" → historical mode throws (R3-RV5);
- "In the event that the reservoir was built after the start of the
  simulation, you can start with a 1900-0-0 triplet and another 19xx-0-0 just
  before the dam is commissioned … a heightening of the dam wall can be
  simulated by increasing the capacities … a reservoir can also be destroyed
  by setting the year-area-volume triplet to year-0-0". A second zero row "just
  before" commissioning is only needed if values between rows are
  **interpolated**, so years between rows are filled linearly (R3-RV4);
- `CAP` and `FSA` hold for the whole hydrological year (TT 691 p.79: `SFULL`
  "Full supply volume for the year"), and a row labelled *Y* is the
  hydrological year starting October *Y*, as in `.RAN` files (R3-RV18).

`a` is recomputed from each year's `CAP` and `FSA`. With `CAP = 0` there is no
dam: `A = 0`, nothing evaporates, and every month's inflow less drafts spills.
TT 689 p.92: "Before a Reservoir is built, and also after it was destroyed, a
Reservoir Module behaves just like a Channel Module".

When `CAP` drops below the storage (silting, a lowered wall, a destroyed dam)
the excess leaves by the spill route at the end of the first month of the
new year, through the normal spill test (R3-RV17).

### 3.7 Initial storage

L.015, optional. TT 691 p.158: "If this line type is absent or the value is
01.00, the initial storage state of the reservoir will be set to 50% of FSV".
"01.00" is a garbled `-1.00` (U-9), so:

- absent or negative → `S₀ = 0.5 × CAP` of the first simulated year (present
  day: of the held capacity) (R3-RV6);
- `0` → start empty (R3-RV7, U-9; switchable);
- any other value → as given (above `CAP` it spills in the first month).

### 3.8 The monthly loop

For each month *t* (year *y*, month *m*) in run order:

1. `CAP`, `FSA` for year *y* (§3.6); `a = FSA / CAP^b`.
2. Demands per outflow route (§3.2), the `'*'` routes tested on `S₁`.
3. `A₁ = a·S₁^b` (eq. 2.3; 0 if `S₁ = 0` or `CAP = 0`).
4. `rain = A₁·P/1000`, `evap = A₁·G/1000`, `E = evap − rain` (eq. 2.1).
5. `W = S₁ + I − E`; supplies from §3.3.
6. `S₂ = W − Σ supply` (eq. 2.2), 0 in a deficit case.
7. If `S₂ > CAP`: `SPILL = S₂ − CAP`, `S₂ = CAP`.
8. If `W < 0` (net evaporation above `S₁ + I`, only possible with `G > P`):
   evaporation is limited to the water there was, `evap = S₁ + I + rain`
   (R3-RV3).
9. Route flows: each route's supply, plus `SPILL` on the spill route.
10. `S₁ ← S₂`.

Every month then satisfies

```
S₂ − S₁ = I + rain − evap − SPILL − Σ supply,   0 ≤ S₂ ≤ CAP,   0 ≤ supply ≤ demand
```

which the tests check over random inputs.

### 3.9 The lumped farm-dam form

TT 689 p.xv: "The reservoir module can be used to represent a single reservoir
or an equivalent dam made up of any number of small dams … for the number of
small dams to change over time by inputting values of storage and surface area
for up to ten different years." There are **no separate equations**: a farm-dam
module is an RV module whose `CAP` and `FSA` are the sums over the dams, with
the 0.6 default `b` where no area–capacity data exists (TT 689 p.92: "For small
dams where no such data exists, a value of 0.6 is usually adopted"). Round 7's
2025 farm-dam capacities (D4) are written into its L.004–L.006 table. Its
outflows are typically a spill route to the river and calculated irrigation
abstraction routes.

---

## 4. Worked example (synthetic; the tests reuse these numbers)

### 4.1 Area–storage

`CAP = 10`, `FSA = 2`, `b = 0.6`: `a = 2 / 10^0.6 = 2 / 3.981072 = 0.502377`.
`A(10) = 2` (the curve passes through full supply); `A(5) = 0.502377 × 5^0.6 =
0.502377 × 2.626528 = 1.319508 km²`.

### 4.2 Two months

Module: MAP 600 mm, pan Oct 200 / Nov 220 mm, pan factor 0.8, `%MAP` Oct 10 /
Nov 25, `S₀ = 5` (L.015). Outflows: route 10 spill (blank), route 11 defined
0.5 per month, route 12 `'*'` with `Dm` Oct 1.0 / Nov 1.2, `Sr = 4`, `Fr = 0.5`.
Inflow route 1: Oct 3, Nov 6.

**October.** `S₁ = 5 ≥ Sr`, so route 12 asks the full 1.0; `D = 0.5 + 1.0 = 1.5`.
`A₁ = 1.319508`. `G = 200 × 0.8 = 160 mm`, `P = 0.10 × 600 = 60 mm`.
`rain = 1.319508 × 60 / 1000 = 0.079170`, `evap = 1.319508 × 160 / 1000 =
0.211121`, `E = 0.131951`.
`S₂ = 5 + 3 − 1.5 − 0.131951 = 6.368049`; below `CAP`, no spill.

**November.** `S₁ = 6.368049 ≥ Sr`; `D = 0.5 + 1.2 = 1.7`.
`A₁ = 0.502377 × 6.368049^0.6 = 1.525576`. `G = 176`, `P = 150`,
`E = 1.525576 × 26 / 1000 = 0.039665`.
Preliminary `S₂ = 6.368049 + 6 − 1.7 − 0.039665 = 10.628384` > `CAP`, so
`SPILL = 0.628384`, `S₂ = 10`. Route 10 carries 0.628384.

### 4.3 A deficit month

Same dam, `S₀ = 0.4`, October pan 250 mm (G = 200 mm), no rain, inflow 0.1,
route 11 defined 0.2, route 12 `'*'` 1.0 with `Sr = 0`.
`A₁ = 0.502377 × 0.4^0.6 = 0.289912`, `E = 0.289912 × 200 / 1000 = 0.057982`.
`W = 0.4 + 0.1 − 0.057982 = 0.442018 ≥ Ddef = 0.2`: route 11 gets 0.2, route 12
gets 0.242018 (calculated reduced), shortfall 0.757982 (> 0.009: a major
failure), `S₂ = 0`.
With `Sr = 4` instead, `S₁ = 0.4 < Sr` so route 12 asks `0.5 × 1.0 = 0.5` and
still gets 0.242018.

TT 689 p.170's own example (routes demanding 2.5 and 3.0, 3.5 available)
gives 1.590909 and 1.909091, which the manual prints "rounded to 2
significant digits" as 1.59 and 1.91; nothing is rounded in the engine.

---

## 5. Run modes (D1)

WRSM2000 has one mode: the files as given, which is **historical**. Present day
and natural are Pitman's (decision D1); for the reservoir:

| | Capacity (`CAP`, `FSA`) | Defined drafts and defined inflows | `'*'` drafts | Calculated drafts | Rain, evaporation | Initial storage |
|---|---|---|---|---|---|---|
| **historical** | by year from the table (§3.6) | each year's row (R3-2) | 12 monthly values | as the caller gives them | yes | §3.7, first year's `CAP` |
| **present day** (year *Y*) | the value for *Y* (interpolated), every year; the nearest end row if the table doesn't reach *Y*, with an info message | row *Y* every year, nearest row if absent (R3-2) | unchanged (they don't vary by year) | as the caller gives them (held at *Y* by the network runner) | yes | §3.7, held `CAP` |
| **natural** | 0 (no dam) | 0 (R3-2) | 0 | 0 | none (`A = 0`) | 0 |

Natural mode needs neither a rainfall file nor a capacity table.

**Natural = dam removed (R3-RV14).** The manuals define no natural mode. TT 689
p.xv describes the goal ("naturalised flows can be determined, i.e. flows
without any man-made effects of reservoirs, industry, towns, irrigation
schemes, mines, etc."), TT 689 p.27 the per-runoff-module "Simulate
Naturalised outflows" tick box (it drops paved areas, afforestation and alien
vegetation and says nothing about reservoirs), and TT 689 p.92 says a reservoir
with no capacity "behaves just like a Channel Module". So in natural mode the
reservoir is a capacity-0 module with no drafts: storage is 0 throughout,
there's no evaporation or rain on a lake, and every month's total inflow passes
to the spill route. Nothing in the manuals says otherwise. Consequences worth
knowing:

- a defined **inflow** (a transfer in) is zero in natural mode (R3-2), so the
  spill route carries only the simulated inflows. A defined inflow that is in
  fact natural (an observed upstream record) must be read in historical mode
  by the caller (the contract's `definedFlowSeries` note);
- the lake surface's own rainfall-runoff is not modelled in any mode. In
  natural mode the land under the lake is whatever the upstream runoff
  modules already cover.

---

## 6. Invalid data

`runReservoir` throws `ReservoirRunError` with the module named (`RV 4 (SY
Dam): …`) for (R2-2 pattern):

- `b` (RVPOW) not positive; MAP negative; a negative pan or pan factor;
- an empty capacity table, years not ascending, a negative volume or area, or
  (historical, R3-RV5 `error`) a simulated year outside the table;
- the rainfall file missing, a year missing from it, or a negative % MAP
  (not in natural mode, which doesn't read it);
- the spill route not among the outflow routes; an outflow route listed twice;
- a defined-flow file missing from the network or short of the run;
- `'*'` without its L.014 line; a negative monthly volume, trigger or
  restriction factor;
- an inflow route listed twice (L.011);
- a simulated inflow route with no flow given; a series of the wrong length,
  in a unit other than million m³, or negative (R3-RV23);
- a calculated demand given for a route that isn't a blank-file outflow route,
  or a negative demand.

A restriction factor above 1 is used as 1 with a warning (TT 689 p.151: "When
restriction factors of greater than 1.00 are accidentally set, they will
automatically be reset to 1").

A one-row capacity table is accepted although TT 689 p.91 asks for "at least
two year – area – volume triplet[s]": one row covering the whole run is
unambiguous, and in historical mode the coverage rule (R3-RV5) still applies.

---

## 7. Open questions

Each has a proposed default. "Option" means it can be switched through
`ReservoirOptions` (`packages/wrsm/src/reservoir/reservoir.ts`, the R2-1
pattern).

| ID | Question | Default | Basis | Option |
|---|---|---|---|---|
| R3-RV1 | Order within the month | TT 690's literal order: one balance with `E` on `A₁`, then spill, then dry | TT 690 p.9; the reference check (§8) agrees in 99.85 % of months | – |
| R3-RV2 | Area used for rain on the surface | `A₁`, as for evaporation (eq. 2.1 nets them). Rain on an empty dam is lost | TT 690 p.9 | – |
| R3-RV3 | Net evaporation larger than `S₁ + I` (TT 690's `D = D + S₂` would make `D` negative) | evaporation limited to the water present; `S₂ = 0`, drafts 0 | mass balance | – |
| R3-RV4 | Capacity in a year between table rows | linear interpolation in the year | TT 689 p.91's "19xx-0-0 just before the dam is commissioned" row | `capacityBetweenRows: 'linear' \| 'step'` |
| R3-RV5 | A simulated year outside the capacity table (historical) | error | TT 689 p.91 | `capacityOutsideTable: 'error' \| 'nearest'` |
| R3-RV6 | 50 % of which year's FSV for the default initial storage | the first simulated year's (present day: the held year's) | TT 691 p.158 says "FSV" only | – |
| R3-RV7 | L.015 = 0 (U-9) | start empty | U-9 | `zeroInitialStorage: 'empty' \| 'halfFull'` |
| R3-RV8 | `S` in eqs. 2.4–2.5; `S₁ = Sr` exactly | `S₁` (start of month); `S₁ ≥ Sr` takes the full demand | TT 691 p.158 ("at the beginning of the month"; "above … full", "less than … reduced") | – |
| R3-RV9 | Defined outflow routes when the reservoir can't supply them | the route carries the reduced supply, shared in proportion to demand | TT 689 pp.16, 17, 170; `.ERR` wording (§3.3) vs TT 689 pp.169–170 ("NEVER adjusted downwards", "inviolate"). The reference set can't test it (§8): **for the hydrologist (#21)** | – |
| R3-RV10 | Minor vs major failure | per month and per class (defined, calculated): shortfall > 0.009 million m³ major, otherwise minor; shortfalls below 1e-9 are rounding, not failures | TT 691 p.80 (`RVFAIL` codes, "< 0.009 per month") | – |
| R3-RV11 | Arithmetic | float64. Under float32, `S₂` is rounded before the spill test, so it never ends above `CAP` and the balance closes to float32 precision | TT 691 p.79 declares the state `REAL` (float32) | `precision: 'float64' \| 'float32'` |
| R3-RV12 | Restriction factor outside 0–1 | > 1 → 1 with a warning; < 0 → error | TT 689 p.151 | – |
| R3-RV13 | A blank-file outflow route that isn't the spill route | carries the calculated demand the caller passes (irrigation abstraction), else 0 | TT 690 p.10 type 1; the contract can't pass it yet (report) | `runReservoir(…, { demands })` |
| R3-RV14 | Natural mode | dam removed: `CAP = 0`, no drafts, no rain or evaporation, inflow to the spill route | §5 | – |
| R3-RV15 | Present-day capacity when the table doesn't reach the year | the nearest end row, with an info message (as R3-2 for flow files) | D1 | – |
| R3-RV16 | Rainfall file coverage and sign | every simulated year required; negative % MAP is an error | R2-2 | – |
| R3-RV17 | `CAP` falling below the storage | the excess spills in the first month of the year | §3.6; alternative: lost | – |
| R3-RV18 | Year label of capacity rows | hydrological year (October *Y* to September *Y*+1); `CAP` changes in October | TT 691 p.79 `SFULL` "for the year"; U-19 | – |
| R3-RV19 | A calculated demand on the spill route, and TT 689 p.169's "Irrigation blocks have preference over outflow and spillage routes" | one proportional class for every calculated and `'*'` draft. Only an irrigation module sets a calculated demand in WRSM2000, so every demand passed in is an irrigation abstraction, and a non-defined outflow or spill route without one has no demand and gets only what is left (the spill). A calculated demand on the spill route is therefore an irrigation abstraction sharing that route, and the spill is added on top. If a later module type sets demands, a third, lower tier is needed | TT 689 pp.89, 169 | – |
| R3-RV20 | Rounding of proportional shares | none | TT 689 p.170 rounds only in the printed example | – |
| R3-RV21 | Messages | one warning per deficit month (module, `at`, case, shortfall by class), and an end-of-run "At least one minor/major failure to supply defined/calculated demands" per class, like WRSM2000.ERR | TT 689 p.169; docs/formats.md §14 | – |
| R3-RV22 | An inflow route with both a defined file and a simulated upstream flow | the file wins | TT 691 p.157 | – |
| R3-RV23 | A negative simulated inflow or demand (possible upstream under OQ-22's literal Muskingum form) | error, naming the route and month. Values down to −1e-9 are rounding noise and read as 0 | carrying it would need a negative spill or created water; neither is in TT 690 | – |

---

## 8. Reference check (local, `WRSM_REFERENCE_DIR`)

`reservoir.reference.test.ts`. WRSM2000 wrote no reservoir storage files
(`RV<n>.ANS`) in the reference set, so the check runs each reservoir whose
inflow routes and outflow routes all have WRSM2000 route outputs
(`RQ<route>.ANS`) on those inflows, in historical mode over its `.NET`
period, with each calculated outflow's output as its demand, and compares the
**spill route** with WRSM2000's.

Result (2026-10-29): 168 reservoir modules in the set; 39 checkable (121 lack
an inflow route's output, 7 the spill route's, 1 a calculated outflow's).
All 39 are within 1 % of WRSM2000's spill-route MAR (median |difference|
0.008 %, worst 0.72 %), all have NSE ≥ 0.996, and 99.85 % of their months are
within 0.015 million m³ of WRSM2000's printed value (inputs and outputs are
printed to 0.01). The few differing months are scattered, consistent with
inflows read at two-decimal precision. This confirms R3-RV1/RV2 and the §3.3
calculated-draft rule; it cannot test R3-RV4 (every table in the set has two
rows with one capacity), R3-RV7 or R3-RV9 (no defined outflow in the set is
ever short), and float32 makes no visible difference.

## 9. Outputs

`simulateReservoir` (the `ReservoirSimulator` of `network/contract.ts`)
returns:

- `outflows`: every outflow route (the spill route included), keyed by route
  number: the **supplied** flow, plus the spill on the spill route (TT 689
  p.16: a route's `.ANS` holds "the flows that were supplied");
- `storage`: end-of-month `S₂` (WRSM2000's `RV<n>.ANS`, TT 689 §4.5);
- `messages`: §7 R3-RV21, each with `module: { type: 'RV', number }`.

`runReservoir` also returns `detail`: monthly inflow, start and end storage,
`CAP`, `A₁`, rain, evaporation, spill, the deficit case, and per route the
demand and supply. Demand and supply give WRSM2000's `.DEM` and `.SHO`
(shortage = demand − supply, positive; TT 689 §4.6 p.15, §4.8 pp.16–17).

## 10. What this module does NOT cover

- Irrigation demand: the irrigation module computes it (Round 7); the network
  runner passes it as a calculated demand and re-simulates the irrigation
  module with the supply (TT 689 p.85).
- Diversion-channel demands on a reservoir ("spare capacity", TT 689 p.149,
  `RV_GetSpareCapacity`): a channel-module feature, out of scope here.
- Observed storage plots (TT 689 p.68 `%` storage files): UI, later.
- Daily time step (TT 689 §11.3): not in the monthly engine.
