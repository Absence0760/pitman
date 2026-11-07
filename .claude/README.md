# .claude/ — Claude Code tooling

These agents and commands started as the shared `templates` repo's scaffolding (written for another app, with placeholder names for its payment processor, CMS and email service) and have been **rewritten for Pitman**: the static SvelteKit SPA that runs WRSM networks in the browser, the Hono data API on Lambda behind CloudFront, sign-in from auth-kit over the DynamoDB user table with SES mail, and the pure engine in `packages/wrsm`. There is no SQL database, no payments and no CMS, so the template's migration tooling (`migration-coordinator`, `/safe-migration`) and its WebSocket and LLM-endpoint audits were deleted rather than faked, and listed in `.github/template-sync-ignore` so a template sync doesn't bring them back.

`pnpm check:claude` (`scripts/ci-guards/check_claude_tooling.mjs`, the `claude-tooling` job in `ci.yml`) keeps it that way: it fails when an agent, command or skill has no frontmatter `description:` (or an agent no `name:` matching its file), when a template placeholder survives, or when anything here or in `CLAUDE.md` cites a backticked repo path that doesn't exist.

## What's here

### Agents (`agents/`, grouped by team: `engineering/`, `audit/`, `design/`, `legal/`, `personas/`)

Claude Code resolves an agent by its frontmatter `name:`, not its path, so the folders are for people. Base ships these flat; `.github/template-sync-ignore` lists the flat paths so a template sync doesn't add second copies.

- **`code-reviewer.md`** — reviews a diff against Pitman's rules: clean room and no client data, engine purity, the session gate and auth-kit, rate limits and input caps, no personal data in logs, no dotenv in the Lambda bundle, static SPA, strict CSP. Run by `/check`, `/safe-edit`, `/improve-round`, `/issue`.
- **`test-gap-checker.md`** — which tests a diff should ship with, by surface (engine, CLI, data routes, auth, frontend, e2e, infra plan tests, guards).
- **`doc-hygiene-checker.md`** — which docs a diff should update (theory specs, formats, `docs/decisions.md`, `docs/departures.md`, data, security, deployment, the user guide).
- **`repo-security-auditor.md`** — read-only security auditor with Pitman's trust boundaries (SPA ↔ user, API ↔ caller, sign-in ↔ the user table and SES, API ↔ data sources, CI ↔ AWS). Backs `/audit/secrets`, `/audit/xss`, `/audit/auth`.
- **`compliance-auditor.md`** — read-only privacy and accessibility auditor, POPIA first. Backs `/audit/popia`, `/audit/data-export-completeness`, `/audit/account-deletion-completeness`, `/audit/third-party-data-flows`, `/audit/cookie-consent`, `/audit/accessibility`.
- **`ui-polisher.md`** — polishes one existing page or component to the UI playbook; edits, doesn't commit. Run by `/polish-ui`. New screens go to `ui-designer`.
- **`persona-*.md`** — bug-hunting personas (`new-user`, `power-user`, `admin`, `international-user`, `accessibility-user`, `integrator`, `adversary`, `data-subject`, plus Pitman's `hydrologist`). Each walks the app from one point of view and writes a living report to `reviews/<persona>.md` (git-ignored). Protocol: `personas/README.md`. Run via `/persona`.

### Commands (`commands/`)

- **`check.md`** — `/check`: `code-reviewer` + `test-gap-checker` + `doc-hygiene-checker` in parallel on the working diff.
- **`safe-edit.md`** — coder ↔ `code-reviewer` loop for security-sensitive or load-bearing changes.
- **`polish-ui.md`** — runs `ui-polisher` on one surface.
- **`persona.md`** — runs one, several or all `persona-*` auditors and consolidates their reports.
- **`release-readiness.md`** — go/no-go before pushing to `main` or approving a waiting production deploy (Pitman deploys after CI passes on a push to `main`, through the `production` environment; there are no release tags).
- **Hunts and loops** — `audit-and-fix.md`, `bug-hunt.md`, `coverage-hunt.md`, `perf-hunt.md`, `ux-hunt.md`, `a11y-hunt.md`, `improve-round.md`, `fix-ci.md`, `endpoint-inventory.md`: stack-agnostic workflows that discover the app first.
- **`audit/`** — focused, read-only audits; `audit/README.md` is the index:
  - Security: `secrets.md`, `xss.md`, `auth.md` (route gating and admin checks)
  - Health: `deps.md`, `infra.md`, `cost-controls.md`
  - Privacy / compliance: `popia.md`, `cookie-consent.md`, `data-export-completeness.md` (answering a POPIA access request), `account-deletion-completeness.md` (the erasure procedure), `third-party-data-flows.md`
  - Quality: `accessibility.md`
  - `all.md` runs the security, deps, infra and cost audits in parallel

### Hooks (`hooks/`, wired in `settings.json`)

- **`git-scope-guard.py`** (PreToolUse on Bash) — blocks whole-tree git commands (`git add -A`, bare `git commit`, `git stash`, `reset --hard`, …) so sessions sharing one checkout can't sweep up each other's work (CLAUDE.md § Working alongside other Claude sessions). Tests: `python3 .claude/hooks/git-scope-guard.test.py`.
- **`unmerged-worktree-check.sh`** (SessionStart) — lists local branches with commits not yet on `main`, so a worktree's work isn't stranded.
- **`security-patterns.sh`** — see Pitman additions below.

## Pitman additions

Project-owned (not from the templates `base` branch). Adapted from the
estate's other repos, mostly IC-WBT (`project-water-management`, same
domain and stack), with every fact rewritten for Pitman.

