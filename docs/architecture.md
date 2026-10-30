# Architecture

## Overview

This is a pnpm monorepo with two app packages plus Terraform for infrastructure
and GitHub Actions for CI/CD:

- `frontend/` — SvelteKit (Svelte 5), built with `@sveltejs/adapter-static`. Ships as
  pre-rendered HTML + assets to S3 + CloudFront.
- `backend/` — Hono app, written once and deployed two ways: as a local Node HTTP
  server for development and as an AWS Lambda handler for production. Bundled
  with esbuild.
- `infra/` — Terraform module that provisions all AWS resources (S3, CloudFront,
  Lambda, IAM, Route 53, ACM, GitHub OIDC). Not a workspace package.
- `.github/workflows/` — two deploy workflows (frontend, backend) that run on
  a push to `main` touching their paths (or by hand), authenticate to AWS via
  OIDC and deploy only after approval in the `production` environment
  (`docs/deployment.md`). They skip until the operator sets the repo variables.

The two app packages are decoupled. The frontend knows the backend only by its
URL (`PUBLIC_API_URL`).

## Repo layout

```
pitman/
├── package.json              Workspace root scripts (dev/build/check)
├── pnpm-workspace.yaml       Lists frontend, backend as packages
├── docs/                     Architecture, deployment, run-locally, security
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── .env.development      PUBLIC_API_URL, PUBLIC_SITE_URL, the map's PUBLIC_TILES_* (committed defaults)
│   └── src/
│       ├── app.css           Base styles
│       ├── env.ts            The PUBLIC_* variables, declared for SvelteKit 3 (read from $app/env/public)
│       ├── app.html
│       ├── lib/network/      Load, validate, store, run (worker), save (§ App flow)
│       ├── lib/extend/       Extend a .RAN with CHIRPS (method A): area upload, the CHIRPS client, the fit screen, apply (§ App flow, step 5)
│       ├── lib/map/          The map: Map.svelte (takes contract.ts MapProps), MapPanel.svelte (the step), the style and tokens (mapStyle, palette), the client (api), module placing (modules), drawing (draw/); MapLibre loads lazily (maplibre.ts)
│       ├── lib/map/tributary/ The tributary tool: api.ts (the /delineate and /channels client), present.ts (its wording), TributaryTool.svelte (embedded by the wizard; never touches MapLibre)
│       ├── lib/calibrate/    Edit a runoff module's parameters, preview a historical rerun at a gauge, apply (docs/user-guide.md)
│       ├── lib/landuse/editor/ Edit a runoff module's land-use year tables: LandUseEditor.svelte (the card), offers.ts (which tables a module offers, the SFR rules), review.ts (drafts, checks, what apply writes), composition.ts and CompositionTable.svelte (the species split and composition behind a table), chart.ts and plot.ts (the series as a run reads it); the engine side is packages/wrsm/src/landuse/tables.ts and composition.ts (docs/user-guide.md § Land-use tables)
│       ├── lib/demand/       Create, edit and remove demand files: the list, the form beside its preview, apply, the removal's confirmation and undo (§ App flow, Demands)
│       ├── lib/subdivide/    Sub-divide a quaternary (method B): the wizard, its logic in .ts modules, the engine adapter `engine.ts` and the backend client `data.ts` (§ App flow, step 6)
│       ├── lib/map/mapzone/  The MAP-zone tool: threshold, drawn or pasted zone (§ App flow, step 6)
│       ├── lib/landuse/cfm/  Land use: the /cfm/land-use client (api), its logic (plan), LandUsePanel.svelte with CropStep and DamStep (docs/data.md § Cape Farm Mapper)
│       ├── lib/results/      Results and plots: logic in targets, analysis, charts, statistics-table, downloads (.ts, unit-tested); plot.ts is the uPlot action; spec docs/theory/statistics.md
│       ├── lib/shell/        The frame around the steps: app bar, landing page, step rail (steps.ts holds its wording), the fold round each optional card, the design-token guards; rules in docs/design/ui-playbook.md
│       └── routes/           +page.svelte: the app shell; methods/: the Methods page (prerendered, mapped by infra/functions/spa_rewrite.js)
├── backend/
│   ├── package.json          Build script runs esbuild → dist/lambda.mjs
│   ├── tsconfig.json
│   ├── .env.development      Backend env vars (committed local defaults)
│   └── src/
│       ├── app.ts            Hono app factory + CORS + route mounting
│       ├── server.ts         Local dev entry (runs on :3001)
│       ├── lambda.ts         AWS Lambda entry (wraps app with hono/aws-lambda)
│       └── routes/           Your API routes go here
├── infra/
│   ├── main.tf               Providers, state backend
│   ├── variables.tf
│   ├── outputs.tf
│   ├── s3_cloudfront.tf      Bucket + OAC + cert + CloudFront + Route 53
│   ├── lambda.tf             Function + exec role + log group + Function URL
│   ├── github_oidc.tf        GitHub OIDC provider + CI role + scoped policy
│   └── terraform.tfvars.example
└── .github/
    └── workflows/
        ├── ci.yml                CI: typecheck + test on PR/push
        ├── deploy-frontend.yml   Build + sync to S3 + CloudFront invalidation
        ├── deploy-backend.yml    esbuild bundle + zip + update Lambda
        └── claude.yml            Claude Code issue/PR automation
```

