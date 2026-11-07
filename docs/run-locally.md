# Running locally

## Prerequisites

- **Node.js 24 or later** (`engines` in `package.json`; the Lambda runs 24 and auth-kit requires it; `.tool-versions` pins it for asdf / mise) — check with `node --version`
- **pnpm 10** — the root `package.json` pins `pnpm@10.34.9` (`packageManager`);
  `corepack enable` picks it up, or run `npx pnpm@10.34.9 …`
- **Read access to the private `Absence0760/auth-kit`** — the backend installs
  it from git over SSH, so your GitHub SSH key must be able to read it
- **Docker** — only for the opt-in sign-in services (§ Sign-in)

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
- **Backend** — http://127.0.0.1:3001 (`tsx watch` auto-reloading), on loopback only so the dev keys and dev cookie aren't reachable from the LAN; `BACKEND_HOST` overrides the address (e.g. `0.0.0.0` in a container)

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
pnpm check:env            # the committed .env.development files stay local-only
pnpm check:compliance     # advisory: this branch vs origin/main, privacy/data docs kept in step
```

`pnpm check:doc-links` checks that every relative link in the tracked markdown resolves, to the file and to the GitHub heading slug (`scripts/ci-guards/check_doc_links.mjs`; the byte-exact `docs/formats/examples/` is skipped). Rewording a heading breaks every link to it; the failure names the slug to write when the heading is numbered.

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
pnpm test:tools           # repo scripts + CI guards (scripts/ci-guards/), root-scripts guard first
```

## Using the app locally

`pnpm frontend dev` serves the app at http://localhost:7777. Load a network
folder or zip (a synthetic one: `docs/formats/examples/network/`), pick the
run modes and run; **Save as WRSM2000 zip** downloads the network with its
`pitman.json` sidecar. The flow is described in
[`architecture.md` § App flow](./architecture.md#app-flow-load--validate--store--extend--sub-divide--run--save).

- Nothing is uploaded: the backend is not involved in loading, running or saving.
- The browser keeps a working copy in IndexedDB (database `pitman`). **Forget
  the working copy** deletes it; so does clearing the site's data in the
  browser's developer tools (Application → Storage).
- Until Round 3 integration wires the network runner, `run()` in
  `@pitman/wrsm` is a stub, so each mode reports "run(): network routing is
  wired at Round 3 integration" as its error. The app's tests use a fake run.

## Backend data (local-first)

The data API (`POST /chirps/monthly`, `POST /map-grid/mean`,
`POST /map-grid/cells`, `POST /delineate`, `GET /channels`) reads local synthetic
copies in dev, set by the committed `backend/.env.development`
(`CHIRPS_SOURCE=local`, `MAP_GRID_SOURCE=local`, `DEM_SOURCE=local`). Write them
once:

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
codes `Z01A`…) sit inside the block, are what `GET /quaternaries` serves in dev
and make good test boundaries to upload.
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

## Sign-in (local-first)

Every API route but `/health` needs a session (`docs/architecture.md`
§ Sign-in), and `pnpm dev` signs you in with **no docker and no setup**:
`backend/.env.development` sets an in-memory user list (`USER_STORE=memory`),
console mail (`MAIL_TRANSPORT=console`) through an in-process mail queue
(`MAIL_QUEUE=inline`: the code is sealed and sent just after the request
answers, as the Lambda's SQS worker does; the Lambda uses SQS, #30), dev-only signing keys, and
`DEV_ADMIN_EMAIL=admin@example.test`, whom the dev server makes the first
admin at startup (the in-memory list is empty on every restart).

1. Sign in as `admin@example.test`.
2. The code is printed in the backend's terminal, with the address masked:
   `[mail:console] Pitman sign-in code 123456 for a…@example.test`.
3. Add more users on the Users page; they live until the backend restarts.

The browser must reach the API same-origin (the frontend's Vite proxy sends
`/api/*` to the backend, as CloudFront does in production), so the session
cookie is sent without CORS credentials. Over http://localhost the cookie is
a plain `pitman_session` without `Secure` (`AUTH_DEV_COOKIE=true`); production
always uses `__Host-pitman_session`.

### With DynamoDB Local and Mailpit

To run against the same store as production and see the emails:

```bash
pnpm dev:auth:up        # DynamoDB Local on 127.0.0.1:8000, Mailpit on 1025 (SMTP) and http://localhost:8025 (UI)
pnpm dev:auth:seed      # makes the table pitman-users-local and the dev admin; safe to re-run
```

Then put these in `backend/.env.development.local` and restart `pnpm dev`:

```bash
USER_STORE=dynamodb
USERS_TABLE=pitman-users-local
DYNAMODB_ENDPOINT=http://127.0.0.1:8000
MAIL_TRANSPORT=smtp
```

Codes now arrive in Mailpit. `pnpm dev:auth:status` and `pnpm dev:auth:logs`
show the containers; `pnpm dev:auth:down` stops them, and DynamoDB Local runs
in memory, so the table goes with it (seed again after the next `up`).
auth-kit's own `pnpm dynamo:up` uses port 8000 too: run one at a time.

The operator scripts (`pnpm admin:*`, `docs/deployment.md` § Sign-in) run
against DynamoDB Local when `DYNAMODB_ENDPOINT` is set, taking the table and
code key from the environment instead of the Lambda's (they don't read
`.env.development`), and skip SES. To try an access export
(`docs/security.md` § Access requests) on the seeded table:

