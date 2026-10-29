# Sami groundwater model (WRSM2000 GW model 2)

Implementable specification of the **Sami groundwater–surface water interaction model** as it is
used inside a WRSM/Pitman runoff (RU) module when its groundwater model is `2` (L.022 variable 1).
It is written for Round 6, which implements it as two modules:
`packages/wrsm/src/groundwater/sami/soil.ts` (agent 6.1) and
`packages/wrsm/src/groundwater/sami/aquifer.ts` (agent 6.2). §6 defines the boundary between them.

The focus is **method 2** (Pitman S drives recharge, with an unsaturated "percolating" store). Every RU
module in the reference network uses GW model 2 and populates L.031–L.035. Method 1 (hydrograph
separation) appears in §9, more briefly. WRSM2000 has no file field that selects it (OQ-S1).

## Sources and citation style

| Ref | Report | Used for |
|---|---|---|
| TT 690 | WRSM/Pitman Theory Manual (TT 690/16), ch.8, book p.72–111 (PDF p.85–124) | Equations 8.1–8.16, Table 8.1, worked example §8.5 |
| TT 687 | WR2012 SAMI Groundwater module (TT 687/16), §2–4 | The WR2012 restatement (eqs 1–14), separate HGSL threshold, interflow lag eq. 9, borehole-yield curtailment eq. 14, parameter table, calibration guide |
| TT 691 | Programmer's Code Manual (TT 691/16) | §7.4 runoff record variable names (p.47–51), §11.2 and §11.21 notes (p.123, 145), ch.12 line types L.021–L.037 (p.150–153), testing notes (p.186–187) |
| TT 689 | User Manual (TT 689/16) | §6.1.7.1 and §6.1.9 (p.38–45) Sami dialog and defaults, Table 9.1 (p.173–174), §10.2 (p.181–182) |

Equation references give the report, the **book** page and the report's own equation number, for
example `TT 690 p.84 eq. 8.5`. TT 690's equations are images. Every equation below was transcribed
from page renders, not from `pdftotext`. TT 687 equations 9 and 14 were also read from renders (TT 687
book p.15 and p.18).

## 1. What Sami replaces in the classic Pitman RU

The classic Pitman RU (see `docs/theory/pitman.md`, TT 690 ch.1) produces subsurface runoff
`Q = FT·((S−SL)/(ST−SL))^POW` (TT 690 p.4 eq. 1.13). The parameter GW splits it into a baseflow part,
lagged by GL, and a remainder, lagged by TL. In a Sami module:

1. **The Pitman soil-moisture core still runs, with GW = 0 and GL = 0.** WRSM2000 forces both to zero
   "globally" before calling the Pitman routine `RU_GW`, so they have no effect (TT 691 p.123 §11.2;
   TT 691 p.206 item 43; TT 689 p.38–39). The Pitman core uses the **Sami calibration set on L.035**
   (POW, SL, ST, FT, GW, ZMIN, ZMAX, PI, TL, GL, R, FF), not the classic set on L.003 (TT 689 p.38
   §6.1.7.1: one calibration set per GW model; TT 691 p.123 §11.1). Interception, the S-curve rainfall,
   surface runoff, soil evaporation and the soil-moisture balance are unchanged.
2. **Sami runs as a monthly post-process on the Pitman soil-moisture series S** ("Pitman S"). WRSM2000
   needs **three passes** because Sami's spreadsheet uses whole-record averages: "The first loop
   calculates the average recharge, the second the average percolation and then the third loop
   recalculates everything using the averages previously determined" (TT 691 p.51 note on the Sami
   method). The programmers validated WRSM2000 against Sami's spreadsheet by feeding the spreadsheet
   S and Q from a WRSM2000 run with the Pitman GW model switched on (TT 691 p.186–187). That only works
   if Sami does **not** feed back into S. So in this spec Sami never alters S (OQ-S2).
3. **Subsurface runoff becomes "interflow"**, computed by Sami from monthly S with the same Pitman
   formula (TT 690 p.88 eq. 8.12; TT 687 p.5 eq. 1), plus any percolation the full aquifer rejects. It
   is lagged by its own parameter **F28_Lag** (L.034 var 3), not by GL or TL (TT 687 p.15 eq. 9).
4. **Recharge** comes from S with its own threshold and maximum, `HGSL` and `HGGW` on L.032, and power
   `GPOW` (TT 687 p.6 eq. 2). Recharge passes through an **unsaturated percolating store** (PMAX, PPOW,
   averaged over D9_MMA months) into an **aquifer store** (CAP = thickness × storativity). The aquifer
   loses water to **riparian evaporation**, **regional outflow** and **baseflow**. It gains water from
   **transmission losses** out of the river, and it supplies **abstractions**.
5. **Final RU runoff** (OQ-S3):
   `Qfinal = Qsurface + INTERFLOW_lagged + GWBaseflow_net − TL`, where `Qsurface` is the Pitman
   run's surface component, with the FT subsurface term excluded because Sami's interflow replaces it.
6. **Upstream inflow routed through a Sami RU is not touched.** Sami transmission losses apply only to
   the module's own runoff. "What comes in via the inflow route goes out via the outflow route(s)"
   (TT 689 p.42 §6.1.8.1). This is unlike Hughes.

Sami depths are **mm over the RU's catchment area** `AREA_km2` (L.002 var 1, the child area for an SFR
child). Volumes convert with `mm = Mm³ × 1000 / AREA_km2`.

## 2. Symbols, units and file mapping

Line numbers are those of TT 691 ch.12 (p.150–153). The variable names are the TT 691 §7.4 runoff
record (p.47–51).

### 2.1 Sami physical block (L.031–L.034)