### Agents
- **`wrsm-engine-reviewer.md`** — review-only judge of `packages/wrsm` diffs: specs and TT manual citations, `docs/decisions.md` IDs (no silent change to a provisional default), the TT 690 errata, `docs/departures.md`, water balance and bounds, units, hydrological-year month order (index 0 = October), float32 rounding in writers, byte-identical round-trips, the reference comparison's skip rule, purity. Same output shape as `code-reviewer`; run it beside `/check` (which doesn't call it) and from `/issue`.
- **`persona-hydrologist.md`** — domain persona: a WRSM2000-literate consulting hydrologist bringing a network to 2025. Synthetic data only; writes `reviews/persona-hydrologist.md`. Runs with the `/persona` panel.
- **`za-legal-researcher.md`** — pre-counsel research on one licence or law question (WR2012/WRC terms, DWS data, CHIRPS/CHELSA attribution, Cape Farm Mapper terms, the clean-room rule, South African law). Not legal advice.
- **`infra-auditor.md`** — read-only spend and IAM auditor for `infra/` and the backend's AWS use, including the cross-account grants in `docs/data.md` § Cross-account access. Areas: `cost`, `iam`, `cross-account`, `data`, `observability`, `all`. Backs `/audit/infra` and `/audit/cost-controls`.
- **`ui-designer.md`** — build or review one screen against `docs/design/ui-playbook.md` (IC-WBT's playbook as a read-only reference where Pitman's is silent).

### Commands
- **`issue.md`** — `/issue <n>`: one issue end to end in a worktree, routed to the right agents, gated, merged into `main` while PRs are off (the PR variant is noted inline for when PRs return, issue #22 step 10).
- **`audit/licenses.md`** — `/audit/licenses`: dependency licences (what ships in the SPA and Lambda bundles) plus data attribution and what must never be committed.
- **`audit/docs-drift.md`** — `/audit/docs-drift`: README, `CLAUDE.md`, `docs/STACK.md`, `docs/*` and `.claude/` listings against the code, scripts, workflows and Terraform.
- **`audit/popia.md`** — `/audit/popia`: replaces the template's GDPR audit; Pitman's personal data is a short list of sign-in records, held in South Africa.

### Skills
- **`skills/steward/SKILL.md`** — drive a red CI run to green: every job in pitman's workflows with the exact local command that reproduces it, what counts as a flake, main moving under you, and when to ask the operator. Applies to a red run on `main` while PRs are off (issue #22 steps 10–11), and to PRs once they return. Adapted from IC-WBT's.

### Hooks
- **`hooks/security-patterns.sh`** (PostToolUse on Edit/Write/MultiEdit) — grep rules for engine purity and determinism, float32 rounding in `src/io/` writers, private env in the frontend, `S3Client` with no region, and hard-coded machine paths. Runs after the edit, so it never blocks; findings reach the next turn. Bypass a line with `// noqa: <rule>`. Tests: `bash .claude/hooks/security-patterns.test.sh`.

## Adding or changing an agent

1. Describe Pitman's reality: real paths, real routes, real services. If a template piece has no meaning here, delete it (and add its base path to `.github/template-sync-ignore`) rather than fake it.
2. Frontmatter: every agent has `name:` (equal to its file name, unique across `agents/`) and `description:`; every command and skill (`skills/<name>/SKILL.md`) has `description:`.
3. Cite paths in backticks only when they exist; write a pattern with a placeholder or glob (`backend/src/<area>/*.ts`) when you mean a pattern.
4. List it here, and in CLAUDE.md § Available Claude tooling if it is a command people run.
5. `pnpm check:claude` must pass. When it fails, fix the agent or command, not the guard.
