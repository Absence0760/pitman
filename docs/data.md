# Data sources and reuse from IC-WBT

What data Pitman needs, where each dataset lives, under what licence, what
read access a separate AWS account needs, and which IC-WBT code to copy.
Round 4 (the data API, the cross-account PR, the CHIRPS extension), Round 5
(map and sub-division) and Round 7 (Cape Farm Mapper, farm dams) build on
it. Methods: [theory/extend.md](./theory/extend.md) (A) and
[theory/subdivide.md](./theory/subdivide.md) (B).

IC-WBT is `Absence0760/project-water-management` (public, MIT, same author).
Everything below was read from its `origin/main` at `f888e4461`
(2026-10-28): `docs/maps.md`, `docs/architecture.md`, `docs/deployment.md`,
`docs/data-model.md`, `docs/legal/map-data-licences.md`, `infra/*.tf` and
the source under `backend/src/{mirror,feeds,geo,delineation}` and
`frontend/src/lib/components/map`. Paths in this page are that repo's
unless they start with `packages/` or name Pitman. Pitman never writes to
IC-WBT and is not wired into it (issue #3).

## Summary

| Dataset | Pitman uses it for | Where it lives | Format | Licence | In IC-WBT production? |
|---|---|---|---|---|---|
| CHIRPS v3 daily (`rnl`) | method A | mirror bucket, `rnl/` | Zarr v3 + `manifest.json` | CC BY 4.0 | yes, once the backfill has run (check `rnl/manifest.json`) |
| MAP grid, Southwestern Cape (WAAS 2007, ~100 m) | method B, D6 | reference bucket, `reference/map-grid/…json.gz` | gzipped JSON of cell centres | terms not stated; IC-WBT operator's decision | yes, clipped to the client's area |
| MAP grid, national (Lynch 2004, 1′) | D6 alternative | not in production | ESRI grid (operator's download) | unconfirmed | **no** (blocked) |
| Quaternary boundaries (DWS) | the quaternary layer, method A area, method B `Q` | not in production; operator's local DB | GeoJSON | DWS open data, commercial terms unconfirmed | **no** (blocked) |
| WR2012 values per quaternary (MAP, **naturalised MAR**, monthly, period) | D2 target (D2a) | not in production; operator's local DB | CSV → table | WRC, redistribution terms unpublished | **no** (blocked) |
| DEM (Copernicus GLO-30, Mapterhorn Terrarium PMTiles) | relief layer, tributary delineation | tiles bucket, `tiles/terrain.pmtiles` | PMTiles, WebP Terrarium, z ≤ 12 | Copernicus DEM licence (free, commercial, adaptation allowed) | yes |
| Basemap (Protomaps/OSM) + label fonts | the map | tiles bucket, `tiles/south-africa.pmtiles`, `tiles/fonts/*` | PMTiles (vector), PBF glyph ranges | ODbL 1.0 / SIL OFL 1.1 | yes |
| DWS List of Registered Dams | D4 (larger dams) | not in production; operator's local DB | XLS + KMZ → table | none stated; DWS terms non-commercial | **no** (blocked) |
| JRC Global Surface Water v1.5 occurrence | D4 (area × 3 m) | tiles bucket, `tiles/water.pmtiles` (when `dam_trace_water`) | PMTiles, Terrarium PNG, z 12 | free, no restriction (Copernicus) | only if `dam_trace_water = true` |
| DE Africa Waterbodies v0.0.3 polygons | D4 (area × 3 m), alternative | reference bucket `reference/waterbodies/…` (operator's clip), or DE Africa's public bucket | GeoJSON / GPKG | CC BY 4.0 | only if loaded |
| WCG NGI dam outlines (`SpatialDataWarehouse/Hydrology/MapServer/0`) | D4 locations, alternative | Western Cape Government's public ArcGIS server | ArcGIS REST (polylines) | DWS/NGI, terms not stated | n/a (not IC-WBT) |
| Cape Farm Mapper crop census fields + dams | Round 7 (D3) | WCG ArcGIS Enterprise, token-secured | ArcGIS REST | WCG copyright; terms to ask | n/a (not IC-WBT) |

Three of the datasets the plan assumed IC-WBT holds (**quaternary
boundaries, WR2012 naturalised MAR, the register of dams**) are blocked
from IC-WBT's production on their licences and exist only in the
operator's local database. A cross-account grant cannot reach them, and
Pitman needs its own copy and its own licence decision for each
(§ Quaternaries, § Register of dams, open questions D-1 to D-3).

## CHIRPS: IC-WBT's rain data copy

**Where.** `s3://water-management-mirror-<IC-WBT account id>/` in IC-WBT's
region (`var.aws_region`, which its validation holds to `af-south-1`
unless a deliberate override). Private, versioned (old versions 30 days),
**SSE-S3** (AES256, no KMS), `DenyInsecureTransport`. Written by
IC-WBT's `mirror-ingest` Lambda (`infra/ingest.tf`, `ingest/`), daily.

**What.** CHIRPS **v3** from the Climate Hazards Center, for IC-WBT's region
D1 (10–41° E, 35.5–8° S) on CHC's 0.05° grid (620 columns × 550 rows,
`[0,0]` the south-west cell, centred 35.475° S, 10.025° E; rows grow north):

| Product | Meaning | From | Pitman |
|---|---|---|---|
| `rnl` | CHIRPS v3 final daily, ERA5-based disaggregation | 1981-01-01 | **used** |
| `sat` | CHIRPS v3 final daily, satellite-based disaggregation | 1998 (its year axis starts 1981, unwritten before 1998) | not used (`extend.md` A6) |
| `prelim`, `gefs/<issue>`, `era5l`, `imerg_late`, … | preliminary days, forecasts, other products | | not used |

**Layout** (`mirror/arrays.ts`, `mirror/grid.ts`): Zarr v3, float32, fill
NaN (sea, never-written chunk, no data), codecs `bytes` (little-endian) then
`gzip` level 6, default `/` chunk keys. The finals arrays are
`(year, doy[366], lat, lon)` in **(1, 366, 20, 20)** chunks; `year index =
year − attrs.firstYear` (1981), `doy index` = days since 1 January, so
slot 365 is NaN in a non-leap year. Attributes carry `region {w,s,e,n}` and
`grid {origin {lat, lon}, step}`; the reader checks both. A chunk that was
never written is read as all-NaN (zarr-python skips all-NaN chunks).

**Manifest** (`rnl/manifest.json`, `mirror/manifest.ts`): `revision` (moves
only when values change), `finalThrough` (the end of the **contiguous**
months held, never the newest day seen), `years`, and the upstream files
with a hash of their values. A day is final when the manifest says so; a
NaN on a final day is no data. Pitman reads `finalThrough` to know the
last complete month and records `revision` in the sidecar (`extend.md`
§ Step 8).

**Before Round 4 relies on it**: the one-off 1981 backfill
(`docs/deployment.md` § Backfill, `water-management-mirror-backfill`) must
have run for `rnl`. The operator checks `rnl/manifest.json`'s
`finalThrough` and that its files start in 1981-01 (Pitman's agents can't
read IC-WBT's account).

**A polygon's monthly series** (Pitman's `POST /chirps/monthly`, built in
Round 4.2 under `backend/src/chirps/`; § Pitman's data API):

1. `boundaryCells(polygon)` (copied, `feeds/boundaryCells.ts`): each 0.05°
   cell the polygon touches, `share` by exact clipping, weight
   `share × cos(lat)`; cells under 0.1 % dropped. Pitman raises IC-WBT's
   100-cell feed limit to 2 000 cells (`extend.md` § Step 1).
2. Each cell to the copy's indices (`grid.ts` `mirrorCell`: from the cell
   centre to the region's row/column in whole cells, never by matching
   floats); a cell outside D1 is refused.
3. Group the cells by 20 × 20 chunk (`cellsByChunk`) and, for each year
   1981 → `finalThrough`'s year, read each group's block (`readFinalsBlock`).
   About 46 years × 1–4 chunk groups per quaternary: tens to a couple of
   hundred GETs of ~0.6 MB uncompressed each. Run them a few at a time and
   cache the result by (polygon hash, manifest revision): a quaternary's
   result is a few KB.
4. Per cell, sum days into calendar months by date (leap years), then the
   weighted mean over valid cells per month and the 90 % coverage rule
   (`extend.md` §§ Steps 2–3). Return `ChirpsMonthly`
   (`packages/wrsm/src/extend/contract.ts`): `{ months: [{ year, month,
   mm|null }], cells, weightRemovedPct, areaKm2, product, revision,
   finalThrough, source }`, every month from 1981-01 to `finalThrough`'s.

As built: the 90 % rule is taken over the weight of the cells **kept** (after
sea/no-data cells are removed), so a coastal quaternary keeps its months
(R4-D1); a month with any day after `finalThrough` is `null`; `mm` is rounded
to 0.001 mm.

IC-WBT's `readCells` answers in its feed cache's shape (`f`/`p`/`-` day
codes, `encodeCellValue`), which Pitman doesn't need: copy the block
readers and write a small `readMonthly` instead (§ Code to copy).

**Licence and attribution.** CHIRPS3 is public domain, licensed CC BY 4.0
([chc.ucsb.edu/data/chirps3](https://www.chc.ucsb.edu/data/chirps3), read
by IC-WBT 2026-10-01). Credit wherever CHIRPS-derived values show (the
extension screen, the methods page, the sidecar): "Climate Hazards Center
Infrared Precipitation with Stations version 3 (CHIRPS3) Data Repository:
https://doi.org/10.15780/G2JQ0P (2025). Data was accessed on [date]." or
Funk, C. et al., *Sci Data* 13, 718 (2026).

## MAP grids (D6)

**Where.** IC-WBT keeps MAP grids in its **database** (`rain_map_dataset`,
`rain_map_cell_reference`, migration 207), not in S3; its production
loads come from one file in the **reference bucket**,
`s3://water-management-reference-<account>/reference/map-grid/<file>.json.gz`
(private, versioned a year, SSE-S3; read today only by IC-WBT's migrate
Lambda). Pitman has no database, so it reads that **file**.

**Which grids.**

| Grid | Cell | Coverage | In IC-WBT production | Licence |
|---|---|---|---|---|
| WAAS-SWCape-2007, "Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1." | ~100 m (0.001° after warping) | Southwestern Cape, **clipped to the client's area** (`--bbox`) | yes: `reference/map-grid/waas-swcape-2007.json.gz` per the deployment recipe (the operator confirms the exact key) | terms not stated; IC-WBT's operator decided to use it (2026-10-23, `legal/map-data-licences.md` § 3.3b). **Pitman needs the same decision recorded for itself.** |
| Lynch (2004) national MAP, 1 arc-minute (~1.7 km), WRC 1156/1/04, via the Schulze (2007) Atlas | 1′ | SA, Lesotho, Eswatini | **no**, blocked (CC BY-SA 4.0 and "No License Provided" at once) | unconfirmed |
| Synthetic (`backend/fixtures/geo/map-grid.synthetic.json`, region Z) | 0.01° | invented | dev/tests only | the repo's own |

So in production the D6 choice is, today, only the WAAS surface, and only
inside the client's box: a quaternary outside it has no grid, and the
wizard must say so and take a typed MAP.

**Format** (`geo/rainMap.ts` `rainMapToJson` / `rainMapFromJson`):
`{ "cellDeg", "source"?, "version"?, "attribution"?, "cells": [[lon, lat,
mapMm], …] }`, each cell by its centre, WGS84 degrees. A 1° box at
0.001° is about a million cells, ~25 MB of JSON before gzip.

**How Pitman reads it.** The API Lambda reads the object once per
container (cold start), indexes the cells by their south-west corner indices
(`evaporationGrid.ts` `originOf`/`indexOf`, the same keying IC-WBT's table
uses) into a `Float32Array` with NaN for no value, and answers:

- `POST /map-grid/mean` (polygon → `MapGridSample` (`packages/wrsm/src/types.ts`:
  `grid`, `cellSizeM`, `cellCount`, `meanMapMm`, `fetchedOn`) plus `cellDeg`,
  `coveragePct`, `version`, `attribution`, `source`) with `gridShares` (copied:
  share by exact clipping × the cell's ellipsoidal area; cells without a
  value excluded; under 90 % coverage → 422 "no MAP grid covers the area",
  with each grid's reason). Built in Round 4.2 (`backend/src/mapgrid/`).
  `cellSizeM` is the square root of the mean area of the cells used;
  `meanMapMm` is whole mm, as IC-WBT rounds a unit's;
- `GET /map-grid/points?bbox=` for the map layer, IC-WBT's limits (bbox at
  most 2° a side, at most 5 000 points, else `tooDense`). **Not built yet**
  (Round 5.1 needs it).

**Plugging in the real grids.** Neither real grid is in reach yet (WAAS
pending D-4; CHELSA v2.1, D-5, not yet converted). Each grid is one
`MapGridSource` (`backend/src/mapgrid/source.ts`) in a catalogue, and the
mean takes the **finest grid that covers the area** (D6), one grid, never a
mix. Today the environment configures one grid: `MAP_GRID_SOURCE=local`
(dev: `.local/map-grid/synthetic.json`) or `MAP_GRID_SOURCE=s3://bucket/key`
(the WAAS file, once D-4 allows), `MAP_GRID_DATASET` naming it. Adding CHELSA
means converting its GeoTIFF to this JSON form (or the raw `Float32` grid
above) and a second source in the catalogue.

IC-WBT's own `GET /projects/:id/map/map-grid` needs an IC-WBT session and
project, so Pitman can't (and mustn't) call it. If the JSON grows past a
comfortable cold start, convert it at deploy time to a raw `Float32` grid
plus a header in Pitman's own bucket.

## Quaternaries and WR2012 values (D2a)

**IC-WBT's table** `quaternary_reference` (migration 152) has `code`
(`^[A-Z][0-9]{2}[A-Z]$`), `geometry`, `area_km2`, `map_mm`, **`mar_mm3`**
(the WR2012 naturalised MAR), `monthly_mm3` (12, Oct–Sep), `period_start`,
`period_end` and `source`. The loader (`pnpm import:quaternaries … --values
wr2012.csv`, `geo/loadQuaternaries.ts`) takes the DWS boundaries and a CSV
the operator transcribes from the WR2012 tables.

**But it is not available to Pitman**:

- the committed data is synthetic only (region Z, codes `Z01A`–`Z02C`);
- real boundaries and WR2012 values are **blocked from production** (`docs/maps.md`
  § Sources: "blocked: licence unconfirmed; operator's own database only";
  `load-reference.yml` refuses kind `quaternaries`), so they are in no
  bucket a grant could open;
- they live, if at all, in the operator's **local** development database.

**So: the WR2012 naturalised MAR per quaternary does not exist anywhere
Pitman can read.** D2a's default ("IC-WBT's quaternary dataset") can't
work. Proposed instead (`theory/subdivide.md` § The target): the user types
the quaternary's WR2012 natural MAR from WR2012's tables (with the volume
and table cited, rule 8), and Pitman always shows the unsplit module's own
natural run beside it; with no value typed, the unsplit natural run is the
target.

**Boundaries for Pitman.** Options, in order of preference:

1. The operator uploads the DWS quaternary boundaries (the WR2012 GIS
   download they already hold, as GeoJSON in WGS84:
   `ogr2ogr -t_srs EPSG:4326 -f GeoJSON quaternaries.geojson <file>.shp`) to
   **Pitman's own** private bucket, after recording a licence decision for
   Pitman (DWS publishes them as open data; commercial terms unconfirmed).
   The API serves `GET /quaternaries?bbox` (codes + outlines, IC-WBT's limits:
   bbox ≤ 5° a side, ≤ 100 outlines) and `GET /quaternaries/:code`.
2. The Western Cape Government's public copy, "Quaternary Drainage Regions
   (DWS)",
   `https://gis.westerncape.gov.za/server2/rest/services/SpatialDataWarehouse/Hydrology/MapServer/7`
   (polygons, `QUATERNARY` field, credited to DWS, "DWS publication date is
   2012"; no token needed, read 2026-10-28): Western Cape only, terms not
   stated on the service. Usable as a check, or as the source if the
   operator accepts its terms.
3. The synthetic fixture for tests (copy
   `backend/fixtures/geo/quaternaries.synthetic.geojson`, 4.7 KB).

Quaternary **codes** are public and may appear anywhere; outlines and
WR2012 values are never committed.

**Until D-1 is settled, Pitman's API serves no `GET /quaternaries*`.** The
app takes an **uploaded boundary** (GeoJSON Polygon/MultiPolygon in WGS84)
for the area it extends, and the API takes any checked area. Faking the
routes on synthetic outlines would only hide the gap. IC-WBT's synthetic
quaternaries (option 3) are committed at
`backend/fixtures/geo/quaternaries.synthetic.geojson` for tests and as a dev
upload; they sit inside the synthetic CHIRPS and MAP copies.

## DEM: relief and delineation

**Where.** `s3://water-management-tiles-<account>/tiles/terrain.pmtiles`
(private bucket, SSE-S3, versioned 14 days; served to browsers only through
IC-WBT's CloudFront `/tiles/*` behaviour with an OAC). Present in production
when the operator uploaded it; IC-WBT's API reads it when
`delineation_dem = true`.

**What.** [Mapterhorn](https://mapterhorn.com)'s planet build (0.0.13),
Terrarium-encoded 512 px **WebP** tiles; over South Africa its only source
is **Copernicus GLO-30** (30 m), to zoom 12 (z 11 ≈ the DEM's own
resolution, ~32 m a pixel at 33° S). About 2.2 GB for the South African
extract at z 12. Elevation = `R·256 + G + B/256 − 32768` m.

**Read by** the browser (MapLibre `raster-dem` + `hillshade`, through the
`pmtiles` protocol) and by the backend for delineation (`delineation/dem.ts`:
ranged reads of a local file, `http(s)://` or `s3://bucket/key`, its own
PMTiles, PNG and WebP decoders, no native dependency). Delineation works at
zoom 11 (`TARGET_ZOOM`), windows of 1 024 / 2 048 / 3 072 cells.

**How Pitman reads it.** `DEM_SOURCE=s3://…/tiles/terrain.pmtiles` in
production (ranged GETs in `DATA_REGION`; row 3 of § Cross-account access),
`DEM_SOURCE=local` in dev (`DEM_LOCAL_FILE`, default
`.local/dem/synthetic.pmtiles`, written by `pnpm dev:data:synthetic`:
`backend/src/delineation/syntheticDem.ts`, invented terrain over the same
block as the other synthetic data). `DEM_LABEL` overrides the name a
delineation carries. Unset, the routes answer 503 "not configured"; the local
file absent, 503 naming the command. The Art. 6(b) notice below travels on
every delineation as `dem.attribution` (R5-D4).

**Licence.** Copernicus WorldDEM-30 licence: free, worldwide, reproduction,
distribution and adaptation allowed, no restriction on commercial use
([License COPDEM 30](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf)).
Pitman must show, while the relief is drawn and on every delineated polygon,
the Art. 6(b) notice word for word: "produced using Copernicus WorldDEM-30 ©
DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided
under COPERNICUS by the European Union and ESA; all rights reserved", with
"© Mapterhorn"; and the Art. 6(c) liability sentence on its data-sources
page (IC-WBT has it at `/data-sources#copernicus-dem`; copy the wording).
Mapterhorn's code is BSD-3 ([attribution](https://mapterhorn.com/attribution)).

## Basemap and fonts

**Where.** The same tiles bucket: `tiles/south-africa.pmtiles` (Protomaps
daily build, bbox 16.3,−35.0,33.0,−22.0, maxzoom 15, ~1.0 GB) and
`tiles/fonts/<fontstack>/<range>.pbf` with `tiles/fonts/OFL.txt` (Noto Sans
Regular, Medium, Italic from
[protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets)
at commit `028c18f7`).

**Served** same-origin through CloudFront `/tiles/*`, with IC-WBT's
`tiles_range` CloudFront function letting through one range of at most
2 MiB per request (so the archive can't be pulled whole) and answering 404
for any other path. Pitman needs **its own** distribution's `/tiles/*`
behaviour pointing at IC-WBT's tiles bucket (§ Cross-account access), so the
plan's CSP `connect-src 'self'` holds.

**Licences.** Basemap: ODbL 1.0 for the OSM data; "© Protomaps ©
OpenStreetMap contributors" always visible on the map. Fonts: SIL OFL 1.1,
the `OFL.txt` notice kept beside them.

## The register of dams (D4)

DWS Dam Safety Office's *List of Registered Dams* (XLS: capacity in
thousands of m³, wall height, completion date, river, farm, no
coordinates) joined by register number to its Google Earth overlay (KMZ:
positions) ([DWS DSO publications](https://www.dws.gov.za/DSO/Publications.aspx)).
In IC-WBT: table `dam_register_reference` (157), loaded locally by the
operator; **blocked from production** (no terms stated; DWS's general data
terms say "may not be sold to third parties" and restrict use to academic,
research or personal purposes). IC-WBT also decided a registered capacity is
a *reference only*, never written into a unit (its units are composite
dams); Pitman's D4 differs (the register wins for the dams it lists), which
is fine for Pitman's model but doesn't change the licence position.

**For Pitman**: same as the quaternaries: the operator's own download in
Pitman's own bucket, after a licence decision (ideally DWS's written
permission). A public alternative for the *larger* dams only: WCG's "Large
Dams (DWS)" layer
(`…/SpatialDataWarehouse/Hydrology/MapServer/20`, polygons with `NAME`,
`STATION`, `AreaHa`; no capacity), credited to DWS.

## Satellite surface water for D4 (area × 3 m)

What IC-WBT holds:

1. **JRC Global Surface Water v1.5 occurrence** (1984–2024), as
   `tiles/water.pmtiles`: Terrarium PNG tiles at zoom 12 (~32 m), the
   "height" being the % of observations the pixel was water (R = 128, G =
   0–100, B = 0; anything else no data). Read by `delineation/damTrace.ts`
   (IC-WBT's "Trace a dam") with the DEM's PMTiles/PNG readers. In production
   only with `dam_trace_water = true` and the operator's upload. Licence:
   produced under Copernicus, "free of charge, without restriction of use"
   ([global-surface-water.appspot.com/download](https://global-surface-water.appspot.com/download));
   credit "Source: EC JRC/Google" on a map, "modified" for a traced outline,
   cite Pekel et al. (2016) *Nature* 540, 418–422.
2. **Digital Earth Africa Waterbodies v0.0.3 historical-extent polygons**
   (`waterbody_reference`, 261), from the operator's clip of DE Africa's
   continental GPKG
   (`https://deafrica-services.s3.af-south-1.amazonaws.com/waterbodies/v0.0.3/historical_extent/waterbodies.gpkg`,
   ~900 MB, anonymous), loaded into IC-WBT's database through
   `reference/waterbodies/…` in the reference bucket. CC BY 4.0, "Contains
   Digital Earth Africa data (CC BY 4.0)". Per-waterbody area series
   (v0.0.2, frozen upstream since 2024-02) are in DE Africa's public bucket.

**How a dam's area is measured** (Round 7.4, proposed):

- **Default: JRC occurrence.** Around the dam's point (a register or CFM
  position), read the occurrence tiles in a window (IC-WBT traces with at
  most 512 cells), threshold at **occurrence ≥ 25 %** (a dam that is full a
  quarter of the time; the full-supply edge sits lower than the median
  shoreline), keep the connected region containing or nearest the point,
  outline it (`traceRings`) and take its **geodesic area** (`geo/area.ts`).
  Volume `= area × 3 m`. The threshold is shown and editable; IC-WBT's own
  trace uses a user-chosen share in the same way.
- **Alternative: DE Africa Waterbodies.** The historical-extent polygon
  that contains the point; its geodesic area. It is the maximum extent ever
  seen (wetter than full supply in a flood year, and merges adjacent dams),
  so it overstates; useful as a cross-check, and its polygons give
  locations for dams no other source lists.
- Below ~0.1 ha (one or two 30 m pixels) satellite area is noise: such dams
  are listed but get no area-based volume unless the user types one.

The **NGI dam outlines** on WCG's public server
(`https://gis.westerncape.gov.za/server2/rest/services/SpatialDataWarehouse/Hydrology/MapServer/0`,
"Dams (NGI)", 48 955 polylines with `DAM_NAME`, `QUATERNARY` in the
description, credited to DWS; read 2026-10-28 without a token) are a third
location source for the matching step (D4), with no capacity.

## Cape Farm Mapper (D3)

What is publicly visible (read 2026-10-28):

- **The app** is at [gis.elsenburg.com/apps/cfm](https://gis.elsenburg.com/apps/cfm/)
  ([WCDoA service page](https://westerncape.gov.za/agriculture/service/capefarmmapper)),
  built on the ArcGIS Maps SDK for JavaScript 4.34. It lists crop layers
  **Crops 2023, Crops 2017/18, Crops 2013/14** (the Western Cape's
  four-yearly airborne census, the "Flyover"; the 2023 iteration's report was
  received in March 2024:
  [gov.za](https://www.gov.za/news/media-statements/mec-ivan-meyer-receives-flyover-project-report-19-mar-2024)),
  land cover 2018/2020/2022, CBAs, slope, VEGMAP, and the Surveyor-General
  cadastre. Users can export features as Shapefile, GeoJSON or KML.
- **The services are ArcGIS Enterprise REST**, token-secured, at
  `https://gis.westerncape.gov.za/server3/rest/services` (ArcGIS Server
  11.5), federated with the portal `https://gis.westerncape.gov.za/portal`,
  whose token service is `…/portal/sharing/rest/generateToken`
  (`/rest/info` says `isTokenBasedSecurity: true`). The folder listing is
  public and includes **`DOA-Agric-Census`**, `DOA-Agriculture`,
  `DOA-Natural_Resources`, `DOA-Feature_Layers`, `DOA-Land_Cover`,
  `DOA-WCDOA` and others; every folder answers **499 Token Required**
  without a token. The CFM web app obtains short-lived tokens from its own
  server-side endpoint and registers them with the SDK's IdentityManager;
  Pitman must **not** use that endpoint (it is the app's, not an API).
- **Attributes** are not published anywhere readable without a token. A
  metadata record of the WCDoA's *Mapping of Agricultural Commodity
  Production and Infrastructure* (shown on George municipality's server)
  describes "all field boundaries in the Western Cape … with the associated
  crops as captured for the winter snapshot", horticulture and viticulture
  included. No public source confirms an **irrigation** attribute, a survey
  date per field, or dam **capacity**.

**What Pitman does with the token** (D3, decided): the operator stores it
with sops in `infra-secrets/pitman/` → Secrets Manager; only the API Lambda
reads it; the browser never sees it, and neither does any agent. The proxy
(Round 7.3) sends `query` requests (`geometry` = the (sub-)catchment
polygon, `geometryType=esriGeometryPolygon`, `spatialRel=esriSpatialRelIntersects`,
`outFields` = the agreed list, `f=geojson`, paging with
`resultOffset`/`resultRecordCount` up to the layer's `maxRecordCount`)
and caches by polygon hash.

**Questions to ask the operator once the token arrives** (the answers go on
issue #3 and in `docs/decisions.md`; never the token itself):

1. What kind of credential is it: an ArcGIS **API key**, a **long-lived
   token** from `generateToken`, or a **username/password** for the portal
   that the Lambda exchanges for tokens? Its expiry and how it is renewed.
2. Its **terms of use**: may derived numbers (irrigated area per crop per
   catchment) be stored in a client's network file and shown to the client?
   Any attribution line WCDoA asks for? Any rate limit?
3. Which **services and layers** it opens: the exact URL of the Crops 2023
   layer (under `DOA-Agric-Census`?), of a **farm dams** layer if CFM has
   one, and whether 2017/18 and 2013/14 are open too (for the historical
   run mode's year table).
4. The **fields** of the crop layer: crop (code or name, and its code
   list), **irrigation** (a field? values such as irrigated / dryland /
   drip / micro / pivot / flood?), the survey or capture date, the field
   area (and in which units and projection), and a stable field id.
5. The **dams** layer's fields: capacity (m³?) or only surface area, survey
   date, whether registered dams are flagged (for matching against the DWS
   register, D4).
6. What counts as **irrigated** for WRSM2000's irrigation module: an
   irrigation-type value, a crop list (e.g. vineyards and orchards always
   irrigated), or both? (Default until answered: irrigated when the
   irrigation attribute says so; if there is none, the user marks crops
   irrigated in the crop-mapping step.)
7. The layer's coordinate system (WCG often uses Lo19/Lo21 Transverse
   Mercator), so the proxy asks for `outSR=4326` and areas are recomputed
   geodesically, never taken from a projected `Shape_Area`.

## Cross-account access (Round 4.1)

Pitman runs in its own AWS account; its API Lambda role and its CloudFront
distribution need read access to three IC-WBT buckets, and nothing else.
The PR goes in `project-water-management`'s `infra/` (its `/safe-edit`
flow), as **bucket-policy statements naming Pitman's principals** (the
IC-WBT side) plus matching **identity policies** in Pitman's `infra/`
(both are needed cross-account). All three buckets are **SSE-S3**, so
**no KMS grant** is needed.

| # | Principal (Pitman account) | Bucket (IC-WBT) | Actions | Resources / condition | For |
|---|---|---|---|---|---|
| 1 | API Lambda role | `water-management-mirror-<id>` | `s3:GetObject` | `arn:aws:s3:::water-management-mirror-<id>/rnl/*` (also `zarr.json` at the root, the group metadata zarrita reads) | method A |
| 2 | API Lambda role | `water-management-mirror-<id>` | `s3:ListBucket` | the bucket ARN, `Condition: StringLike s3:prefix ["rnl/*"]` | so a never-written (all-NaN) chunk answers **404**, not 403 (below) |
| 3 | API Lambda role | `water-management-tiles-<id>` | `s3:GetObject` | `…/tiles/terrain.pmtiles` | delineation |
| 4 | API Lambda role | `water-management-tiles-<id>` | `s3:GetObject` | `…/tiles/water.pmtiles` | D4 area (Round 7; add then) |
| 5 | API Lambda role | `water-management-reference-<id>` | `s3:GetObject` | `…/reference/map-grid/<the WAAS file's key>` (exact key, not a prefix) | method B MAP |
| 6 | Pitman's CloudFront distribution (service principal `cloudfront.amazonaws.com`, `AWS:SourceArn` = Pitman's distribution ARN) | `water-management-tiles-<id>` | `s3:GetObject` | `…/tiles/south-africa.pmtiles`, `…/tiles/fonts/*`, `…/tiles/terrain.pmtiles` | the browser's basemap, labels, relief |

Notes:

- **Why ListBucket.** Without `s3:ListBucket`, S3 answers a missing key with
  **403 AccessDenied**, not 404. IC-WBT's `S3Store.get` treats only
  `NoSuchKey`/404 as "chunk never written, all NaN" and throws on anything
  else, so every sea or empty chunk would fail the read. Scoping the list to
  `rnl/` keeps it minimal. (Don't "fix" this by treating 403 as missing: it
  would hide a real permission error as no rain.)
- **The root `zarr.json`.** Zarr v3 has no implicit groups, but the reader
  opens the `rnl` array directly and **never asks for the root `zarr.json`**:
  confirmed by `backend/src/chirps/mirror/store.test.ts` (every key the fake
  S3 client is asked for is under `rnl/`). Row 1 needs `rnl/*` only.
- **Principals by exact ARN**, `aws:PrincipalArn`, never the whole Pitman
  account; IC-WBT's `DenyInsecureTransport` statements stay.
- **Row 6 is an OAC grant across accounts**: Pitman's distribution signs
  with its own OAC; the bucket policy allows `cloudfront.amazonaws.com` with
  Pitman's distribution ARN as `AWS:SourceArn`, exactly as IC-WBT's own
  `AllowCloudFrontReadTiles` does. Pitman copies the `tiles_range`
  function (`infra/s3_cloudfront.tf`) onto its `/tiles/*` behaviour, so the
  2 MiB-per-request bound holds for Pitman's viewers too, and its own WAF
  rate rule and bytes alarm cover them (IC-WBT pays the S3 GETs; CloudFront
  egress is Pitman's).
- **Region.** The buckets are in IC-WBT's region (`af-south-1`, an opt-in
  region). Set the S3 client's `region` explicitly (IC-WBT's code uses
  `new S3Client({})`, which takes the Lambda's own region). Enable
  `af-south-1` in the pitman account (expected to be required for its
  principals to call an opt-in region; verify in Round 4.1), and prefer
  running Pitman's API Lambda in `af-south-1` so the reads stay in-region.
- **Costs.** Requests are billed to the bucket owner (IC-WBT); a quaternary's
  CHIRPS read is at most a few hundred GETs and is cached, so this is cents.
  No Requester Pays.
- **Not granted**: `sat/`, `prelim/`, `gefs/`, `era5l/`, `dams/` and any
  other mirror prefix; `reference/*` beyond the one file; `originals/`; any
  write, delete or list outside `rnl/`; any database access.

## Pitman's data API (Round 4.2)

`backend/src/` (`docs/architecture.md` § Data API for the request path and
limits). Routes are unprefixed (CloudFront strips `/api`, R4-I4).

| Env var | Default (`backend/.env.development`) | Meaning |
|---|---|---|
| `CHIRPS_SOURCE` | `local` | `local` or `s3`; unset or empty = not configured, every CHIRPS request 503 |
| `CHIRPS_LOCAL_DIR` | `.local/mirror` | the local Zarr copy (`pnpm dev:data:synthetic` writes a synthetic one) |
| `CHIRPS_BUCKET` | — | IC-WBT's mirror bucket (`s3`) |
| `CHIRPS_PREFIX` | `rnl` | the `rnl` array's key prefix; the store opens at its parent |
| `MAP_GRID_SOURCE` | `local` | `local` or `s3://bucket/key` (gzipped when `.gz`); unset = not configured |
| `MAP_GRID_LOCAL_FILE` | `.local/map-grid/synthetic.json` | the local grid |
| `MAP_GRID_DATASET` | `synthetic` | the grid's name in answers and the sidecar (default: the file name) |
| `DATA_REGION` | `af-south-1` | the S3 client's region for IC-WBT's buckets (not `AWS_REGION`, which Lambda reserves) |

The S3 client is imported lazily, with 3 s connection / 10 s request
timeouts (a MAP grid file 60 s), three attempts, and treats only
`NoSuchKey`/404 as an unwritten chunk; a 403 is an error (§ Cross-account
access). A CHIRPS read runs 6 chunk GETs at a time and stops at a 25 s
deadline (504). A quaternary's read is about 46 years × 1–4 chunk groups;
the worst case (2 000 cells, ~16 chunk groups) is ~740 GETs.

## Code to copy

IC-WBT is MIT, same author; keep a header line on each copied file naming
its origin path and commit (`f888e4461`). Pins below are IC-WBT's exact
versions; Pitman keeps them exact (zarrita's minor versions have changed
APIs).

### Backend: CHIRPS reader (Round 4.2)

| From `backend/src/` | Lines | Keep / strip |
|---|---|---|
| `mirror/grid.ts` | 202 | keep `MIRROR_STEP`, `MIRROR_REGION`, `gridOf`, `regionSize`, `mirrorCell`, `cellsByChunk`, `doyIndex`, `isLeapYear`; drop the 0.1° products and the forecast grids; replace `@water-management/engine/calendar` (`toEpochDay`, `fromEpochDay`) with a local 20-line date helper |
| `mirror/arrays.ts` | 308 | keep `openFinals`, `readFinalsBlock`, `checkLayout`, the constants; drop every writer (`ensure*`, `write*`, `growOuter`) and the daily layout |
| `mirror/manifest.ts` | 380 | keep `readManifest`, `parseManifest` and `finalsCoverage` (the contiguous-months rule); drop era5l/imerg coverage |
| `mirror/store.ts` | 105 | keep `S3Store.get` (drop `set`/`delete`), `registerNodeGzip`/`NodeGzip` (decode only is enough; zarrita 0.7.5's gzip only decodes anyway) and `openStore`; pass `region` to `S3Client` |
| `mirror/url.ts` | 26 | keep as is |
| `mirror/readCells.ts` | 170 | **don't copy**: write `readMonthly(store, cells, fromYear, toYear)` on the same block reads, summing to months (`extend.md` §§ Steps 2–3) |
| `feeds/boundaryCells.ts` | 141 | keep; raise the cell limit to 2 000; take `CHIRPS_CELL_DEG` and `WeightedCell` from a local constants file instead of `feeds/config.ts` |
| `mirror/manifest.ts` (note) | | IC-WBT validates with **zod**, which Pitman's backend doesn't depend on: Round 4.2 rewrote `parseManifest` by hand with the same finals rules |
| `feeds/errors.ts` | 103 | only the error classes the reader throws (`FeedFormatError`, `FeedUnavailableError`) as local classes |
| `backend/fixtures/mirror/` | 255 files, 280 KB | the committed synthetic copy (finals 2023–2025 of an invented grid): the reader's tests |

Packages: `zarrita` **0.7.5**, `@zarrita/storage` **0.2.0**,
`@aws-sdk/client-s3` **3.1154.0** (imported lazily, as IC-WBT does). About
900 lines after stripping.

### Backend: geometry (Rounds 4–5)

| From `backend/src/` | Lines | Keep / strip |
|---|---|---|
| `geo/area.ts` | 79 | keep whole: geodesic area on the WGS84 ellipsoid (authalic latitude), `cellRowAreaM2`, `mercatorLat`; no dependencies |
| `geo/clip.ts` | 126 | keep whole: Sutherland–Hodgman bands, the work budget |
| `geo/gridShares.ts` | 125 | keep whole: share × ellipsoidal cell area, for the MAP-grid mean |
| `geo/geojson.ts` | 743 | keep the types, `checkGeometry` and its ring checks, `pointInRing`, `pointInGeometry`, `interiorPoint`, `centerOf`, the size limits; drop feature kinds, names (the engine's `oneLineName`), uploads and overlap proposals (~300 lines left) |
| `geo/rainMap.ts` | 289 | keep only `rainMapFromJson` and the JSON shape; the rest is the database |
| `geo/evaporationGrid.ts` | (part) | `originOf` / `indexOf` (cell keying) |

**Not in IC-WBT, needed for method B: a polygon boolean.** IC-WBT clips
polygons only to convex cells; the remainder `Q − T` and the zone `Z ∩ Q`
need a general intersection/difference. Use **`polyclip-ts` 0.16.8** (MIT;
deps `bignumber.js`, `splaytree-ts`; the library `@turf/intersect` 7 is built on)
in the backend, and in the engine only if `src/subdivide/zones.ts` must run
it client-side. (`polygon-clipping` 0.15.7 is the older, unmaintained
alternative.)

### Backend: delineation (Round 5.2)

Built as this table says, with R5-D1 … D5 (`docs/decisions.md`). `delineate`
returns the cell mask rather than an outline, because the clip comes first
(`tributary.ts`). The tests were copied too and adapted; `dem-fixture.ts`
wasn't, so `backend/fixtures/dem/synthetic-dem.pmtiles` is IC-WBT's bytes.

| From `backend/src/delineation/` | Lines | Keep / strip |
|---|---|---|
| `delineate.ts` | 483 | keep `delineate`, windows, refusals, `readWindow`, the method text; drop job windows (no background worker) |
| `dem.ts` | 227 | keep whole (local file / http / s3 ranged reads, fingerprint); pass `region` to the S3 client |
| `pmtiles.ts`, `png.ts`, `webp.ts` | 328, 138, 495 | keep whole: dependency-free readers (only `node:zlib`) |
| `flow.ts` | 321 | keep whole: Priority-Flood+ε, D8, accumulation |
| `outline.ts` | 204 | keep whole: `traceRings`, `simplifyRing` |
| `place.ts` | 90 | keep whole: snapping to a terrain channel |
| `pans.ts` | 534 | `delineate` calls it; keep (the effective-area report is useful), but its "storage on a river" check needs the river network and dam register, which Pitman lacks: pass none |
| `channels.ts` | 148 | keep: terrain channels for the click layer (0.2° tiles, 1 km² threshold) |
| `subcatchments.ts` | 1 081 | copy only `rasterize` (for clipping `D` to `Q`, `subdivide.md`); the rest is IC-WBT's unit partitioning |
| `fixture.ts`, `valleyFixture.ts`, `backend/fixtures/dem/` (10 files, 700 KB) | | the synthetic DEM and its generator, for tests |
| `routes.ts`, `start.ts`, `divide.ts`, `clicks.ts`, `requests.ts`, `attempt.ts`, `throttle.ts`, `reach.ts`, … | | **don't copy**: database, auth, jobs, history, projects |

About 3 000 lines, no new packages (`node:zlib`, `node:crypto`,
`@aws-sdk/client-s3`). Memory: IC-WBT measured up to ~460 MB at the 3 072
window on the real DEM; give the API Lambda at least 1 024 MB, and keep
IC-WBT's 20 s budget under a 30 s timeout.

### Frontend: map shell (Round 5.1)

From `frontend/src/lib/components/map/`:

| File | Lines | Keep / strip |
|---|---|---|
| `maplibre.ts`, `maplibre-theme.css` | 24, 49 | keep: lazy MapLibre, its CSS, the worker URL, the lazy `pmtiles` protocol |
| `appTheme.ts` | 24 | keep |
| `mapStyle.ts` | 880 | keep basemap, labels (`labelLayers`, `glyphsUrl`, contrast), relief (`terrainSource`, `reliefLayer`, `TERRAIN_ATTRIBUTION`), `quaternaryLayers`, `mapGridData`/layers, `channelLayers`, `proposalLayers`/`pieceTints` (the pieces); drop farm parcels, rivers, units, results fills (~450 left) |
| `quaternaryLayer.svelte.ts`, `mapGridLayer.svelte.ts`, `channelLayer.svelte.ts` | 95, 134, 120 | keep; repoint `load` at Pitman's API (no project id) |
| `mapLayers.ts` | 325 | keep the bbox snapping (`quaternaryBbox`, `mapGridViewBbox`, `snappedViewBbox`); drop `$app/state`, credits and feature lists |
| `draw/shape.ts`, `draw/snap.ts`, `draw/parseShape.ts`, `draw/drawLayers.ts`, `draw/attachDrawing.ts`, `draw/draft.svelte.ts`, `draw/DrawBar.svelte` | 160, 195, 181, 97, 277, 376, 316 | the polygon drawing and paste (MAP-zone split); strip the parcel/dam kinds and the `confirm` and `measure` imports |
| `CatchmentMap.svelte` | 987 | **rewrite** as a smaller Pitman map using its patterns (one effect per GeoJSON source, `setStyle` on theme change, focus handling); it carries IC-WBT's features, results and sheets |
| `pieces.ts` | 173 | the proposal pieces' tints and highlight |

Every file imports `#lib/api/types.js` for its types: define the few it
needs (`MapPosition`, the outline and point types) locally. Packages:
`maplibre-gl` **6.15.0**, `pmtiles` **4.5.0**. The MapLibre worker is
emitted as a page-build entry by a Vite plugin in IC-WBT's
`frontend/vite.config.ts` (`workerChunks`, `virtual:maplibre-worker-url`),
written for Vite 8 / SvelteKit 3, which Pitman also runs (since 2026-10-28),
so the plugin ports as is. Without it, MapLibre needs a `blob:` worker, which the
CSP refuses. About 2 500 lines after stripping.

### Infra

- `infra/s3_cloudfront.tf`'s `tiles_range` CloudFront function and its
  tests (`infra/scripts/cloudfront-functions*.mjs`) for Pitman's `/tiles/*`.
- The pattern of `infra/map_data.tf`'s one-key `GetObject` grants.

## Open questions (with proposed defaults)

- **D-1** Quaternary boundaries for Pitman: default the operator's DWS
  download in Pitman's own bucket, after recording Pitman's licence decision.
- **D-2** D2a's WR2012 natural MAR: default hand-entered from WR2012's tables
  with citation, the unsplit natural run beside it as cross-check and fallback.
- **D-3** DWS register of dams: default the operator's download in Pitman's
  bucket once DWS's permission (or the operator's decision) is recorded;
  until then CFM + satellite only.
- **D-4** WAAS MAP surface: default extend IC-WBT's operator decision to
  Pitman (recorded in Pitman's `docs/decisions.md`), same credit line.
- **D-5** D6 national grid: default none in production (Lynch blocked); a
  quaternary outside the WAAS box takes a typed MAP.
- **D-6** Pitman's AWS region: default `af-south-1`, same as the buckets.
- **D-7** Dam area from satellite: default JRC occurrence ≥ 25 %, DE Africa
  Waterbodies as cross-check; below 0.1 ha no area-based volume.
- **D-8** CFM "irrigated": default the irrigation attribute if the layer has
  one, else the user's crop marking.
