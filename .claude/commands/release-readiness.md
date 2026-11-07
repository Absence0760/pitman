---
description: Pre-deploy readiness gate. Pitman deploys after CI passes on a push to main (each deploy waits for approval in the production environment), so this checks the working tree, main, CI status, and what each deploy workflow will ship since its last successful run. Reports a green/red checklist. Read-only; never pushes, approves or deploys.
---

Run a readiness audit before pushing to `main` or approving a waiting deploy in the `production` environment. Report a green/red checklist; never push, approve a deployment, run a workflow or tag anything. The operator does that after reviewing the report.

## Why this exists

Pitman has no release tags. `deploy-frontend.yml` and `deploy-backend.yml` run when CI completes successfully on a push to `main`, deploying only when their paths changed since the last successful deploy job (or by hand, from main, on a commit CI passed); they build without AWS access, then wait for the operator's approval in the `production` environment before the deploy job may assume the OIDC role (`docs/deployment.md` § How a deploy happens). Approving with CI red, or without knowing what changed since the last deploy, means the deploy doesn't match what you think it does. Until the operator sets the repo variables, both workflows skip; say so rather than reporting red.

## When to use

**Right fit:** you're about to push to `main`, or a deploy run is waiting for approval, and you want a single yes/no.

**Wrong fit — refuse:** you're on a feature branch or in a sub-agent worktree. Deploys come from `main`; say so and stop.

## Procedure

### 1. Confirm we're on main

```
git rev-parse --abbrev-ref HEAD
```

Not `main` → abort: "deploys come from `main`; you're on `<branch>`."

### 2. Universal gates

Mark each **green** / **red** with a one-line reason for any red.

- **Working tree clean** — `git status --porcelain` is empty. Other sessions may share this checkout (CLAUDE.md § Working alongside other Claude sessions): list dirty paths and say whose they look like, don't clean them. A tracked `backend/.env`, `infra/terraform.tfvars` or `infra/backend.config` is a separate Critical.
- **main in sync** — `git fetch origin main` then `git rev-list --left-right --count origin/main...HEAD`. Behind → red. Ahead → amber ("these commits deploy when pushed").
- **Local gate** — `pnpm check && pnpm test && pnpm test:tools && pnpm check:claude` pass on HEAD.
- **CI green** — `gh run list --workflow ci.yml --branch main --limit 1 --json headSha,status,conclusion`: for the pushed HEAD, `completed/success` → green. Also note the latest `terraform.yml`, `security.yml` and `audit.yml` runs; a failed one is amber.

If `gh` isn't logged in, recommend `gh auth login` and skip the `gh` rows rather than failing the report.

### 3. What each deploy will ship

For each deploy workflow, find the commit its last successful **deploy job** shipped. A successful run isn't enough (the gate may have decided nothing changed), and a run's `headSha` is main's head when it was triggered, not the commit it built: each run names its commit in its run-name (`Deploy backend <sha>`), which is what `scripts/deploy/deploy-gate.mjs` reads back. List recent successful runs with their titles, then take the newest whose deploy job (`Deploy to S3 + CloudFront` / `Update Lambda code`) succeeded:

```
gh run list --workflow deploy-frontend.yml --status success --limit 10 --json databaseId,displayTitle
gh run view <databaseId> --json jobs --jq '.jobs[] | "\(.name) \(.conclusion)"'
```

Do the same for `deploy-backend.yml`.

Then list what changed on the workflow's trigger paths since that SHA (or since the first commit, if it has never deployed):

```
# Frontend: frontend/, packages/wrsm/, pnpm-lock.yaml, pnpm-workspace.yaml, infra/csp.json, infra/scripts/check-csp.mjs, the workflow
git log --oneline <sha>..HEAD -- frontend/ packages/wrsm/ pnpm-lock.yaml pnpm-workspace.yaml infra/csp.json infra/scripts/check-csp.mjs .github/workflows/deploy-frontend.yml

# Backend: backend/, packages/wrsm/, pnpm-lock.yaml, pnpm-workspace.yaml, the workflow
git log --oneline <sha>..HEAD -- backend/ packages/wrsm/ pnpm-lock.yaml pnpm-workspace.yaml .github/workflows/deploy-backend.yml

# Infra: never deployed by CI; terraform apply is the operator's (docs/STACK.md: never without confirmation)
git log --oneline <sha>..HEAD -- infra/
```

Check the paths above against each workflow's `DEPLOY_PATHS` (the gate job's env) before relying on them; if they differ, the workflow wins and the drift is a finding for `docs/deployment.md`.

Flag:
- An `infra/` change since the last deploy that the code depends on (a new env var, a new grant, a CSP source) — the operator must `terraform apply` **before** approving the code deploy.
- A change to the engine (`packages/wrsm/`) — it ships in both deploys; confirm the reference comparison was run where the change could move results (`docs/departures.md`).
- A pinned auth-kit tag bump (`backend/package.json`) — note it; sign-in behaviour may change.

### 4. Open signals

```
gh issue list --label dependency-audit --state open
gh issue list --label secret-scan --state open
gh api repos/{owner}/{repo}/code-scanning/alerts --jq '[.[] | select(.state=="open")] | length'
gh api repos/{owner}/{repo}/dependabot/alerts --jq '[.[] | select(.state=="open")] | length'
```

Any non-zero → amber with the titles. Don't block; surface.

### 5. Report

```
# Deploy readiness — <date>, HEAD <sha>

## Universal gates
| Gate | Status | Detail |
|---|---|---|
| On main | green / red | ... |
| Working tree clean | green / red | ... |
| main in sync with origin | green / amber / red | ... |
| Local gate | green / red | ... |
| CI green on HEAD | green / red | ... |

## What will deploy
| Workflow | Last deployed | Commits since | Notes |
|---|---|---|---|
| deploy-frontend.yml | <sha> | <n> | ... |
| deploy-backend.yml | <sha> | <n> | ... |
| infra (manual apply) | n/a | <n> | apply first? |

## Open signals
- dependency-audit issue: ...
- secret-scan issue: ...
- CodeQL alerts: <n>
- Dependabot alerts: <n>

## Verdict
READY — push / approve the waiting runs in the Actions tab
or
NOT READY — fix the red items first
```

**Do not push, approve a deployment, run a workflow, run `terraform apply` or auto-fix a red gate.** This command is read-only.

## Notes

- The whole thing should take under a minute. If a `gh` call hangs, mark the row `skipped — <reason>` rather than blocking.
- This doesn't replace `docs/deployment.md`; it's the pre-flight, not the procedure.
