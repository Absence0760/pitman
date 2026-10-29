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
│       └── routes/
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
