# Method B: sub-dividing a quaternary

This page specifies how Pitman splits one quaternary's runoff module into
pieces, and how it sets each piece's MAP. It is the contract for Round 5:
the tributary delineation (agent 5.2, backend), the MAP-zone geometry
(agent 5.3, `src/subdivide/zones.ts`), the split engine and `calibrateMap()`
(agent 5.4, `src/subdivide/**`) and the wizard (agent 5.5). The operator's
method is issue #3, *Methods the user specified*, B, with decision D2
(decided) and D2a, D6 (open, defaults below).

The file formats (`.NET`, RU/RV/RR `.DAT`) are in `docs/formats.md`; this
page talks about the typed model (`Network`, `Route`, `RunoffModule`, … in
`packages/wrsm/src/types.ts`) and names a file field only where the rule
depends on it.

## What a sub-catchment is for

A piece exists **only** to give a runoff module its own **area** and
**MAP**. Every piece of a quaternary uses the quaternary's `.RAN`
(extended per method A, `extend.md`), so each piece's monthly rain is

    P_i(t) = (%MAP(t) / 100) · MAP_i

(TT 690 §1.3: catchment rain = % MAP × MAP). Nothing else about the rain
differs between pieces.

## The two ways to split

Both produce pieces that tile the quaternary polygon `Q` exactly: no gaps,
no overlaps, areas adding up (invariant 1).

### Hydrological split (a tributary)

1. The user clicks a point on a **terrain channel** inside `Q`. The terrain
   channels are the DEM's own drainage lines, drawn while the tool is on
   (IC-WBT `delineation/channels.ts`, copied; `docs/data.md` § Code to copy).
2. The backend delineates the catchment draining to the point with IC-WBT's
   `delineate()` (copied): the point placed on the nearest DEM cell within
   150 m with at least 1 km² draining through it (`place.ts`), a window of
   1 024 cells (about 34 km at zoom 11, about 32 m a cell over the Western
   Cape) grown to 2 048 and 3 072 while the catchment reaches the window's
   edge, Priority-Flood+ε fill, D8, every cell upstream of the outlet. The
   result is a cell mask `D` on the window grid. Refusals keep IC-WBT's codes
   and messages (`outside`, `no_data`, `off_channel`, `too_small`,
   `too_large`, `larger_channel`).
3. **Clip in raster space.** `Q` is rasterised onto the same window grid
   (cell centre inside the polygon; IC-WBT `subcatchments.ts` `rasterize`),
   giving `Qm`. The tributary mask is `T = D ∧ Qm`. The part of `D` outside
   `Q` is dropped and reported (km² and % of `D`): the DEM's divides and the
   DWS quaternary boundary disagree by a few cells along most edges, and a
   click on a river that enters `Q` from upstream would otherwise pull in the
   upstream quaternary. **Above 20 % of `D` outside `Q`, a warning**: "most of
   this river's catchment is outside the quaternary; its flow from upstream
   already reaches this quaternary by route. Click further down a tributary
   that rises inside it."
4. `T` is outlined with `traceRings` and simplified to about one cell
   (IC-WBT `outline.ts`), giving polygon `T_poly`.
5. **The remainder** is `R_poly = Q − T_poly`, a vector difference
   (`polyclip-ts`, `docs/data.md`). `R_poly` may be a MultiPolygon (a
   tributary that cuts `Q` in two); that is allowed, a piece is a lumped
   module and need not be contiguous.
6. Areas are geodesic (IC-WBT `geo/area.ts`): `A_T = area(T_poly)`,
   `A_R = area(Q) − A_T`, so they add up exactly. Then both are scaled to the
   module (§ Areas).

