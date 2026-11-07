# User guide

How to take a WRSM2000 network through Pitman: load it, extend its rainfall,
run it, read the results, calibrate, and save. What the model does and how far
it agrees with WRSM2000 is on the app's Methods page (`/methods`); read that
before you rely on a result. In short: **Pitman doesn't yet reproduce WRSM2000
across a whole network, and its irrigation model hasn't been compared with it.** Check anything that
matters by opening the saved network in WRSM2000.

Your network stays in your browser. Extending rainfall sends the outline of an
area to Pitman's data service, and never a network file.

## Sign in

Everyone signs in before using Pitman. There is no sign-up: an admin adds your
email address first.

1. Type your email address and choose **Send a code**. The screen says the same
   thing whether or not your address is on the list, so it never tells anyone
   who is.
2. Type the 6-digit code from the email and choose **Sign in**. A code works for
   10 minutes and once; **Send a new code** replaces it (codes can be sent a
   minute apart, five an hour). After 3 wrong codes the code is spent: send a
   new one. Too many tries locks the address for a while, and the screen says
   how long to wait.
3. **Use a different address** goes back to step 1.

You stay signed in on that browser for up to 7 days. If the session ends while
you work (it expired, or an admin removed you), Pitman goes to the sign-in page
and, once you are back in, to where you were. Your working copy is still there:
the redirect doesn't touch the browser's copy of your network.

The bar at the top shows the address you're signed in with. **Sign out** ends
this browser's session; **Sign out everywhere** ends it on every browser you've
used. Signing out doesn't remove the working copy: on a shared computer, use
**Forget the working copy** first.

The Methods and Privacy pages open without signing in.

## Users (admins)

An admin sees **Users** in the top bar. The page lists everyone who can sign in,
their role, and who added them when.

- **Add:** type the address and choose **Add**; tick **Admin** to let them
  manage users too. They can sign in straight away (Pitman doesn't email them:
  tell them yourself).
- **Make admin / Remove admin** changes the role.
- **Remove** asks first. The person is signed out on their next request and
  can't sign in again.
- Pitman always keeps at least one admin, and you can't remove yourself or your
  own admin rights. When the server refuses a change it says why, and the page
  shows that sentence as it is.
- **Mail bounced on … / Mail complaint on …** beside an address means a
  sign-in code to it bounced for good, or its owner marked Pitman's mail as
  spam, at that date. Codes may not reach them until it's fixed: check the
  address with them (remove and re-add it if it was mistyped), or ask them to
  mark Pitman's mail as not spam, then choose **Clear**.
- **Recent changes and sign-ins** lists the latest 50 entries of the audit log,
  newest first, in your time zone. Entries are kept for about 24 months.

Keep at least two admins, so that one admin's mailbox being unreachable doesn't
lock everyone out.

## Privacy

The Privacy page (`/privacy`, linked from the sign-in page and the footer) says
what Pitman keeps about you (your address, your role, an audit log of sign-ins
and changes, briefly your IP address for rate limits), why, where (AWS in Cape
Town), for how long, your rights under POPIA and how to complain to the
Information Regulator. Network files are never sent anywhere.

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

The steps down the left say where the network stands and mark the section you're
in. The optional steps start closed: **Show** opens one, and so does its step.
**Hide** only hides it. Nothing you typed there is lost.

If the working copy holds changes that aren't in a saved zip, **Forget the working
copy** asks first, and loading another network warns you. Applying a change clears
old results; the card you applied it in offers **Rerun the network**.

Everything works from the keyboard. **Skip to the page** is the first stop. On a map,
the arrow keys move it under a crosshair and Enter acts there; a quaternary can also be
chosen from its list, and a shape pasted as GeoJSON or WKT.

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

Anything the model has to say about a run stands at the top of Results, under
"Read before using these results": supply failures, an irrigation allocation of
0, area tables that don't cover the run. The same complaint across months is one
line, with how many months and which years. Notes that need no action are folded
below it.

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
table. The screen says so on the table.