## Frontend

SvelteKit with `adapter-static`. Every route can prerender to static HTML.
The build emits `.html` files per route, uploaded to S3. CloudFront sits in
front for caching and TLS termination. No server-side rendering at runtime.

## App flow: load → validate → store → extend → sub-divide → run → save

The app is one static page (`frontend/src/routes/+page.svelte`). Everything
happens in the browser; no network file is ever uploaded (issue #3 rule 7).
The page holds the state; the logic is in `frontend/src/lib/network/*.ts`,
each with a vitest test beside it. Before a network is loaded it shows the
landing page; once one is, the sections below sit beside a step rail, all
mounted, so moving between steps loses nothing, and Save stays in the app bar
(`frontend/src/lib/shell/`, `docs/design/ui-playbook.md`).

1. **Load** (`sources.ts`, `zip.ts`). A zip (`<input type="file">`), a
   folder (`<input webkitdirectory>`) or either dropped on the drop area
   (`webkitGetAsEntry`, folders walked recursively) becomes a list of files.
   A single `.zip` is unpacked with fflate. Size limits (`limits.ts`: 20,000
   files, 64 MB per file, 256 MB in all, checked against a zip's declared
   sizes before it is inflated) stop a zip bomb exhausting the tab.
2. **Decode** (`encoding.ts`). Every file is decoded as **Latin-1** (one
   character per byte, so a non-ASCII byte or a binary `.pdf` survives),
   except a `pitman.json` beside a `.NET`, which is strict UTF-8 (invalid
   bytes are a load error; a byte-order mark is kept) (docs/formats.md
   §1.1). A zip entry whose CRC-32 doesn't match is refused as damaged.
3. **Validate** (`open.ts` → `readBundle` in `packages/wrsm/src/io/bundle.ts`).
   The engine finds the `.NET` (or asks which one when the folder holds
   several), reads every module file it lists and every rainfall, observed
   and defined-flow file they name, case-insensitively within the `.NET`'s
   folder (a name matched only by its base name gets a warning), plus the
   `pitman.json` sidecar. Every file's error is collected
   and shown with its file, line, column and field (`IssueList.svelte`,
   focus moves to the list). Files no reader uses (`Out/`, diagrams, a second
   `.NET`) are kept.
4. **Store** (`storage.ts`). The loaded network's files (`writeBundle`
   output, not the parsed objects, so a stored copy goes back through
   validation) and the chosen run modes go into IndexedDB (`pitman` /
   `working-copy` / `current`). A reload restores it; **Forget the working
   copy** deletes it. The user's own copy is the saved zip.
