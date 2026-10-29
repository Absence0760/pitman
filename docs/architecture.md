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
- `.github/workflows/` — two deploy workflows (frontend, backend) that
  authenticate to AWS via OIDC and deploy on release.

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
│       ├── lib/results/      Results and plots
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
   except `pitman.json`, which is UTF-8 (docs/formats.md §1.1).
3. **Validate** (`open.ts` → `readBundle` in `packages/wrsm/src/io/bundle.ts`).
   The engine finds the `.NET` (or asks which one when the folder holds
   several), reads every module file it lists and every rainfall, observed
   and defined-flow file they name, case-insensitively within the `.NET`'s
   folder, plus the `pitman.json` sidecar. Every file's error is collected
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

## Deployment targets

- **Frontend**: S3 bucket (private) + CloudFront with OAC. ACM cert in
  `us-east-1`. Route 53 A-alias records for apex and `www`.
- **Backend**: AWS Lambda with Function URL (no API Gateway). Single
  `dist/lambda.mjs` ESM bundle via esbuild.

Both deploy workflows authenticate via **GitHub OIDC federation** — no
long-lived AWS access keys. The IAM role's trust policy is scoped to the
`main` branch only.
