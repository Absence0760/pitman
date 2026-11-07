---
name: steward
description: How to drive a red pull request (or a red CI run on main) in pitman to green — reading CI, reproducing each job locally with the exact command, what counts as a flake, a branch that fell behind, reviews, and when to ask the operator. Use when watching, fixing or babysitting CI or a PR here.
---

# Steward: driving pitman's CI to green

**Every change reaches `main` through a pull request** (`CLAUDE.md` § Working
alongside other Claude sessions). `main` is protected, admins included:
`CI gate` is the one required check, history is linear, review conversations
must be resolved, and nobody pushes to it. So this skill mostly drives a
**red PR** to green, and the fix is another commit on the PR's branch. A red
run on `main` itself (a push-only or weekly workflow, or a break that only
shows once two green PRs meet) is fixed through a PR too. The root
`CLAUDE.md` rules still apply; this adds how CI here behaves and what to do
about it. For one failed run end to end, `/fix-ci`
(`.claude/commands/fix-ci.md`) is the procedure; this is the map it works
from.

## Read the run first

For a PR: `gh pr checks <pr>` (add `--watch` to wait). For `main`:
`gh run list --branch main --limit 10`. Then `gh run view <run>` and
`gh run view <run> --log-failed` for the failing job. Quote the job, the
step and the first real error line before changing anything.

`CI gate` (the `ci-gate` job in `.github/workflows/ci.yml`) fans in on
`test`, `e2e` and `doc-links` and is green only when none failed. A red
`CI gate` names the upstream job; that job is the thing to fix. It is the
one check branch protection requires, so nothing merges past it, and
`dependabot-auto-merge.yml`'s queued merges wait on it too.

`pr-mergeable` failing means GitHub couldn't build a merge ref
(a conflict), so **ci.yml didn't run at all**; green checks from the other
workflows prove nothing. Resolve the conflict first.

## Docs-only changes

`.github/workflows/ci.yml` runs on every PR. Its `changes` job skips the heavy jobs
(`test`, `e2e`) on a PR that touches only `docs/**`, `.claude/**` or `*.md`;
`doc-links`, `env-isolation` and `claude-tooling` always run, and the `CI gate`
waits on all of them (a skipped job counts as passing). A push to `main` always
runs everything. So before pushing a docs or `.claude/` change, run
`pnpm check:doc-links && pnpm check:claude`.

## Reproduce a failed job locally

Run the same command the job runs, scoped to what failed. Install once with
`pnpm install --frozen-lockfile` (auth-kit comes over your SSH key; CI uses
`AUTH_KIT_READ_TOKEN` on the install step alone, `docs/deployment.md`
§ Sign-in).

