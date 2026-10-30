# Stack — web-minimal

Full-stack web template. Static frontend + serverless backend, deployed to AWS via GitHub Actions with OIDC. Production secrets live SOPS + AWS-KMS-encrypted in the private `infra-secrets` repo (one subdir per project), never in this repo.

## Stack

- **frontend/** — SvelteKit 5 static site (adapter-static), Vite, TypeScript, vitest; Playwright for end-to-end tests. Dev port `7777`.
- **backend/** — Hono on AWS Lambda (Function URL). TypeScript, esbuild, tsx for local dev, vitest. Dev port `3001` (`PORT` env override).
- **infra/** — Terraform: S3 + CloudFront + Lambda + Route 53 + ACM + GitHub OIDC. No package.json.

pnpm monorepo, four workspaces: `@pitman/{frontend,backend}` and the engine packages `@pitman/wrsm` (`packages/wrsm`, the pure TypeScript model: no I/O, DOM or Node APIs) and `@pitman/wrsm-cli` (`packages/wrsm-cli`, the `wrsm` command that reads and writes network folders). Node `>=22`.

## Commands (run from repo root)

```bash
pnpm install                 # bootstrap
pnpm dev                     # frontend (7777) + backend (3001) in parallel
pnpm build                   # build all workspaces
pnpm check                   # typecheck all
pnpm test                    # vitest run across workspaces
pnpm test:frontend:e2e       # Playwright against the built site (first: pnpm --filter @pitman/frontend exec playwright install chromium)
pnpm test:coverage           # the same with v8 coverage + a table of what no test reaches (a report, never a gate)
pnpm test:tools              # node:test suites for scripts/ (the coverage summary)
pnpm frontend <script>       # run a script in one workspace
pnpm backend <script>
```

Unit tests (vitest) sit beside the code in every workspace. End-to-end tests (Playwright) live in `frontend/e2e/*.spec.ts` and run against `vite build` + `vite preview` on port 8888.

## First-time setup (after cloning this template)

Local dev needs **no env setup** — both workspaces ship a committed
`.env.development` with non-sensitive local defaults, loaded automatically:

1. Find-and-replace `pitman` with your project name across all files (package.json, infra/, scripts/, README.md). See `README.md § Customise the template` for the exact list.
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
- `docs/design/ui-playbook.md` — the look, the design tokens and how screens are checked
- `infra/README.md` — Terraform module specifics
- `.github/workflows/` — `ci.yml` (PR + push typecheck/test), two deploy workflows (frontend, backend), `claude.yml` Claude Code automation, `audit.yml` (weekly `pnpm audit`), `dependabot-lockfile.yml` (syncs root `pnpm-lock.yaml` on Dependabot PRs), `gitleaks-sweep.yml` (weekly full-history secret scan, opens a `secret-scan` issue on failure), `coverage.yml` (weekly coverage report), `terraform.yml` (`infra/` fmt + validate + Trivy, credential-free; Terraform version in `infra/.terraform-version`), `pr-mergeable.yml` (flags a conflicted PR that CI never ran on). Dependabot config in `.github/dependabot.yml`.

Prefer reading these over guessing. Update them when behavior changes.

## Conventions and gotchas

- **Static frontend** — no SSR. Anything dynamic goes through the backend API.
- **Two backend entry points** — `backend/src/app.ts` builds the Hono app via `createApp()`. `backend/src/server.ts` is the local dev entry (imports `dotenv/config`). `backend/src/lambda.ts` is the AWS Lambda entry and deliberately does **not** import `server.ts`, so esbuild tree-shakes `dotenv` out of the deployment bundle. Do not add `dotenv` imports to any module reachable from `lambda.ts`.
- **Terraform** — don't run `terraform apply` without explicit user confirmation. `plan` is fine.
- **Infra changes** — coordinate Terraform edits with workflow changes in `.github/workflows/`.
- **Svelte 5 runes** — use `$state`, `$derived`, `$effect`, `$props` — not the legacy options API.
- **Two TypeScript majors, on purpose** — `packages/wrsm`, `packages/wrsm-cli` and `backend` use TypeScript 7 (the native `tsc`; their only consumer of `typescript` is the `check` script). `frontend` stays on TypeScript 6 because TypeScript 7.0 ships no JavaScript compiler API, which `svelte-kit sync` and `svelte-check` load (`@sveltejs/kit` 3.1.0 peers `typescript ^6.0.0`, `svelte-check` 4.7.7 peers `^5 || ^6`). Engine source is therefore typechecked by both: by TS 7 in its own `check`, by TS 6 when svelte-check follows the frontend's imports. Move the frontend to 7 once both tools support it: sveltejs/kit#17537 and sveltejs/language-tools#3063 (both wait on TypeScript 7.1's new API). Don't bump the frontend's `typescript` before then; Dependabot's combined bump breaks `svelte-kit sync`.

## What not to do

- Don't add a test framework other than vitest (unit) and Playwright (end-to-end, `frontend/e2e/`).
- Don't replace pnpm with npm/yarn — workspace filters assume pnpm.
- Don't add SSR adapters to the frontend; it must stay static for the S3 + CloudFront deploy.
- Don't call secret-bearing services directly from the frontend — go through the backend.
