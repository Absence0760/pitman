# User guide

How to take a WRSM2000 network through Pitman: load it, extend its rainfall,
run it, read the results, calibrate, and save. What the model does and how far
it agrees with WRSM2000 is on the app's Methods page (`/methods`); read that
before you rely on a result. In short: **Pitman doesn't yet reproduce WRSM2000
across a whole network, and its irrigation model hasn't been compared with it.** Check anything that
matters by opening the saved network in WRSM2000.

Your network stays in your browser. Extending rainfall sends the outline of an
area to Pitman's data service, and never a network file.

## Load a network

Drop a zip or a folder on the first screen, or choose one. It's the same folder
WRSM2000 uses: the `.NET`, the module `.DAT` files, the `.RAN` rainfall files,
observed `.obs` files and any defined-flow or demand files. A folder holding
several `.NET` files asks which one to open. Names are matched without regard to
case, as on Windows.

If something is wrong, every problem is listed with its file, line and field.
Warnings don't stop a load: read them anyway. Modules Pitman can't simulate are
listed under "Kept but not modelled".

The browser keeps a working copy, so a reload brings the network back. **Forget
the working copy** removes it. Your real copy is the zip you save.

## Extend rainfall with CHIRPS

Optional. **Extend rainfall with CHIRPS** lists each `.RAN` with the modules that
read it.

1. Choose **Extend** on a file and upload the area it represents as GeoJSON.
   Until the quaternary boundaries are licensed, you supply the boundary.
2. Fetch CHIRPS. Pitman averages it over the area and compares it with the file
   over the years both cover.
3. Look at the fit: the scatter, the mean monthly bars and the annual totals.
4. Check the 12 monthly factors, October first. You can change any of them, or
   narrow the overlap years. Factors far from 1 are flagged; check the fit before
   you accept one.
5. **Apply**. The corrected CHIRPS years are appended and marked as CHIRPS-derived
   in `pitman.json`, with the factors, the window and the fetch date.

The run stops at the `.NET`'s last year, so after extending, Pitman offers to move
it once every rainfall file in use reaches further. Applying clears old results.

## Run

Pick the modes and **Run**. The run happens in the background, and **Cancel** stops
it.

| Mode | Development | Use it for |
|---|---|---|
| Present day | held at the year you choose (2025 by default) over the whole record | today's yield and flows |
| Natural | removed: dams, irrigation, abstractions, paved areas and streamflow reductions | naturalised flows |
| Historical | as the files' year tables give it | comparing with gauges, calibration |

One mode failing doesn't lose the others: the failure is shown and the rest
appear in Results.

## Read the results

Pick a route or reservoir. A route with a gauge opens with the statistics period
set to the gauge's record, and shows observed flow beside the simulated.

- **Flow statistics:** MAR, mean log, standard deviation, log standard deviation
  and seasonal index (TT 689 pp.61–62), with the coefficient of variation. At a
  gauge each has its error and whether that's within the TT 689 p.177 guidelines
  (under 4 % for MAR and mean log, 6 % for the standard deviations, 8 % for the
  seasonal index). The manual calls these guidelines, not firm criteria.
- **Period:** change the years, or leave out months flagged incomplete (`+`). Only
  years with all 12 observed months are compared, on both sides.
- **Charts:** monthly and annual hydrographs, mean monthly flows (October first) and
  the flow-duration curve. Every chart has a data table under it.
- **Downloads:** an `.ANS` per run in WRSM2000's layout, and a CSV with every run and
  the observed flows.

Flows are in million m³ per month, or per year where a chart says so.

## Land-use tables

**Land-use tables** brings a runoff module's afforestation, alien vegetation and
paved area up to date, usually to 2025. The line above the picker says how many
modules have tables and how many stop before 2025, and each module in the list
says how far its tables reach. **Nothing changes until you apply it.**

1. **Choose a runoff module.** A sub-divided network's pieces are modules like any
   other, and each piece's table says how it was shared out.
   - An **SFR child** is edited here, though Calibrate sends you to its parent. Its
     parameters are the parent's, but its land-use table is its own: a run reads it
     as the child's active area and takes that off the parent year by year.
   - An **SFR parent** holds no afforestation or alien vegetation of its own, so the
     screen links to its children. It can hold paved area; a child can't. A child
     holds one kind of land use (TT 689 p.140).
