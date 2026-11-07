# .claude/ — Claude Code tooling

These agents and commands were derived from a real working web app (SvelteKit + Hono + DynamoDB + CMS + payment-redirect shape) and **lightly generalized** with placeholder names: `<payment-processor>`, `<CMS>`, `<email-service>`, `<aws-region>`, `<EMAIL_SERVICE>_API_KEY`, etc.

**They will not be 100% accurate for your project out of the box.** Each new project should re-read these and replace placeholder examples with the actual services / routes / file paths in use. Treat them as templates of *structure and rigor*, not as fully-portable boilerplate.

## What's here

### Agents (`agents/`, grouped by team: `engineering/`, `audit/`, `design/`, `legal/`, `personas/`)

Claude Code resolves an agent by its frontmatter `name:`, not its path, so the folders are for people. Base ships these flat; `.github/template-sync-ignore` lists the flat paths so a template sync doesn't add second copies.


- **`code-reviewer.md`** — invoked at PR / pre-commit time to review the diff against the project's documented rules.
- **`doc-hygiene-checker.md`** — checks that code changes update docs and tests in the same change.
- **`test-gap-checker.md`** — finds modules / routes without test coverage.
- **`ui-polisher.md`** — applies typography / layout polish to frontend surfaces. Heavily SvelteKit-flavoured; adapt for other frontend frameworks.
- **`repo-security-auditor.md`** — read-only security auditor. The "trust boundaries" section needs rewriting per project — the example boundaries (frontend ↔ user, backend ↔ caller, backend ↔ <CMS>, backend ↔ <payment-processor>) reflect one specific stack shape, not a universal map.
- **`compliance-auditor.md`** — read-only privacy / legal / accessibility auditor. Backs the GDPR, cookie-consent, data-export, account-deletion, third-party-data-flows, and accessibility audit commands. Knows enough about GDPR / ePrivacy / CCPA / WCAG to flag the obvious gaps; the operator still owns the final policy / legal call.
- **`migration-coordinator.md`** — DB schema-change coordinator. Applies a migration locally, verifies RLS coverage on tenant tables, surfaces manual type-sync edits, proposes smoke-test additions. Pairs with `/safe-migration`.
- **`persona-*.md`** — bug-hunting personas. Each adopts a real-world point of view (`new-user`, `power-user`, `admin`, `international-user`, `accessibility-user`, `integrator`, `adversary`, `data-subject`) and walks the app the way that person would, finding logic / UX / domain bugs a code review misses. Read-only; each writes a living report to `reviews/<persona>.md` (git-ignored). Stack-agnostic — they discover the app first. They live in `agents/personas/`. Protocol + how to add project-specific domain personas (an invoicing app's approver/CFO/accountant, a marketplace's buyer/seller, …): `personas/README.md`. Run via `/persona`.

### Commands (`commands/`)

- **`check.md`** — run typecheck + tests + format + lint and report.
- **`safe-edit.md`** — workflow for edits to security-sensitive or load-bearing files.
- **`safe-migration.md`** — DB-schema-change workflow with `migration-coordinator` in the loop.
- **`polish-ui.md`** — orchestrates the `ui-polisher` agent against a target surface.
- **`persona.md`** — runs one, several, or all of the `persona-*` bug-hunting auditors in parallel and consolidates their reports.
- **`release-readiness.md`** — go/no-go checklist before tagging a release.
- **`audit/`** — directory of focused audits. Each command delegates to `repo-security-auditor` (security surfaces) or `compliance-auditor` (privacy / legal / a11y surfaces):
  - Security: `secrets.md`, `infra.md`, `deps.md`, `xss.md`, `cost-controls.md`, `auth.md` (route gating + tenant-context discipline)
  - Privacy / compliance: `gdpr.md`, `cookie-consent.md`, `data-export-completeness.md`, `account-deletion-completeness.md`, `third-party-data-flows.md`
  - Quality: `accessibility.md`
  - `all.md` runs them all in sequence; `README.md` is the index

## Pitman additions

