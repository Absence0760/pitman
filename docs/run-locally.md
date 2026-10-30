# Running locally

## Prerequisites

- **Node.js 20 or later** — check with `node --version`
- **pnpm 9 or later** — install with `npm install -g pnpm`

## One-time setup

```bash
pnpm install
```

No env setup needed — both workspaces ship a committed `.env.development` with
working local defaults (`backend/.env.development`, `frontend/.env.development`),
loaded automatically by `pnpm dev`. They hold only non-sensitive values
(localhost URLs, ports). To override a value locally, or to add a real secret,
create a gitignored `.env.development.local` next to it (loaded first, so it
wins) — don't edit the committed file.

## Running the site

```bash
pnpm dev
```

This starts the frontend and backend in parallel:

- **Frontend** — http://localhost:7777 (Vite dev server with HMR)
- **Backend** — http://localhost:3001 (`tsx watch` auto-reloading)

## Running packages individually

```bash
pnpm frontend dev         # frontend only
pnpm backend dev          # backend only
```

## Type-checking

```bash
pnpm check                # all workspaces
pnpm frontend check       # svelte-check on frontend
pnpm backend check        # tsc --noEmit on backend
```

## Building

```bash
pnpm build                # all workspaces
pnpm frontend build       # static site for S3
pnpm backend build        # esbuild bundle for Lambda
```

## Running tests

```bash
pnpm test                 # all workspaces
pnpm backend test         # backend only
pnpm frontend test        # frontend only
```

## Using the app locally

