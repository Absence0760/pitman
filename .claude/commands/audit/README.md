# Audit commands

Slash commands for focused, read-only audits of Pitman. Each reports findings; none applies a fix without explicit confirmation.

Invoke from a Claude Code session as `/audit/<name>`.

## Index

### Security

| Command | What it checks |
|---|---|
| [/audit/secrets](secrets.md) | No secret file in this repo, plaintext in git history, server-only env in the client bundle, the auth-kit token's reach in CI, workflow secret hygiene |
| [/audit/xss](xss.md) | Loaded network files, GeoJSON areas and upstream strings rendered by Svelte; `{@html}`, href/src, SVG; the strict CSP |
| [/audit/auth](auth.md) | The session gate and its `PUBLIC` list, admin checks on `/users*` and `/audit`, cookie flags, fail-closed config |

### Health

| Command | What it checks |
|---|---|
| [/audit/deps](deps.md) | `pnpm audit`, Dependabot coverage, the auth-kit pin, action SHA pinning, install-script allowlist, Node/runtime agreement |
| [/audit/infra](infra.md) | `infra/` — the deploy policy, buckets and OAC, CloudFront headers and CSP, WAF, Lambda bounds, cross-account grants, the user table, SES, alarms |
| [/audit/cost-controls](cost-controls.md) | Reserved concurrency, per-instance and WAF limits on the costly data routes, budget and alarms, log retention, CloudFront egress, SES volume |
| [/audit/licenses](licenses.md) | Dependency licences in the shipped bundles, data attribution, what must never be committed |
| [/audit/docs-drift](docs-drift.md) | README, `CLAUDE.md`, `docs/` and `.claude/` against the code, scripts, workflows and Terraform |

### Privacy and accessibility

| Command | What it checks |
|---|---|
| [/audit/popia](popia.md) | POPIA posture: the privacy notice against what the code keeps, lawful basis, retention, residency, data-subject rights |
| [/audit/data-export-completeness](data-export-completeness.md) | Whether a POPIA access request can be answered completely |
| [/audit/account-deletion-completeness](account-deletion-completeness.md) | The erasure procedure in `docs/security.md` § Erasure against the code |
| [/audit/third-party-data-flows](third-party-data-flows.md) | Every outbound hop that carries personal data, as a sub-processor list |
| [/audit/cookie-consent](cookie-consent.md) | The one strictly necessary cookie and no third-party loads |
| [/audit/accessibility](accessibility.md) | WCAG 2.2 AA on Pitman's screens |

### Dispatcher

| Command | What it does |
|---|---|
| [/audit/all](all.md) | Runs secrets, xss, deps, infra and cost-controls in parallel and consolidates one report. Optional arg: `security` / `deps` / `infra` / `cost`. |

## Conventions

- Every audit is **read-only**. The deliverable is a findings report, not a diff.
- Findings are grouped by severity: **Critical / High / Medium / Low**, and every report ends with a clean list.
- Each command is a **self-contained prompt**, runnable from a fresh session.
- Findings cite the rule they break: a `docs/security.md` section, a `docs/decisions.md` ID, or a CLAUDE.md rule.
- No audit decrypts, prints or reads a secret value, calls AWS or load-tests the API.

## Agent delegation

- `repo-security-auditor`: secrets, xss, auth. It has Pitman's trust boundaries baked in.
- `infra-auditor`: infra and cost-controls, in more depth on spend and the cross-account grants.
- `compliance-auditor`: popia, data-export-completeness, account-deletion-completeness, third-party-data-flows, cookie-consent, accessibility.
- A `general-purpose` agent with the command body as the prompt: deps, licenses. `Explore`: docs-drift.

## Diff-time enforcement (complementary)

- [/check](../check.md) — pre-commit gate: `code-reviewer` + `test-gap-checker` + `doc-hygiene-checker` in parallel on the working diff.
- [/safe-edit](../safe-edit.md) — coder ↔ reviewer loop for load-bearing changes.
- [/release-readiness](../release-readiness.md) — before pushing to `main` or approving a production deploy.
- `wrsm-engine-reviewer` — for any `packages/wrsm` change.

## When to run

- **Before approving a production deploy with infra or auth changes** — `/audit/infra` and `/audit/auth`, then `/release-readiness`.
- **After bumping a dependency major or the auth-kit tag** — `/audit/deps` + `/audit/secrets`.
- **After editing anything under `infra/`** — `/audit/infra` before `terraform apply`.
- **After adding a data route** — `/audit/auth` + `/audit/cost-controls`.
- **After changing what is stored about a user** — `/audit/popia` + `/audit/account-deletion-completeness`.
- **Periodically (monthly)** — `/audit/all`. The scheduled `audit.yml` covers `pnpm audit` weekly.

## What's intentionally not here

The template's database (RLS, migrations), WebSocket-hub and LLM-endpoint audits: Pitman has none of those surfaces. Add an audit as `.claude/commands/audit/<area>.md` when a new surface appears, delegate it to the matching agent, list it here and in `.claude/README.md`, and keep `pnpm check:claude` green.