| Symbol (TT 690/687) | Meaning | Unit | File | TT 691 name | TT 689 default (Table 9.1) |
|---|---|---|---|---|---|
| THICK | Aquifer thickness | m | L.031 v1 (F6.2) | `B8_AquiferThick` | 20 |
| Sy (S in eq. 8.13) | Storativity | – | L.031 v2 (F6.4) | `B9_Storativity` | 0.005 |
| CAP (TAS in TT 687) | Aquifer capacity = THICK·Sy·1000 | mm | derived | `B10_AquiferCap` | – |
| STORE₀ | Initial aquifer storage | mm | L.031 v3 (F6.2) | `B11_AquiferStor` | 0.9·CAP (45 if no info) |
| SWL | Static water level (storage at which baseflow, ET and outflow stop) | mm | L.031 v4 (F6.2) | `B13_StatWaterLevel` | 60 |
| PMAX | Unsaturated (percolating) storage capacity | mm | L.031 v5 (F6.2) | `D7_Unsat` | 20 |
| P₀ | Initial unsaturated storage | mm | L.032 v1 (F7.2) | `D8_STinit` | 10 (½ PMAX) |
| PPOW | Percolation power (<1) | – | L.032 v2 (F7.2) | `D13_PPOW` | 0.2 |
| GPOW | Recharge power | – | L.032 v3 (F7.2) | `D16_GPOW` | 3 |
| BFMAX | Maximum GW discharge rate | mm/month | L.032 v4 (F7.2) | `B21_MaxDischRate` | 2 |
| BPOW | GW/SW interaction power | 1/mm | L.032 v5 (F7.2) | `B22_GWSW_ICP` | −0.05 |
| HGSL | Soil moisture below which there is no recharge | mm | L.032 v6 (F7.2) | `B17_HGSL` | 0 |
| HGGW | Recharge at S = ST | mm/month | L.032 v7 (F7.2) | `D15_HGGW` | 2 |
| HGRAD | Maximum hydraulic gradient out of the catchment | – | L.033 v1 (F10.8) | `B23_MaxHydGrad` | 0.001 |
| T | Transmissivity | m²/d | L.033 v2 (F8.2) | `D21_Transmissivity` | 10 |
| x | Weighted borehole distance to river | m | L.033 v3 (F8.2) | `D22_DistToRiver` | 1000 |
| EVAREA | GW evaporation (riparian) area | km² | L.033 v4 (F8.2) | `B28_GWEvapArea` (`B28_GWEvapAreaFactor` = EVAREA/AREA) | 1 % of AREA |
| k2 | Abstraction curve parameter | – | L.034 v1 (F7.2) | `D24_K2` | 0.1 |
| k3 | Abstraction curve parameter | – | L.034 v2 (F7.2) | `D25_K3` | −3 |
| LAG | Interflow lag | months | L.034 v3 (F7.2) | `F28_Lag` | 0 |
| MMA (x) | Months over which recharge is averaged | months (int) | L.034 v4 (F7.2, written as an integer in practice) | `D9_MMA` | 2 |
| ABSON | Abstractions: 0 none, 1 annual pairs, 2 time-series file | int | L.034 v5 (I4) | `AbstractionsOn` | 0 |
| GWMAX | Maximum % of abstraction from storage | % | not in file, fixed at 100 | `D23_MaxFromGWperc` | 100 |

### 2.2 Pitman soil parameters used by Sami (L.035, the Sami calibration set)

| Symbol | Meaning | Unit | File | Note |
|---|---|---|---|---|
| POW | Interflow power | – | L.035 v1 (F3.1) | |
| SL | Soil moisture below which there is no interflow | mm | L.035 v2 (I5) | Interflow threshold only. Recharge uses HGSL (TT 687 Table 2: SL and HGSL are separate, both 5–20 % of ST) |
| ST | Soil moisture capacity | mm | L.035 v3 (I5) | Shared by interflow and recharge |
| FT | Interflow at S = ST | mm/month | L.035 v4 (F4.1) | |
| GW, GL | Pitman baseflow split and lag | – | L.035 v5, v10 | Forced to 0 in the run (§1) |
| ZMIN, ZMAX, PI, TL, R, FF | Unchanged Pitman meanings | | L.035 v6–v12 | Used by the Pitman core |

L.022 v2–v5 (HGSL, GPOW, TLGMax, HGGW) belong to **Hughes** and are ignored by Sami. Sami's own GPOW,
HGSL and HGGW sit on L.032.

### 2.3 Climate and abstraction inputs

| Symbol | Meaning | Unit | Source |
|---|---|---|---|
| S_i | Pitman soil moisture, month i | mm | Pitman core output, "Pitman S (Sami)" (TT 689 p.181). OQ-S4 says which instant |
| Q_i | Monthly runoff used for the surface-water head | mm | Pitman core runoff (OQ-S3) |
| RAIN_i | Monthly catchment rainfall | mm | `%MAP × MAP / 100` from the `.RAN` (TT 690 p.85 eq. 8.6 "RAIN") |
| E_m | Monthly evaporation (S-pan input on L.004) | mm | RU climate |
| APF_m | A-pan factors | – | L.040, 12 values (TT 691 p.153). TT 689 p.34–35 says WRSM2000 converts S-pan to A-pan internally and derives initial A-pan factors (OQ-S7) |
| NYGA, (year, Mm³/a) | Annual abstraction pairs, linearly interpolated by year | Mm³/a | L.036, L.037 (`GWAbst`); TT 689 p.45 |
| ABS series | Monthly abstraction time series (ABSON = 2) | Mm³/month (assumed) | Separate file in the format of other abstraction files (TT 689 p.45). Where its filename sits in the `.DAT` is not documented (OQ-S9) |

## 3. Equations (method 2)

All quantities are per month i, in mm over AREA, unless stated.

### 3.1 Interflow from the soil zone

```
SIF_i = FT · ((S_i − SL)/(ST − SL))^POW      if S_i > SL, else 0
```
TT 690 p.80 eq. 8.2 and p.88 eq. 8.12 (first term); TT 687 p.5 eq. 1. Clamp the ratio to [0, 1]
(S ≤ ST by the Pitman balance; TT 690 p.81 "error check ... S cannot rise above ST").

### 3.2 Potential recharge

```
RE_i = HGGW · ((S_i − HGSL)/(ST − HGSL))^GPOW   if S_i > HGSL, else 0
```
TT 687 p.6 eq. 2. TT 690 p.82 eq. 8.3 prints the same formula with "GW" and "SL". TT 687 and the file
(B17_HGSL, D15_HGGW) make the threshold and maximum separate parameters (OQ-S5).

### 3.3 Mean monthly recharge (pass 1)

