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

## The engine CLI (`wrsm`)

`pnpm wrsm-cli wrsm <command>` runs `packages/wrsm-cli` under tsx.

- `wrsm run <networkDir> [--net <file.NET>] [--out <dir>] [--mode historical|presentDay|natural] [--year yyyy]`: Round 2 runs each classic-groundwater runoff module on its own (no network routing yet; Sami and Hughes modules are skipped with a message) and writes `<net>RQ<route>.ANS` for each route a runoff module feeds. Output goes to `<networkDir>/Out.pitman` unless `--out` is given. `--net` picks one network when the folder has several `.NET` files. `--mode` other than historical is accepted with a warning until Round 3; `presentDay` needs `--year`.
- `wrsm compare <networkDir> <outDir> [--reference <dir>]`: pairs simulated and reference `.ANS` files by name and prints, per route, MAR simulated/reference, % difference, NSE, max abs difference and the first diverging month. The reference defaults to `<networkDir>/Out`, else the folder itself. Exit 1 if a route listed as expected to match misses |MAR diff| ≤ 1 % or NSE ≥ 0.99 (`packages/wrsm/src/compare/expectations.ts`).
- Exit codes: 0 ok, 1 a failed run or comparison, 2 a usage error.

**Reference suite.** Point `WRSM_REFERENCE_DIR` at a folder of real WRSM2000 networks (never committed) and run `pnpm test:wrsm`: every reader then round-trips every real file. Without the variable those tests skip. Don't write `wrsm run` output into a reference folder you don't own: pass `--out`.

## Pushing straight to `main` (for now)

Until PRs return (issue #22 steps 10–11), work is committed and pushed straight to `main`. Install the local gate once per clone; it runs `pnpm check && pnpm test` before any push that touches code:

```bash
cp scripts/git-hooks/pre-push .git/hooks/pre-push
```

## Common issues

**`PUBLIC_API_URL` is not defined at build time**
: It's set in the committed `frontend/.env.development`. If you overrode it in `frontend/.env.development.local`, make sure that file still defines it.

**CORS errors in the browser**
: `ALLOWED_ORIGINS` (in `backend/.env.development`, or your `.env.development.local` override) must include `http://localhost:7777`.

**Port already in use**
: Frontend is hardcoded to 7777. Backend respects `PORT` env var (default 3001).

## Next step: deploying

See [`deployment.md`](./deployment.md) for the AWS deployment walkthrough.
