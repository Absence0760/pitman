# Stack — web-minimal

Full-stack web template. Static frontend + serverless backend, deployed to AWS via GitHub Actions with OIDC. Production secrets live SOPS + AWS-KMS-encrypted in the private `infra-secrets` repo (one subdir per project), never in this repo.

## Stack

- **frontend/** — SvelteKit 5 static site (adapter-static), Vite, TypeScript, vitest. Dev port `7777`.
- **backend/** — Hono on AWS Lambda (Function URL). TypeScript, esbuild, tsx for local dev, vitest. Dev port `3001` (`PORT` env override).
- **infra/** — Terraform: S3 + CloudFront + Lambda + Route 53 + ACM + GitHub OIDC. No package.json.

pnpm monorepo, two workspaces: `@my-project/{frontend,backend}`. Node `>=22`.

## Commands (run from repo root)

```bash
pnpm install                 # bootstrap
pnpm dev                     # frontend (7777) + backend (3001) in parallel
pnpm build                   # build all workspaces
pnpm check                   # typecheck all
pnpm test                    # vitest run across workspaces
pnpm frontend <script>       # run a script in one workspace
pnpm backend <script>
```

Tests live in `frontend/` and `backend/` (vitest).

## First-time setup (after cloning this template)

Local dev needs **no env setup** — both workspaces ship a committed
`.env.development` with non-sensitive local defaults, loaded automatically:

1. Find-and-replace `my-project` with your project name across all files (package.json, infra/, scripts/, README.md). See `README.md § Customise the template` for the exact list.
2. `pnpm install`
3. `pnpm dev`

Personal overrides or real secrets you want locally go in a gitignored
`<workspace>/.env.development.local` (loaded first, so it wins) — never edit the
committed `.env.development`.

### Deploy bootstrap (AWS — only when you're ready to ship)

4. **Cross-project bootstrap** (provisions the AWS sub-account itself + tfstate bucket + KMS + OIDC deploy role + GitHub `production` env + branch protection). Run from `~/repos/templates`:
   ```bash
   ./scripts/new-project-account.sh <your-slug>
   ```
5. **Bootstrap this project's secrets slot** — production secrets live in the private `infra-secrets` repo (sibling of this repo under `~/github/`), one subdir per project, **not** in this repo. Authenticated to the project's AWS account:
   ```bash
   cd ../infra-secrets && ./bin/sops-init.sh --project <your-slug> --region <region>
   ```
6. Fill in the **real** production secrets and commit them encrypted, in `infra-secrets`:
   ```bash
   sops <your-slug>/prod.sops.yaml   # seed from <your-slug>/prod.sops.yaml.example
   ```
   Local dev does not need these — a gitignored `backend/.env.development.local` covers it. See `../infra-secrets/README.md` for the full model.

Production deploy (after first-time setup): see `infra/README.md § First-time setup`.

## Where to look

- `docs/architecture.md` — system diagram and service boundaries
- `docs/run-locally.md` — detailed local dev setup
- `docs/deployment.md` — CI/CD, OIDC, release flow, SOPS secrets workflow
- `docs/security.md` — risk register, mitigations, incident playbook
- `infra/README.md` — Terraform module specifics
- `.github/workflows/` — `ci.yml` (PR + push typecheck/test), two deploy workflows (frontend, backend), `claude.yml` Claude Code automation, `audit.yml` (weekly `pnpm audit`), `dependabot-lockfile.yml` (syncs root `pnpm-lock.yaml` on Dependabot PRs). Dependabot config in `.github/dependabot.yml`.

Prefer reading these over guessing. Update them when behavior changes.

## Conventions and gotchas

- **Static frontend** — no SSR. Anything dynamic goes through the backend API.
- **Two backend entry points** — `backend/src/app.ts` builds the Hono app via `createApp()`. `backend/src/server.ts` is the local dev entry (imports `dotenv/config`). `backend/src/lambda.ts` is the AWS Lambda entry and deliberately does **not** import `server.ts`, so esbuild tree-shakes `dotenv` out of the deployment bundle. Do not add `dotenv` imports to any module reachable from `lambda.ts`.
- **Terraform** — don't run `terraform apply` without explicit user confirmation. `plan` is fine.
- **Infra changes** — coordinate Terraform edits with workflow changes in `.github/workflows/`.
- **Svelte 5 runes** — use `$state`, `$derived`, `$effect`, `$props` — not the legacy options API.

## What not to do

- Don't add a test framework other than vitest.
- Don't replace pnpm with npm/yarn — workspace filters assume pnpm.
- Don't add SSR adapters to the frontend; it must stay static for the S3 + CloudFront deploy.
- Don't call secret-bearing services directly from the frontend — go through the backend.
