---
description: Find server-only secrets that may have leaked into a client bundle, git history, GitHub Actions logs, or a public asset
---

Audit for secrets, env vars and keys that should be server-only but are reachable from the client bundle, a public asset, a workflow log or git history.

## Goal

Production secrets live SOPS-encrypted in the **sibling `infra-secrets` repo** (`infra-secrets/pitman/`), NOT in this repo. Pitman's own secrets are few: the CloudFront shared secret and the two auth keys are Terraform `random_password` values (in state and the Lambda's environment, an accepted gap in `docs/security.md`), the Cape Farm Mapper token (`CFM_TOKEN`) is the operator's, and CI holds `AUTH_KIT_READ_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and the Dependabot `DEPENDABOT_LOCKFILE_PAT`. The frontend has only `PUBLIC_*` values, inlined at build. Find any key on the wrong side, confirm no secret (encrypted or not) is committed here, and confirm history is clean.

**Never decrypt, print or read a secret value** (no `sops -d`, no `aws lambda get-function-configuration`, no `terraform output` of a sensitive value). SOPS keeps key names in plaintext, so names can be compared without decrypting; values are the operator's to check.

## What to check

1. **No secret files in this repo.**
   - `git ls-files | grep -E '\.sops(\.yaml)?$'` returns nothing (bar `*.sops.yaml.example`); the `.gitignore` guard (`*.sops`, `*.sops.yaml`) backs it up.
   - `../infra-secrets/pitman/*.sops.yaml`, if present: every value is `ENC[AES256_GCM,...]` with a `sops:` block. Check by reading the file's structure, not by decrypting it.

2. **Plaintext siblings absent from git.**
   - `backend/.env`, `frontend/.env`, `*.env.development.local`, `infra/terraform.tfvars`, `infra/backend.config`, `infra/*.tfstate*` are gitignored.
   - `git log --all --full-history -- backend/.env frontend/.env infra/terraform.tfvars infra/backend.config` returns no commits. Any hit means the values are permanently exposed and need rotation: Critical.

3. **Committed `.env.development` files are non-sensitive.** `backend/.env.development` and `frontend/.env.development` may hold only localhost URLs, ports, local file paths, `memory`/`console` transports and dev flags (CLAUDE.md § Local-dev env is committed). A real token, a real AWS resource name that grants access, or a value reused elsewhere is a finding.

4. **Client-bundle leakage.**
   - The frontend is static: `$env/static/private` and `$env/dynamic/*` must not appear in `frontend/src/` (their presence implies an SSR adapter). Every hit is a finding.
   - Raw `process.env` in `frontend/src/` is dead code or a bug.
   - `frontend/src/env.ts` declares only `PUBLIC_*` names; compare with `frontend/.env.development`.

5. **Backend env hygiene.**
   - Nothing reachable from `backend/src/lambda.ts` imports `dotenv` (only `backend/src/server.ts` does).
   - `CFM_TOKEN` is read only in `backend/src/cfm/` and never logged or returned; upstream error text is not passed through to a response.
   - Logs carry no secret and no personal data (`backend/src/http/logError.ts`, `backend/src/__tests__/logGuard.ts`).
   - Compare the env names the Lambda needs (`infra/lambda.tf` `environment`, `docs/deployment.md` § Lambda environment) with what the code reads; a name with no documented purpose is Low.

6. **GitHub Actions.**
   - Every `env:` in `.github/workflows/*.yml` references `${{ secrets.X }}` or `${{ vars.X }}`, never a literal.
   - No step echoes a secret or runs `set -x` with one in scope.
   - `AUTH_KIT_READ_TOKEN` reaches git only on the `pnpm install` step, as `GIT_CONFIG_*` env, never written to a config file (`scripts/ci-guards/workflows.test.mjs` enforces this; confirm it's green).
   - Deploy workflows use OIDC (`role-to-assume`), never `aws-access-key-id`. A long-lived AWS key in any workflow is Critical.

7. **Terraform outputs.** No `output` in `infra/outputs.tf` exposes the shared secret or an auth key without `sensitive = true`.

8. **Public assets.** Search `frontend/static/` and the committed fixtures (`backend/fixtures/`, `docs/formats/examples/`) for key shapes: `AKIA`, `ghp_`, `github_pat_`, `sk-`, `Bearer `, long hex or base64 runs.

9. **Git history pickaxe.** `git log --all -S 'AKIA' -S 'github_pat_' -S 'CFM_TOKEN=' -S 'AUTH_SESSION_KEY=' -S 'CLOUDFRONT_SHARED_SECRET=' --source --pretty=oneline`. A real value touched once is permanently exposed: rotate it, whatever was removed later. The weekly `gitleaks-sweep.yml` covers the same ground; check its latest run.

10. **`.gitignore`** covers `.env`, `.env.*.local`, `*.tfvars` (with `!*.tfvars.example`), `infra/backend.config`, `*.tfstate*`, `*.sops*`. A missing path is Medium.

## Report

- **Critical**: a real secret in git history; a secret file committed to this repo; an SSR adapter exposing server-only env; an AWS access key in a workflow.
- **High**: server-only env referenced from frontend code; dotenv reachable from the Lambda bundle; a workflow that logs a secret; the auth-kit token outside the install step.
- **Medium**: a sensitive value in a committed `.env.development`; a sensitive output without `sensitive = true`; `.gitignore` missing a path.
- **Low**: an env name with no documented purpose; a missing example entry.

For each: the env-var name and file:line, and what should change. **Never paste a found value into the report.**

## Useful starting points

- `backend/.env.development`, `frontend/.env.development`, `infra/terraform.tfvars.example` — declared env shapes
- `backend/src/lambda.ts`, `backend/src/server.ts` — the two entry points (`docs/STACK.md` § Conventions and gotchas)
- `.github/workflows/deploy-frontend.yml`, `.github/workflows/deploy-backend.yml` — the OIDC pattern
- `scripts/ci-guards/workflows.test.mjs` — the auth-kit token guard
- `docs/deployment.md` § Secrets, `docs/security.md` § Secrets management
- `../infra-secrets/README.md` — the estate secrets model

## Delegate to

Use the `repo-security-auditor` agent: `"Audit for server-only secrets that may have leaked into a client bundle, public asset, GitHub Actions log, or git history."`

Read-only. Recommendations only; never decrypt or paste a secret. Identify by name and location.