5. **Extend rainfall** (`frontend/src/lib/extend/`, method A,
   `docs/theory/extend.md`). The panel lists every `.RAN` with the modules
   that read it and any earlier extension (the sidecar's
   `rainfallExtensions`). For one file the user uploads the area it
   represents as GeoJSON (`area.ts`: Polygon, MultiPolygon or a
   FeatureCollection of them, WGS84, inside the CHIRPS copy's region,
   at most 50 000 vertices, the backend's limit; decision D-1, no licensed boundaries yet) and
   fetches CHIRPS (`api.ts`: `POST ${PUBLIC_API_URL}/chirps/monthly` with the
   bare geometry, nothing else, rule 7; decision R4-I4; 60 s timeout, Cancel,
   the backend's `{ error }` shown as it is). The fit (`engine.ts` wires the
   engine's `fitRainfallExtension`, `applyRainfallExtension`, `checkFactor`,
   `fitStatistics` and, for a file extended before, `refitFromSidecar`,
   R4-E2) is shown as the monthly scatter with its 1:1 line and a corrected
   toggle, the mean monthly bars with each factor, the annual totals with
   the appended years shaded (`charts.ts`, drawn by `plot.ts` with uPlot,
   each with a data table), and the numbers before and after. The 12 factors
   (`factors.ts`) take typed values (a decimal comma too), are checked by
   `checkFactor` (refused, confirm a 0, warn far from 1) and reset to the
   computed value; the D5 window narrows the overlap and resets. The
   preview is the engine's own apply. Every number shows its provenance
   (`provenance.ts`: product, copy and revision, final day, cells, weight
   removed, area, fetch date, CHIRPS MAP and overlap). **Apply**
   (`apply.ts`) replaces the `.RAN` in the bundle, records the sidecar entry
   (stamped `createdAt`), and the page stores the working copy and clears
   the old results. When every rainfall file in use now reaches further the
   panel offers to move the `.NET`'s last year (L.012, at most 150 years),
   then to rerun.
6. **Sub-divide a quaternary** (`frontend/src/lib/subdivide/`,
   `frontend/src/lib/map/mapzone/`, method B, `docs/theory/subdivide.md`). One
   screen flowing down the page, the steps listed at the top with their state
   in words, focus moving to each new step. The engine (`engine.ts`, one
   adapter), the backend (`data.ts`) and the map and tributary tool (snippets,
   `slots.ts`) are injected, so the panel builds alone.
   **Quaternary:** from `GET /quaternaries` or the map, or an uploaded
   boundary while the service has none (D-1); the modules named for the code
   come first, every other runoff module stays on offer (`modules.ts`), SFR
   children go with their parent, and a module already in an applied
   sub-division is refused. The ±5 % area check runs here, before any work.
   **Split** (`pieces.ts`): a tributary, or a MAP zone from a threshold, drawn
   or pasted (`mapzone/`), repeated up to 8 pieces with undo. A split keeps
   the remainder in its piece's place and adds the new piece at the end, so
   numbers on the map and the cards never move.
   **Pieces:** polygon and scaled area, grid MAP (`POST /map-grid/mean`) with
   its cell size, source and coverage, a typed MAP in its place, located dams,
   how each table is shared, `previewSplit`'s changes. One grid per
   quaternary: a mix is refused until the odd piece's MAP is typed.
   **Calibrate** (`target.ts`, `calibration.ts`): the WR2012 natural MAR with
   its citation, or the unsplit natural run labelled as the fallback, always
   side by side with the 5 % warning, then every try. A calibration that
   didn't converge offers Use the best factor, Change the target or Cancel;
   only the first reaches Apply, and it is recorded as such. Changing the
   pieces, a MAP, the target or the network invalidates a calibration.
   **Apply** hands the page the engine's bundle (`onupdate`, as the
   extension). The panel keeps the page's runs from before, since the page
   clears them, and after a rerun compares them at the outlet (`outlet.ts`):
   the first route all the module's water reaches, per mode, over the years
   both ran, with the mean monthly flows October first.
7. **Run** (`modes.ts`, `run-client.ts`, `run.worker.ts`, `run-protocol.ts`).
   The mode picker offers present day (year default 2025), natural and
   historical (decision D1); several run in one go so results compare. The
   run happens in a module Web Worker: one request (the bundle without its
   file index, and the modes), then per mode a `progress` and a `result` or
   an `error`, then `done`. A failing mode doesn't lose the others; Cancel
   terminates the worker. The results section carries
   `data-run-state` (`idle`, `running`, `done`, `failed`) and
   `data-ready="true"` once a run has finished, for end-to-end tests, and
   renders `frontend/src/lib/results/Results.svelte` with the successful runs.
8. **Save** (`save.ts`). `writeBundle` writes every file back: an unchanged
   file byte for byte, a changed one in WRSM2000's standard layout
   (decision R2-4), plus every kept file. The sidecar is stamped with
   `writtenBy` (the frontend package version) and `savedAt` and written as
   `pitman.json` beside the `.NET`. The zip is offered as a download.

