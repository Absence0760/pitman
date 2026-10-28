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

## Common issues

**`PUBLIC_API_URL` is not defined at build time**
: It's set in the committed `frontend/.env.development`. If you overrode it in `frontend/.env.development.local`, make sure that file still defines it.

**CORS errors in the browser**
: `ALLOWED_ORIGINS` (in `backend/.env.development`, or your `.env.development.local` override) must include `http://localhost:7777`.

**Port already in use**
: Frontend is hardcoded to 7777. Backend respects `PORT` env var (default 3001).

## Next step: deploying

See [`deployment.md`](./deployment.md) for the AWS deployment walkthrough.