**Species split and composition.** Under the afforestation table is its genus split
(pine, eucalyptus, wattle), rotations, optimal growth and required reductions (L.009,
L.010). Under the alien vegetation table are its three classes, ages, optimal area and
riparian share (L.014, L.015, L.011). Each value has what the file holds beside it,
**Reset**, and a source note once it changes, as a year does; the same Apply takes both.

- **Shares add up.** Change a share and the three must come to 100.00 %, to the two
  decimals the file keeps; the sum shows as you type. Shares a file arrived with are
  shown and left alone until you change one.
- **What a change does is on the screen.** An SFR child's line gives the MAR and low-flow
  targets a run calibrates it to, before and after, and the notes say which values its
  algorithm reads. A run works those targets out every time, so no calibration goes
  stale, but a fit of the parent to a gauge was made with the old ones: check it after
  the next run.
- **Rotations and optimal growth are read-only on a CSIR child.** WRSM2000 reads them
  through tables the manuals don't publish, so Pitman runs the child on Smoothed Gush
  targets and can't show what a change does, and WRSM2000's own log points to rotations
  when that calibration doesn't close. Change them in WRSM2000. On every other module
  they can be edited, though Smoothed Gush and User-defined don't read them.
- **The required reductions** can be edited only under the User-defined algorithm, the
  one that reads them. **The algorithm** isn't edited here: it decides how a run treats
  the area, and how a child is calibrated.
- **A first year in an empty table** opens the split in the same Apply, so set it then.
  Left alone it saves as zeros. A version 0 file has no lines for it.

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
- Land use, census rows and calibrated values can go on before or after a split. Each
  source note goes with its value: copied to every piece that keeps it, or, for an area
  or volume shared among the pieces, marked as divided, with this piece's part of the
  whole. Resetting such a value gives the piece its share.
- A quaternary is sub-divided once. Once a split is applied, step 1 stops a further split
  of its pieces and a second module under the same code, and says to go back to the zip
  saved before it. A plan the network can't carry (the pieces can't be connected, say) is
  refused at the review, with nothing changed: undo the split or start again.

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

**Remove** on a file's row asks first, and says what happens before anything does:

- **The routes.** An outflow route stays on its module and carries nothing, and a new
  demand can use it. That goes for a route Pitman added for the demand too. A principal,
  diversion or wetland route goes back to being simulated, and a route to an irrigation
  block goes back to the block's calculated demand. An inflow from another module goes
  back to what that module sends.
- **A route from the zero source goes with its file**, because such a route must have one
  (TT 689 p.xv). If a gauge or summary line names the route, or it is a wetland inflow,
  the removal is refused and the screen says why; change the network in WRSM2000 first.
- **A file several routes read** can come off all of them, when the file goes, or off one,
  when it stays for the rest with its spec and sources.
- **The file** leaves the working copy and the next saved zip, with its spec and sources in
  `pitman.json`. If a gauge reads the same file as its observed flow it stays in the zip.
- **One of the network's own files** needs a reason. There is no spec to make it again from,
  so `pitman.json` keeps one entry saying what was removed, what it held and why, and the
  card lists it. A demand Pitman generated needs no reason and leaves nothing behind.

**Undo the removal** puts everything back, until something else changes the network.
After that the only copy of a network's own file is the zip you loaded.

Natural mode ignores demands (decision D1). After applying or removing, run again to see
the effect.

## Crop fields and farm dams

**Crop fields and farm dams** fetches a (sub-)catchment's crop fields and dams, lets you
confirm how crops map to the irrigation module's crop types, and writes the irrigation
and farm-dam rows, 2025 by default. Choose a quaternary, upload a boundary or draw one;
only the shape is sent.

On the map a field has a solid edge: filled for irrigated, lightly filled where the
layer doesn't say, and empty for dryland. A dot is a dam, and a dashed line is the
boundary you gave. The key under the map names what's there, and the pointer gives a
field's crop.

It needs the operator's Cape Farm Mapper token, so a deployed site says the data isn't
available until then. Run locally it shows invented data and says so.
