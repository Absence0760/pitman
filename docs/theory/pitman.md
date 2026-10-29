# Classic Pitman runoff module

Spec for the **classic Pitman** rainfall-runoff calculation inside a WRSM2000 runoff
(RU) module: groundwater model `0` on line L.022 (TT 691 p.150), or any RU file
older than version 3. It is written so that `src/runoff/pitman.ts`,
`src/runoff/rain.ts` and `src/runoff/lag.ts` (Round 2, agent 2.4) can be coded
without opening the PDFs.

## Sources and how to cite them

| Short name | Report | Used for |
|---|---|---|
| TT 690 | WRC TT 690/16, *WRSM/Pitman Theory Manual*, ch.1 "Runoff module (prior to 2005 enhancements)", book pp.1–8 (PDF pp.14–21) | every equation below |
| TT 691 | WRC TT 691/16, *Programmer's Code Manual*, §7.4 Runoff_Type (pp.37–46), §7.4.4 methods (pp.47–63), §12.1 runoff file (pp.146–151) | variable names, field formats, array shapes that hint at how the code is organised |
| TT 689 | WRC TT 689/16, *User Manual*, §2.5 time-series list (p.13), ch.6 runoff dialogs (pp.38–142), ch.9 defaults (Table 9.1, p.172), ch.10 calibration (Table 10.1, p.178) | parameter meanings, defaults, sentinel values |
| HRU 2/73 | Pitman, W.V. (1973) *A mathematical model for generating monthly river flows from meteorological data in South Africa*, HRU Report 2/73 | cited by TT 690 for derivations; **not** read for this spec |

Citations use **book** page numbers (`TT 690 p.4 eq. 1.13`). PDF page = book
page + 13 for TT 690. The equations in TT 690 are images in a symbol font;
`pdftotext` drops or garbles them, so every equation here was read from page
renders (100 dpi, with 250 dpi crops for eqs. 1.4, 1.10, 1.11, 1.14, 1.18 and 1.19).

Where a proposal below relies on general knowledge of the Pitman model as
published elsewhere (Pitman 1973; Hughes' descriptions of the Pitman model
in SPATSIM and related papers) rather than on TT 689/690/691, it says
"*(literature, not these manuals)*".

## What the module does, in one paragraph