Refused: `A_T < 1 km²` (below the DEM's 1 km² channel threshold), or
`A_T > 0.95 · area(Q)` ("the tributary is almost the whole quaternary: there
is nothing to split").

A quaternary is at most a few thousand km², so `D`, clipped or not, fits the
request's largest window (3 072 cells, about 100 km); Pitman does not need
IC-WBT's background delineation worker. A catchment still at the edge of
3 072 cells is refused (`too_large`), never cut off.

### MAP-zone split

The zone `Z` comes from one of:

- **A drawn polygon**, by hand or pasted (GeoJSON/WKT), checked as IC-WBT
  checks an upload (`geo/geojson.ts` `checkGeometry`: closed, simple rings,
  holes inside, size limits).
- **A MAP-grid threshold**: the cells of the chosen MAP grid (D6) with
  `MAP ≥ t` (a high zone) or `MAP ≤ t` (a low zone) whose centres lie in
  `Q`, as a mask on the grid; regions smaller than 1 km² are dropped; the
  mask is outlined along cell edges (`traceRings`) and simplified by half a
  cell. The screen shows the zone and lets the user move `t` before
  accepting.

Then `Z_q = Z ∩ Q` and `Rest = Q − Z_q` (vector, `polyclip-ts`). Areas as
above: `A_Z = area(Z_q)`, `A_Rest = area(Q) − A_Z`. Refused when either
piece is under 1 km².

### Repeated splits

A split acts on one piece; the result can be split again (a tributary inside
a MAP zone, two zones). At most **8 pieces** per quaternary. Each split is
recorded in the sidecar in order, so the pieces can be rebuilt.

## Areas

The runoff module's area in the network (`.DAT`) is what WRSM2000 was run
with, and need not match the DWS polygon's geodesic area exactly. The pieces
**keep the module's total**:

    A_i = A_module · area_i / Σ_j area_j

and are rounded to the file's precision with the largest-remainder rule so
they sum to `A_module` exactly. The screen shows each piece's polygon area,
the scale `A_module / Σ area_j`, and warns when it is outside `[0.95, 1.05]`
("the network's area for this module differs from its boundary by 7 %:
check you picked the right quaternary").

## Each piece's MAP (D2)

### Starting values: the gridded MAP

For each piece, the mean of the chosen MAP grid over its polygon:

    MAP⁰_i = Σ_c s_c · a_c · M_c / Σ_c s_c · a_c

over the grid cells `c` it touches, `s_c` the share of the cell inside the
piece (exact clipping) and `a_c` the cell's ellipsoidal area, cells without a
value left out of both sums (IC-WBT `geo/gridShares.ts`, copied, as its
"MAP for each unit" does). A piece with values over less than 90 % of its
area is **not covered** by that grid: the screen says so and offers another
grid or a typed MAP. A piece smaller than one grid cell gets the value of the
cell(s) it lies in, weighted; with fewer than 4 cells' area the screen notes
that the grid cannot resolve rain inside the piece.

**One grid for every piece of a quaternary**, never a mix (IC-WBT's rule:
two grids can differ by tens of percent in mountain catchments). D6
default: the finest grid covering every piece, named on screen with its
cell size and source.

### Calibration: one common factor

The pieces' MAPs are then scaled by **one** factor `s`:

    MAP_i(s) = s · MAP⁰_i

so the ratios between pieces stay as the grid gives them (invariant 2). `s`
is chosen so that the quaternary's **natural MAR** matches the target `T`
(D2a) within 2 %.

**What is compared.** `MAR(s)` is the mean annual natural runoff, in Mm³/a,
**generated by the quaternary's pieces** (the sum of the pieces' natural
outflows, before any route, reservoir or channel), averaged over the
hydrological years of **WR2012's period**: the `.RAN` years before
extension (`extend.md`; for WR2012 networks 1920/21 to 2009/10). The
CHIRPS-appended years are excluded. It is the quaternary's **incremental**
natural MAR, which is what WR2012 tabulates per quaternary: upstream inflow
is not included.

Because the comparison is incremental and natural (no dams, irrigation,
abstractions or SFR, D1), only the pieces' runoff modules need to run; the
rest of the network does not affect `MAR(s)`. `calibrateMap()` runs just
those modules, which keeps an iteration to milliseconds.

**The iteration** (`calibrateMap`, pure):

    e(s) = MAR(s) − T
    s₀ = 1
    if |e(s₀)| / T ≤ 0.02: done, s = 1
    s₁ = s₀ · T / MAR(s₀)                         (the ratio: the first step)
    s_{n+1} = s_n − e(s_n) · (s_n − s_{n−1}) / (e(s_n) − e(s_{n−1}))   (secant)
    stop when |e(s_n)| / T ≤ 0.02

Guards:

- **Bounds.** `s` is kept in `[0.5, 2.0]`. A step outside is clamped and the
  iteration marked `clamped`; two clamped steps at the same bound end it as
  failed ("the MAPs would have to change by more than a factor of 2: check
  the target and the grid").
- **Flat secant.** If `e(s_n) = e(s_{n−1})`, or the secant step leaves a
  bracket already found (a sign change of `e` between two iterates), the step
  is a **bisection** of that bracket instead.
- **No runoff.** `MAR(s₀) = 0`: refused ("the natural run gives no runoff, so
  no factor can be found").
- **MAP limits.** Every `MAP_i(s)` must be within the engine's MAP range
  (1–12 000 mm); a step that leaves it is clamped as above.
- **Cap.** At most **12** evaluations of `MAR` (the starting one included).

**Failure.** If the cap is reached or the bounds end it, `calibrateMap`
returns `status: "not_converged"` with every iteration and the best one (the
smallest `|e|`). Nothing is applied: the wizard shows the log and offers
**Use the best factor** (recorded as not converged), **Change the target**,
or **Cancel**. It never applies an unconverged factor silently.

**The log.** Each iteration returns
`{ n, s, maps: number[], marMm3, errorPct, step: "start" | "ratio" | "secant" | "bisect" | "clamped" }`;
the wizard shows them as a table (factor, MAR, % error, each piece's MAP),
and the final one goes into the sidecar with the target and its source.

**Rounding.** The final `MAP_i` are rounded to the file's precision
(`docs/formats.md`); the reported MAR is recomputed with the rounded MAPs,
and must still be within 2 % (if rounding pushes it out, which needs a tiny
MAR, the result is reported as such, not hidden).

Runoff is convex in MAP, so the ratio step overshoots when the start is far
off (see the worked example: +25 % at `s = 1`, then −41 % after the ratio
step). The secant recovers in two more steps. The ratio step is kept because
the operator specified it; the bracket and bisection guard make it safe.

### The target (D2a)

The operator decided the target is **WR2012's naturalised MAR** for the
quaternary. IC-WBT does not hold it in a form Pitman can read in
production (`docs/data.md` § Quaternaries and WR2012 values: the dataset is
blocked there on its licence, and lives only in the operator's local
database). Proposed default, in order:

1. **A value the user enters** from WR2012's tables, with its citation
   (volume and table), stored in the sidecar as a hand-entered value
   (rule 8). The wizard asks for it, prefilled with nothing.
2. **The unsplit network's own natural run** over the same period, always
   shown beside it as the cross-check. If the user enters no WR2012 value,
   this becomes the target, labelled "natural MAR of the unsplit module (no
   WR2012 value entered)". Splitting then preserves the quaternary's natural
   yield as the original network had it, which is the same intent.

A difference of more than 5 % between the two is shown as a warning: it
means either the value was mistyped or Pitman's natural run of the unsplit
module departs from WRSM2000's (a `docs/departures.md` item).

## Splitting the module and the network

The original runoff module is `M` (type RU, number `m`). Its pieces are
`P_1 … P_n`. One piece is the **outlet piece** and keeps the number `m`:

- tributary split: the remainder `R`;
- MAP-zone split: the larger piece by area (ties: the rest), so the
  common case of a small high-MAP zone keeps `m` on the rest.

Every other piece gets a **new module number**: the largest RU number in the
network plus one, in piece order. Module numbers are per type in WRSM2000
(`1RU`, `1RV`, `1RR`, `1CR` coexist; `docs/formats.md` § `.NET`). New pieces
are inserted in the `.NET` module list **immediately before** `M`, so
anything that runs after `M` still runs after every piece. File names follow
the network's own pattern (e.g. `<prefix>RU<n>.DAT`).

### Fields of a runoff module

| Kind | Fields | Rule |
|---|---|---|
| **Set** | area, MAP | from § Areas and § MAP |
| **Copied** (intensive) | every Pitman parameter (POW, SL, ST, FT, GW, AI, ZMIN, ZMAX, PI, TL, GL, R, …), the rainfall file and its zone, evaporation (zone and monthly values), the groundwater method and every Sami/Hughes **rate or ratio** parameter, file version, flags | copied unchanged to every piece |
| **Split** (extensive) | afforestation area by year (per species/group), alien vegetation areas by year and density class, paved area by year, groundwater abstraction volumes, any other direct abstraction volume | each piece gets `share_i ×` the original, per year, rounded with largest remainder so every year's total is preserved |

`share_i` is the **location share** where the user has a polygon for that
land use (e.g. plantations drawn or imported: the area of it inside each
piece), else the **area share** `A_i / A_module`. The screen says which
was used, per table. `docs/theory/sami.md` (agent 1.3) must confirm which
Sami parameters are extensive; until it does, only the abstraction volumes
are treated as extensive.

### SFR parent and children

An RU module with SFR children (sub-areas whose afforestation or alien
vegetation is modelled as child modules; `docs/formats.md` § RU, TT 691
§7.4) is split as a group:

- every piece of the parent is a parent;
- each child is **split by share** into one child per piece that gets a
  non-zero share (area share by default, location share if its land use is
  located), attached to that piece; a child whose share in a piece rounds
  to zero area is not created;
- a child's MAP keeps its original ratio to the parent's: `MAP_child,i =
  MAP_i · MAP_child / MAP_M`, and the D2 factor scales it with its parent.

The alternative (assign each child whole to one piece) is offered in the
wizard when the user knows where the land use is.

### Routes

The typed model: a `Route` has a number, a `from` module (or none: an
external inflow) and a `to` module (or none: the network's end), and a
runoff module's outflow is divided over its outflow routes by percentages
summing to 100 (`docs/formats.md` § `.NET` and RU outflow splits). New
routes take the largest route number plus one, in order.

**The farm-dam pattern.** WR2012 networks usually model a quaternary's farm
dams as one lumped reservoir: `M` sends `p %` of its runoff to a farm-dam
module `V` (type RV) and `100 − p %` past it (the **bypass**) to the
downstream module `X`, and `V` spills to `X` too. Irrigation modules (RR)
draw from `V` or from a route. Pitman recognises that pattern (an RV module
that receives only `M`'s outflow) and splits it with the module.

**Tributary split (in series).** `T` joins the network **at `R`'s outlet**:

- `R` keeps number `m`, every outflow route of `M` and their `%` splits, and
  `V` (its capacity and area reduced to the dams inside `R`).
- `T` gets its own outflow routes, patterned on `M`'s: if any dams lie in
  `T`, a **new RV module** `V_T` (a copy of `V`'s parameters, capacity and
  area from the dams in `T`, new RV number), a route `T → V_T` with `p %`, a
  route `T → X` with `100 − p %`, and a route `V_T → X`; with no dams in
  `T`, one route `T → X` at 100 %.
- So `T`'s water passes everything downstream of `R`'s junction (the channel
  reach, a main-stem dam at the outlet), which is what "the tributary drains
  into the remainder" means for a lumped model: `R`'s lumped farm dams
  intercept only `R`'s own runoff, as before.
- If `M`'s outflow does not match the farm-dam pattern, `T` gets one route
  to the module `M`'s largest-% outflow route ends at, and the wizard lists
  the rewiring for the user to confirm.

**MAP-zone split (side by side).** Every piece gets outflow routes patterned
on `M`'s, to the **same** destinations with the same `%` splits; the outlet
piece keeps `M`'s routes and `V`; another piece gets its own `V_i` only if
dams lie in it, otherwise its `p %` route goes to `X` as well (so it
sends 100 % to `X`).

For a runoff module the two layouts reach the same downstream module; they
differ in which pieces have farm dams and where irrigation draws. That is
deliberate: a runoff module doesn't route flow through itself, so "series"
can only be expressed by where the tributary's water joins.

**`p` for a new piece's farm-dam route.** WR2012 sets `p` as the share of
the quaternary's area that drains into its farm dams. For a piece, the
default is the original `p`; when dam catchments are known (a later
refinement: delineating each dam on the DEM), `p_i` = the share of the
piece's area upstream of its dams. The sidecar records which.

**Inflow routes into `M`** (if any end at an RU module; `docs/formats.md`
says whether WRSM2000 allows it) go to the outlet piece.

**Irrigation modules** drawing from `V` are split by the irrigated area in
each piece (Cape Farm Mapper fields located in it, Round 7; else by area
share): each piece with irrigation gets an RR copy drawing from its own
`V_i` (or the same route as the original), with its area-by-crop table; its
return flow goes where the original's did. A piece with no irrigation gets
no RR module. **Main-stem reservoirs, channel reaches, demand files and
gauges are never split**: they stay on their routes.

**Farm dams** are assigned to the piece that contains the dam's point (or
its polygon's centroid). Where only a total is known (no locations), the
capacity and surface area are split by area share. The two are never mixed
within one quaternary: either every dam is located or the total is shared.

## Invariants (the engine's tests)

1. The pieces tile `Q` (polygon areas add to `area(Q)` to 1e-6 relative), and
   their module areas add to `A_module` exactly.
2. `MAP_i / MAP_j = MAP⁰_i / MAP⁰_j` for every pair (before rounding,
   to 1e-12).
3. Every split table's total is preserved per year (afforestation, alien
   vegetation, paved, abstraction volumes, irrigated area per crop, farm-dam
   capacity and surface area).
4. Every piece references the original `.RAN` and zone.
5. The network stays acyclic, every route's ends exist, every runoff
   module's outflow `%` sum to 100, and module and route numbers are unique.
6. **Equivalence:** with every `MAP_i = MAP_M` and nothing extensive in play,
   the pieces' summed natural runoff equals the unsplit module's, month by
   month, to floating point (Pitman's runoff depth does not depend on area,
   so `Σ A_i q = A q`). A split that breaks this is a bug.
7. `calibrateMap` terminates within 12 evaluations, and returns `converged`
   only with `|e| / T ≤ 0.02`.
8. Splitting and then merging the pieces (the inverse) gives back the
   original module's fields.

## Provenance (sidecar)

```jsonc
{
  "subdivisions": {
    "Z01A": {
      "method": "subdivide-1",
      "module": { "type": "RU", "number": 3, "areaKm2": 400.0, "mapMm": 640 },
      "splits": [
        { "kind": "tributary", "click": [20.7412, -33.5521], "snapM": 41,
          "dem": { "label": "Copernicus GLO-30 (Mapterhorn 0.0.13)", "fingerprint": "…", "zoom": 11 },
          "outsideQuaternaryPct": 3.1 }
      ],
      "pieces": [
        { "role": "tributary", "number": 16, "polygonKm2": 121.1, "areaKm2": 120.0, "gridMapMm": 820, "mapMm": 765 },
        { "role": "outlet",    "number": 3,  "polygonKm2": 282.6, "areaKm2": 280.0, "gridMapMm": 610, "mapMm": 569 }
      ],
      "grid": { "dataset": "…", "cellDeg": 0.001, "source": "…" },
      "calibration": {
        "target": { "marMm3": 24.0, "source": "hand-entered: WR2012 (WRC 2015), vol. …, table …" },
        "crossCheck": { "marMm3": 23.7, "source": "unsplit module, natural run, 1920–2009" },
        "period": [1920, 2009], "status": "converged", "factor": 0.9325,
        "iterations": [ /* the log */ ]
      },
      "shares": { "afforestation": "location", "alien": "area", "dams": "location" }
    }
  }
}
```

## Worked example

Synthetic; computed by a throwaway script whose numbers Round 5's tests
reuse. Quaternary `Z01A`, runoff module RU 3, `A_module = 400 km²`. The
network's largest numbers are RU 15, RV 8 and route 64. `M`'s outflow:
route 10 `RU3 → RV2` at 40 %, route 11 `RU3 → CR4` at 60 %; RV 2 spills by
route 12 to CR 4. Six farm dams, two of them in the tributary.

**Geometry.** The click delineates `D` = 125.0 km², of which 3.9 km²
(3.1 %) is outside `Q` and dropped. Polygon areas: `T` 121.1 km², `R`
282.6 km² (`area(Q)` = 403.7 km²). Scaled to the module: `A_T = 400 ·
121.1 / 403.7 = 120.0`, `A_R = 280.0` (scale 0.991, no warning).

**Grid MAP.** `MAP⁰_T = 820 mm`, `MAP⁰_R = 610 mm` (area-weighted 673 mm,
above the module's own 640 mm).

**Calibration.** For the example, the natural run is stood in for by a toy
convex response, runoff depth `q(P) = 0.0004 · max(0, P − 250)²` mm and
`MAR = Σ A_i · q(s · MAP⁰_i) / 1000` Mm³; the target is `T = 24.0 Mm³`.

| n | step | s | MAR (Mm³) | error | MAPs |
|---|---|---|---|---|---|
| 0 | start | 1.0000 | 30.110 | +25.46 % | T 820, R 610 |
| 1 | ratio | 0.7971 | 14.068 | −41.38 % | T 654, R 486 |
| 2 | secant | 0.9227 | 23.282 | −2.99 % | T 757, R 563 |
| 3 | secant | 0.9325 | 24.098 | +0.41 % | T 765, R 569 |

Converged at `s = 0.9325`; the ratio `MAP_T / MAP_R = 1.3443` is the grid's
(820 / 610) throughout.

**Rewiring.** `T` becomes RU 16 (inserted before RU 3). Two dams lie in
`T`, so it gets RV 9 (a copy of RV 2, capacity and area of those two dams)
and routes 65 `RU16 → RV9` (40 %), 66 `RU16 → CR4` (60 %), 67 `RV9 → CR4`.
RU 3 keeps routes 10 and 11 and RV 2, whose capacity is now the four dams in
`R`. Afforestation of 12.0 km² drawn on the map, 3.0 km² of it in `T`:
location shares, so RU 16 gets 3.0 km² and RU 3 9.0 km² in every year.

## Open questions (with proposed defaults)

- **B1** Does WRSM2000 allow a route to end at an RU module? If it does, the
  operator's literal "tributary drains into the remainder" could route `T`
  into `R`; default **no**: join at `R`'s outlet as above (which also keeps
  `T`'s water out of `R`'s lumped farm dams). `docs/formats.md` to confirm.
- **B2** Keep the module's area total (scale the polygon areas), or use the
  polygon areas as they are? Default **keep the total**, warn outside ±5 %.
- **B3** D2a, the target: default the hand-entered WR2012 value, else the
  unsplit natural run, with both always shown (§ The target).
- **B4** `s` bounds `[0.5, 2.0]`, cap 12, tolerance 2 %: tolerance decided
  (D2), bounds and cap proposed.
- **B5** SFR children with unknown locations: default split by area share;
  the wizard offers whole-assignment.
- **B6** `p` for a new piece's farm-dam route: default the original `p`.
- **B7** Which Sami parameters are extensive: `docs/theory/sami.md` decides;
  until then only abstraction volumes.
- **B8** Maximum pieces per quaternary: default 8.
- **B9** The 20 % "delineation mostly outside the quaternary" warning
  threshold: default as stated.