Project-owned (not from the templates `base` branch). Adapted from the
estate's other repos, mostly IC-WBT (`project-water-management`, same
domain and stack), with every fact rewritten for Pitman.

### Agents
- **`wrsm-engine-reviewer.md`** — review-only judge of `packages/wrsm` diffs: specs and TT manual citations, `docs/decisions.md` IDs (no silent change to a provisional default), the TT 690 errata, `docs/departures.md`, water balance and bounds, units, hydrological-year month order (index 0 = October), float32 rounding in writers, byte-identical round-trips, the reference comparison's skip rule, purity. Same output shape as `code-reviewer`; run it beside `/check` (which doesn't call it) and from `/issue`.
- **`persona-hydrologist.md`** — domain persona: a WRSM2000-literate consulting hydrologist bringing a network to 2025. Synthetic data only; writes `reviews/persona-hydrologist.md`. Runs with the `/persona` panel.
- **`za-legal-researcher.md`** — pre-counsel research on one licence or law question (WR2012/WRC terms, DWS data, CHIRPS/CHELSA attribution, Cape Farm Mapper terms, the clean-room rule, South African law). Not legal advice.
- **`infra-auditor.md`** — read-only spend and IAM auditor for `infra/` and the backend's AWS use, including the cross-account grants in `docs/data.md` § Cross-account access. Areas: `cost`, `iam`, `cross-account`, `data`, `observability`, `all`.
- **`ui-designer.md`** — build or review one screen of the Round 3+ app against the UI playbook (IC-WBT's, read-only, until Pitman has its own).

### Commands
- **`issue.md`** — `/issue <n>`: one issue end to end in a worktree, routed to the right agents, gated, merged into `main` while PRs are off (the PR variant is noted inline for when PRs return, issue #22 step 10).
- **`audit/licenses.md`** — `/audit/licenses`: dependency licences (what ships in the SPA and Lambda bundles) plus data attribution and what must never be committed.
- **`audit/docs-drift.md`** — `/audit/docs-drift`: README, `CLAUDE.md`, `docs/STACK.md`, `docs/*` and `.claude/` listings against the code, scripts, workflows and Terraform.

### Skills
- **`skills/steward/SKILL.md`** — drive a red CI run to green: every job in pitman's workflows with the exact local command that reproduces it, what counts as a flake, main moving under you, and when to ask the operator. Applies to a red run on `main` while PRs are off (issue #22 steps 10–11), and to PRs once they return. Adapted from IC-WBT's.

### Hooks
- **`hooks/security-patterns.sh`** (PostToolUse on Edit/Write/MultiEdit) — grep rules for engine purity and determinism, float32 rounding in `src/io/` writers, private env in the frontend, `S3Client` with no region, and hard-coded machine paths. Runs after the edit, so it never blocks; findings reach the next turn. Bypass a line with `// noqa: <rule>`. Tests: `bash .claude/hooks/security-patterns.test.sh`.

## Adapting these for a new project

1. Rewrite the trust-boundary map in `agents/audit/repo-security-auditor.md` to match your stack's actual third-party integrations.
2. Update route tables in `audit/cost-controls.md` and `audit/infra.md` to match your `backend/src/routes/*` and `infra/*.tf`.
3. Replace the `<placeholder>` tokens (`<payment-processor>`, `<CMS>`, `<email-service>`, `<aws-region>`) with real service names so the agents stop emitting them in reports.
4. Add stack-specific audits not covered here (Postgres RLS? Edge functions? Mobile-twin parity? GDPR / app-store privacy? — extend `audit/` with the checks that matter for your trust surface).
5. Remove audits that don't apply (e.g. `cost-controls.md` doesn't apply to a static-only site with no Lambda / no third-party APIs).
6. Add domain personas. The generic `persona-*` panel applies to any app; most projects also deserve personas tied to their domain (an invoicing app's approver/CFO/accountant, a marketplace's buyer/seller/dispute, a healthcare app's patient/clinician). Copy the closest generic persona and follow `personas/README.md` § "Domain packs".