Each month the module takes catchment rainfall (MAP × the month's % of MAP),
removes runoff from the impervious (paved) fraction, computes a monthly
interception loss, splits the month's rainfall into 4 sub-steps along a
synthetic S-shaped mass curve, and for each sub-step runs a single soil-moisture
store: surface runoff from a triangular distribution of absorption rates, the
rest infiltrates; subsurface flow is a power function of soil moisture;
evaporation is a linear function of soil moisture; any overflow above capacity
(SPILL) becomes runoff. Subsurface flow up to `GW` (plus a `GW/FT` share of SPILL)
is the slow "baseflow" component; everything else is the fast component. After
the time loop each component's monthly totals are lagged with a Muskingum
(x = 0) reservoir, `GL` for the slow one and `TL` for the fast one, summed, and
converted from mm to million m³.

---

## 1. Symbols, units, file fields and TT 691 names

RU `.DAT` line types are from TT 691 §12.1 (pp.147–151). "L.003 v4" = 4th
value on line type 3. Fortran field formats in brackets.

### 1.1 Module data

| Symbol | Meaning | Units | RU `.DAT` field | TT 691 §7.4 name |
|---|---|---|---|---|
| `AREA` | catchment area | km² | L.002 v1 (F7.1) | `AREA` |
| `MAP` | catchment mean annual precipitation | mm/yr | L.002 v2 (**I4**: integer) | `PMEAN` |
| — | rainfall file (`.RAN`, % of MAP per month) | — | L.002 v3 (C100) | `NPU` (raingauge object) |
| `SPAN(m)` | mean monthly Symons-pan evaporation, m = Oct…Sep | mm/month | L.004 v1–12 (F4.0), **October first** | `SPAN(12)` |
| `SPF(m)` | monthly pan factor, Oct…Sep | – | L.005 v1–12 (F4.2) | `SPF(12)` |
| `AI(y)` | impervious ("paved") fraction of the catchment in year y | fraction 0–1 | L.016 `NYRP`; L.017 years (I4); L.018 values (F6.3) | `Paved(YearValue)`, `NYRP` |

### 1.2 Calibration parameters (classic set, L.003)

L.003 is the parameter set for the classic Pitman GW model. L.023 (Hughes)
and L.035 (Sami) hold separate sets with the same 12 fields; the program keeps
one array per GW model (`A_POW(NGWMODELS)` …) and copies the active one into
the scalars below (`RU_LoadParameters`, TT 691 p.41). **This module reads L.003.**

| # | Symbol | Meaning (TT 690 / TT 689 Table 10.1) | Units | L.003 field | TT 691 name | TT 689 Table 9.1 default |
|---|---|---|---|---|---|---|
| 1 | `POW` | power of the Q–S curve | – | v1 (F3.1) | `POW` | 3 |
| 2 | `SL` | soil moisture below which no subsurface runoff occurs | mm | v2 (I5) | `SL` | 0 |
| 3 | `ST` | total soil moisture capacity | mm | v3 (I5) | `ST` | 150 |
| 4 | `FT` | subsurface runoff at S = ST | mm/month | v4 (F4.1) | `FT` | 20 |
| 5 | `GW` | maximum baseflow rate (subsurface flow treated as baseflow) | mm/month | v5 (F4.1) | `GW` | 0 |
| 6 | `ZMIN` | minimum catchment absorption rate | mm/month | v6 (I5) | `ZMIN` | 999 |
| 7 | `ZMAX` | maximum catchment absorption rate | mm/month | v7 (I5) | `ZMAX` | 999 |
| 8 | `PI` | interception storage | mm | v8 (F4.1) | `PI` | 1.5 |
| 9 | `TL` | lag of surface runoff and subsurface flow above GW | months | v9 (F4.2) | `TL` | 0.25 |
| 10 | `GL` | lag of baseflow (subsurface flow ≤ GW) | months | v10 (F5.2) | `GL` | 2.5 |
| 11 | `R` | evaporation–soil moisture coefficient, 0 ≤ R ≤ 1 | – | v11 (F3.1) | `R` | 0.5 |
| 12 | `FF` | forest factor: multiplier on PE (see OQ-14) | – | v12 (F5.2) | `FF` | 1.00 (read-only) |

### 1.3 Derived quantities and state

| Symbol | Meaning | Units | TT 691 name |
|---|---|---|---|
| `NOFT` | time steps per month, fixed at 4 (TT 690 p.1: "NIT was subsequently fixed at a value of 4") | – | `NOFT` |
| `DT` | fraction of a month per time step = 1/NOFT = 0.25 | month | `DT` |
| `P` | catchment rainfall for the month | mm | — |
| `PE(m)` | potential evaporation for calendar month m | mm/month | `PE(12)` |
| `PEMAX` | maximum monthly PE (OQ-13) | mm/month | — |
| `b(m)`, `c(m)` | evaporation coefficients per calendar month (eqs. 1.18, 1.19) | 1/month, mm/month | `B(12)`, `C(12)` |
| `A` | `FT / (ST − SL)^POW`, so `Q = A (S − SL)^POW` | – | `A` ("coefficient in soil moisture / subsurface flow equation") |
| `GFRACT` | `GW / FT`, the share of SPILL sent to baseflow (step 9) | – | `GFRACT` ("groundwater fraction of subsurface flow") |
| `a`, `b_I` | interception constants (eqs. 1.6, 1.7). Written `b_I` here to avoid a clash with evaporation `b` | mm, 1/mm | — |
| `S` | soil moisture storage | mm | `S1` |
| `FG1` | current (routed) baseflow, the GL reservoir's outflow state | mm/month | `FG1` |
| `FI1` | current (routed) fast flow ("interflow"), the TL reservoir's outflow state | mm/month | `FI1` |
| — | total catchment runoff | mm | `TFLOW` |

The names `A`, `GFRACT`, `FG1`, `FI1` and their roles are inferred from the
TT 691 comments (pp.38–41) and from `HGA = FT / (ST − 0.00) ** POW`, which TT 691
p.45 gives explicitly for the Hughes analogue. They are only hints about code
organisation; nothing below depends on them.

---

## 2. Equations (TT 690 ch.1, transcribed)

Plain-text maths; `^` is power, `e^x` is exp(x).

### 2.1 Rainfall disaggregation (§1.2, TT 690 pp.1–2)

`P` = total precipitation for the month (mm). `W` = maximum deviation of cumulative
rainfall above and below the line representing the average rate (mm).

```
W = −2 + 1.3732 (P + 1.6)^0.8                          TT 690 p.1 eq. 1.1
y = x^n / (x^n + (1 − x)^n)                            TT 690 p.1 eq. 1.2
n = 1.28 / (1.02 − W/P)^1.49                           TT 690 p.2 eq. 1.3
```

* `y` = cumulative precipitation / total precipitation; `x` = cumulative time /
  total time (fraction of the month); `n` = exponent related to W.
* The manual prints the left side of 1.3 as capital `N`; it is the same `n`
  as in 1.2 (TT 690 p.1 lists "n = exponent related to W").
* Properties to test: `W(0) ≈ 0` (−1.4e−6) and `W ≈ P` for very small falls
  (W'(0) = 1.000), so `W/P < 1.02` for all P > 0 and n is finite. y(0.5) = 0.5
  for every n (the curve is symmetric), so the two halves of the month always
  get equal rain. n = 1 gives uniform rain; n → ∞ concentrates the rain in the
  middle of the month.

Reference values (computed): P = 90 → W = 48.9624353694, n = 3.8691217634;
P = 30 → W = 19.7512119773, n = 5.8264311144; P = 1 → n = 66.25; P = 400 → n = 2.68.

### 2.2 Catchment rainfall (§1.3, TT 690 p.2)

```
PC = 100 × [Σ (P_n / M_n)] / N                         TT 690 p.2 eq. 1.4
```

`P_n` = monthly rainfall at gauge n; `M_n` = MAP of gauge n; `N` = number of gauges;
`PC` = catchment rainfall as % of its MAP. The printed equation has lost the
Σ (verified on a 250 dpi render: `100 × [(Pn / Mn)] / N`); it must be a sum
over gauges, since it is divided by N and described as equal weighting.

WRSM2000 does not apply eq. 1.4 itself: the `.RAN` file already holds `PC` per
month (hydrological year rows, October first). The model converts it to mm
"by application of the appropriate MAP" (TT 690 p.2):

```
P = PC × MAP / 100                                     (TT 690 p.2, text after eq. 1.4)
```

with `MAP` from L.002 v2. This is the hook that method A (CHIRPS extension) and
method B (sub-division) in issue #3 rely on: every piece of a split quaternary
uses the same `PC` series with its own `MAP`.

### 2.3 Interception (§1.4, TT 690 pp.2–3)

```
I = a (1 − e^(b_I P))                                  TT 690 p.2 eq. 1.5
a = 13.08 PI^1.14                                      TT 690 p.3 eq. 1.6
b_I = 0.00099 PI^0.75 − 0.011                          TT 690 p.3 eq. 1.7
```

`I` = total interception for the month (mm); `P` = total precipitation for the
month (mm); `PI` = interception storage (mm), valid range 0–10 mm (TT 690 p.2).
Assumptions (TT 690 p.2): each rain-day is one event, and interception storage
dries out completely between rain-days.

* `b_I < 0` for every `PI < 24.9`, so `I` rises towards the asymptote `a`.
* Check against TT 690 Fig. 1.3 (p.7): PI = 4 → a = 63.53, I(100) = 35.55 (figure
  ≈ 36); PI = 8 → asymptote ≈ 140 (figure ≈ 128 at P = 400, still rising). ✓
* PI = 1.5: a = 20.7659488200, b_I = −0.0096581510.

### 2.4 Surface runoff (§1.5, TT 690 pp.3–4)

Two components:

1. **Impervious area**: catchment rainfall × the impervious fraction `AI`. `AI`
   was originally fixed; it can now vary in time "to reflect the growth of
   urbanized areas" (TT 690 p.3). In WRSM2000 this is the paved-area year table
   (L.016–L.018). See OQ-17, OQ-18.
2. **Rainfall not absorbed by the soil**: absorption rate varies across the catchment
   with a symmetrical triangular frequency distribution between `ZMIN` and `ZMAX`
   (TT 690 Fig. 1.4, p.8).

```
Zave = (ZMIN + ZMAX) / 2                               TT 690 p.3 eq. 1.8
```

With `r` = rainfall (mm) and `Surf` = surface runoff (mm):

```
Case 1  r < ZMIN            Surf = 0                                              eq. 1.9  (p.3)
Case 2  ZMIN < r < Zave     Surf = 2 (r − ZMIN)^3 / [3 (ZMAX − ZMIN)^2]             eq. 1.10 (p.3)
Case 3  Zave < r < ZMAX     Surf = r − Zave + 2 (ZMAX − r)^3 / [3 (ZMAX − ZMIN)^2]  eq. 1.11 (p.4)
Case 4  r > ZMAX            Surf = r − Zave                                       eq. 1.12 (p.4)
```

* **Erratum, eq. 1.10:** the printed text reads `2(r Zmin)^3`, without the minus
  sign (confirmed on a 250 dpi render). The correct form is `(r − ZMIN)^3`: it is
  the expected excess `E[(r − Z)+]` over the triangular density, it is continuous
  with case 1 at r = ZMIN (= 0) and with case 3 at r = Zave (both give
  `(ZMAX − ZMIN)/12`), and case 3 is consistent with it.
* Eq. 1.11's denominator is printed `3(Zmax − Zmin)2`; the `2` is an exponent, as in 1.10.
* All four cases are one continuous, convex, non-decreasing function of r, with
  `0 ≤ Surf ≤ r`. The case boundaries can use `≤` either way.
* `ZMIN`, `ZMAX` and `Zave` are **rates in mm/month** (TT 690 p.3; TT 689 Table 10.1
  calls ZMIN the "minimum rainfall intensity required to initiate surface runoff").
  `r` must therefore be a rate in the same units when compared; see OQ-5.
* `ZMIN = ZMAX = 999` is the documented sentinel for "all rainfall is absorbed
  into the ground" (TT 689 Table 10.1, p.178; Table 9.1 default). See OQ-6.

Reference values (ZMIN = 0, ZMAX = 500, rates in mm/month): Surf(100) = 2.6666667
(case 2), Surf(250) = 41.6666667 (boundary), Surf(300) = 71.3333333 (case 3),
Surf(600) = 350 (case 4); ZMIN = 50: Surf(40) = 0 (case 1).

### 2.5 Subsurface runoff (§1.6, TT 690 p.4)

```
Q = FT [(S − SL) / (ST − SL)]^POW                      TT 690 p.4 eq. 1.13
```

`Q` = subsurface runoff (mm, a monthly rate: TT 690 Fig. 1.5 labels it mm/month);
`S` = actual soil moisture (mm). Q = 0 for S ≤ SL (TT 690 Fig. 1.5 shows zero
flow below SL). TT 689 Table 10.1: POW "should only be values of 1, 2 or 3".

**Baseflow split** (TT 690 p.4): "If the soil moisture is such that Q is less than
GW the associated runoff is considered to be all baseflow and is lagged
accordingly. If the storage is such that Q is greater than GW the remainder
(Q − GW) is lagged to a much smaller degree than the baseflow component." So:

```
Q_base = min(Q, GW)          lagged with GL
Q_fast = Q − Q_base          lagged with TL
```

GW = 0 means there is no baseflow component (TT 689 Table 10.1: "If GW=0 there is
only an upper zone").

### 2.6 Time delay of runoff (§1.7, TT 690 pp.4–5)

Muskingum with weighting factor x = 0 ("reservoir-type routing"):

```
O2 = O1 + C1 (I1 − O1) + C2 (I2 − I1)                  TT 690 p.4 eq. 1.14  (sign corrected, see erratum)
C1 = Δt / (k + 0.5 Δt)                                 TT 690 p.4 eq. 1.15
C2 = 0.5 Δt / (k + 0.5 Δt)                             TT 690 p.4 eq. 1.16
```

`O` = monthly runoff at the catchment outlet (mm); `I` = "instantaneous" monthly
runoff (mm), i.e. the un-lagged monthly total of a component; `Δt` = routing
period ("normally one month"); `k` = lag (months). Subscript 1 = previous month,
2 = current month (TT 690 p.5).

* **Erratum, eq. 1.14:** the manual prints `− C2 (I2 − I1)` (confirmed at 250 dpi).
  Standard Muskingum with x = 0 is `O2 = c0 I2 + c0 I1 + c2' O1` with
  `c0 = Δt/(2k + Δt)` and `c2' = (2k − Δt)/(2k + Δt)`. Rearranged, that is
  exactly `O1 + C1 (I1 − O1) + C2 (I2 − I1)` with C1, C2 as in 1.15–1.16. The
  printed minus sign gives a negative outflow for any rise in inflow from a
  dry start (I1 = O1 = 0, I2 > 0 → O2 = −C2 I2), and with k = 0 it does not
  reduce to `O = I`. The plus sign does both correctly. Proposed in OQ-21.
* Two components with different k (TT 690 p.5): "All runoff from soil moisture
  that is equal to or less than GW is assigned a 'k' value equal to GL and all
  remaining runoff is assigned a somewhat shorter lag with k = TL (i.e. TL << GL)."
  TT 689 Table 10.1 says TL is the "lag of surface runoff and subsurface flow from
  the upper zone", so surface runoff goes through the TL reservoir too.
* Δt = 1 month: GL = 2.5 → C1 = 1/3, C2 = 1/6; TL = 0.25 → C1 = 4/3, C2 = 2/3.

### 2.7 Evaporation from soil moisture (§1.8, TT 690 p.5)

E = PE when S = ST. E is linear in S, reaching zero at some minimum S. The slope
lies between two limits set by `R` (0 ≤ R ≤ 1): R = 0 → `E/PE = S/ST`; R = 1 → every
month's E–S line has slope `PEMAX/ST`, where PEMAX is "the maximum monthly
potential evaporation" (TT 690 Fig. 1.6, p.8).

```
E = b S + c                                            TT 690 p.5 eq. 1.17
b = PE / [ST (1 − R (1 − PE/PEMAX))]                   TT 690 p.5 eq. 1.18
c = PE − PE / [1 − R (1 − PE/PEMAX)]                   TT 690 p.5 eq. 1.19
```

* Checks: `b·ST + c = PE`; E = 0 at `S0 = −c/b = R·ST·(1 − PE/PEMAX)`; R = 0 gives
  `b = PE/ST, c = 0`; R = 1 gives `b = PEMAX/ST`. `c ≤ 0` always, so E < 0 for
  S < S0, so E must be clamped at 0 (OQ-11).
* Because TT 691 stores `B(12)` and `C(12)`, b and c are evaluated once per
  calendar month from the **mean monthly** PE, not from a time series.

### 2.8 Potential evaporation (TT 691 §7.4 + §12.1; TT 689 Table 9.1)

TT 690 ch.1 does not give the PE formula. The file stores mean monthly Symons-pan
evaporation (L.004) and pan factors (L.005, default `0.8, 1.0 ×8, 0.8 ×3`,
"Don't change, unless you want to use another type of pan", TT 689 Table 9.1),
and TT 691 holds `PE(12)` "mean monthly potential evapotranspirations in mm".
Proposed (OQ-13, OQ-14):

```
PE(m)  = FF × SPAN(m) × SPF(m)       m = Oct … Sep
PEMAX  = max over m of PE(m)
```

### 2.9 Conversion to volume (TT 690 p.6, last step)

```
V [million m³] = D [mm] × AREA [km²] / 1000
```

(1 mm over 1 km² = 1000 m³ = 0.001 million m³.)

---

## 3. Calculation procedure (TT 690 §1.9, pp.5–6)

### 3.1 As printed

> The calculation procedure for each month follows the following steps:
> • Compute runoff from impervious area;
> • Determine interception loss;
> • Synthesize mass curve of rainfall for the month and calculate rainfall for each time step;
> • The following 9 steps are performed for each time step;
> • Subtract interception loss from rainfall;
> • Compute surface runoff;
> • Perform mass balance of soil moisture to determine soil moisture at end of time interval. Note that evaporation from soil moisture is adjusted to account for the evaporative loss from intercepted rainfall;
> • If soil moisture capacity is exceeded calculate the excess water (SPILL) and apportion it to baseflow (to be lagged by GW) and remaining flow (lag of TL) as per step 9;
> • The quantity SPILL × GW/FT is added to baseflow and the remainder is added to the component to be lagged by TL. (Note that this procedure is different to that of the original model in which all of the SPILL is added to the component lagged by TL.);
> • Compute the runoff components originating from soil moisture;
> • Accumulate runoff components for the month;
> • After all months have been processed perform the routing (lagging) procedure and combine runoff components to obtain total monthly runoffs and
> • Convert monthly runoffs from depths (mm) to volumes (million cubic metres).

Notes on the text:
* "to be lagged by GW" is a typo for GL (GW is a flow rate, not a lag).
* The list announces "9 steps" per time step but only 6–7 bullets are per-step;
  "step 9" is evidently the SPILL × GW/FT bullet in an older, numbered version
  of the list. Nothing depends on the count.

### 3.2 Proposed implementable algorithm

This fixes every ambiguity with the defaults proposed in §5 (OQ numbers in
brackets). Quantities per time step are depths in mm over the whole catchment.

**Once per module (before the time loop):**

1. `PE(m) = FF·SPAN(m)·SPF(m)` for m = 1..12 (Oct..Sep); `PEMAX = max PE(m)` [OQ-13, OQ-14].
2. `b(m)`, `c(m)` from eqs. 1.18–1.19.
3. `a`, `b_I` from eqs. 1.6–1.7.
4. `gf = GFRACT = min(1, GW/FT)` if FT > 0, else 0 [OQ-10].
5. Initial state: `S = ST/2` [OQ-23, settled from the reference outputs]; lag states `I_GL = O_GL = I_TL = O_TL = 0` [OQ-24].

**For each month t (hydrological year order, Oct first), calendar month m:**

1. `P = PC(t)·MAP/100`.
2. Impervious runoff: `R_imp = AI(year)·P`; pervious rainfall `P' = P − R_imp` [OQ-17].
3. Interception: `I = min(P', (1 − AI)·a·(1 − e^(b_I·P)))` for P > 0, else 0 [OQ-3, OQ-17].
4. Mass curve: if P > 0, `W` (eq. 1.1), `n` (eq. 1.3) from the gross `P`; `y_j = y(j/4)`
   for j = 0..4 (eq. 1.2), so `f_j = y_j − y_(j−1)` [OQ-1, OQ-2]. If P = 0, all `f_j = 0`.
5. For each step j = 1..4, with `S` the storage at the start of the step:
   1. `r_j = P'·f_j`; `i_j = I·f_j`; net rain `rn_j = r_j − i_j` [OQ-3].
   2. Surface runoff `s_j = DT·Surf(rn_j/DT)` using eqs. 1.8–1.12 with ZMIN, ZMAX
      in mm/month [OQ-5, OQ-6, OQ-7].
   3. Infiltration `inf_j = rn_j − s_j`.
   4. Subsurface flow `q_j = DT·FT·((S − SL)/(ST − SL))^POW` if S > SL, else 0 [OQ-8].
   5. Evaporation `e_j = DT·max(0, b(m)·S + c(m))·max(0, 1 − i_j/(DT·PE(m)))` [OQ-11, OQ-12].
   6. `S' = S + inf_j − q_j − e_j` [OQ-8].
   7. If `S' > ST`: `spill_j = S' − ST`, `S' = ST`; else `spill_j = 0`.
   8. If `S' < 0`: cut `e_j` and then `q_j` until `S' = 0` [OQ-9].
   9. Split: `qb_j = min(q_j, DT·GW)`; `base_j = qb_j + gf·spill_j`;
      `fast_j = s_j + (q_j − qb_j) + (1 − gf)·spill_j`.
   10. `S = S'`.
6. Monthly totals: `B_t = Σ_j base_j`, `F_t = Σ_j fast_j`, plus `R_imp(t)`.

**After all months (or month by month, since the recursion is causal):**

7. `O_GL(t)` = Muskingum(B, k = GL); `O_TL(t)` = Muskingum(F, k = TL), with
   Δt = 1 month and k = 0 meaning `O = I` [OQ-20, OQ-21, OQ-22].
8. Runoff depth `D(t) = O_GL(t) + O_TL(t) + R_imp(t)` [OQ-18].
9. Volume `V(t) = D(t)·AREA/1000` (million m³).

**Water-balance invariant** (per month, before lagging):

```
P = R_imp + I + Σ s_j + Σ inf_j
ΔS = Σ inf_j − Σ q_j − Σ e_j − Σ spill_j
Σ base_j + Σ fast_j = Σ s_j + Σ q_j + Σ spill_j
```

and over a long run `Σ O = Σ I` for each lag reservoir (Muskingum conserves mass
apart from what is still in storage at the end).

---

## 4. Worked example (synthetic; reuse these numbers in tests)

All values are invented. Computed in double precision with the §3.2 algorithm
and its proposed defaults; quoted to 10 decimals.

### 4.1 Inputs

| | |
|---|---|
| AREA | 100.0 km² |
| MAP | 600 mm |
| L.003 | `POW=2 SL=0 ST=200 FT=10 GW=3 ZMIN=0 ZMAX=500 PI=1.5 TL=0.25 GL=2.5 R=0.5 FF=1.00` |
| L.004 S-pan (Oct..Sep) | `180 200 220 230 190 170 120 90 70 80 110 150` |
| L.005 pan factors | `0.80 1.00 1.00 1.00 1.00 1.00 1.00 1.00 1.00 0.80 0.80 0.80` |
| AI | 0 (no paved area) |
| Initial S | **150 mm** (set by the test, not a proposed default) |
| Initial lag states | all 0 |
| Rainfall `.RAN` | Oct 15.00 %, Nov 5.00 % of MAP |

### 4.2 Derived constants

| | |
|---|---|
| PE (Oct..Sep) | 144, 200, 220, 230, 190, 170, 120, 90, 70, 64, 88, 120 |
| PEMAX | 230 (January) |
| b, c (Oct) | 0.8855614973, −33.1122994652 |
| b, c (Nov) | 1.0697674419, −13.9534883721 |
| a, b_I | 20.7659488200, −0.0096581510 |
| GFRACT | 0.3 |
| Muskingum GL=2.5 | C1 = 0.3333333333, C2 = 0.1666666667 |
| Muskingum TL=0.25 | C1 = 1.3333333333, C2 = 0.6666666667 |

### 4.3 Month 1: October, P = 90 mm

W = 48.9624353694, n = 3.8691217634, I = 12.0593521432.
y at x = 0, ¼, ½, ¾, 1: 0, 0.0140544132, 0.5, 0.9859455868, 1.

| step | r | i | rn | surf | inf | Q | E rate (b S + c) | E | spill | S end | base | fast |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1.2648971860 | 0.1694871177 | 1.0954100683 | 0.0000560814 | 1.0953539869 | 1.4062500000 | 99.7219251337 | 24.8131091886 | 0 | 124.8759947984 | 0.75 | 0.6563060814 |
| 2 | 43.7351028140 | 5.8601889539 | 37.8749138601 | 2.3181614332 | 35.5567524269 | 0.9746258798 | 77.4730734685 | 16.2154430243 | 0 | 143.2426783211 | 0.75 | 2.5427873130 |
| 3 | 43.7351028140 | 5.8601889539 | 37.8749138601 | 2.3181614332 | 35.5567524269 | 1.2824040558 | 93.7379012298 | 19.6197404925 | 0 | 157.8972861997 | 0.75 | 2.8505654890 |
| 4 | 1.2648971860 | 0.1694871177 | 1.0954100683 | 0.0000560814 | 1.0953539869 | 1.5582220618 | 106.7154577255 | 26.5532609915 | 0 | 130.8811571333 | 0.75 | 0.8082781432 |

Month totals: surface 4.6364350292, Q 5.2215019974, E 87.2015536969,
**base B = 3.0000000000, fast F = 6.8579370266**, S end = 130.8811571333.

(Step 1 by hand: Q = 0.25 × 10 × (150/200)² = 1.40625; E rate = 0.88556·150 − 33.1123
= 99.7219; E = 0.25 × 99.7219 × (1 − 0.16949/36) = 24.8131. Every step has
Q > DT·GW = 0.75, so base = 0.75 and the rest of Q is fast.)

### 4.4 Month 2: November, P = 30 mm

W = 19.7512119773, n = 5.8264311144, I = 5.2235757804.
y: 0, 0.0016571643, 0.5, 0.9983428357, 1.

| step | r | i | rn | surf | inf | Q | E rate | E | S end | base | fast |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0.0497149305 | 0.0086563236 | 0.0410586069 | 0.0000000030 | 0.0410586040 | 1.0706173308 | 126.0589122821 | 31.5092720369 | 98.3423263696 | 0.75 | 0.3206173337 |
| 2 | 14.9502850695 | 2.6031315666 | 12.3471535029 | 0.0803136303 | 12.2668398726 | 0.6044508222 | 91.2499305349 | 21.6248047606 | 88.3799106593 | 0.6044508222 | 0.0803136303 |
| 3 | 14.9502850695 | 2.6031315666 | 12.3471535029 | 0.0803136303 | 12.2668398726 | 0.4881880380 | 80.5924625658 | 19.0991517248 | 81.0594107691 | 0.4881880380 | 0.0803136303 |
| 4 | 0.0497149305 | 0.0086563236 | 0.0410586069 | 0.0000000030 | 0.0410586040 | 0.4106642546 | 72.7612301251 | 18.1871583075 | 62.5026468109 | 0.4106642546 | 0.0000000030 |

Month totals: surface 0.1606272665, Q 2.5739204457, E 90.4203868298,
**B = 2.2533031149, F = 0.4812445973**, S end = 62.5026468109.
(From step 2, Q < 0.75, so all of Q is baseflow.)

### 4.5 Routing and volumes

| month | O_GL (mm) | O_TL (mm) | total (mm) | volume (million m³) |
|---|---|---|---|---|
| Oct | 0.5000000000 | 4.5719580178 | 5.0719580178 | 0.5071958018 |
| Nov | 1.2088838525 | 3.3688017434 | 4.5776855959 | 0.4577685596 |

(Oct: O_GL = 0 + ⅓(0 − 0) + ⅙(3 − 0) = 0.5; O_TL = 0 + 0 + ⅔·6.8579370266.)

### 4.6 Second vector: a wet month with SPILL and case 3

Same parameters, initial S = **190**, one October month at 40 % of MAP (P = 240).
W = 108.7162426234, n = 2.9809407555, I = 18.7210295266, y(¼) = 0.0364424418.

| step | rn | rn/DT (case) | surf | Q | E | spill | S end | base | fast |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 8.0639460034 | 32.26 (2) | 0.0223733774 | 2.2562500000 | 33.1458121653 | 0 | 162.6395104608 | 0.75 | 1.5286233774 |
| 2 | 102.5755392332 | 410.30 (3) | 40.5566607063 | 1.6532256477 | 21.0443670537 | 1.9607962862 | 200 | 1.3382388859 | 42.8324437544 |
| 3 | 102.5755392332 | 410.30 (3) | 40.5566607063 | 2.5000000000 | 27.3217252657 | 32.1971532612 | 200 | 10.4091459784 | 64.8446679892 |
| 4 | 8.0639460034 | 32.26 (2) | 0.0223733774 | 2.5000000000 | 35.3177599710 | 0 | 170.2238126550 | 0.75 | 1.7723733774 |

Totals: B = 13.2473848642, F = 110.9781084983; routed (from zero states):
O_GL = 2.2078974774, O_TL = 73.9854056656, total 76.1933031429 mm =
7.6193303143 million m³. Balance: 240 = 18.7210 (I) + 81.1581 (surf) + 140.1209
(inf); ΔS = −19.7762 = 140.1209 − 8.9095 (Q) − 116.8297 (E) − 34.1579 (spill). ✓

### 4.7 Routing edge case for tests

Muskingum k = 0.25, Δt = 1, from zero states, inflow `[0, 10, 0, 0]` →
outflow `[0, 6.6666666667, 4.4444444444, −1.4814814815]`. With the literal
monthly scheme, a lag below 0.5 month gives a negative coefficient on O1, so
outflow can go negative (see OQ-22).

---

## 5. Open questions

Each has the evidence, the readings, and a **proposed default** for the
orchestrator to accept or change in `docs/decisions.md`. Many can be settled
empirically in Round 2: WRSM2000 can write the module time series "Pitman S
(soil moisture storage)" and "total surface runoff" for a module
(TT 689 p.13 and p.120). A classic-GW reference run with those exports would pin
OQ-1–12 and OQ-23–24 directly.

**OQ-1 How the S-curve is sampled into the 4 steps.**
Evidence: "Synthesize mass curve of rainfall for the month and calculate rainfall for each time step" (TT 690 p.5); NOFT = 4, DT = "fraction of month represented by time step" (TT 691 p.38–39).
Readings: (a) evaluate y at x = j/4 and take differences; (b) integrate y over each quarter, or sample at mid-points.
**Default: (a).** y(j/4) differences are the only reading that gives a cumulative-curve partition summing exactly to P. Note y(½) = ½ always, so steps 1 and 4 get the same share, and so do steps 2 and 3.

**OQ-2 Gross or net rainfall in W and n.**
Evidence: eqs. 1.1–1.3 use "total precipitation for a month"; the procedure computes impervious runoff and interception *before* synthesising the mass curve.
Readings: (a) gross catchment P; (b) pervious rain P'; (c) P' − I.
**Default: (a) gross P.** The curve describes the storm's timing, which doesn't depend on land surface. With AI = 0, (a) = (b). For P = 0, skip (W/P is 0/0) and set every step to 0.

**OQ-3 How interception is spread over the steps, and its cap.**
Evidence: I is a monthly total (eq. 1.5); "Subtract interception loss from rainfall" is a per-step bullet (TT 690 p.5).
Readings: (a) `i_j = I·f_j`, proportional to step rain; (b) `I/4` per step, capped at step rain, the shortfall carried or lost; (c) fill a PI-sized store each step.
**Default: (a)**, plus `I ≤ P'`. It never makes step rain negative and keeps the monthly total exactly I. Eq. 1.5 gives I < P for PI ≤ 10 anyway (slope at P = 0 is 0.98 at PI = 10), so the cap is a guard.

**OQ-4 Whether n, I and Surf use the month's rain before or after the impervious share is removed.** Folded into OQ-2/OQ-17.

**OQ-5 How ZMIN/ZMAX (mm/month) apply to a quarter-month step.**
Evidence: ZMIN, ZMAX, Zave are "absorption rate (mm/month)" (TT 690 p.3); ZMIN is the "minimum rainfall intensity required to initiate surface runoff" (TT 689 Table 10.1).
Readings: (a) convert step rain to a rate, `Surf_j = DT·Surf(rn_j/DT; ZMIN, ZMAX)`; (b) scale the limits to the step, `Surf(rn_j; DT·ZMIN, DT·ZMAX)`; (c) compare step depth with the monthly limits unscaled.
(a) and (b) are **identical**, because Surf is homogeneous of degree 1 in (r, ZMIN, ZMAX). (c) would make surface runoff four times rarer than intended, and would make it depend on NOFT.
**Default: (a)/(b).**

**OQ-6 The ZMIN = ZMAX = 999 sentinel, and ZMIN = ZMAX in general.**
Evidence: "999 is a default value, used in conjunction with a ZMAX of 999 to signify that all rainfall is absorbed into the ground" (TT 689 Table 10.1, p.178). Eqs. 1.10–1.11 divide by (ZMAX − ZMIN)².
Readings: (a) hard sentinel: both ≥ 999 → Surf = 0; (b) the mathematical limit `Surf = max(0, r − Z)` for every ZMIN = ZMAX, which with 999 still gives runoff above 999 mm/month (≥ 250 mm in one quarter-month step).
**Default: (a) when ZMIN ≥ 999 and ZMAX ≥ 999; (b) for any other ZMIN = ZMAX; reject ZMIN > ZMAX in validation.** The reference network runs with ZMIN ≥ 999 should check that no month ever produces surface runoff.

**OQ-7 Strict or inclusive inequalities at the case boundaries.** The function is continuous, so it makes no numerical difference. **Default: `≤`** as in §4's script.

**OQ-8 Order of operations within a step, and which S drives Q and E.**
Evidence: the procedure lists "mass balance of soil moisture to determine soil moisture at end of time interval" *before* "SPILL" and "Compute the runoff components originating from soil moisture" (TT 690 pp.5–6). TT 691 p.64 says the Hughes routine averages flows over consecutive intervals "to allow smoothing", which suggests the Pitman routine does not.
Readings: (a) explicit: Q and E from S at the start of the step, one mass balance, then SPILL; (b) add infiltration and take off E first, then SPILL, then Q from the post-spill S; (c) implicit / sub-iterated.
**Default: (a).** It is the simplest reading of "mass balance … to determine soil moisture at end of time interval". "Compute the runoff components" then means the GW/TL split. This is the most likely place for a systematic difference against the reference; test (b) if Round 2 doesn't match.

**OQ-9 Negative soil moisture.**
Evidence: none. With §3.2, `q_j/S ≤ DT·FT/ST`-ish and E → 0 as S → S0, so S < 0 needs extreme parameters.
**Default:** if `S' < 0`, reduce E first and then Q so that S' = 0, and count it in a diagnostic.

**OQ-10 GW > FT, FT = 0, and GFRACT.**
Evidence: SPILL × GW/FT (TT 690 p.6); TT 691 `GFRACT` "groundwater fraction of subsurface flow".
**Default:** `GFRACT = min(1, GW/FT)`, and `0` when FT = 0 (all SPILL fast). The baseflow cap `min(Q, GW)` stays as written.

**OQ-11 Clamping E.**
Evidence: c ≤ 0 (eq. 1.19), so `bS + c < 0` when S < R·ST·(1 − PE/PEMAX); TT 690 Fig. 1.6 draws the R = 1 line starting at E = 0 on the S axis.
**Default:** `E_rate = max(0, b·S + c)`. No upper clamp is needed, since `E_rate ≤ PE` for S ≤ ST.

**OQ-12 The "evaporation adjusted for interception" rule.**
Evidence: "evaporation from soil moisture is adjusted to account for the evaporative loss from intercepted rainfall" (TT 690 p.5). No formula given.
Readings: (a) proportional: `E·(1 − I/PE)` (per step, `1 − i_j/(DT·PE)`), clamped ≥ 0; (b) subtractive: `max(0, E·DT − i_j)`; (c) recompute b, c with `PE − I`.
**Default: (a).** Intercepted water uses part of the evaporative demand; (a) gives the remaining demand to the soil in proportion, and for R = 0 it equals `(S/ST)(PE − I)`. That is the form usually described for the Pitman model, where interception evaporates at the potential rate and the rest of the demand is applied to soil moisture *(literature, not these manuals)*. (b) over-penalises when S < ST. (c) conflicts with the precomputed `B(12)`, `C(12)`.

**OQ-13 PEMAX and PE.**
Evidence: "PEMAX is the maximum monthly potential evaporation" (TT 690 p.5). TT 691 stores `SPAN(12)`, `SPF(12)`, `PE(12)`, `B(12)`, `C(12)`. TT 689 Table 9.1: S-pan factors convert S-pan to the evaporation the model uses.
**Default:** `PE(m) = FF·SPAN(m)·SPF(m)`, and `PEMAX = max` of the 12 PE values (after FF). There is no PE time series, so the same 12 values repeat every year.

**OQ-14 What FF (forest factor) does.**
Evidence: FF is "the factor by which potential evapotranspiration is increased" for SFR Child modules (TT 690 ch.11, p.126); "In previous versions … the Forest Factor was always 1.00 … the field … will always be read-only … WRSM/Pitman will adjust FF automatically when it reduces the outflows for the Child SFR" (TT 689 p.38).
**Default:** multiply PE by FF (as in OQ-13). For every non-Child module FF = 1.00 and this has no effect. How FF is set for Children is in `docs/theory/afforestation.md` (the SFR child calibration adjusts PI, FF, SL and ST; R6-F6, R6-F15).

**OQ-15 Bounds of R.** Evidence: "'R' that ranges between 0 and 1" (TT 690 p.5). **Default:** validate `0 ≤ R ≤ 1` and reject anything else. Both ends are handled by eqs. 1.18–1.19 with no special case (R = 1 with PE = PEMAX gives c = 0).

**OQ-16 Validation of the other parameters.** **Default:** reject `ST ≤ SL`, `SL < 0`, `POW ≤ 0`, `FT < 0`, `GW < 0`, `PI < 0`, `TL < 0`, `GL < 0`, `AREA ≤ 0`, `MAP ≤ 0`. Warn (don't reject) for PI > 10 (outside the fitted range, TT 690 p.2) and POW ∉ {1, 2, 3} (TT 689 Table 10.1).

**OQ-17 How the impervious (paved) fraction enters the pervious calculation.**
Evidence: "computed by multiplying catchment rainfall by the area of catchment that is impervious" (TT 690 p.3). TT 689 p.142: "with paved areas the soil moisture (Pitman S) is lower than without, because they prevent some of the rain infiltrating". Paved areas are a Parent-only feature (Children may not have them, TT 689 p.140).
Readings: (a) one whole-catchment store: rain reaching the pervious path is `P' = (1 − AI)·P`, and S, Q, E stay whole-catchment depths with the same ST, FT, GW; (b) area-weighted: run the pervious model per unit pervious area on the gross P, and weight its output by (1 − AI). Then S per pervious area would *not* drop, which contradicts TT 689.
**Default: (a)**, with interception `(1 − AI)·a(1 − e^(b_I P))`, i.e. eq. 1.5 on the gross rain depth falling on the vegetated fraction. TT 689's statement that S drops rules out (b). How AI is interpolated by year belongs to the land-use spec (TT 689 p.142: the year/area pairs must span the run, values are "determined for every given year"). Proposed there: AI constant within a year, linear between listed years.

**OQ-18 Whether impervious runoff is lagged.**
Evidence: TT 690 doesn't say. TT 691 keeps `TS_PavedOutflow` separately, and `TS_SurfaceOutflow` = "paved area runoff and component f (the surface flows)". TT 689 says paved flows are "not affected" by CSIR reductions and are reported separately.
**Default: not lagged.** It is added straight to the month's outflow and reported as its own series. Directly connected impervious runoff reaches the stream within the month.

**OQ-19 Interception on impervious areas.** **Default:** none. Impervious runoff = AI·P.

**OQ-20 Monthly routing (Δt = 1) or per-step routing (Δt = DT).**
Evidence: "After all months have been processed perform the routing" and "Δt = routing period (normally one month)" (TT 690 pp.5–6). But TT 691's `FG1`/`FI1` ("current groundwater flow / interflow in mm/month") are carried state, which per-step routing would also need.
**Settled (Round 6, R6-R6): per-step.** The printed monthly form was the default until the reference comparison overturned it through OQ-22. `routing: 'monthly'` keeps it selectable; the worked examples in § 4 are worked with it.

**OQ-21 Sign in eq. 1.14.** Erratum in §2.6. **Default: `+ C2 (I2 − I1)`.** It is standard Muskingum (x = 0), and k = 0 gives O = I. The printed `−` gives negative outflow on every rise.

**OQ-22 Negative outflows when k < 0.5 Δt (e.g. the default TL = 0.25).**
Evidence: with Δt = 1 and k = TL = 0.25, `O2 = −⅓ O1 + ⅔ I1 + ⅔ I2`, so a wet month followed by two dry months goes negative (§4.7). TL = 0.25 is the documented "good average" (TT 689 Table 9.1). TL = 0 and 0.25 both occur in real files.
Readings: (a) literal: allow it; (b) clamp at 0, which breaks mass balance; (c) route per step (Δt = 0.25), where all coefficients are ≥ 0 for k ≥ 0.125; (d) k = 0 special-cased as no lag.
**Settled (Round 6, R6-R6): (c), per-step routing.** 206 of 210 reference Sami modules have TL < 0.5, the literal form went negative and stopped 29 of 35 networks, and WRSM2000's outputs for them never go negative. Per-step coefficients are all ≥ 0 only for k ≥ 0.125 month (Δt = 0.25): below that a negative month is still possible and is not yet covered by a test (Round 6 wave 2). The Round 2 default was (a) + (d), with this check: run the reference modules that have TL = 0.25 and GW = 0 (nearly all flow on the TL path) and look for negative or oscillating months. If WRSM2000 never shows them where (a) does, switch to (c) and record it in `docs/departures.md`. Note that with k = 0, (a) already reduces to O = I exactly when the initial states are equal, so (d) only removes a rounding path.

**OQ-23 Initial soil moisture.**
Evidence: nothing in ch.1. There is no initial-S field on L.001–L.020. TT 691 `RU_Reset` (p.60) "recalculate[s] (or reset[s]) all the initial values".
Readings: (a) S0 = 0; (b) S0 = SL; (c) S0 = ST/2; (d) S0 = ST; (e) a warm-up year.
**Settled (Round 6 wave 2): (c) ST/2, single pass, no warm-up.** The manuals still say nothing; the value is taken from WRSM2000's outputs. In October of the first year almost all of a module's net catchment runoff (`<net>RU<n>ncr.MTS`) is soil interflow draining S0, so the first month measures S0 directly. Run from S0 = f·ST for f = 0, 0.1, …, 1 (Sami modules, the Pitman total as the interflow, OQ-S3 (b)), the best f is ½ for 12 of the 17 free reference modules whose first month is ≥ 0.05 Mm³ and moves by more than 10 % with S0 (`runoff/initial-state.reference.test.ts`; the 3 best at 0 are within 17 % of the reference at ½; 2 are best at 0.8). Over all 96 S0-sensitive modules (SFR members included, run in their networks) 73 are best at ½ (median month-1 error 6 % at ½, ≥ 26 % at any other f). A warm-up year (e) would make month 1 independent of ST and is ruled out by the same fit. Under the default Sami composition (OQ-S3 (a)) no S0 fits month 1 (the best f spreads over 0.6–1, median error ≥ 24 %), which is evidence on OQ-S3, not on S0 (sami.md OQ-S17, evidence). Whole-record effect of S0 is small (median |MAR %| 3.05 at ½ and at 0, 3.21 at ST), the first year's large (median |%| 2.98 at ½, 4.59 at 0, 5.82 at ST); it decays within 2–3 years.

**OQ-24 Initial lag states.**
Evidence: none beyond `FG1`, `FI1` existing.
Readings: (a) all zero; (b) `I0 = O0 =` the first month's inflow (steady start).
**Default: (a) zero, kept (Round 6 wave 2).** Under per-step routing (R6-R6) the start barely matters: first-year median |%| difference against the reference ncr.MTS 2.98 (zero) vs 3.02 (steady), whole record 3.05 for both. With the Pitman total in the first month (OQ-S3 (b)) zero fits month 1 better than steady (median error 13 % vs 18 %, at S0 = ST/2): steady at the first *step's* inflow overshoots, because the first step of a recession carries the most water. The unlagged total fits month 1 best (6 %), so the true start may route less than either; that is confounded with OQ-S3 and left until OQ-S3 is settled. All 191 reference Sami modules have TL ≤ 0.5 and most GL = 0, so the classic GL path is not exercised.

**OQ-25 Numeric precision.**
Evidence: TT 691 declares the state and parameters `REAL` (Lahey Fortran 90, TT 691 p.1), i.e. 32-bit by default.
**Default:** compute in float64. If the reference comparison shows drift beyond the Round 2 tolerance, add an optional `Math.fround` mode at the state updates. Don't round internally. Output rounding belongs to the `.ANS` writer (`docs/formats.md`).

**OQ-26 MAP as an integer.**
Evidence: L.002 v2 is `I4` (TT 691 p.148). Method B (issue #3) gives sub-catchments a fractional MAP from the grid and a scale factor.
**Default:** the engine accepts a real MAP. When writing a `.DAT`, round to the nearest integer and record the unrounded value in the `pitman.json` sidecar, and use the *written* (rounded) value in any run that is compared against WRSM2000. Cross-reference for `docs/theory/subdivide.md` and `docs/formats.md`.

**OQ-27 Hydrological year alignment.**
Evidence: L.004/L.005 start in October (TT 691 p.148); `.RAN` rows are hydrological years, October first (issue #3, method A).
**Default:** month index 1 = October in PE, b, c, and in the rainfall series.

**OQ-28 Number of time steps.**
Evidence: NOFT "(default=4)" in TT 691; "fixed at a value of 4" in TT 690 p.1.
**Default:** NOFT = 4 as a constant. Code it as a parameter, but don't expose it.

---

## 6. Outputs the module should expose

For the engine and the comparison tool, per month (all mm unless stated):
`P`, `I`, `R_imp`, surface runoff total, `Q` total, `E` total, SPILL total,
`S` at month end ("Pitman S"), un-lagged `B` and `F`, routed `O_GL` and `O_TL`,
total depth `D`, and volume `V` (million m³). For a classic-GW module, WRSM2000's
"total surface runoff" equals the "net catchment runoff" and the "groundwater
outflow" is zero (TT 689 pp.120–121). The `.ANS` writer and the `RunResult` type
should mirror that, even though this spec keeps B and F apart internally.

## 7. What this module does NOT cover

* **Hughes and Sami groundwater** (GW model 1 and 2; L.021–L.037): `docs/theory/hughes.md`
  and `docs/theory/sami.md`. They use their own parameter sets (L.023 / L.035) and
  replace the GL/baseflow path. "Pitman S" from this soil store is the input to Sami.
* **Afforestation and alien vegetation** (Van der Zel, CSIR, Gush, user-defined
  reductions, SFR Parent/Child, how FF/PI/SL/ST are adjusted for Children):
  TT 690 ch.11–12, a later land-use spec.
* **Paved-area year interpolation** and land-use year tables in general: land-use spec
  (only how AI enters the water balance is here, OQ-17/18).
* **Upstream inflow routes into the RU, splitting outflow over exit routes**
  (`RUPERC`, L.019–L.020): network/route spec.
* **Reservoirs, farm dams, channel reaches, irrigation, wetlands, mines**: TT 690 ch.2–10.
* **Producing the `.RAN` % MAP series** (eq. 1.4 from gauges, or CHIRPS extension):
  `docs/theory/extend.md`.
* **The daily time-step model** (TT 690 ch.14, WRSM/Pitman v2.6): out of scope.
* **File parsing/writing** of L.001–L.040: `docs/formats.md`.