| Workflow / job | Locally |
|---|---|
| `.github/workflows/ci.yml` / Test and typecheck (`test`) | `pnpm check`, then `pnpm test` (one workspace: `pnpm test:wrsm`, `pnpm test:wrsm-cli`, `pnpm backend test`, `pnpm frontend test`), then `pnpm test:tools`. CI runs `pnpm test` with DynamoDB Local, so `backend/src/auth/dynamo.test.ts` runs there and skips locally unless you start it: `pnpm dev:auth:up && DYNAMODB_ENDPOINT=http://127.0.0.1:8000 pnpm backend test` |
| `.github/workflows/ci.yml` / End-to-end (`e2e`) | `pnpm --filter @pitman/frontend exec playwright install chromium` once, then the failing spec only: `pnpm --filter @pitman/frontend exec playwright test e2e/<spec>.spec.ts > e2e.log 2>&1` (all of them: `pnpm test:frontend:e2e`). It builds the site and serves it with `vite preview` on 8888 (`frontend/playwright.config.ts`) |
| `.github/workflows/ci.yml` / Doc links (`doc-links`) | `pnpm check:doc-links`. Fix the link at the source (the failure names the slug to write for a numbered heading); never add an exemption for a real dead link |
| `.github/workflows/terraform.yml` / fmt, validate (`check`) | the version in `infra/.terraform-version`, then `terraform fmt -check -recursive -diff infra`, `terraform -chdir=infra init -backend=false -input=false && terraform -chdir=infra validate`, `terraform -chdir=infra test` (mocked providers, no credentials; `infra/tests/`), `node --test infra/scripts/*.test.mjs`. Never `apply` |
| `.github/workflows/terraform.yml` / Trivy IaC scan (`trivy-iac`) | `trivy config --severity CRITICAL,HIGH .` from the repo root if Trivy is installed (it isn't on the workstation by default; the private-repo run writes its findings to the job summary instead). Report-only (exit code 0); an accepted finding carries `#trivy:ignore:<ID>` with the reason beside the resource |
| `.github/workflows/fresh-clone.yml` / `install-and-dev` | in a clean clone with Node from `.tool-versions`: `pnpm install --frozen-lockfile && pnpm dev:data:synthetic && pnpm dev`, then `curl -fsS http://127.0.0.1:3001/health` (`{"ok":true}`), `curl -fsS http://localhost:7777/` and `curl -fsS http://localhost:7777/api/health`. The dev log is the `fresh-clone-dev-log` artifact (`docs/run-locally.md` § Fresh clone) |
| `.github/workflows/coverage.yml` / Unit coverage (`unit`) | `pnpm test:tools`, then `pnpm test:coverage`. A report, never a gate: it fails only when a test does |
| `.github/workflows/gitleaks.yml` / `scan` (and the weekly `.github/workflows/gitleaks-sweep.yml`) | `pre-commit run gitleaks --all-files` (`.pre-commit-config.yaml`). The finding names the file and rule: remove the secret and treat it as leaked (rotate), never allowlist a real one |
| `.github/workflows/audit.yml` / `audit` (weekly) | `pnpm audit --audit-level=moderate`. It opens or updates a `dependency-audit` issue; fix by bumping the dependency (or an override with a reason), not by raising the level |
| `.github/workflows/security.yml` / Analyze (CodeQL) | no local equivalent. Fails while the repo is private because code scanning needs GitHub Advanced Security (`docs/decisions.md` § Repository follow-ups): known, not yours, until the repo goes public (`docs/deployment.md` step 26); after that a failure is real |
| `.github/workflows/deploy-backend.yml` / `deploy-frontend.yml` / Decide whether to deploy (`gate`) | `node --test scripts/deploy/deploy-gate.test.mjs`. Runs after CI succeeds on a push to main (`workflow_run`), or by hand; its error names the refusal (a manual run off `main`, or no successful CI run on that commit: wait for or re-run CI). Skipped means CI failed or the repo variables aren't set, not a bug |
| `.github/workflows/deploy-backend.yml` / Build Lambda bundle (`build`) | `pnpm check && pnpm build` (the Lambda bundle is `pnpm backend build`). The `deploy` job runs only behind the `production` environment's approval; its smoke test is `curl -fsS "$SITE/api/health"` |
| `.github/workflows/deploy-frontend.yml` / Build + CSP check (`build`) | `pnpm build && node infra/scripts/check-csp.mjs frontend/build`. Its `deploy` job is behind `production` too |
| `.github/workflows/dependabot-lockfile.yml` | `pnpm install --lockfile-only --ignore-scripts` on the Dependabot branch; it commits the root `pnpm-lock.yaml` back |
| `.github/workflows/pr-title-lint.yml` (PRs only) | the title is `type(scope): lowercase subject`, no trailing period, type one of `feat fix chore docs refactor test perf ci build revert` |
| `.github/workflows/labeler.yml` (PRs only) | no local equivalent. "Resource not accessible by integration" is a known repo-settings issue (`docs/decisions.md` § Repository follow-ups) |
| `.github/workflows/pr-mergeable.yml` (PRs only) | a conflict: see below |

The engine's reference comparison (`WRSM_REFERENCE_DIR`) always skips in CI:
the reference networks never leave the operator's machine
(`CLAUDE.md` rule 2). A CI failure is never "fixed" by depending on it.

## Flakes

"Flake" is not a root cause. A test that fails once and passes on a re-run
is still a bug in the test or the app: find the race (`CLAUDE.md` § Fix bugs
at the source). Never allowed: a bigger timeout, a `waitForTimeout`, a
retry, `test.skip`/`fixme`, a loosened assertion.

A re-run is fine once, and only to confirm a failure that isn't yours: the
job died before any test ran (checkout, install, runner loss, an empty
`AUTH_KIT_READ_TOKEN`), or the same check was already red on the previous
`main` commit. `backend/src/auth/dynamo.test.ts` skips locally without `DYNAMODB_ENDPOINT` but
runs in CI on purpose: a CI failure there is real.

## Main moved under you

Another PR merged first, so your branch is behind (CI tests the merge with
`main`, so it can go red for a change that isn't yours). Bring the branch up
to date; never force-push `main`, never rebase a branch someone else has:

```
git fetch origin
git merge origin/main
```

A conflict in `pnpm-lock.yaml`: take `main`'s, then `pnpm install` to
regenerate. Never edit `docs/formats/examples/` to resolve anything: those
files are byte-exact (`CLAUDE.md` rule 6).

## Reviews and conversations

Branch protection requires every review conversation to be resolved before
merging.


- A small, local ask (a rename, a nit, an added test): do it, push, reply in
  the thread naming the commit, resolve it.
- A larger or design-level ask: reply with a proposal and ask the operator
  before building it.
- Pre-empt reviewers locally with `/check`, plus the `wrsm-engine-reviewer`
  agent on any `packages/wrsm` change.

## Ask the operator before

- Anything irreversible or outside the fix: a Terraform `apply`, approving a
  `production` deploy, a release, deleting a branch that isn't yours.
- Rotating a secret, or anything that needs `infra-secrets`.
- Merging with `--admin`, or merging a PR that isn't yours (a Dependabot
  major bump included). Your own PR is merged by the orchestrating session
  once `CI gate` is green and every conversation is resolved (`/issue` § 6).
- A fix that changes a recorded decision (`docs/decisions.md`) or a
  documented departure (`docs/departures.md`).

## Done

Done when the PR's head (or the latest run on `main`) has `CI gate` green and
every other triggered workflow green or failing only for a known, recorded
reason above, and nothing is waiting on you. Say so once, with the run link,
and stop.
