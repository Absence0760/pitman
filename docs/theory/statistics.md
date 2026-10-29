# Flow statistics and the results screen

Spec for `packages/wrsm/src/stats/` (the statistics, pure) and
`frontend/src/lib/results/` (the results screen). Round 3, agent 3.5.

## Sources

| Short name | Report | Used for |
|---|---|---|
| TT 689 | WRC TT 689/16, *WRSM/Pitman User Manual*, §6.1.18 "Viewing the Statistics" (book pp.60–62), §6.1.19 plots (pp.62–68), §10.1 calibration guidelines (p.177), §2.3.4 flow files and patching codes (p.8) | every definition below |
| TT 691 | WRC TT 691/16, *Programmer's Code Manual*, §8.2 `Stats_Type` (pp.93–95), §8.3.1 `STATS`/`STCALC`/`STATX` (pp.95–96) | which statistics exist and their names |

Book page numbers. PDF page = book page + 21 for TT 689 (p.61 is PDF p.82).

## The five WR2012 statistics

WRSM2000's View | Statistics screen shows, for the simulated flows in a route and,
when the route has a gauge, for the observed flows, five statistics of the **annual**
flows x₁ … xₙ of n hydrological years (October–September, million m³/year):

| # | Statistic | Definition | Source |
|---|---|---|---|
| 1 | MAR | (1/n) Σ xᵢ | TT 689 p.61 |
| 2 | Mean (log) | (1/n) Σ yᵢ, yᵢ = log xᵢ | TT 689 p.61 |
| 3 | Standard deviation | √( Σ (xᵢ − MAR)² / (n − 1) ) | TT 689 p.61 |
| 4 | Log standard deviation | √( Σ (yᵢ − mean(log))² / (n − 1) ) | TT 689 p.62 |
| 5 | Index of seasonal variability Is | max_m S_m − min_m S_m, S_m = Σ_{k=1..m} (Q_k − 100/12), Q_k = mean flow of month k as % MAR, m = 1…12 | TT 689 p.62 |

TT 691 §8.2 names them `QMSIM/QMOBS`, `QMLSIM/QMLOBS`, `SDSIM/SDOBS`,
`SDLSIM/SDLOBS` and `SISIM/SIOBS`, and also carries a coefficient of variation
(`CVSIM/CVOBS`), skewness, range and autocorrelation computed by `STATX`
(p.96). We add the **coefficient of variation** CV = SD / MAR, since hydrologists
read it beside the five (R3-S5).

Two typos in TT 689 are read the only way that makes sense: the mean (log)
formula sums xᵢ where it defines yᵢ (p.61), and the log standard deviation
subtracts "Standard Deviation" where it must subtract the mean of the logs (p.62).

Is is "the storage capacity, as percentage MAR, required to balance the seasonal
variations" (p.62): the range of the running sum of each month's departure from a
uniform 1/12 of the year's flow. The departures sum to zero over a year, so the
range does not depend on the starting month. All flow in one month gives
100 − 100/12 ≈ 91.7 %; even flow gives 0.

### Calibration guidelines (TT 689 p.177)

"There are no firm criteria … but one can use the following guidelines": error in
MAR and mean (log) < 4 %, in the standard deviations (natural and log) < 6 %, in the
seasonal index < 8 %. The table shows each error with a "within" / "outside" word
(not only a colour). Priority when they conflict: MAR, then SD, then Is (p.177).

## Simulated against observed at a gauge

A gauge is a route with an observed-flow file (`.NET` L.009–L.011). When the route
has a gauge, WRSM2000 sets the statistics period to the gauge's period of record and
shows the statistics of the flows "observed in this period" (TT 689 p.60). The
manuals do not say how gaps are handled; our rules:

- A **negative** observed value is missing (docs/formats.md §11.4, U-16) and that
  month is never compared.
- A month flagged **`+`** is incomplete (a patching code, TT 689 p.8). Kept by
  default; the screen has a switch to leave them out (R3-S1).
- The annual statistics need whole years, so a year enters them only when all 12
  observed months are usable, and the **simulated statistics use exactly the same
  years** (R3-S1). Years before or after the simulation, or outside the chosen
  period, are left out and counted.
- % error = (simulated − observed) / |observed| × 100 (R3-S8).

The monthly hydrograph shows every observed month that is not missing; incomplete
months are marked with a point and listed as "incomplete" in the data table.

## Other results

- **Annual totals**: sum of the 12 months of each hydrological year, million m³/year.
  For a reservoir the annual figure on the chart is the mean end-of-month storage
  (a sum of storages means nothing); the `.ANS` file still writes the sum, as
  WRSM2000 is assumed to (docs/formats.md U-20).
- **Mean monthly flows**: the mean of each month over the years shown, October first.
- **Flow-duration curve** (TT 689 p.68 "cumulative frequency … the percentage time
  that various flows are equalled or exceeded"): monthly values ranked from largest
  (rank 1) to smallest and plotted at the **Weibull** position 100·i/(n + 1) %
  (R3-S6). The flow axis is logarithmic when every value is positive.
- **Several runs** (present day, natural, historical) are drawn on the same axes with
  different line styles and listed side by side in the tables and the statistics.
- **Downloads**: one `.ANS` per route (or `RV` per reservoir) per run, in WRSM2000's
  layout (`answerFromSeries` + `writeAnswer`, docs/formats.md §11.2), named
  `<net>RQ<route>.ANS`; when more than one run exists the mode is appended
  (`SYRQ4-natural.ANS`), which WRSM2000's name rule still reads. And one CSV per
  route with every run and the observed flows side by side.

## Open questions (defaults in force)

| ID | Question | Default |
|---|---|---|
| R3-S1 | How WRSM2000 treats missing (negative) and incomplete (`+`) observed months, and which simulated years it compares | Missing months never compared; incomplete months kept (switchable); annual statistics over years with 12 usable observed months; simulated statistics over the same years |
| R3-S2 | The base of the logarithm in mean (log) and log SD (TT 689 writes "log") | log₁₀. The % error in log SD does not depend on the base; the mean (log) error does |
| R3-S3 | A year with zero (or negative) annual flow in the log statistics | Left out of the log statistics only, and counted on the screen |
| R3-S4 | TT 689 p.62 writes Is as `max(sum(Qm − m·100/12)) − min(...)` | Running (cumulative) sum of Q_k − 100/12 over k ≤ m |
| R3-S5 | CV is listed in TT 691 p.94 without a formula | SD / MAR |
| R3-S6 | Plotting position of the cumulative-frequency curve | Weibull, i/(n + 1) |
| R3-S7 | WRSM2000 computes in float32 (`REAL`, TT 691 §8.2) | Float64; these are display figures. Revisit if the reference comparison ever checks `.OUT` statistics files |
| R3-S8 | Definition of the "error" in the TT 689 p.177 guidelines | (sim − obs) / |obs| × 100 |
| R3-S9 | Default statistics period when the route has no gauge | The whole simulated record (TT 689 p.60) |