```
REbar = (1/N) · Σ_{i=1..N} RE_i     over the whole simulation
```
TT 690 p.84 symbol "RE (overbar) = mean monthly recharge"; TT 691 p.51 (pass 1 "calculates the
average recharge"). Over all N months of the run, not per calendar month (OQ-S6).

### 3.4 Moving average of recharge

```
REx_i = mean(RE_{i−x+1}, …, RE_i),  x = MMA     (trailing window; fewer terms at the start)
```
TT 690 p.84 eq. 8.5 definitions ("moving average of recharge RE for x months (1–120 months)"); TT 687
p.8. Window alignment and start-up are not stated (OQ-S6).

### 3.5 Percolating store and percolation

Each month (TT 690 p.84–85 §8.3.6; TT 687 p.8–10 §2.6):
```
P ← P + RE_i
EXRECH_i = max(0, P − PMAX);   P ← P − EXRECH_i            (excess dumped straight to aquifer)
PERC_i  = REx_i · (P/PMAX)^PPOW · (REx_i / REbar)           TT 690 p.84 eq. 8.5; TT 687 p.8 eq. 3
PERC_i  = min(PERC_i, P);      P ← P − PERC_i               (Fig 8.2 "PERC ≤ P")
```
If REbar = 0 then PERC = 0. If PMAX = 0 there is no percolating store: every RE_i leaves as EXRECH_i
and PERC = 0 (R6-S1; eq. 8.5's P/PMAX is otherwise 0/0). A P₀ above PMAX leaves as EXRECH in month 1.
Whether P in eq. 8.5 is taken before or after adding RE_i is OQ-S8. The proposed order is the one
above, after adding RE and removing EXRECH.

### 3.6 Aquifer recharge and excess to interflow

```
STORE ← STORE + PERC_i + EXRECH_i
AQX_i  = max(0, STORE − CAP);   STORE ← STORE − AQX_i
AQRECH_i = PERC_i + EXRECH_i − AQX_i
```
TT 690 p.83 eq. 8.4 (`AQRECH = RE − (STORE − CAP)` if STORE > CAP); TT 690 p.88 eq. 8.12 second term;
TT 687 p.15 eq. 8 `(PERC + STORE − TAS)` with STORE before the increment; TT 687 p.16 §2.11.

### 3.7 Interflow and its lag

```
INTERFLOW_i = SIF_i + AQX_i                                  TT 690 p.88 eq. 8.12; TT 687 p.15 eq. 8
```
Lag by k = LAG months with the Pitman reservoir (Muskingum x = 0) routing, TT 687 p.15 eq. 9, in the
standard form of TT 690 p.4 eqs 1.14–1.16 with Δt = 1:
```
C1 = 1/(k + 0.5),  C2 = 0.5/(k + 0.5)
QLAG_i = QLAG_{i−1} + C1·(INTERFLOW_{i−1} − QLAG_{i−1}) + C2·(INTERFLOW_i − INTERFLOW_{i−1})
```
If k = 0, `QLAG_i = INTERFLOW_i` (no routing). TT 687's printed eq. 9 has typographical slips
(OQ-S10). Use the same routine as `src/runoff/lag.ts`, so the two lags cannot drift apart.

### 3.8 Groundwater evaporation

```
PETgw_m  = E_m · APF_m                                     (MAE·MDIST·CROP in TT 690)
f_i      = clamp((STORE − SWL)/(CAP − SWL), 0, 1)
ET_i     = max(0, PETgw_m − RAIN_i) · (EVAREA/AREA) · f_i
STORE   ← STORE − ET_i
```
TT 690 p.86 eq. 8.6; TT 687 p.10 eq. 4. The manual prints `(STORE − SWL/CAP − SWL)`. The prose
("maximum rate when groundwater storage is at aquifer capacity and declines towards 0 as groundwater
storage drops to ... static water level") fixes the intended bracketing. The "error check ... does not
become negative" gives the lower clamp. EVAREA/AREA turns the km² product into mm over the catchment
(B28_GWEvapAreaFactor).

### 3.9 Regional groundwater outflow

```
HG_i   = HGRAD · (STORE − SWL)/(CAP − SWL)                 TT 690 p.87 eq. 8.7; TT 687 p.11 eq. 5
OUT_i  = T · HG_i · Δt_days · W / (AREA·10⁶) · 1000        (mm)
STORE ← STORE − OUT_i
```
HG and OUT may be **negative**, drawing water in from neighbouring catchments when STORE < SWL
(TT 690 p.87). The manual gives the Darcian product "T × HG" and no flow width W or day count. The
proposed W = 4·√(AREA·10⁶) m and Δt = 30 d is a reconstruction (OQ-S11).

### 3.10 Baseflow and transmission losses

```
HEAD_i = STORE − SWL − Q_i                                   TT 690 p.87 eq. 8.9; TT 687 p.12 eq. 7
F_i    = sign(HEAD_i) · (1 − e^{BPOW·|HEAD_i|}) · BFMAX      TT 690 p.87 eq. 8.8; TT 687 p.12 eq. 6
if HEAD_i > 0:  GWBF_i = F_i;            STORE ← STORE − GWBF_i     (effluent)
if HEAD_i < 0:  TL_i = min(−F_i, Q_i);   STORE ← STORE + TL_i       (influent, "TL < Q")
```
The manual writes `(1 − e^{HEAD×BPOW})·BFMAX` without the sign/abs. Taken literally, that grows
without bound for HEAD < 0, but TT 690 Fig 8.8 shows an odd-symmetric curve that saturates at
±BFMAX (OQ-S12). `Q_i/AREA` in the manual is the runoff volume over the catchment area, which is
simply Q_i in mm.

Three provisional details of this step (Round 6, `aquifer.ts`; §8):

- The curve uses `−|BPOW|`, so a positive BPOW cannot turn the saturating curve into an unbounded
  one (R6-A6; TT 689 p.44: BPOW "should always be −0.05").
- A negative Q_i (the literal Muskingum lag can produce one, OQ-22) counts as 0 in HEAD and in the
  TL cap, so `0 ≤ TL ≤ Q` holds (R6-A5).
- TL is added to STORE with no capacity cap (TT 690 p.87), so STORE can end the month above CAP. The
  surplus then spills as AQX at the start of the next month, and that month's AQRECH can be negative
  (R6-A2, switchable).

### 3.11 Abstraction (ABSON ≠ 0, never in natural mode)

Monthly demand `ABS_i` (mm) comes from the interpolated annual value or the time series (OQ-S9). With
`ratio_i = PERC_i / PERCbar`, where PERCbar is the whole-record mean PERC from pass 2 (TT 691 p.51;
OQ-S13):
```
t_i  = t_{i−1} + (1 − ratio_i)·30      if ratio_i < 1           TT 690 p.90 eq. 8.14; TT 687 p.18 eq. 11
t_i  = t_{i−1} − (ratio_i − 1)·30      if ratio_i ≥ 1           TT 690 p.91 eq. 8.15; TT 687 p.18 eq. 12
t_i  = max(t_i, 0)                                                (days)
t'_i = 4·T·t_i / (x²·Sy)                                         TT 690 p.89 eq. 8.13
%GW_i = GWMAX / (1 + e^{k3 + k2·t'_i})                           TT 690 p.89 eq. 8.13; TT 687 p.16 eq. 10
DEP_i = (100 − %GW_i)/100 · ABS_i · ratio_i                       TT 690 p.91 eq. 8.16; TT 687 p.18 eq. 13
STORE ← STORE − (ABS_i − DEP_i)
if DEP_i ≤ GWBF_i: GWBF_i ← GWBF_i − DEP_i
else:              STORE ← STORE − (DEP_i − GWBF_i);  GWBF_i ← 0
```
"The balance of abstraction volumes (abstraction − depletion) is taken from STORE. Depletion is
subtracted from calculated groundwater baseflow ... If calculated baseflow depletion exceeds
GWBaseflow, the excess is removed from groundwater storage" (TT 690 p.91). t counts days since pumping
started. The rule for when it starts and resets is OQ-S14. TT 687 §2.13 eq. 14 also adds borehole-yield
curtailment (EXTINCT, SUPPLY). It has no field in the v7 file format (OQ-S15), so it is **off** by
default.

Eqs. 8.14 and 8.15 are one expression, `t_i = max(0, t_{i−1} + (1 − ratio_i)·30)`. TT 690 p.91 prints
eq. 8.15's condition as "> 1, t 13", a garbled fragment; nothing in it changes the reading. With
`ratio > 1` and a small %GW (late in pumping), eq. 8.16 gives DEP > ABS, and `STORE −= ABS − DEP`
adds the difference to STORE. That is the "rewatering" TT 690 p.91 describes ("allows the portion of
recharge above the mean monthly value to replenish the accumulated aquifer storage deficit"), so the
literal form is kept (R6-A1, switchable to DEP ≤ ABS). The output `fromStorage` is everything the
abstraction takes from STORE, `(ABS − DEP) + max(0, DEP − GWBF_gross)`, so
`ABS = fromStorage + (GWBF_gross − GWBF_net)` (R6-A3). It is negative in a rewatering month.

The clock already moves in the first month with ABS > 0: t goes from 0 to `max(0, (1 − ratio)·30)`
before %GW is computed (OQ-S14 as implemented; the §7 example cannot tell the readings apart because
its first pumping month has ratio > 1). Nothing floors STORE: heavy abstraction can take it below 0
(R6-A7). Below SWL, OUT turns negative and TL grows, so the aquifer then draws water in.

### 3.12 Module outputs

```
GWBF_net_i = GWBF_i (after depletion)
Qfinal_i   = Qsurface_i + QLAG_i + GWBF_net_i − TL_i          (OQ-S3)
```
Time series WRSM2000 can save for a Sami RU (TT 689 p.18 and p.181–182), which our outputs should match
by name:

- Pitman S
- weighted Pitman S (SFR parent)
- aquifer storage (STORE, mm)
- aquifer recharge (AQRECH, mm)
- groundwater baseflow (GWBF_net)
- interflow (QLAG)
- "groundwater outflows" (= baseflow + interflow, **not** the regional OUT)
- total recharge = AQRECH + interflow (mm)

Record names: `TS_SamiGWStorage`, `TS_Recharge`, `TS_AvGWStorage` (area-weighted for an SFR parent),
`TS_GroundwaterOutflow` (TT 691 p.50–51).

## 4. Order of operations

### 4.1 Run level

1. **Pitman core run** over the whole record for this RU, with the L.035 set and GW = GL = 0. It yields
   monthly `S_i`, `Q_i` and `Qsurface_i` (and the other Pitman outputs). The 4-substep soil loop is
   unchanged (`docs/theory/pitman.md`).
2. **Pass 1 (soil):** RE_i for all i, then REbar.
3. **Pass 2 (soil):** percolating store over all i, giving PERC_i and EXRECH_i, then PERCbar.
4. **Pass 3 (aquifer + interflow):** the monthly loop in §4.2 from STORE₀, then the interflow lag.
5. Assemble `Qfinal` and hand it to the RU's outflow routes (and, for an SFR parent/child, to the
   land-use reductions; Round 6.3/6.4).

The soil passes (2–3) depend only on S, so they are deterministic and independent of the aquifer.
The aquifer feeds back only through AQX (excess to interflow), which the soil side then lags.

### 4.2 Month i inside pass 3 (aquifer)

1. `STORE += PERC_i + EXRECH_i`; `AQX_i` = excess over CAP (§3.6).
2. Evaporation ET_i (§3.8).
3. Outflow OUT_i (§3.9).
4. HEAD, then baseflow GWBF_i or transmission loss TL_i (§3.10).
5. Abstraction: t, %GW, DEP, then update STORE and GWBF (§3.11).
6. Record STORE_i. `INTERFLOW_i = SIF_i + AQX_i` goes to the lag (§3.7).

Steps 2–4 follow TT 690 p.87 ("After evapotranspiration and groundwater outflow have been decremented
from groundwater storage, groundwater baseflow is calculated") and Fig 8.2. Step 5 follows §8.3.12.
Placing abstraction **after** baseflow is required by eq. 8.16, which subtracts depletion from the
already-computed GWBaseflow.

### 4.3 Relative to the Pitman steps

| Pitman step (TT 690 p.5–6 §1.9) | Sami module |
|---|---|
| Impervious runoff, interception, rain mass curve | unchanged |
| 4 sub-steps: surface runoff, soil balance, subsurface Q, evaporation | unchanged, with GW = 0; the subsurface FT term still drains S inside the Pitman balance (OQ-S2) |
| Lag: baseflow by GL, rest by TL | GL inert (GW = 0); everything Pitman produces is lagged by TL. Sami then **swaps** the lagged FT part for its own interflow (OQ-S3) |
| (after all months) | Sami passes 1–3 (§4.1) |

## 5. Invariants (for the unit tests)

- **Aquifer mass balance**, every month:
  `ΔSTORE = PERC + EXRECH − AQX − ET − OUT − GWBF_gross + TL − (ABS − DEP) − max(0, DEP − GWBF_gross)`.
  Because `GWBF_gross + max(0, DEP − GWBF_gross) = GWBF_net + DEP`, this is also
  `ΔSTORE = AQRECH − ET − OUT − GWBF_net + TL − ABS`: depletion only moves water from baseflow to
  the abstraction.
- **Percolating store balance:** `ΔP = RE − EXRECH − PERC`, with `0 ≤ P ≤ PMAX`.
- **Soil/aquifer accounting:** `Σ RE = Σ (PERC + EXRECH) + ΔP`;
  total recharge `= AQRECH + INTERFLOW` (TT 689 p.182).
- `0 ≤ TL_i ≤ Q_i`; `0 ≤ GWBF_i ≤ BFMAX`; `ET_i ≥ 0`; `STORE ≤ CAP` after step 1.
- With no abstraction and HGRAD ≥ 0, every loss term goes to 0 as STORE → SWL, so STORE should stay
  ≥ SWL once above it. This is a **soft** check, not an invariant. Each of the three loss steps is
  linear or sub-linear in `STORE − SWL` and can overshoot on its own:
  - ET cannot overshoot only if `(PETgw − RAIN)⁺·EVAREA/AREA ≤ CAP − SWL`;
  - OUT cannot overshoot only if `T·HGRAD·Δt·W/(AREA·10⁶)·1000 ≤ CAP − SWL` (OUT at HG = HGRAD);
  - baseflow cannot overshoot only if `BFMAX·|BPOW| ≤ 1`, since `1 − e^{−b·H} ≤ b·H` gives
    `GWBF ≤ HEAD ≤ STORE − SWL`.

  Assert it only for parameter sets that satisfy all three. Otherwise log any undershoot. (Corrected
  in Round 6: the earlier text named only the baseflow condition, but ET and OUT are taken first and
  each can overshoot alone.)
- `STORE ≥ 0` is **not** an invariant under abstraction (R6-A7).
- Zero rain (S below both SL and HGSL) ⇒ RE = SIF = 0, and the aquifer only recedes towards SWL.
- Natural mode ⇒ ABS ≡ 0.

## 6. Interface split for Round 6 (`soil.ts` ↔ `aquifer.ts`)

**Boundary:** everything that depends only on the Pitman S series lives in `soil.ts`. That is
interflow from the soil, recharge, the percolating store, the whole-record averages and the interflow
lag. Everything that depends on aquifer storage lives in `aquifer.ts`. Data crosses the boundary in
two places:

- **soil → aquifer:** per-month `aquiferInflow = PERC + EXRECH` (mm), plus `PERC` and `PERCbar` for the
  abstraction ratio.
- **aquifer → soil:** per-month `excessToInterflow = AQX` (mm), which `soil.ts` adds to SIF before
  lagging.

Both sides are pure, with no I/O. Depths are mm over the RU area and months are indices into the run.

```ts
// ---- shared ---------------------------------------------------------------
export type Mm = number;          // depth over the RU catchment area
export interface SamiCommon {
  areaKm2: number;                // L.002 v1 (child area for an SFR child)
}

// ---- soil.ts (agent 6.1) --------------------------------------------------
export interface SamiSoilParams {
  // L.035 (Sami calibration set)
  POW: number; SL: Mm; ST: Mm; FT: Mm;
  // L.032
  HGSL: Mm; HGGW: Mm; GPOW: number; PPOW: number; P0: Mm;
  // L.031 v5, L.034 v3–v4
  PMAX: Mm; MMA: number /* int ≥ 1 */; lag: number /* F28_Lag, months */;
}
export interface SamiSoilPass {
  re: Mm[];            // potential recharge RE_i               (§3.2)
  soilInterflow: Mm[]; // SIF_i                                 (§3.1)
  reX: Mm[];           // moving average REx_i                  (§3.4)
  exrech: Mm[];        // EXRECH_i                              (§3.5)
  perc: Mm[];          // PERC_i                                (§3.5)
  p: Mm[];             // percolating storage at month end
  reBar: Mm;           // pass-1 mean RE                        (§3.3)
  percBar: Mm;         // pass-2 mean PERC (abstraction ratio)  (§3.11)
}
/** Passes 1–2. Input: Pitman S per month (mm, OQ-S4). */
export function samiSoilPass(S: readonly Mm[], p: SamiSoilParams): SamiSoilPass;
/** Interflow assembly + lag. raw_i = soilInterflow_i + excessToInterflow_i. */
export function samiInterflow(
  soilInterflow: readonly Mm[], excessToInterflow: readonly Mm[], lag: number,
): Mm[];                                             // QLAG_i (§3.7)

// ---- aquifer.ts (agent 6.2) -----------------------------------------------
export interface SamiAquiferParams {
  thicknessM: number; storativity: number;          // CAP = thicknessM*storativity*1000
  store0: Mm; SWL: Mm;
  BFMAX: Mm; BPOW: number;
  HGRAD: number; T_m2d: number; evapAreaKm2: number;
  // abstraction
  k2: number; k3: number; distM: number; GWMAX: number /* = 100 */;
  // reconstruction constants (OQ-S11), exposed for the comparison harness
  outflowWidthFactor: number /* 4 */; daysPerMonth: number /* 30 */;
}
export interface SamiAquiferState { store: Mm; tDays: number; pumping: boolean }
export interface SamiAquiferInput {
  aquiferInflow: Mm;   // PERC_i + EXRECH_i   (from soil.ts)
  perc: Mm;            // PERC_i              (from soil.ts, abstraction ratio)
  percBar: Mm;         //                     (from soil.ts)
  runoffForHead: Mm;   // Q_i                 (Pitman core, OQ-S3)
  rain: Mm;            // RAIN_i
  petGw: Mm;           // E_m * APF_m          (OQ-S7)
  abstraction: Mm;     // ABS_i, already 0 in natural mode
}
export interface SamiAquiferOutput {
  excessToInterflow: Mm; // AQX_i  -> soil.ts
  aquiferRecharge: Mm;   // AQRECH_i
  et: Mm; outflow: Mm;   // ET_i, OUT_i (OUT may be < 0)
  baseflow: Mm;          // GWBF_net_i (after depletion)
  transmissionLoss: Mm;  // TL_i (≤ runoffForHead)
  depletion: Mm; fromStorage: Mm; pctFromGw: number;
  store: Mm;             // STORE at month end
}
export function samiAquiferInit(p: SamiAquiferParams): SamiAquiferState;
export function samiAquiferStep(
  s: SamiAquiferState, i: SamiAquiferInput, p: SamiAquiferParams,
): { state: SamiAquiferState; out: SamiAquiferOutput };
```

The thin composition (run Pitman, then `samiSoilPass`, loop `samiAquiferStep`, then `samiInterflow`,
then `Qfinal`) belongs in the RU runner (`src/runoff/**`). It needs one orchestrator-assigned file, for
example `src/groundwater/sami/index.ts`, so neither 6.1 nor 6.2 writes it. Both agents can test
against the §7 table without the other's module: 6.2 feeds the table's `aquiferInflow` column, and 6.1
checks its RE/PERC columns.

## 7. Worked example (method 2)

TT 690 §8.5 (Middle Letaba B82B) publishes the **parameters** (Fig 8.13, p.98) and the **long-term
balance** (Fig 8.17, p.103). It publishes no monthly series, and TT 687's verification studies give
only annual balances. So this example uses the **published B82B parameter set** with an **invented
6-month driving series**. It was computed with a throwaway script, not committed.

Parameters (TT 690 Fig 8.13): AREA = 406 km², THICK = 17 m, Sy = 0.009 ⇒ CAP = 153 mm, STORE₀ = 142,
SWL = 126, PMAX = 9, P₀ = 5, MMA = 2, FT = 4.2, POW = 3, SL = 180, ST = 800, HGGW = 4.5, GPOW = 1,
BFMAX = 2, BPOW = −0.05, HGRAD = 0.001, T = 10 m²/d, x = 20 m, EVAREA = 12 km², k2 = 0.1, k3 = −3,
LAG = 0. Assumed: HGSL = SL = 180 (the 2005 spreadsheet had one SL), PPOW = 0.2 (TT 689 default; not
shown in Fig 8.13). REbar = 19.337/12 = 1.61142 mm ("Est Recharge 19.34 mm/a", Fig 8.13). PERCbar =
18.58/12 = 1.5483 mm (virgin aquifer recharge, Fig 8.17). W = 4√A = 80 598 m, Δt = 30 d.

Invented inputs:

| m | S | RAIN | PETgw | Q (head) | Q surface | ABS |
|---|---|---|---|---|---|---|
| 1 | 520 | 60 | 150 | 3.0 | 2.3074 | 0 |
| 2 | 610 | 110 | 140 | 9.0 | 7.5989 | 0 |
| 3 | 690 | 150 | 145 | 40.0 | 37.6623 | 0 |
| 4 | 640 | 120 | 140 | 14.0 | 12.2847 | 0.8 Mm³ = 1.9704 mm |
| 5 | 420 | 70 | 120 | 4.0 | 3.7564 | 1.9704 |
| 6 | 380 | 25 | 105 | 2.0 | 1.8590 | 1.9704 |

(Q surface = Q − SIF here, a stand-in for the Pitman surface component.)

Soil side (`soil.ts`):

| m | RE | SIF | REx | EXRECH | PERC | P end |
|---|---|---|---|---|---|---|
| 1 | 2.4677 | 0.6926 | 2.4677 | 0 | 3.6407 | 3.8271 |
| 2 | 3.1210 | 1.4011 | 2.7944 | 0 | 4.6013 | 2.3468 |
| 3 | 3.7016 | 2.3377 | 3.4113 | 0 | 6.0484 (capped at P) | 0 |
| 4 | 3.3387 | 1.7153 | 3.5202 | 0 | 3.3387 (cap) | 0 |
| 5 | 1.7419 | 0.2436 | 2.5403 | 0 | 1.7419 (cap) | 0 |
| 6 | 1.4516 | 0.1410 | 1.5968 | 0 | 1.0985 | 0.3531 |

Month 1 by hand:

- RE = 4.5·(340/620)¹ = 2.46774.
- SIF = 4.2·(340/620)³ = 0.6926.
- P = 5 + 2.46774 = 7.46774 < 9, so EXRECH = 0.
- PERC = 2.46774·(7.46774/9)^0.2·(2.46774/1.61142) = 2.46774·0.96336·1.53141 = 3.6407.
- P = 3.8271.

(Round 6.1 recomputed this table at full precision. An earlier version rounded REbar to 1.6115 and
carried 4-dp intermediates, giving PERC 3.6406, 4.6012, 6.0485 and P 3.8272, 2.3469 in months 1–3;
the error was at most 1.3e‑4 mm. The aquifer table below still takes those earlier PERC values as
its inflow, so it is self-consistent but its months 1–3 inflows differ from the soil table by that
much.)

Aquifer side (`aquifer.ts`):

| m | STORE after inflow | AQX | f | ET | HG | OUT | HEAD | GWBF gross | TL | t (d) | %GW | DEP | STORE end |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 145.6406 | 0 | 0.7274 | 1.9350 | 0.000656 | 0.0391 | 14.6665 | 1.0394 | 0 | – | – | – | 142.6271 |
| 2 | 147.2283 | 0 | 0.7862 | 0.6972 | 0.000760 | 0.0453 | 11.4859 | 0.8738 | 0 | – | – | – | 145.6121 |
| 3 | 151.6606 | 0 | 0.9504 | 0 | 0.000950 | 0.0566 | −14.3960 | 0 | 1.0263 | – | – | – | 152.6303 |
| 4 | 153 | 2.9690 | 1 | 0.5911 | 0.000978 | 0.0583 | 12.3506 | 0.9215 | 0 | 0 | 95.26 | 0.2015 | 149.6602 |
| 5 | 151.4021 | 0 | 0.9408 | 1.3904 | 0.000889 | 0.0530 | 19.9588 | 1.2627 | 0 | 0 | 95.26 | 0.1051 | 146.8308 |
| 6 | 147.9293 | 0 | 0.8122 | 1.9205 | 0.000741 | 0.0441 | 17.9647 | 1.1854 | 0 | 8.72 | 0.12 | 1.3962 | 143.9942 |

Month 1 aquifer by hand:

- STORE = 142 + 3.6406 = 145.6406.
- f = 19.6406/27 = 0.72743.
- ET = (150 − 60)·(12/406)·0.72743 = 1.9350, so STORE = 143.7056.
- HG = 0.001·17.7056/27 = 0.00065576.
- OUT = 10·0.00065576·30·80 598/406·10⁶·1000 = 0.0391, so STORE = 143.6665.
- HEAD = 143.6665 − 126 − 3 = 14.6665.
- GWBF = (1 − e^{−0.73333})·2 = 1.0394, so STORE = 142.6271.

Months 3–6 exercise the other branches:

- **Month 3 (TL).** HEAD = −14.396 < 0, so TL = (1 − e^{−0.05·14.396})·2 = 1.0263 (≤ Q = 40),
  added to STORE.
- **Month 4 (aquifer full).** AQX = 2.9690 goes to interflow, which becomes 1.7153 + 2.9690 = 4.6844.
- **Months 4–5 (abstraction, PERC above mean).** ratio > 1, so t stays clamped at 0. %GW = 100/(1 + e^{−3}) = 95.26.
  - Month 4: DEP = 0.0474·1.9704·(3.3387/1.5483) = 0.2015. Net baseflow 0.7199. STORE loses 1.9704 − 0.2015.
- **Month 6 (dry).** ratio = 1.0985/1.5483 = 0.7095, so t = 0.2905·30 = 8.72 d.
  - t' = 4·10·8.72/(400·0.009) = 96.8, so %GW = 0.12 (a borehole 20 m from the river draws almost
    entirely on baseflow).
  - DEP = 0.9988·1.9704·0.7095 = 1.3962 > GWBF 1.1854, so baseflow = 0 and the excess 0.2108 also
    comes from STORE.

Final runoff (LAG = 0, so QLAG = INTERFLOW):

| m | INTERFLOW | GWBF net | TL | Qfinal |
|---|---|---|---|---|
| 1 | 0.6926 | 1.0394 | 0 | 4.0394 |
| 2 | 1.4011 | 0.8738 | 0 | 9.8738 |
| 3 | 2.3377 | 0 | 1.0263 | 38.9737 |
| 4 | 4.6844 | 0.7199 | 0 | 17.6890 |
| 5 | 0.2436 | 1.1576 | 0 | 5.1576 |
| 6 | 0.1410 | 0 | 0 | 2.0000 |

The mass balance (§5) closes to < 1e‑4 mm each month. `aquifer.test.ts` reproduces every column of
the aquifer table from the rounded `aquiferInflow` column to the printed precision. For a regression check against the source, the
B82B virgin balance in TT 690 Fig 8.17 has an exact aquifer identity: aquifer recharge 18.58 + TL 0.38
= GW baseflow 9.79 + ET 8.67 + outflow 0.50 (+ Δstorage −0.01) = 18.96 mm/a. That is the §5 balance
in annual form. Treat it as a structural check, not a number to reproduce, because the 1922–1996 S
series is not published.

## 8. Open questions

Each one gives the evidence, the readings and a **proposed default**. The orchestrator records its
resolutions in `docs/decisions.md`. Several can be settled empirically by Round 6.5 against the
reference network: no abstraction, LAG = 0, MMA 1–18, HGSL 0 or small, TL and ET active.

- **OQ-S1. Method selection.** TT 691 has `SamiModel` (p.48), and D7/D8/D13 double as method-1 Decay,
  Growth and InitBaseFlow vs method-2 Unsat, STinit and PPOW (p.48–49). No line in L.021–L.037 stores
  the method. TT 689 §6.1.9 (p.43) describes only S-driven (method 2) behaviour.
  *Readings:* (a) WRSM2000 always runs method 2; (b) the method is inferred from some other field.
  *Default:* (a). Parse L.031 v5, L.032 v1–v2 as PMAX, P₀, PPOW. Method 1 is spreadsheet-only and
  is not implemented in v1 (§9).
- **OQ-S2. Does Sami recharge drain Pitman S?** Hughes removes recharge from S inside the 4-step loop
  (TT 690 ch.7, TT 691 `RU_HGMoist`). For Sami, the three-pass note (TT 691 p.51), the "Pitman analysis
  is called first" note (p.123) and the validation with S from a Pitman run (p.186–187) all imply no
  feedback. But then RE is water added on top of the Pitman soil balance, and only the FT term is
  "swapped" (OQ-S3).
  *Readings:* (a) post-process, no feedback; (b) RE subtracted from S inside the Pitman steps.
  *Default:* (a). Round 6.5 compares both against the reference `.ANS` and records the winner.
- **OQ-S3. What is Q, and how is final runoff assembled?** TT 690 Fig 8.2 and TT 687 Fig 1 are
  truncated or ambiguous ("Surface Runoff = Q − GWBaseflow − Interflow − TL"). The HEAD runoff is "input
  of streamflow" (TT 690 p.87). The spreadsheet's column C was the naturalised flow from a Pitman-GW run
  (TT 691 p.186). TT 691 keeps `TS_SurfaceOutflow` ("component f, the surface flows", p.50).
  *Readings for Qfinal:* (a) Pitman surface component (FT term excluded) + lagged Sami interflow + net
  GW baseflow − TL; (b) Pitman total Q + GW baseflow − TL (interflow double-counted, unlikely).
  *Readings for HEAD:* (i) Pitman total Q; (ii) surface component.
  *Default:* (a) and (i), with Q and the surface component both lagged by TL as the Pitman core
  produces them. Highest-priority item for 6.5.
- **OQ-S4. Which S value per month?** The Pitman core updates S in 4 sub-steps. Sami's spreadsheet
  takes one S per month (the saved "Pitman S" series).
  *Readings:* end-of-month S; mean of the four sub-step values.
  *Default:* end-of-month S, the value written to the "Pitman S" time series.
- **OQ-S5. One SL or two?** TT 690 eq. 8.3 uses SL for recharge. TT 687 Table 2 and the file use HGSL.
  *Default:* recharge uses HGSL (L.032 v6), interflow uses SL (L.035 v2). Switch:
  `SamiSoilOptions.rechargeThreshold` (`HGSL` | `SL`), `groundwater/sami/soil.ts`.
- **OQ-S6. REbar and REx details.** Is REbar the mean over all months or per calendar month? Is the
  REx window trailing or centred, and what happens in the first x − 1 months?
  *Default:* REbar = mean of RE over the whole run (per the three-pass note). REx is the trailing mean
  including month i, over the available months at the start. A centred window would need future S,
  which a monthly spreadsheet can do but the text never suggests. Switch:
  `SamiSoilOptions.rechargeAverageStart` (`available` | `zeroPadded`, the latter dividing the first
  windows by MMA as if the months before the run had no recharge).
- **OQ-S7. Groundwater PET.** TT 690 builds it from MAE·MDIST·CROP (A-pan). WRSM2000 stores S-pan
  monthly evaporation (L.004) and A-pan factors (L.040), and converts S→A "internally" without saying
  how (TT 689 p.34–35).
  *Default:* PETgw_m = E_m × APF_m. The A-pan factors are taken to already include the conversion,
  since WRSM2000 derives their initial values from the S-pan data. RAIN = gross catchment rain
  (%MAP × MAP). 6.5 to verify.
- **OQ-S8. P in eq. 8.5: before or after RE?**
  *Default:* after adding RE_i and removing EXRECH_i, then cap PERC at P (§3.5). Alternative: P_{i−1}.
  Switch: `SamiSoilOptions.percolationStorage` (`afterRecharge` | `previous`); either way PERC is
  capped at the month's store after EXRECH.
- **OQ-S9. Abstraction inputs.** Is the annual value (Mm³/a) spread evenly (/12), or by a monthly
  pattern? `AD35_GWAbstraction(12)` exists in the record but no Sami line holds 12 values. For
  ABSON = 2, where is the time-series filename and what is its unit? TT 691 §11.21 also reports WR2005
  files with abstraction pairs but ABSON = 0.
  *Default:* annual/12 per month, after linear interpolation by hydrological year. Unit Mm³. For
  ABSON = 0 with NYGA > 0, read the pairs (as the "old version" did) but don't apply them unless the
  run mode enables abstractions. File location deferred to `docs/formats.md` (agent 1.4).
- **OQ-S10. Interflow lag formula.** TT 687 eq. 9 prints
  `+[(1/(GL+0.5))·0.5] + (INTERFLOW − QLAG_{t−1})`, which has a "+" where a product belongs and
  `QLAG_{t−1}` where `INTERFLOW_{t−1}` belongs. It also names GL, though Sami's lag is F28_Lag
  (GL is forced to 0).
  *Default:* the standard x = 0 Muskingum of TT 690 eqs 1.14–1.16 with k = F28_Lag, as in §3.7, with
  k = 0 ⇒ no routing. Share `lag.ts` and follow whatever sign `docs/theory/pitman.md` settles for
  eq. 1.14.
- **OQ-S11. Outflow width and days.** Eq. 8.7 gives HG. "T × HG" needs a flow width and a time to
  become a depth. B82B's published balance (outflow 0.50 mm/a at T = 10, HGRAD = 0.001, A = 406 km²)
  is impossible with W = √A (maximum 0.18 mm/a) and consistent with W = 4√A at a mean HG/HGRAD ≈ 0.69.
  C24C (Fig 8.12: 0.41 mm/a, T = 3000, HGRAD = 6e‑6, A = 1585 km²) also needs W ≥ 2.5√A.
  *Default:* W = 4√A (perimeter of an equivalent square), Δt = 30 days (the constant eq. 8.14 uses).
  Exposed as constants and fitted by 6.5 if outflow shows up in the reference balance.
- **OQ-S12. Sign and symmetry of eq. 8.8.** Taken literally, `(1 − e^{HEAD·BPOW})·BFMAX` is unbounded
  for HEAD < 0. Fig 8.8 (BFMAX = 8, CAP − SWL = 40) is odd-symmetric and saturating. Its plotted points
  (head 23 → 5.5 mm) match `(1 − e^{−0.05·23})·8 = 5.47`. The figure's caption calls the positive branch
  "influent". TT 687 p.12 says "if head is positive, transmission losses occur". Both contradict the
  prose (GW above SW ⇒ baseflow).
  *Default:* odd-symmetric `sign(H)·(1 − e^{BPOW|H|})·BFMAX`, with HEAD > 0 ⇒ baseflow out of STORE and
  HEAD < 0 ⇒ TL into STORE, capped at Q. The physics in both reports' prose wins over the captions.
- **OQ-S13. "Recharge or PERC" in eqs 8.14–8.16 and its mean.** Method 2 uses PERC. Is "mean monthly
  recharge" REbar or mean PERC? Eq. 8.15's condition prints "Recharge_i" only.
  *Default:* PERC_i / PERCbar throughout, with PERCbar from pass 2 (TT 691's "second loop calculates
  the average percolation"). If PERCbar = 0, ratio = 0.
- **OQ-S14. Pumping clock.** When does t start, and does it reset? Eq. 8.14 lets t decrease. Nothing
  bounds it.
  *Default:* t = 0 until the first month with ABS > 0, then evolve by eqs 8.14/8.15 every month
  (including months where ABS = 0 after pumping started), with t ≥ 0 and no reset. Units: days.
- **OQ-S15. Borehole-yield curtailment (TT 687 §2.13 eq. 14).** It was added in WR2012, but EXTINCT and
  SUPPLY have no field in L.031–L.037 (file version 7). As printed, eq. 14 is dimensionally
  inconsistent; the intended form is clearly
  `CURTAILQ = clamp((STORE − EXTINCT·CAP)/((SUPPLY − EXTINCT)·CAP), 0, 1)·GWQ`.
  *Default:* not implemented in v1 (no parameters to read). Document as a departure if a future file
  version carries it.
- **OQ-S16. k2/k3 labels.** TT 690 p.90 and TT 687 p.17 say "k2 = −3 to −8". The parameter tables
  (TT 690 Table 8.1, TT 687 Table 2) give K2 0.05–0.5 and K3 negative. TT 689 and the reference files
  use K2 = 0.1, K3 = −3.
  *Default:* the table convention `%GW = GWMAX/(1 + e^{k3 + k2·t'})` with k2 > 0 and k3 < 0, which
  gives ≈ 95 % from storage at t' = 0.
- **OQ-S17. Initial states and warm-up.** Is there a warm-up run like Hughes? Nothing says so. The
  reference files set STORE₀ = SWL and P₀ = ½ PMAX.
  *Default:* single pass from STORE₀ and P₀ as read. QLAG₀ = INTERFLOW₀, i.e. the lag reservoir
  starts in steady state at the first month's interflow. Switch (lag only):
  `SamiInterflowOptions.initialLagState` (`steady` | `zero`, the classic OQ-24 dry start).
- **OQ-S18. SFR parent/child.** WRSM2000 computes Sami for parent and child modules separately
  (TT 689 p.182), and `TS_AvGWStorage` is the area-weighted parent storage (TT 691 p.51). How a child's
  land-use reduction interacts with its Sami flows is ch.11/12 territory.
  *Default:* run Sami per module on that module's own area and parameters. Round 6.3/6.4 own the
  reduction coupling.
- **R6-A1. Depletion above the abstraction** (§3.11). Eq. 8.16 lets DEP exceed ABS when ratio > 1
  and %GW is small. *Default:* literal, with the surplus returned to STORE (TT 690 p.91 "rewater").
  *Option:* `depletionCap: 'abstraction'` (DEP ≤ ABS).
- **R6-A2. TL above capacity** (§3.10). TT 690 p.87 adds TL to STORE with no cap. *Default:* literal
  (TL ≤ Q only), and the surplus spills as next month's AQX. *Option:*
  `transmissionLossCap: 'runoffAndCapacity'` (TL ≤ min(Q, CAP − STORE)).
- **R6-A3. Meaning of `fromStorage`.** Not defined by the manuals. *Default:* everything the abstraction
  takes from STORE, `(ABS − DEP) + max(0, DEP − GWBF_gross)`; `%GW` is reported as `pctFromGw`, and
  is 0 before pumping starts.
- **R6-A4. Missing CAP ≤ SWL guard.** The storage factor divides by CAP − SWL; WRSM2000 refuses
  CAP ≤ SWL (TT 691 p.209 item 83). *Default:* `samiAquiferInit` and the step throw a `RangeError`.
- **R6-A5. Negative runoff for the head** (§3.10). *Default:* `max(0, Q)` in HEAD and in the TL cap.
- **R6-A6. Sign of BPOW** (§3.10). *Default:* the curve uses `−|BPOW|`. No option: the file value is
  −0.05 everywhere the manuals mention it.
- **R6-A7. STORE below zero.** TT 690 p.91 takes `ABS − DEP` and any excess depletion from STORE with
  no lower bound. TT 687 eq. 14's curtailment is the only limit in the manuals, and OQ-S15 turns it
  off. TT 691 p.209 item 78 ("Aquifer storages have no zeroes unlike before which incorrectly showed
  negatives") hints that WRSM2000's storages can go negative but doesn't settle it. *Default:* no
  floor (literal). *Alternative:* clamp at 0 and report the unmet abstraction, which needs a contract
  output field. 6.5 to check any abstraction network.
- **R6-A8. Input guards.** Beyond R6-A4, the step throws a `RangeError` for storativity ≤ 0 or
  borehole distance ≤ 0 (eq. 8.13 divides by x²·S), for an evaporation area outside [0, AREA], and
  for a negative or non-finite ABS (a demand, never a supply).
- **OQ-S19. Table 8.1 typography.** The Table 8.1 caption (TT 690 p.92) says method-2-only parameters
  are in italics and method-1-only ones underlined. At 100 and 140 dpi renders, no row is visibly
  italic or underlined. So the method split here comes from the prose and TT 691's per-method variable
  comments, not the typography. Nothing to decide unless a better scan disagrees.

- **R6-S1. PMAX = 0.** Eq. 8.5 divides by PMAX. *Default:* no percolating store; all RE goes to the
  aquifer as EXRECH and PERC = 0 (the limit of the dump rule). PMAX < 0 or P₀ < 0 is an invalid
  parameter and the soil pass throws (R2-2).
- **R6-S2. Reading MMA.** L.034 v4 is F7.2 but means a whole number of months (TT 690 p.84 "1–120
  months"). *Default:* the nearest integer; a value below 1 after rounding makes the soil pass throw
  (R2-2) rather than being silently raised to 1.

## 9. Method 1 (hydrograph separation), for reference

Method 1 drives the same aquifer from a **separated baseflow hydrograph** instead of Pitman S
(TT 690 p.76–80, Fig 8.1):

1. **Herold separation** (TT 690 p.79 eq. 8.1): `Qg_i = Qg_{i−1}·Decay + Q_{i−1}·PG`, with
   0 < Decay < 1 (`D7_Decay`), PG the growth fraction (`D8_GrowthPerc`) and initial baseflow
   `D13_InitBaseFlow`. Qg ≤ Q.
2. **Back-calculate S** by inverting eq. 8.2: `S = SL + (ST − SL)·(Qg/FT)^{1/POW}`, with S ≤ ST
   (TT 690 p.80–81).
3. RE from S by eq. 8.3 (with GPOW ≈ POW), added **directly** to STORE. There is no percolating store.
   The excess over CAP is lost (TT 690 p.83 eq. 8.4).
4. ET, outflow, baseflow/TL and abstraction exactly as §3.8–3.11, with "Recharge" (not PERC) in the
   abstraction ratio. GWBaseflow ≤ Qg (TT 690 p.88).
5. Interflow: `VIRGIN INTERFLOW = Qg − GWBaseflow` (eq. 8.10). Under abstraction,
   `INTERFLOW = VIRGIN INTERFLOW − EXCESS1 + EXCESS2` (eq. 8.11), where EXCESS1 and EXCESS2 are the
   over-capacity recharge in the virgin and modified runs. It is lagged by GL (TT 690 p.89).

Method 1 needs an observed or simulated flow series as **input**, so it cannot run inside a rainfall-runoff
network. It is listed for completeness and is out of scope for v1 (OQ-S1).