2. **Edit the table.** Each row has its year, its value and what the network file
   holds. **Add a year** offers 2025 first. **Reset** goes back to the file's value
   and **Remove** takes a year out; a year you removed stays in view with **Put
   back**. A table with species or composition lines (afforestation, alien
   vegetation) keeps its last year, because the file holds those lines only while
   the table has a row: set it to 0 if the area has gone.
3. **Say where each value came from.** A changed value needs a source note. When one
   survey answers several values, **Same source for all of them** fills the empty
   notes. Going back to the file's value needs none.
4. **Read the chart.** It draws the series as a run reads it: **a straight line
   between the listed years, flat before the first and after the last**, one value
   for the whole hydrological year (2025 is October 2025 to September 2026). So a
   new last year changes every year back to the row before it, not just its own,
   and the screen says so. Edited years are hollow diamonds on a dashed line, and
   the data table below the chart gives every year in words.
5. **Fix what's marked.** The file keeps 1 decimal place for an area (L.008, L.013)
   and 3 for the paved fraction (L.018), so a value it can't hold exactly is refused
   with the two nearest offered. A paved fraction runs from 0 to 1. Alien vegetation
   can't exceed the module's area, and afforestation, alien vegetation, paved area
   and SFR children together can't exceed it in any year (TT 689 pp.127–128). A
   child's own limit is its parent's area; past its own L.002 area you get a warning
   (p.139). An area the file already had over the limit is said, not blamed on you.
6. **Apply to the working copy.** Pitman changes the module and clears the old
   results; run the network again to see them. A module you leave with edits not
   applied keeps them, listed under the picker.

Two things to check: a run takes no flow reduction from afforestation in a **free
module** yet, and an alien vegetation algorithm of **None** means a run ignores the
table. The screen says so on the table. The species split and the composition are
shown but edited in WRSM2000, so a first year in an empty table saves them as zeros.

Each apply adds one entry per changed value to `values` in `pitman.json`, with the
module, the field, the year, the date and a note holding the change and your source:

```json
{ "target": { "module": { "type": "RU", "number": 7 }, "field": "afforestation.areaKm2", "year": 2025 },
  "source": { "kind": "manual", "note": "Land use: none → 14.5; Aerial photos 2025", "date": "2026-10-30T08:00:00.000Z" } }
```

The list is a log, so the file's value stays known after a save and reload.

## Calibrate

**Calibrate** changes one runoff module's parameters and shows the effect as you
type. It runs in historical mode. **Nothing changes until you apply it.**

1. **Choose a runoff module.** Modules that can't be edited stay in the list, greyed
   out, with the reason:
   - an **SFR child** takes its parent's parameters, so edit the parent;
   - a **Hughes** module can't run yet.
2. **Change a value.** Each row gives the parameter, its unit, the value in the
   network file and where that sits in the file (for example `L.035 v3`). **Reset**
   goes back to the file's value; **Reset all to the file** does the whole module.
   A classic module has POW, SL, ST, FT, GW, ZMIN, ZMAX, PI, TL, GL and R (line
   L.003). A Sami module uses its own copy of those (L.035) and the Sami parameters
   (L.031–L.034). A Sami run ignores GW and GL, and the screen says so.
3. **Watch the fit.** The network reruns shortly after you stop typing, and a newer
   edit cancels a run in progress. **Cancel** stops it, and **Run again** restarts it.
   - **Compare at** lists the routes below the module, gauges with observed flow
     first.
   - The fit table shows **Before** and **With edits** against **Observed**, using the
     same statistics and guidelines as Results, and the charts below show all three.
     Before means the working copy, so it's the file's values until you've applied
     something.
   - With **no gauge** below the module, or none in the network, the panel says so,
     and you can still compare your edits with the file's values at any route.
4. **Fix what's marked.** A value the model can't take stops the preview and says
   why, and a value that goes against the manuals' advice is flagged but allowed.
   The file holds each parameter to a fixed number of decimals, so a value it can't
   hold exactly is refused, with the two nearest offered. What you see is what the
   run uses and what the file gets.
5. **Apply to the working copy.** Add a reason if you like. Pitman changes the
   module, keeps the working copy and clears the old results; run the network again
   to see them with the new values.

Read a fit with the model's gaps in mind. **Irrigation is new and hasn't been compared
with WRSM2000**; the panel warns when the network has irrigation. Don't tune a
catchment's parameters to absorb a difference below an abstraction. The priority when the guidelines
conflict is MAR, then standard deviation, then seasonal index (TT 689 p.177).

On an SFR parent, a change reaches its children: they take the parent's parameters
and are calibrated to their reduction targets again in every run.

### What gets recorded