```bash
DYNAMODB_ENDPOINT=http://127.0.0.1:8000 USERS_TABLE=pitman-users-local AUTH_CODE_KEY=dev-only-code-key-not-a-secret-0123456789 pnpm admin:export
```

Type `admin@example.test`, then a path outside the repository such as
`/tmp/export.json` (or `-` for stdout).

The backend's DynamoDB tests (`src/auth/dynamo.test.ts`, the sign-in races)
run when `DYNAMODB_ENDPOINT` is set and skip, saying so, when it isn't:

```bash
pnpm dev:auth:up && DYNAMODB_ENDPOINT=http://127.0.0.1:8000 pnpm backend test
```

## Land use

Local-first, with nothing to generate. `POST /cfm/land-use` answers from invented
fields and dams computed in code (`CFM_SOURCE=local` in
`backend/.env.development`), over the same block as the synthetic data above:
about 330 fields and 17 dams in `Z01A`, some dams listed by several sources with
figures that disagree. Off the block the answer is empty. The screen says when it
is showing this source. Unset `CFM_SOURCE` to see the 503 "not configured" path,
which is production until the operator's token exists
([`data.md` § Cape Farm Mapper](./data.md#cape-farm-mapper-d3)). No token goes in
any `.env` file in this repo.

## The map

Local-first, with no setup beyond the section above. `GET /quaternaries` serves
the committed synthetic region (`QUATERNARIES_SOURCE=local` in
`backend/.env.development`, codes `Z01A`…), and the MAP-grid layer reads the
synthetic grid, so run `pnpm dev:data:synthetic` once. With
`QUATERNARIES_SOURCE` unset the route answers 503 and the panel says the
boundaries aren't available, which is what production does until D-1.

There are no tiles locally: `PUBLIC_TILES_URL`, `PUBLIC_TILES_GLYPHS_URL` and
`PUBLIC_TERRAIN_URL` are empty in `frontend/.env.development`, so the map draws
on a plain background and says so in a small note. Nothing else changes. To see
a basemap, put PMTiles files where the browser can read them with range requests
and set the URLs in a gitignored `frontend/.env.development.local`. Formats and
licences: [`data.md` § Basemap and fonts](./data.md#basemap-and-fonts).

## The engine CLI (`wrsm`)

`pnpm wrsm-cli wrsm <command>` runs `packages/wrsm-cli` under tsx.

- `wrsm run <networkDir> [--net <file.NET>] [--out <dir>] [--mode historical|presentDay|natural] [--year yyyy]`: reads the whole folder the way the app does (`readBundle`, Latin-1), runs the network in the chosen mode (default historical; `presentDay` needs `--year`), and writes `<net>RQ<route>.ANS` for every route and `<net>RV<n>.ANS` for every reservoir's storage. Output goes to `<networkDir>/Out.pitman` unless `--out` is given, and that folder is never read back as input. `--net` picks one network when the folder has several `.NET` files. Load and run messages go to stderr (info to stdout); any error exits 1. A network with Sami or Hughes runoff modules stops with the module named until Round 6, and irrigation modules carry zero, with a warning, until Round 7.
- `wrsm compare <networkDir> <outDir> [--reference <dir>]`: pairs simulated and reference `.ANS` files by name and prints, per route, MAR simulated/reference, % difference, NSE, max abs difference and the first diverging month. The reference defaults to `<networkDir>/Out`, else the folder itself. Exit 1 if a route listed as expected to match misses |MAR diff| ≤ 1 % or NSE ≥ 0.99 (`packages/wrsm/src/compare/expectations.ts`).
- Exit codes: 0 ok, 1 a failed run or comparison, 2 a usage error.

**Reference suite.** Point `WRSM_REFERENCE_DIR` at a folder of real WRSM2000 networks (never committed) and run `pnpm test:wrsm`: every reader then round-trips every real file, and `readBundle`/`writeBundle` round-trip every network folder byte for byte (`src/io/bundle.reference.test.ts`). Without the variable those tests skip. The whole-network and module comparisons (`src/compare/*.reference.test.ts`) write their detailed reports, which name reference folders and carry per-module figures, to `../pitman-private/reports/` beside the main checkout (override with `WRSM_PRIVATE_DIR`), and refuse a path inside the repo, so no private data lands in the working tree. Don't write `wrsm run` output into a reference folder you don't own: pass `--out`.

## Fresh clone

`.github/workflows/fresh-clone.yml` proves a fresh clone runs with the steps on this page and nothing else: a clean checkout, Node from `.tool-versions`, `pnpm install --frozen-lockfile`, `pnpm dev:data:synthetic`, then `pnpm dev`, until the backend answers `GET http://127.0.0.1:3001/health` with `{"ok":true}` (the one route that needs no session), the frontend renders the home page on `:7777`, and `/api/health` answers through Vite's proxy. It then stops `pnpm dev` and checks the backend is gone. The one difference from a laptop is how auth-kit is fetched: CI uses the read-only `AUTH_KIT_READ_TOKEN` on the install step alone, as `ci.yml` does ([`deployment.md` § Sign-in](./deployment.md#sign-in)).

It is not behind `CI gate`. It runs on a PR or push to `main` that touches what only a fresh clone exercises (the `package.json` files, the lockfile, `pnpm-workspace.yaml`, `.tool-versions`, the committed `.env.development` files, `backend/src/server.ts`, `backend/scripts/gen-synthetic-data.ts`, `frontend/vite.config.ts`), weekly (Mondays 07:00 UTC) for drift no path shows, and by hand (`gh workflow run fresh-clone.yml`). `scripts/ci-guards/fresh-clone.test.mjs` (`pnpm test:tools`) fails if a watched path no longer exists, `.tool-versions` falls below the `engines` floor, or `.tool-versions` gains a comment or blank line (setup-node then reads `#` as the Node version, as the template copy did on the first run).

## Pushing straight to `main` (for now)

Until PRs return (issue #22 steps 10–11), work is committed and pushed straight to `main`. The local gate needs no install: `pnpm install` sets `core.hooksPath` to `.githooks/` (the root `prepare` script, `scripts/git-hooks/install.mjs`), shared by every worktree of the clone. Then:

- `pre-commit` and `commit-msg` run the client terms guard on the staged changes and the message (a no-op until `../infra-secrets/pitman/client-terms.txt` exists; [`security.md` § Public repo hygiene](./security.md#public-repo-hygiene)), then the pre-commit framework's hooks (gitleaks and the file checks) if `pre-commit` is installed.
- `pre-push` runs `pnpm check && pnpm test` before any push that touches more than docs, markdown or `.claude/`.

If you once copied the old `pre-push` into `.git/hooks/`, it is now ignored and can be deleted. If you keep your own hooks in `core.hooksPath`, the install leaves it alone and warns; this repo's hooks then don't run.

## Common issues

**The app calls the wrong API**
: `PUBLIC_API_URL` is declared in `frontend/src/env.ts` and is `/api` everywhere: the committed `frontend/.env.development`, a build without it (a local `vite build`, the end-to-end tests) and production (decision R4-I4). In dev, Vite's dev and preview servers proxy `/api/*` to the Hono server on `http://127.0.0.1:3001` with `/api` stripped, as CloudFront does (`frontend/vite.config.ts`, A-AUTH-9), so the session cookie is first-party and the browser never makes a cross-origin call. Set `PITMAN_API_TARGET` to proxy to another address. A 502 on `/api/*` means the backend isn't running.

**Origin refused (403) on a POST**
: The browser's `Origin` is the page's own (`http://localhost:7777`, or `http://127.0.0.1:8888` under `vite preview`), and the backend's `csrf()`, CORS and same-origin check (`http/sameOrigin.ts`) check it against `ALLOWED_ORIGINS` (in `backend/.env.development`, which lists the dev and preview origins on both `localhost` and `127.0.0.1`, or your `.env.development.local` override). A browser on the page also sends `Sec-Fetch-Site: same-origin` through the Vite proxy, which passes too. A POST from `curl` needs `-H 'Origin: http://localhost:7777'`, or it is 403.

**Every API call answers 401**
: Sign in first (§ Sign-in). With the in-memory store a backend restart (`tsx watch` reloads on every save) empties the user list and ends every session: sign in again. A 503 `sign-in is not configured on this server` means a key or setting is missing; the backend prints `{"event":"auth.unconfigured","problem":…}` at startup naming it.

**Port already in use**
: Frontend is hardcoded to 7777. Backend respects `PORT` env var (default 3001) and `BACKEND_HOST` (default `127.0.0.1`).

## Next step: deploying

See [`deployment.md`](./deployment.md) for the AWS deployment walkthrough.