**Demands** (`frontend/src/lib/demand/`, `packages/wrsm/src/demand/`,
`docs/formats.md` §12). A section of the page, like Extend and Calibrate. It
lists each defined-flow file once (`files.ts`) with the routes that read it,
its years, and whether it covers the run. A file with a `DemandSpec` in
`sidecar.demands` opens in the form; one without can be viewed and replaced,
never edited as a spec, because a spec can't be recovered from monthly rows.
The form holds text (`draft.ts`); the engine's `planDemand` turns it into a
plan on every keystroke, and Apply carries out that same plan (`applyDemand`),
so the rows and file on screen are what gets written. Rows are generated at
the writer's rounding, so a run of the working copy equals a run of the saved
zip. Apply names the file after the route, sets the RV L.013 or CR L.010 line,
adds a `.NET` route to the zero sink when asked, and records the spec in
`sidecar.demands` and each value's source in `sidecar.values` (target `{ file,
field, year? }`, rule 8). It hands the page the bundle through `onupdate`.
Removing works the same way: `planDemandRemoval` says what would happen, the
confirmation shows that plan and `applyDemandRemoval` carries it out (R7-X8 …
R7-X12). Undo hands back the bundle from before, while nothing else has
changed it.

`synthetic.ts` builds a synthetic network (the engine's `syntheticNetwork()`
plus its channel reach) as files or a zip, for tests: load it, run every
mode, save, reload the saved zip and compare.

## Backend

Hono, a small TypeScript HTTP framework. One app definition (`src/app.ts`)
shared by two entry points:

- `src/server.ts` — local dev via `@hono/node-server` on port 3001.
  `tsx watch` reloads on change.
- `src/lambda.ts` — AWS Lambda entry via `hono/aws-lambda`.

Handler code, routing, and middleware are identical across both — the only
difference is how requests reach the app.

**Important:** `server.ts` imports `dotenv/config`; `lambda.ts` does not.
This ensures esbuild tree-shakes `dotenv` out of the Lambda bundle. Do not
add `dotenv` imports to any module reachable from `lambda.ts`.
`src/lambda.test.ts` bundles `lambda.ts` with esbuild and fails if `dotenv`,
`server.ts` or the synthetic-data writers end up in it.

### Data API

Stateless: it receives only an area (GeoJSON) or a box and answers numbers,
never network files. CloudFront strips `/api` before the Lambda (R4-I4), so the
routes are mounted unprefixed (`/chirps/monthly` here is `/api/chirps/monthly`
in the browser).

| Route | Body → answer | Module |
|---|---|---|
| `GET /health` | `{ ok: true }` | `app.ts` |
| `POST /chirps/monthly` | `ChirpsMonthlyRequest` → `ChirpsMonthly` (`packages/wrsm/src/extend/contract.ts`) | `src/chirps/` |
| `POST /map-grid/mean` | `{ area }` → `MapGridSample` + provenance | `src/mapgrid/` |
| `POST /delineate` | `DelineateRequest` → `DelineateResponse` (`packages/wrsm/src/subdivide/contract.ts`, plus R5-D4); a refusal is a 422 with `{ error, reason }` | `src/delineation/` |
| `GET /channels?bbox=w,s,e,n` | at most 0.4° a side → `ChannelCollection` (`properties.km2`); off the DEM, an empty collection | `src/delineation/` |
| `POST /map-grid/cells` | `{ bbox }` (≤ 2° a side, ≤ 250 000 cells) → `MapGridCells` (`packages/wrsm/src/subdivide/contract.ts`) | `src/mapgrid/cells.ts` |
| `GET /quaternaries` | → `QuaternaryCollection`; 503 when not configured, which production is until D-1 | `src/quaternaries/` |
| `POST /cfm/land-use` | `LandUseRequest` → `LandUseAnswer` (`packages/wrsm/src/landuse/`); 503 when not configured, which production is until the token (D3) | `src/cfm/`, `src/dams/` |

Layout, by topic:

- `src/geo/`: geometry copied from IC-WBT (`area.ts` geodesic area,
  `clip.ts`, `gridShares.ts`, `geojson.ts` `checkGeometry`).
- `src/chirps/`: the CHIRPS reader copied from IC-WBT (`mirror/`,
  `boundaryCells.ts`), Pitman's own `readMonthly.ts` (days → calendar months
  → area mean), `monthly.ts` (the answer), `copy.ts` (which copy:
  `CHIRPS_SOURCE=local|s3`), `synthetic.ts` + `mirror/writers.ts` (the dev
  copy's generator; never imported by the API).
- `src/mapgrid/`: `rainMap.ts` (the grid's JSON form, an in-memory index),
  `mean.ts` (area-weighted mean, D6 finest grid first), `source.ts`
  (`MAP_GRID_SOURCE=local|s3://bucket/key`; a new grid is one more
  `MapGridSource`), `cells.ts` (a box's block, for the map).
- `src/delineation/`: copied from IC-WBT (`delineate.ts`, `flow.ts`, `place.ts`,
  `outline.ts`, `pans.ts`, `channels.ts`, `rasterize.ts`, the dependency-free DEM
  readers `dem.ts`, `pmtiles.ts`, `png.ts`, `webp.ts`), Pitman's own
  `tributary.ts` (clip to the piece, outline, remainder, areas, the refusals),
  `source.ts`
  (`DEM_SOURCE=local|s3://…|https://…`), `routes.ts`, and `syntheticDem.ts` (the
  dev DEM's generator; never imported by the API). `fixture.ts`,
  `valleyFixture.ts` and `backend/fixtures/dem/` serve the tests only.
- `src/quaternaries/`: `source.ts` (`QUATERNARIES_SOURCE=local`; unset is 503,
  and the file is read once and trimmed to the wire type), `routes.ts`.
- `src/cfm/`: `adapter.ts` (**provisional**: the only file that knows the
  layers' fields), `arcgis.ts` (the paged, bounded `query`; the token's path),
  `clip.ts` (fields cut to the area, geodesic areas), `source.ts`
  (`CFM_SOURCE=local|cfm`), `routes.ts`, `synthetic.ts` (invented fields).
- `src/dams/`: `inArea.ts` (the candidates an area holds), `synthetic.ts`
  (invented dams in all three of D4's sources). Matching is the engine's
  `matchDams`, run in the browser, so changing the radius sends no request.
- `src/http/`: the `{ area }` body check, the result cache, the rate limit,
  error responses.

Request path: CloudFront shared secret (timing-safe compare) → CORS → 2 MiB
body limit → per-client rate limit → geometry check (≤ 50 000 positions,
≤ 1 000 rings, bounded check work) → the result cache, keyed by (geometry
hash, copy, manifest revision) for CHIRPS and (geometry hash, grids) for the
MAP grid → the read. Refusals are `{ error }` JSON: 400 bad body or
geometry, 404, 413, 422 an area the data can't answer (outside the copy,
over 2 000 cells, no data, grid coverage under 90 %, a box too wide, too dense
or with no grid, these last with a `code`), 429, 503 the data
isn't configured or isn't answering, 504 the CHIRPS read passed its 25 s
deadline, or a channel box its 20 s one (asking again finishes it; the tiles
done are kept).

**Per instance, on purpose.** The rate limit (30 CHIRPS / 120 MAP / 120
quaternary / 30 delineate / 60 channel / 20 land-use requests per client per 10
minutes) and the caches (200 CHIRPS series, 500 MAP means, 50 delineations, 128
channel tiles, 16 land-use answers, LRU) live in one Lambda instance's memory. They bound what one client can
make one instance do; the global per-IP limit is the WAF rule on CloudFront,
and reserved concurrency bounds the rest. The opened CHIRPS copy (array +
manifest) is kept 5 minutes, so a new manifest `revision` is seen within that
time; a MAP grid and the quaternary file are read once per instance. The
cells route isn't cached: it is a slice of memory.

## Deployment targets

- **Frontend**: S3 bucket (private) + CloudFront with OAC. ACM cert in
  `us-east-1`. Route 53 A-alias records for apex and `www`.
- **Backend**: AWS Lambda with Function URL (no API Gateway). Single
  `dist/lambda.mjs` ESM bundle via esbuild.

Both deploy workflows authenticate via **GitHub OIDC federation** — no
long-lived AWS access keys. The IAM role's trust policy is scoped to the
`main` branch only.