Each apply adds one entry per changed value to `values` in `pitman.json`:

```json
{
  "target": { "module": { "type": "RU", "number": 1 }, "field": "sami.pitman.ST" },
  "source": { "kind": "manual", "note": "Calibration: 150 → 180; deeper soils", "date": "2026-10-30T08:00:00.000Z" }
}
```

The list is a log, oldest first. Its first entry for a value holds what the network
file had, so **Reset** still knows the original after a browser reload, or after the
saved zip is loaded again. WRSM2000 ignores `pitman.json`; the new values themselves
are in the module's `.DAT` file.

## Save

**Save as WRSM2000 zip** stays in the bar at the top. The zip holds every file you
loaded: an unchanged file byte for byte, a changed one in WRSM2000's standard layout,
and anything Pitman didn't read (such as `Out/`). `pitman.json` goes beside the `.NET`.
Open it in WRSM2000 to check it.

## Sub-division and the map

The map shows the quaternaries from the first screen. On a local copy it draws invented
boundaries and terrain; real ones need a licence decision. The method is in
`docs/theory/subdivide.md`:

- Pick a quaternary on the map and split it by a **tributary**, from a point on the
  river, or by a **MAP zone**, drawn by hand or proposed from a MAP-grid threshold.
- A piece only gives a runoff module its own area and MAP. Every piece uses the
  quaternary's `.RAN`, extended as above, so each gets its own rainfall in mm.
- Each piece starts at the gridded MAP over its boundary. All pieces are then scaled
  by **one common factor**, rerunning in natural mode, until the natural MAR at the
  quaternary's outlet is within **2 %** of the target. You enter the target (WR2012's
  naturalised MAR, with its table and period); without one, the unsplit module's own
  natural run is used. Each iteration is shown, the ratios between pieces don't
  change, and a factor that doesn't converge is never applied silently.
- A tributary drains into the remainder, in series. MAP-zone pieces drain side by side
  to the same outlet. The final factor and its source go into `pitman.json`.

## Demands

**Demands** lists every demand and defined-flow file on the network's routes: what
reads it, its years, the mean annual volume and where it came from. A file that stops
short of the run is marked, because a historical run stops at the first missing year.

**New demand** makes one, mostly for domestic supply:

- **Attached to:** a reservoir or channel reach, then a route. A new route to the zero
  sink is on offer until the module is full (5 outflows on a reservoir, 10 on a channel).
  A route that can't take a demand stays in the list and says why: the spill or
  principal route, one feeding an irrigation block, one that carries another file.
- **Annual volume:** the base year and its volume, in million m³ a year.
- **Monthly distribution:** 12 shares, October first, adding up to 100 %. The sum shows
  as you type; **Even distribution** and **Scale to 100 %** are shortcuts.
- **Growth:** the volume in later years, with 2025 offered. Pitman draws straight lines
  between the years and holds the volume flat before the base year and after the last
  year. A row with no volume is left out. Years are hydrological: 2025 means October
  2025 to September 2026.
- **Where this comes from:** a note beside each value, kept in `pitman.json`. A value you
  leave alone keeps its recorded source; a changed one is marked typed in, with the date.

The preview shows the file before anything changes: its name, its years, every row
with the total the file holds beside the volume you asked for, what else Apply touches,
and the file as text. It covers every year of the run and carries on to the last growth
year. The file is named after the route (`SYRQ11.abs`) and uses WRSM2000's layout.

**Rounding.** A demand file keeps three decimals of a million m³ a month, which is
1,000 m³, so only a very small demand moves in steps: 0.03 a year spread evenly is
written as 0.002 a month, which comes to 0.024. Pitman shows the difference per year
and warns past 0.5 %. The run and the saved file use the rounded values, so what you see is what runs.

A file with no record in `pitman.json` can be viewed and replaced but not edited as a
volume, shares and growth, because monthly rows don't say how they were made. **Replace
it** starts the form from estimates of the file's rows, marked as such. If a file's rows
changed outside Pitman, or the run now goes further than a file, open it and apply to
regenerate it.

Natural mode ignores demands (decision D1). After applying, run again to see the effect.
The Land use screen fetches a (sub-)catchment's crop fields and dams, lets you confirm
how crops map to the irrigation module's crop types, and writes the irrigation and
farm-dam rows, 2025 by default. It needs the operator's Cape Farm Mapper token, so a
deployed site says the data isn't available until then. Run locally it shows invented
data and says so. The remaining year tables and demand files are specified but not
built.