`pnpm frontend dev` serves the app at http://localhost:7777. Load a network
folder or zip (a synthetic one: `docs/formats/examples/network/`), pick the
run modes and run; **Save as WRSM2000 zip** downloads the network with its
`pitman.json` sidecar. The flow is described in
[`architecture.md` § App flow](./architecture.md#app-flow-load--validate--store--run--save).

- Nothing is uploaded: the backend is not involved in loading, running or saving.
- The browser keeps a working copy in IndexedDB (database `pitman`). **Forget
  the working copy** deletes it; so does clearing the site's data in the
  browser's developer tools (Application → Storage).
- Until Round 3 integration wires the network runner, `run()` in
  `@pitman/wrsm` is a stub, so each mode reports "run(): network routing is
  wired at Round 3 integration" as its error. The app's tests use a fake run.

## Backend data (local-first)

The data API (`POST /chirps/monthly`, `POST /map-grid/mean`, `POST /delineate`,
`GET /channels`) reads local synthetic copies in dev, set by the committed
`backend/.env.development` (`CHIRPS_SOURCE=local`, `MAP_GRID_SOURCE=local`,
`DEM_SOURCE=local`). Write them once:

```bash
pnpm dev:data:synthetic      # = pnpm -C backend exec tsx scripts/gen-synthetic-data.ts
```

It writes, under `backend/.local/` (gitignored, ~7 MB, about 15 seconds):

- `mirror/`: a CHIRPS copy in the real copy's Zarr layout and manifest,
  1981-01 to the last complete month, over one invented 1° block (21–22° E,
  34.5–33.5° S) with an invented coast along its south; seeded, so the same
  arguments always write the same values (`--through YYYY-MM`, `--seed N`,
  `--out DIR`).
- `map-grid/synthetic.json`: an invented 0.01° MAP grid over the same block.
- `dem/synthetic.pmtiles`: an invented DEM over the same block (4.3 MB), in
  the real one's form (Terrarium tiles, PMTiles, zoom 11, 512 px, ~32 m), so
  the windows and timings are real. Its valleys are laid out on the synthetic
  quaternaries: each 0.25° column drains south with its ridges on the column's
  edges, and low sills at the row boundaries make each quaternary nearly a
  basin of its own.

Invented values only. Areas elsewhere answer 422 ("no data under the
area"); IC-WBT's synthetic quaternaries (`backend/fixtures/geo/quaternaries.synthetic.geojson`,
codes `Z01A`…) sit inside the block and make good test boundaries to upload.
Without the files the routes answer 503 naming the command. With
`CHIRPS_SOURCE`, `MAP_GRID_SOURCE` or `DEM_SOURCE` unset the routes answer 503
"not configured". The `s3` settings (`CHIRPS_BUCKET`, `CHIRPS_PREFIX`,
`MAP_GRID_SOURCE=s3://…`, `DEM_SOURCE=s3://…`, `DATA_REGION`) are for production and need the
cross-account grant ([`data.md` § Cross-account access](./data.md#cross-account-access-round-41)).

Clicks to try on the synthetic DEM, with their answers:

| Click (lon, lat) | In | Answer |
|---|---|---|
| 21.1110878, −33.6584957 | `Z01A` | a tributary: 29.06 km², remainder 614.17 km² |
| 21.1162376, −33.6001795 | `Z01A` | the river's upper part: 202.47 km², remainder 440.76 km² |
| 21.1066246, −33.7359036 | `Z01A` | refused, `whole_quaternary` |
| 21.115551, −33.8001191 | `Z02A` | 76.54 km², 643 km² (89 %) dropped upstream, the 20 % warning |
| 21.24, −33.62 | `Z01A` | refused, `off_channel` |

## The engine CLI (`wrsm`)

`pnpm wrsm-cli wrsm <command>` runs `packages/wrsm-cli` under tsx.

- `wrsm run <networkDir> [--net <file.NET>] [--out <dir>] [--mode historical|presentDay|natural] [--year yyyy]`: reads the whole folder the way the app does (`readBundle`, Latin-1), runs the network in the chosen mode (default historical; `presentDay` needs `--year`), and writes `<net>RQ<route>.ANS` for every route and `<net>RV<n>.ANS` for every reservoir's storage. Output goes to `<networkDir>/Out.pitman` unless `--out` is given, and that folder is never read back as input. `--net` picks one network when the folder has several `.NET` files. Load and run messages go to stderr (info to stdout); any error exits 1. A network with Sami or Hughes runoff modules stops with the module named until Round 6, and irrigation modules carry zero, with a warning, until Round 7.
- `wrsm compare <networkDir> <outDir> [--reference <dir>]`: pairs simulated and reference `.ANS` files by name and prints, per route, MAR simulated/reference, % difference, NSE, max abs difference and the first diverging month. The reference defaults to `<networkDir>/Out`, else the folder itself. Exit 1 if a route listed as expected to match misses |MAR diff| ≤ 1 % or NSE ≥ 0.99 (`packages/wrsm/src/compare/expectations.ts`).
- Exit codes: 0 ok, 1 a failed run or comparison, 2 a usage error.

**Reference suite.** Point `WRSM_REFERENCE_DIR` at a folder of real WRSM2000 networks (never committed) and run `pnpm test:wrsm`: every reader then round-trips every real file, and `readBundle`/`writeBundle` round-trip every network folder byte for byte (`src/io/bundle.reference.test.ts`). Without the variable those tests skip. Don't write `wrsm run` output into a reference folder you don't own: pass `--out`.

## Pushing straight to `main` (for now)

Until PRs return (issue #22 steps 10–11), work is committed and pushed straight to `main`. Install the local gate once per clone; it runs `pnpm check && pnpm test` before any push that touches code:

```bash
cp scripts/git-hooks/pre-push .git/hooks/pre-push
```

## Common issues

**The app calls the wrong API**
: `PUBLIC_API_URL` is declared in `frontend/src/env.ts` and set in the committed `frontend/.env.development` (`http://localhost:3001`). A build without it (a local `vite build`, the end-to-end tests) uses production's same-origin `/api` (decision R4-I4).

**CORS errors in the browser**
: `ALLOWED_ORIGINS` (in `backend/.env.development`, or your `.env.development.local` override) must include `http://localhost:7777`.

**Port already in use**
: Frontend is hardcoded to 7777. Backend respects `PORT` env var (default 3001).

## Next step: deploying

See [`deployment.md`](./deployment.md) for the AWS deployment walkthrough.
