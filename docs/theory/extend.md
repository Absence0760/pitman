# Method A: extending a rainfall file with CHIRPS

This page specifies how Pitman extends a catchment rainfall file (`.RAN`,
monthly rainfall as **% of MAP**) to the present with CHIRPS. It is the
contract for Round 4: `packages/wrsm/src/extend/rain.ts` (agent 4.3) runs
the method as a pure function, the backend's `POST /chirps/monthly`
(agent 4.2) supplies the monthly totals, and the extension screen (agent
4.4) shows the fit and the factors. The operator's method is in issue #3,
*Methods the user specified*, A. Decision D5 (the overlap window) applies.

Where this page says *must*, a test checks it. The numbers in
[§ Worked example](#worked-example) are the fixture those tests reuse.

## Inputs

| Input | Where it comes from | Shape |
|---|---|---|
| The `.RAN` series | the network zip (`docs/formats.md` § `.RAN`) | rows `(zone, year, v[0..11])`, `v` in % of the model's MAP, October first. `year` labels the hydrological year by the calendar year its October falls in (1981 = Oct 1981 to Sep 1982); `docs/formats.md` is authoritative if the files say otherwise. |
| The area the file represents | the user picks one or more quaternaries (default: the quaternaries of the runoff modules whose `.DAT` names this `.RAN`) | a Polygon or MultiPolygon, the union of their boundaries |
| CHIRPS daily rainfall | IC-WBT's copy (`docs/data.md` § CHIRPS), product `rnl` | 0.05° cells, mm/day, 1981-01-01 to the copy's `finalThrough` |
| The overlap window (D5) | the user; default the whole overlap | `[fromYear, toYear]` in hydrological years |
| Edited factors | the user | 12 numbers, or none |

A `.RAN` file belongs to a **rainfall zone**, which may cover several
quaternaries. The method extends the file as a whole, over the union of the
quaternaries it serves, never per sub-catchment (method B pieces share the
extended file unchanged).

## The algorithm

Notation: `y` a hydrological year, `k = 0…11` its month (0 = October,
11 = September), `r[y][k]` the `.RAN` value (% of model MAP), `c[y][k]` the
CHIRPS monthly total over the area (mm), `p[y][k]` that total as % of the
CHIRPS MAP.

### Step 1. Cells and weights

The backend lists every 0.05° CHIRPS cell the polygon touches, with
`share` = the fraction of the cell's area inside the polygon, by exact
clipping (IC-WBT's `feeds/boundaryCells.ts`, copied: Sutherland–Hodgman per
cell, holes subtracted, MultiPolygon parts added). The weight is

    w_i = share_i × cos(latitude of cell i's centre)

which is the cell's area inside the polygon up to a constant (a 0.05° cell's
area is proportional to cos φ to better than 1e-4 within the cell). Cells
with `share < 0.001` are dropped, as IC-WBT does (their effect on the mean
is below 0.1 % of one cell's rain).

Pitman's limit differs from IC-WBT's feed limit (100 cells): a rainfall zone
can be several quaternaries. **Limit: 2 000 cells** (about 50 000 km² at
South African latitudes), refused above that with the cell count.

### Step 2. Daily to monthly, per cell

For each cell and calendar month, the monthly total is the sum of that
month's daily values. February has 29 days in a leap year and 28 otherwise:
the copy's finals layout has 366 day-of-year slots and slot 365 is always
NaN in a non-leap year, so the reader **must** sum by calendar date, never
by slot (a non-leap year's slot 365 is not a missing day).

A cell-month is **valid** when every one of its days holds a value. A day is
NaN in the copy for the sea, for a chunk never written, or for no data.

A cell that is NaN on every day of the record is a sea or no-data cell: it
is removed from the cell list before any month is computed, and the screen
says how much of the polygon's weight that removed (a coastal quaternary).

### Step 3. Area mean per month

    c[y][k] = Σ_valid w_i · C_i[y][k] / Σ_valid w_i

over the cells valid for that month, **provided** the valid cells carry at
least **90 %** of the polygon's total weight. Otherwise the month is
**missing** (`null`), never zero. (90 % is IC-WBT's unit-coverage rule for
the MAP grid; with CHIRPS final data a land cell is almost never invalid, so
in practice this rule only fires on a corrupt or partial copy.)

Months are labelled into hydrological years: October to December of
calendar year `Y` and January to September of `Y + 1` are hydrological year
`Y`. CHIRPS starts in January 1981, so January to September 1981 belong to
the partial hydrological year 1980 and are not used (step 5).

### Step 4. CHIRPS MAP and % of MAP

    MAP_c = mean over Y_c of Σ_k c[y][k]
    p[y][k] = 100 · c[y][k] / MAP_c

where `Y_c` is every **complete** CHIRPS hydrological year: all 12 months
present and not missing. That is the full CHIRPS record, 1981/82 to the last
complete hydrological year, as the operator specified.

**The choice of period has no effect on the appended values** when the
factors are the computed ones. With the ratio estimator (step 5), the
appended value is

    f_k · p[y][k] = (Σ_O r[y][k] / Σ_O p[y][k]) · p[y][k]
                  = (Σ_O r[y][k] / Σ_O c[y][k]) · c[y][k]

and `MAP_c` cancels. It does matter for **edited** factors, which are
relative to the `p` the user sees, and for the factors shown: a later CHIRPS
month changes `MAP_c` slightly and so moves every computed factor by the
same ratio while leaving the results unchanged. So the sidecar records
`MAP_c` and its years, and re-applying saved factors uses the recorded
`MAP_c`, not a recomputed one.

### Step 5. The overlap and the 12 factors

The overlap `O` is the hydrological years that are in the `.RAN` and whose
twelve months all lie inside the CHIRPS record (from its first October to
the last September it reaches), narrowed to the D5 window if the user set
one; a window that runs past those years is clamped to them, with a note,
and one that misses them is refused. For a WR2012 record (1920–2009) the
default overlap is 1981/82 to 2009/10, 29 years.

`O` is *not* limited to `Y_c`: a year with a missing CHIRPS month stays in
the overlap and drops out of `O_k` for that month only (§ Edge cases), while
`MAP_c` (step 4) leaves the whole year out. (Round 4 correction: an earlier
draft defined `O` from `Y_c`, which made `O_k` always equal `O` and
contradicted the edge-case table.)

For each month `k`, with `O_k` the years of `O` whose `p[y][k]` is present:

    f_k = Σ_{y∈O_k} r[y][k] / Σ_{y∈O_k} p[y][k]

**The estimator is the ratio of the overlap totals** (equivalently, of the
overlap means). Alternatives considered:

| Estimator | Why not |
|---|---|
| mean of the yearly ratios `mean(r/p)` | undefined or explosive in a dry month (`p = 0` or near it), and biased upward (Jensen) |
| least squares through the origin `Σ r·p / Σ p²` | weights wet years most; does not reproduce the overlap's mean monthly rainfall |
| linear regression with intercept | 24 parameters, not 12; an intercept makes dry months wet |
| quantile mapping per month | corrects the distribution too, but is not "12 factors" and cannot be edited by hand; a possible later option |

The ratio of totals is the only one of these that **reproduces the model's
mean rainfall for every calendar month over the overlap exactly**, which is
what the extension must preserve: the corrected series has the same
monthly climatology as the series WRSM2000 was calibrated on. It needs no
special case for a zero month in a single year.

**Dry months.** With `ε = 0.05` (% of MAP, per year):

- `Σ_{O_k} p < ε · |O_k|` and `Σ_{O_k} r < ε · |O_k|`: both are dry. `f_k = 1`,
  note "dry in both".
- `Σ_{O_k} p < ε · |O_k|` but `Σ_{O_k} r ≥ ε · |O_k|`: CHIRPS is dry where the
  model is not; the ratio would be huge and meaningless. `f_k = 1`, flagged
  with a warning ("CHIRPS shows almost no rain in July over the overlap, the
  model's file does; the factor can't be estimated and is set to 1"). The
  user may edit it.
- `|O_k| = 0` (every overlap year of that month missing): `f_k = 1`, flagged.

**Short overlap.** `|O| < 5`: no factors are computed (all shown as 1,
flagged `shortOverlap`; the overlap means are still reported) and the user
must enter them or widen the window. `5 ≤ |O| < 15`:
computed, with a warning that the factors rest on few years. The default
overlap for any WR2012 network is about 29 years, so the warning shows only
for a narrowed window or an unusual file.

**No overlap or a gap.** If the `.RAN` ends before 1981/82 there is no
overlap: the method refuses (it can't calibrate CHIRPS to the file). If the
`.RAN`'s last year `y_N` is already ≥ the last complete CHIRPS year, there is
nothing to append and the method says so.

### Step 6. Editable factors

The screen shows each `f_k` with: the computed value, the value in use, its
note, and the overlap means of `r` and `p` for that month. The user may type
a value or reset it to the computed one.

Validation (the engine refuses outside the hard range; the UI warns inside
it):

| Value | Behaviour |
|---|---|
| not a finite number, `< 0`, or `> 5` | refused |
| `0` | allowed after a confirmation: "every appended July will have no rain" |
| `0 < f < 0.5` or `f > 2` | allowed, warned ("far from 1: check the fit") |
| `0.5 ≤ f ≤ 2` | allowed |

The bounds are deliberately loose: a dry month can carry a legitimately
large factor, and the fit plots are the real check.

The same check applies to **computed** factors (Round 4, `R4-E1`): the fit
warns on a computed factor outside `[0.5, 2]`, and on one above 5 says that
the engine won't accept it, so applying refuses until the user edits it or
narrows the window. A factor above 5 means CHIRPS and the file disagree
about the season (the wrong area, or a winter-rainfall file against a
summer pattern), which a user must look at rather than have silently capped.

### Step 7. Apply and append

For each hydrological year `y = y_N + 1, y_N + 2, …` in order:

- if `y` is a complete CHIRPS year, append the row
  `e[y][k] = round(f_k · p[y][k], 2)` (the `.RAN` holds two decimals,
  `docs/formats.md`), half away from zero, with the zone code of the file's
  other rows;
- otherwise **stop**. Appended years are contiguous: a year with a missing
  month stops the extension there, and the years after it are not appended
  even if complete (a `.RAN` has no way to say "missing"). The screen names
  the year and month that stopped it (`stoppedAt`, month 0 = October, as
  `RunMessage.at`; `null` when the stop is the partial last year).

The last complete CHIRPS hydrological year ends in September; a partial
year (CHIRPS finals through, say, March) is never appended. CHIRPS finals
lag about a month to six weeks (CHC publishes month M between the 20th and
the end of M + 1), so the extension normally reaches the September before
last, or last September from about mid-November.

The original rows are never changed. The function returns the extended
`RainfallSeries` and the sidecar entry; writing the file is the writer's job
(`src/io/rainfall.ts`).

### Step 8. Provenance (sidecar)

`pitman.json` gets one entry per extended file (rule 8; `Sidecar` in
`src/types.ts`, the entry is `RainfallExtension`):

```jsonc
{
  "rainfallExtensions": {
    "ZZA.RAN": {
      "method": "extend-1",
      "file": "ZZA.RAN",
      "area": { "quaternaries": ["Z01A", "Z01B"], "areaKm2": 812.4,
                "cells": 41, "weightRemovedPct": 0.0 },
      "chirps": { "product": "CHIRPS v3 rnl (final)", "copy": "IC-WBT rain data copy",
                  "manifestRevision": 17, "finalThrough": "2026-09-30",
                  "doi": "10.15780/G2JQ0P", "accessed": "2026-10-28" },
      "chirpsMap": { "mm": 452.8, "years": [1981, 2025] },
      "overlap": { "from": 1981, "to": 2009, "window": "default" },
      "factors": [ { "month": "Oct", "computed": 0.8330, "used": 0.8330, "note": "" } /* … 12 */ ],
      "appended": { "from": 2010, "to": 2025, "rows": 16 },
      "originalEndYear": 2009,
      "stoppedAt": null,
      "createdAt": "2026-10-28T00:00:00Z"   // optional, stamped by the app
    }
  }
}
```

`factors[].used` differs from `computed` only when the user edited it; an
edited factor carries `"edited": true` and the user's note (an unedited one
carries the fit's note). `copy` names the store that answered
(`ChirpsMonthly.source`: IC-WBT's copy, or the local synthetic copy), and
`createdAt` is optional: the engine doesn't read the clock, so the app
stamps it (the sidecar's `savedAt` dates every save in any case).

**Re-extending** a file that already has an entry (CHIRPS has gained months):
`refitFromSidecar` drops the rows after `originalEndYear`, refits on the
recorded overlap with the **recorded** `MAP_c`, and returns the factors used
last time; applying them reproduces the years appended before (unless the
copy revised them, `manifestRevision`) and continues past them. The overlap
must never reach into CHIRPS-derived rows, which is why the appended rows are
dropped before the fit. Every appended year is marked by
being in `appended` (WRSM2000 ignores the sidecar; the `.RAN` itself carries
no marks).

## Edge cases and their behaviour

| Case | Behaviour |
|---|---|
| CHIRPS month missing inside the overlap | that year drops out of `O_k` for that month only; the other months keep it. Listed under the fit. |
| CHIRPS month missing after the overlap | the extension stops at that hydrological year (step 7). |
| Leap years | months summed by calendar date; February is 29 days in a leap year; slot 365 of a non-leap year is ignored, not "missing". |
| Partial last hydrological year | never appended; the screen says how many months of it CHIRPS holds. |
| Polygon partly outside CHIRPS land (coast) | sea cells (NaN throughout) removed; their share of the weight shown; above 10 % a warning. |
| Polygon smaller than a cell, or inside one cell | allowed: the mean is that cell's value (or the few cells it touches, weighted). The screen says how many cells; with fewer than 4 it notes that CHIRPS can't resolve rain inside the area. Quaternaries are far larger than a cell, so this mainly guards hand-drawn areas. |
| Polygon outside the copy's region (10–41° E, 35.5–8° S) | refused (`MirrorOutsideRegionError` in the copied reader). |
| More than 2 000 cells | refused with the count. |
| CHIRPS v2 and v3 | the copy holds only v3 (`rnl` from 1981, `sat` from 1998). Pitman uses **v3 `rnl`** only, because it is the one that spans the whole overlap; `sat` and v2 are never mixed in. If another product is ever offered, the factors are always computed and applied with the **same** product, and the sidecar names it. |
| The copy revises a month (a manifest revision) | the sidecar's `manifestRevision` is older than the copy's: the screen offers to recompute. Nothing changes until the user applies. |
| `.RAN` already reaches the present | nothing to append; the fit is still shown, for information. |
| `.RAN` ends before 1981/82 | refused: no overlap. |
| Overlap < 5 years | no computed factors; user enters them. |
| Overlap 5–14 years | warned. |
| Factor edited to 0 or extreme | see step 6. |
| Two `.RAN` files cover one quaternary | each is extended on its own area; the user picks each file's quaternaries. |

## Fit diagnostics (the screen, agent 4.4)

Over the overlap, before (`p`) and after (`f·p`) correction:

1. **Monthly scatter**: `p[y][k]` (x) against `r[y][k]` (y), coloured by
   calendar month, 1:1 line; a toggle shows `f_k · p` instead.
2. **Mean monthly bars**: for each month, the overlap mean of `r`, of `p` and
   of `f·p`; the factor is printed above each group.
3. **Annual totals**: `Σ_k r`, `Σ_k p` and `Σ_k f·p` per hydrological year,
   over the overlap and then the appended years (the appended stretch shaded),
   so the user sees the extended series continue the old one.
4. **Numbers** (a small table):
   - monthly R² (squared Pearson correlation of all overlap months, pooled),
     before and after;
   - monthly NSE of `p` and of `f·p` against `r`;
   - annual R² (`Σ_k p` against `Σ_k r`);
   - bias per month, `100 · (Σ p − Σ r) / Σ r`, before and after. After
     correction it is **0 by construction** for every month with a computed
     factor, so the table says that rather than showing a row of zeros as
     if it were a finding; it is non-zero only for edited or fallback months;
   - annual bias before and after.

R² is nearly unchanged by per-month scaling and NSE is the more telling
"after" number; both are shown.

The fit's `after` uses the computed factors; for edited ones the screen
calls `fitStatistics(overlapYears(ran, fit), factors)`. Monthly numbers pool
every overlap month whose CHIRPS value is present; annual numbers use the
overlap years with all twelve present. A statistic with no variance or too
few points is `NaN`, and a month's bias is `null` when the file has no rain
in it over the overlap.

## Worked example

Synthetic (no real catchment), computed by a throwaway script; Round 4's
tests reuse these inputs and expected outputs. Zone `ZZA`, one quaternary.

`.RAN` (% of model MAP), years 1979–1984, so `y_N = 1984`:

| Year | Oct | Nov | Dec | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1979 | 6.10 | 9.40 | 11.20 | 13.50 | 12.80 | 10.60 | 7.30 | 5.20 | 3.10 | 0.40 | 1.90 | 4.20 |
| 1980 | 5.80 | 8.70 | 10.10 | 14.90 | 13.20 | 11.30 | 6.90 | 4.80 | 2.70 | 0.10 | 1.60 | 3.90 |
| 1981 | 7.20 | 10.30 | 12.60 | 15.10 | 11.90 | 9.80 | 8.10 | 5.60 | 3.40 | 0.30 | 2.20 | 4.60 |
| 1982 | 4.90 | 7.60 | 9.30 | 11.80 | 10.70 | 8.90 | 5.70 | 4.10 | 2.20 | 0.20 | 1.30 | 3.10 |
| 1983 | 6.60 | 9.90 | 11.70 | 14.20 | 13.60 | 10.90 | 7.60 | 5.30 | 3.00 | 0.10 | 2.00 | 4.40 |
| 1984 | 5.40 | 8.20 | 10.40 | 12.70 | 12.10 | 10.20 | 6.60 | 4.70 | 2.80 | 0.30 | 1.70 | 3.60 |

CHIRPS monthly totals over the area (mm; `—` missing; 1987 holds only
October–December):

| Year | Oct | Nov | Dec | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1981 | 38 | 55 | 70 | 86 | 66 | 52 | 44 | 30 | 17 | 0 | 12 | 25 |
| 1982 | 27 | 41 | 52 | 66 | 60 | 49 | 31 | 22 | 11 | 0 | 7 | 17 |
| 1983 | 36 | 54 | 66 | 80 | 76 | 60 | 41 | 28 | 15 | 0 | 11 | 24 |
| 1984 | 30 | 45 | 59 | 72 | 68 | 57 | 36 | 25 | 14 | 0 | 9 | 20 |
| 1985 | 33 | 48 | 61 | 77 | 71 | 55 | 38 | 27 | 16 | 2 | 10 | 22 |
| 1986 | 29 | 44 | 57 | 70 | — | 53 | 35 | 24 | 13 | 0 | 8 | 19 |
| 1987 | 35 | 50 | 64 | | | | | | | | | |

**Step 4.** Complete CHIRPS years `Y_c` = 1981–1985 (1986 has a missing
February, 1987 is partial). `MAP_c = 452.8 mm`.

**Step 5.** Overlap `O` = 1981–1984, 4 years: under 5, so a real run would
refuse to compute factors. The example computes them anyway to show the
arithmetic (the tests call the estimator directly, and separately assert
the `|O| < 5` refusal):

| Month | mean `r` | mean `p` | `f_k` | Note |
|---|---|---|---|---|
| Oct | 6.025 | 7.233 | 0.8330 | |
| Nov | 9.000 | 10.766 | 0.8359 | |
| Dec | 11.000 | 13.637 | 0.8066 | |
| Jan | 13.450 | 16.784 | 0.8013 | |
| Feb | 12.075 | 14.907 | 0.8100 | |
| Mar | 9.950 | 12.036 | 0.8267 | |
| Apr | 7.000 | 8.392 | 0.8341 | |
| May | 4.925 | 5.797 | 0.8495 | |
| Jun | 2.850 | 3.147 | 0.9056 | |
| Jul | 0.225 | 0.000 | 1.0000 | CHIRPS dry, model not: set to 1, warned |
| Aug | 1.800 | 2.153 | 0.8359 | |
| Sep | 3.925 | 4.748 | 0.8266 | |

**Step 7.** 1985 is appended; 1986 stops the extension (February missing);
1987 would not be appended anyway (partial). `p[1985]` =
7.288, 10.601, 13.472, 17.005, 15.680, 12.147, 8.392, 5.963, 3.534, 0.442,
2.208, 4.859, and the appended row is

    ZZA    1985   6.07   8.86  10.87  13.63  12.70  10.04   7.00   5.07   3.20   0.44   1.85   4.02

(annual sum 83.75 % of the model MAP; the column layout is the writer's,
`docs/formats.md`, shown here only to fix the rounding).

**Diagnostics** over 1981–1984:

| | before | after |
|---|---|---|
| monthly R² | 0.9988 | 0.9994 |
| monthly NSE | 0.813 | 0.9993 |
| annual totals, model | 91.10, 69.80, 89.30, 78.70 | |
| annual totals, CHIRPS % MAP | 109.32, 84.58, 108.44, 96.07 | 90.05, 69.59, 89.27, 79.08 |
| annual R² | 0.9968 | |
| annual bias | +21.13 % | −0.27 % |

The after-bias is not zero only because July kept the fallback factor 1:
CHIRPS has no July rain over the overlap, so the corrected series is short
of the model's 0.225 % a year there. That is exactly the case the warning
exists for.

## Open questions (with proposed defaults)

- **A1** The hydrological-year label of a `.RAN` row: default the October
  year, to be confirmed by `docs/formats.md` (agent 1.4) against the real
  files.
- **A2** Use January–September 1981 (the partial first CHIRPS year) in the
  per-month overlap sums? Default **no**: whole hydrological years only, so
  every month has the same years and the annual plot matches.
- **A3** Coverage threshold for a month (90 % of weight) and the dry
  threshold `ε = 0.05 %` of MAP per year: defaults as stated.
- **A4** Minimum overlap: refuse below 5 years, warn below 15: defaults as
  stated.
- **A5** Factor hard range `[0, 5]`, warn outside `[0.5, 2]`: defaults as
  stated.
- **A6** Should Pitman ever offer the `sat` product (1998+) as an
  alternative? Default no (shorter overlap, and two products would invite
  mixing).
