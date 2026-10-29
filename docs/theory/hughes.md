# Hughes groundwater model (WRSM2000 GW model 1)

Specification of the **Hughes groundwater–surface water model** ("Pitman model version 3 with
groundwater", TT 690 ch.7) as used in a WRSM/Pitman runoff (RU) module whose groundwater model is `1`
(L.022 v1). No reference network uses it, so it is a **later-round feature**. This spec is shorter
than `sami.md` but complete: every equation, symbol, file field and ambiguity is recorded.

## Sources

| Ref | Used for |
|---|---|
| TT 690 ch.7, book p.56–71 (PDF p.69–84) | Equations 7.1–7.18 (images, transcribed from page renders), process order (p.60), parameter guidance |
| TT 691 §7.4 (p.43–47) | Runoff-record variables for Hughes (`HGSL`, `GPOW`, `HGGW`, `HGA`, `HGSRC`, `TLGMax`, `RipStripF`, `Transmiss`, `Storativity`, `RestWL`, `RestWLGrad`, `MAXSL`, `DSPerc1/2`, `DSWidth1/2`, `NDSlopes`, `DSLength`, `GWV1/2`, `GWSL1/2`, `GWAbstr1/2`, `GWDemand1/2`, `MAXQS`, `MAXQC`, `CUMA`, `RunNumber`, `GWToNextRU`); routines `RU_GWCalcPhysical`, `RU_HGMoist`, `RU_HGCalcs` (p.62–63) |
| TT 691 ch.12 (p.150–151) | L.021–L.030 |
| TT 689 §6.1.8 (p.39–42), Table 9.1 (p.173) | Dialog behaviour, defaults, drainage density from reach count |

Citations take the form `TT 690 p.59 eq. 7.7` (book page, report equation number).

## 1. How Hughes changes the Pitman RU

1. **Recharge is taken out of soil moisture S inside the Pitman 4-sub-step loop** (`RU_HGMoist`,
   TT 691 p.63). This is unlike Sami, which post-processes S. SL is redefined as the recharge threshold
   HGSL, and SL's effect on soil-moisture runoff is removed (TT 690 p.57). In TT 691's terms,
   `HGA = FT/(ST − 0)^POW`, so interflow uses SL = 0, and `HGSRC = HGGW/(ST − HGSL)^GPOW`
   (TT 691 p.44–45).
2. **GW is redefined** as HGGW, the maximum recharge (TT 690 p.57), and **GL is dropped**: "no longer a
   need for a ground water lag routine ... the new ground water function also acts as a routing
   reservoir" (TT 690 p.61).
3. Recharge feeds a simplified **geometric aquifer**: 2·N_ch parallel drainage slopes, each split into
   an upper part (60 %) and a riparian/lower part (40 %), with Darcy discharge to the channel (§3).
4. **Channel transmission losses** take water from the module's own runoff and, unlike Pitman or Sami,
   from **upstream inflow** routed through the module, into the lower wedge (TT 690 p.64–67;
   TT 689 p.42).
5. The model is **run twice**. The first run warms up the gradients and the maximum-flow scalers
   (TT 690 p.62, p.65–67; `RunNumber`, TT 691 p.43).
6. The Pitman calibration set for Hughes is **L.023** (TT 691 p.150), separate from the classic L.003
   and the Sami L.035.

## 2. Parameters and file mapping

| Symbol | Meaning | Unit | File | TT 691 | Default (TT 689 Table 9.1) |
|---|---|---|---|---|---|
| RTIN | Inflow route from upstream (only one) | – | L.021 v1 (I4) | `RTIN` | – |
| UPRU | Upstream RU whose final GW state feeds this one | – | L.021 v2 (I4) | `UpStrRunoffModule`, `GWToNextRU` | – |
| HGSL | Soil moisture below which no recharge | mm | L.022 v2 (F8.3) | `HGSL` | 0 |
| GPOW | Recharge power | – | L.022 v3 (F8.3) | `GPOW` | 3 |
| TLGMax | Maximum channel loss | mm | L.022 v4 (F8.3) | `TLGMax` | 2 |
| HGGW | Recharge at S = ST | mm/month | L.022 v5 (F8.3; file v ≥ 4) | `HGGW` | 2 |
| POW…FF | Pitman set for Hughes | | L.023 v1–v12 | `A_*(2)` | Pitman defaults |
| useReaches | Derive DD from reach count? 1/0 | – | L.024 v1 (I3) | | 1 |
| DD | Drainage density | km/km² | L.024 v2 (F8.5) | `DRAINAGEDENSITY` | 0.4 |
| NREACH | Number of reaches | – | L.025 v1 (I4) | `NDRAINS` | – |
| DSPerc2 | Riparian width, % of slope width | % | L.025 v2 (F6.2) | `DSPerc2` (DSPerc1 = 100 − DSPerc2) | 40 |
| RSF | Riparian strip factor | see OQ-H6 | L.025 v3 (F7.3) | `RipStripF` | 0.2 (% of riparian zone) |
| RWL | Rest water level (depth below channel, stored positive) | m | L.025 v4 (F6.2) | `RestWL` | 20 |
| T | Transmissivity | m²/d | L.025 v5 (F6.2) | `Transmiss` | 10 |
| Sy | Storativity | – | L.025 v6 (F6.4) | `Storativity` | 0.001 |
| G₀ | Initial gradient, upper and riparian (taken as the regional gradient) | – | L.026 v1 (F8.4) | `GWSLInit` | 0.01 |
| ABS1 | Annual abstraction, upper zone | Ml/a (= m³×1000) | L.027 (F8.2) | `GWAbstr1` | 0 |
| DEM1 | Monthly distribution, upper | % ×12 | L.028 (F6.2) | `GWDemand1` | – |
| ABS2 | Annual abstraction, riparian zone | Ml/a | L.029 (F8.2) | `GWAbstr2` | 0 |
| DEM2 | Monthly distribution, riparian | % ×12 | L.030 (F6.2) | `GWDemand2` | – |

Derived (TT 691 p.43–45): `NDSlopes`, `DSLength`, `DSTotalWidth`, `DSWidth1/2`, `RestWLGrad`,
`MAXSL = 0.7·RestWLGrad`, `CUMA` (cumulative upstream area including this module), `MAXQS` and
`MAXQC` (maximum monthly sub-area runoff and channel flow), `TMAXQS` and `TMAXQC` (kept after run 1).

## 3. Equations

### 3.1 Recharge and interflow (in the soil loop)

```
RE   = HGGW · ((S − HGSL)/(ST − HGSL))^GPOW      S > HGSL, else 0      TT 690 p.57 eq. 7.1
Qsub = FT · (S/ST)^POW                           (SL = 0, via HGA)     TT 691 p.44; TT 690 p.4 eq. 1.13
```
Both are removed from S in each of the 4 sub-steps (OQ-H1 covers the per-step scaling). `RU_HGMoist`
returns sflow and gflow as "the average of those estimated in this time interval and the previous one"
(TT 691 p.63).

### 3.2 Geometry (once per module; `RU_GWCalcPhysical`)

With AREA in km² and DD in km/km² (TT 690 p.59 eqs 7.2–7.6):
```
DD          = NREACH / √AREA                    if useReaches (TT 689 p.40)
Lch         = DD · AREA                         total channel length         (7.2)
Width       = Length · 2 · DD                                                (7.3)
Length      = √(AREA / (2·DD))                  = DSLength (channel length per slope)  (7.4)
NDSlopes    = 2 · DD · AREA / Length            → even integer (OQ-H2)       (7.5)
dw          = Width / NDSlopes                  = DSTotalWidth               (7.6)
w1 = dw · DSPerc1/100 (upper),  w2 = dw · DSPerc2/100 (riparian)
```
Check against TT 690 Fig 7.2: AREA = 100, DD = 0.4 gives Length = 11.18 km, Width = 8.94 km and
NDSlopes = 7.16 → **8**, matching the figure's "8 drainage slopes".

### 3.3 Wedge storage and gradients

Single wedge (TT 690 p.59 eqs 7.7–7.8): `V = dw² · G · Length / 2`, water `= V · Sy`.

For the two-part slope, TT 690 p.60 describes the procedure but gives no formula. Proposed reading
(OQ-H3), per slope, in m and m³:
```
h       = G2 · w2                                   junction height above (or below) channel
W2      = Sy · Length · w2² · G2 / 2                riparian water volume (may be < 0)
W1      = Sy · Length · (h·w1 + w1²·G1/2)           upper water volume (trapezoid on the junction)
G2      = 2·W2 / (Sy·Length·w2²)
G1      = 2·(W1/(Sy·Length) − h·w1) / w1²
```
"The lower slope end point is fixed at the river channel and the gradient calculated from 40 % of the
width and the volume (which can be negative and therefore so can the gradient)" (TT 690 p.60).

### 3.4 Fluxes per iteration (4 per month)

`Δt = days_in_month / 4` (OQ-H4). Fluxes are per slope, using the gradients from the end of the
**previous** iteration:
```
D12   = T · G1 · Δt · Length                      upper → riparian           (7.9 form)
D2c   = T · G2 · Δt · Length                      riparian → channel, if G2 > 0   (7.9)
DSOUT = T · Greg · Δt · dw · DF                   downstream outflow (split 60:40)  (7.12)
```
Here `Greg` is the regional gradient (L.026, OQ-H5) and DF is the depletion factor below.

**Depletion factor** (TT 690 p.62 eq. 7.10), when G2 < 0:
```
RWLGrad = −RWL / w2
DF      = (RWLGrad − G2) / RWLGrad     clamp to [0, 1];   DF = 1 when G2 ≥ 0
```

**Riparian evapotranspiration** (TT 690 p.62 eq. 7.11):
```
NetEvap = max(0, PE − RAIN)          (mm → m)
ETrip   = dw · NetEvap · RSF · DF · Length     (Length implied for a volume; OQ-H6)
```
ETrip first reduces a positive D2c. Any remainder comes out of the riparian volume (TT 690 p.62).
Below the channel, DF also scales downstream outflow and abstractions ("inaccessible to all ground
water outflow processes", TT 690 p.62).

**Abstraction:** per iteration, `ABSk·DEMk(m)/100 / 4 / NDSlopes`, in Ml → m³ (TT 690 p.67 §7.4.2;
OQ-H7).

**Recharge** for the month enters the wedges split 60:40 (by DSPerc), spread over the 4 iterations
(TT 690 p.60 bullet 1).

**Iteration order** (TT 690 p.60, p.64):

1. Add recharge.
2. Compute D12, D2c, DSOUT, ETrip, channel-loss input and abstraction from the previous gradients.
3. Do the riparian water balance first and fix G2 and the junction.
4. Do the upper water balance and fix G1 for the next iteration.

Monthly GW discharge to the river = Σ D2c (net of ETrip) × NDSlopes, converted to mm over AREA.

### 3.5 Channel transmission losses: own runoff

`MAXQ` (mm) is the maximum monthly sub-area runoff. It starts at 20 mm in run 1 and is re-estimated
for run 2 (TT 690 p.65). With Q the month's runoff (mm):
```
TLQ = 0.5 · (tanh(10  · (Q/MAXQ − 0.2)) + 1)     if Q/MAXQ < 0.3 (OQ-H8)    (7.14)
TLQ = 0.5 · (tanh(2.5 · (Q/MAXQ − 0.2)) + 1)     if Q/MAXQ ≥ 0.3            (7.15)
TLG = TLGMax                                     if G2 < 0.7·RWLGrad        (7.16)
TLG = TLGMax · (G2 / (0.7·RWLGrad))^0.25         if 0.7·RWLGrad ≤ G2 < 0    (7.17)
TLG = 0                                          if G2 ≥ 0   (Fig 7.5; OQ-H9)
CLOSS = min(TLQ · TLG, Q)   mm                                         TT 690 p.65
```
CLOSS is removed from the module's runoff and added to the riparian wedge.

### 3.6 Channel transmission losses: upstream inflow

TT 690 p.66–67 eq. 7.18:
```
MAXQ_Inflow   : 20 mm × CUMA in run 1, then the run-1 maximum monthly inflow
TLGmax_Inflow = TLGMax · (MAXQ_Inflow / MAXQ)       (in m³×10⁶)
TLQ           : eqs 7.14/7.15 with Q = upstream inflow, MAXQ → MAXQ_Inflow
TLG           : eqs 7.16/7.17 with TLGMax → TLGmax_Inflow
```
Computed **once at the start of the month** from that month's inflow, with no iteration. It reduces the
inflow passed downstream, and the volume goes into the riparian wedge in 4 equal parts.

### 3.7 Regional slope estimate (guidance only, not run-time)

`Greg = (catchment average slope %)^0.05 / 100` when the slope is > 1 %, else slope/100 (TT 690 p.64
eq. 7.13). TT 689 p.41 prints `0.01·(MEAN_SL_P)^0.05/100 or 0.01`.

## 4. Order within a module run

1. Geometry (§3.2). Gradients = G₀. MAXQ = 20 mm, MAXQ_Inflow = 20 mm·CUMA. `RunNumber = 1`.
2. For each month: inflow channel loss (§3.6), then the Pitman sub-steps with Hughes recharge
   (`RU_HGMoist`), then the 4 GW iterations (`RU_HGCalcs`, §3.4) with the incremental channel loss
   (§3.5) applied to that month's runoff.
3. Record the final gradients, MAXQS and MAXQC. Set `RunNumber = 2`, restart the record with those
   gradients and maxima as initial values, and keep only run 2's outputs (TT 690 p.62, p.67).
4. If another module names this one as UPRU, pass `GWToNextRU` (the downstream outflow) to it (OQ-H10).

The module order in the network must respect UPRU, as well as the surface routing (TT 689 p.39).

## 5. Invariants

- Wedge mass balance per iteration: `ΔW1 + ΔW2 = recharge + CLOSS_in − D2c_net − ETrip_from_store − DSOUT − abstraction`.
- Soil: S drops by RE + Qsub inside each sub-step, and S ≥ 0.
- `0 ≤ CLOSS ≤ Q`. The inflow loss is ≤ the inflow.
- `NDSlopes` is an even integer ≥ 2. `DF ∈ [0, 1]`.
- Zero recharge ⇒ gradients decay monotonically while G2 > 0.
- TT 690 p.66: with no abstraction and no channel loss, the two-element model should give "almost
  identical results" to a single-element one. Worth a regression test.

## 6. Open questions

Each gives a **proposed default**.

- **OQ-H1. Recharge and interflow per sub-step.** HGGW and FT are monthly maxima, and the Pitman core
  has 4 sub-steps. Are RE and Qsub ÷4 per step and recomputed from the evolving S? Also, sflow and
  gflow are averaged with the previous interval (TT 691 p.63).
  *Default:* per sub-step `RE/4` and `Qsub/4` from the sub-step's S, plus the two-interval averaging as
  TT 691 states. Align with `docs/theory/pitman.md`'s sub-step conventions.
- **OQ-H2. Even-integer correction of NDSlopes.**
  *Default:* round to the nearest even integer, minimum 2 (matches Fig 7.2's 7.16 → 8).
- **OQ-H3. Two-wedge geometry.** TT 690 gives the procedure only. *Default:* §3.3's trapezoid on the
  junction.
- **OQ-H4. Time step.** Is Δt in days, fixed 30/4 or days-in-month/4? T is m²/d.
  *Default:* days in the calendar month / 4.
- **OQ-H5. Regional gradient vs initial gradient.** L.026 holds one value, "initial value for the GW
  slope for upper and riparian". TT 690 says run 1 starts from the regional gradient. TT 689 lists
  "Regional GW gradient 0.01" as a parameter.
  *Default:* L.026 is the regional gradient Greg. It is used for DSOUT throughout and as the run-1
  initial G1 and G2.
- **OQ-H6. Riparian strip factor units and ET volume.** TT 690 says % of the **total** slope width.
  TT 689 says % of the **riparian zone** (default 0.2 %). TT 691 says a fraction (0.01–0.001). Eq. 7.11
  omits Length.
  *Default:* RSF is read as a percentage of the total slope width (divide by 100). ET volume =
  dw·RSF/100·NetEvap·Length·DF. Flag it for the first Hughes reference network, if one appears.
- **OQ-H7. Abstraction units and split.** Ml/a (TT 691) vs m³×1000 (TT 690), which are the same. Is
  the monthly % normalised to 100? TT 690 says one distribution serves both zones, but the file has two.
  *Default:* use each zone's own 12 values, normalised to sum to 100. Spread evenly over slopes and
  iterations.
- **OQ-H8. TLQ threshold 0.3 vs 0.2.** With the printed 0.3, TLQ jumps from 0.881 to 0.622 at
  Q/MAXQ = 0.3. At 0.2 both branches equal 0.5, which is continuous. Fig 7.4 (MAXQ = 20) follows
  eq. 7.15 at Q = 5 mm (0.25 → 0.56) and Q = 6 mm (0.62), which is only possible if the switch is at
  0.2. The text also mentions exponents "0.4 and 0.25", but no 0.4 appears in the equations.
  *Default:* switch at Q/MAXQ = 0.2. Record it as a departure if a Hughes reference later disagrees.
- **OQ-H9. TLG for G2 ≥ 0.** Eq. 7.17 takes a 0.25 power of a negative ratio when G2 > 0.
  *Default:* TLG = 0 for G2 ≥ 0 (Fig 7.5 reaches 0 at gradient 0; losses happen only "when the ground
  water level drops below the level of the channel", TT 690 p.64).
- **OQ-H10. Upstream GW coupling (UPRU).** "Final groundwater state" of the upstream module "will
  influence" this one (TT 689 p.39). `GWToNextRU(MNTPS)` is a time series.
  *Default:* add the upstream module's monthly downstream outflow DSOUT (as a volume) to this module's
  upper wedge, spread over the 4 iterations.
- **OQ-H11. Lag of Hughes outputs.** GL is gone. Are interflow and surface runoff both lagged by TL,
  with GW discharge unlagged?
  *Default:* yes.
- **OQ-H12. MAXQ re-estimation.** Is MAXQ the maximum monthly runoff from run 1 or a scaled maximum?
  Figure 7.4 uses 20 mm, and TT 690 p.70 talks of "10 % of maximum runoff depth" for TLGMax only.
  *Default:* the plain maximum monthly value from run 1 (MAXQS for own runoff, MAXQC for inflow).
