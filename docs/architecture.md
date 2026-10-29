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
│   ├── .env.development      PUBLIC_API_URL, PUBLIC_SITE_URL (committed defaults)
│   └── src/
│       ├── app.css           Base styles
│       ├── app.html
│       ├── lib/network/      Load, validate, store, run (worker), save (§ App flow)
│       ├── lib/results/      Results and plots: logic in targets, analysis, charts, statistics-table, downloads (.ts, unit-tested); plot.ts is the uPlot action; spec docs/theory/statistics.md
│       └── routes/           +page.svelte: the app shell
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

## App flow: load → validate → store → run → save

The app is one static page (`frontend/src/routes/+page.svelte`). Everything
happens in the browser; no network file is ever uploaded (issue #3 rule 7).
The page holds the state; the logic is in `frontend/src/lib/network/*.ts`,
each with a vitest test beside it.

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
5. **Run** (`modes.ts`, `run-client.ts`, `run.worker.ts`, `run-protocol.ts`).
   The mode picker offers present day (year default 2025), natural and
   historical (decision D1); several run in one go so results compare. The
   run happens in a module Web Worker: one request (the bundle without its
   file index, and the modes), then per mode a `progress` and a `result` or
   an `error`, then `done`. A failing mode doesn't lose the others; Cancel
   terminates the worker. The results section carries
   `data-run-state` (`idle`, `running`, `done`, `failed`) and
   `data-ready="true"` once a run has finished, for end-to-end tests, and
   renders `frontend/src/lib/results/Results.svelte` with the successful runs.
6. **Save** (`save.ts`). `writeBundle` writes every file back: an unchanged
   file byte for byte, a changed one in WRSM2000's standard layout
   (decision R2-4), plus every kept file. The sidecar is stamped with
   `writtenBy` (the frontend package version) and `savedAt` and written as
   `pitman.json` beside the `.NET`. The zip is offered as a download.

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

Stateless: it receives only an area (GeoJSON) and answers numbers, never
network files. CloudFront strips `/api` before the Lambda (R4-I4), so the
routes are mounted unprefixed (`/chirps/monthly` here is `/api/chirps/monthly`
in the browser).

| Route | Body → answer | Module |
|---|---|---|
| `GET /health` | `{ ok: true }` | `app.ts` |
| `POST /chirps/monthly` | `ChirpsMonthlyRequest` → `ChirpsMonthly` (`packages/wrsm/src/extend/contract.ts`) | `src/chirps/` |
| `POST /map-grid/mean` | `{ area }` → `MapGridSample` + provenance | `src/mapgrid/` |

No quaternary routes: there are no licensed boundaries yet (D-1), so the app
takes an uploaded boundary.

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
  `MapGridSource`).
- `src/http/`: the `{ area }` body check, the result cache, the rate limit,
  error responses.

Request path: CloudFront shared secret (timing-safe compare) → CORS → 2 MiB
body limit → per-client rate limit → geometry check (≤ 50 000 positions,
≤ 1 000 rings, bounded check work) → the result cache, keyed by (geometry
hash, copy, manifest revision) for CHIRPS and (geometry hash, grids) for the
MAP grid → the read. Refusals are `{ error }` JSON: 400 bad body or
geometry, 404, 413, 422 an area the data can't answer (outside the copy,
over 2 000 cells, no data, grid coverage under 90 %), 429, 503 the data
isn't configured or isn't answering, 504 the CHIRPS read passed its 25 s
deadline.

**Per instance, on purpose.** The rate limit (30 CHIRPS / 120 MAP requests
per client per 10 minutes) and the caches (200 CHIRPS series, 500 MAP means,
LRU) live in one Lambda instance's memory. They bound what one client can
make one instance do; the global per-IP limit is the WAF rule on CloudFront,
and reserved concurrency bounds the rest. The opened CHIRPS copy (array +
manifest) is kept 5 minutes, so a new manifest `revision` is seen within that
time; a MAP grid is read once per instance.

## Deployment targets

- **Frontend**: S3 bucket (private) + CloudFront with OAC. ACM cert in
  `us-east-1`. Route 53 A-alias records for apex and `www`.
- **Backend**: AWS Lambda with Function URL (no API Gateway). Single
  `dist/lambda.mjs` ESM bundle via esbuild.

Both deploy workflows authenticate via **GitHub OIDC federation** — no
long-lived AWS access keys. The IAM role's trust policy is scoped to the
`main` branch only.
