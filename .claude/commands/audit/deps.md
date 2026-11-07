---
description: Cross-workspace dependency audit (pnpm + Dependabot config + GitHub Actions pinning)
---

Sweep dependencies across every workspace for known CVEs and version drift; verify Dependabot covers everything and CI workflow pins aren't a supply-chain risk.

## What this is

One pnpm workspace (`pnpm-workspace.yaml`) with four packages:

- `frontend/` (`@pitman/frontend`) — SvelteKit 5, Vite, MapLibre, uPlot, fflate, vitest, Playwright; ships to the public static bundle
- `backend/` (`@pitman/backend`) — Hono, the AWS SDK v3 clients (S3, DynamoDB, SESv2), zarrita, the private `@absence0760/auth-kit` (git dependency at a pinned tag), esbuild, vitest; ships in the Lambda bundle
- `packages/wrsm` (`@pitman/wrsm`) — the engine; no runtime dependencies by design
- `packages/wrsm-cli` (`@pitman/wrsm-cli`) — the `wrsm` command
- `infra/` — Terraform, no Node dependencies; its providers are pinned in `infra/main.tf` and `infra/.terraform.lock.hcl`

Plus:

- **`pnpm-workspace.yaml`** — the install-script allowlist (`onlyBuiltDependencies` / `allowBuilds`: esbuild, and auth-kit at its exact commit)
- **GitHub Actions** — `.github/workflows/*.yml`, every `uses:` pinned by SHA with a version comment
- **Dependabot** — `.github/dependabot.yml`

The scheduled `.github/workflows/audit.yml` runs `pnpm audit` weekly and files an issue on findings. This command does the same sweep on demand plus the supply-chain checks the scheduled job doesn't cover.

## What to check

1. **`pnpm audit`.** From the repo root: `pnpm audit --audit-level=moderate` (the lockfile is shared, so one run covers every workspace). For each moderate+ finding: package, version, advisory, fix version, which workspace pulls it in (`pnpm why <pkg> -r`), and whether it reaches a shipped bundle (frontend build, Lambda bundle) or only dev tooling.

2. **Open audit issue.** `gh issue list --label dependency-audit --state open`: if one exists, compare its findings with today's.

3. **Dependabot coverage.** Read `.github/dependabot.yml`:
   - `npm` at `/` (one root lockfile covers every workspace), with the `github-auth-kit` registry so auth-kit tag bumps arrive, and a cooldown that excludes auth-kit.
   - `github-actions` at `/`.
   - `terraform` at `/infra`.
   - An ecosystem with no manifest in the repo (for example `pip` with no Python files) is noise; flag it as Low.
   - Weekly schedules, grouped minor/patch updates.

4. **Lockfile-sync workflow.** Dependabot can't regenerate the root `pnpm-lock.yaml` when it needs the private auth-kit; `.github/workflows/dependabot-lockfile.yml` does, using the `DEPENDABOT_LOCKFILE_PAT` Dependabot secret (pushes made with `GITHUB_TOKEN` don't retrigger CI). Confirm it exists and is wired; the PAT's expiry is a manual check for the operator (don't read it).

5. **Auth-kit pin.** `backend/package.json` pins `github:Absence0760/auth-kit#v<tag>`; the commit in `pnpm-workspace.yaml`'s allowlist matches the lockfile's resolution, so a moved tag can't run new build code without a reviewed change.

6. **GitHub Actions pinning.** Grep `.github/workflows/` for `uses:`. Every third-party action pinned to a 40-character SHA with a `# vX.Y.Z` comment. A floating ref (`@v6`, `@main`) on a deploy workflow (`deploy-frontend.yml`, `deploy-backend.yml`) or `claude.yml` is High; elsewhere Medium.

7. **Install scripts.** Only the packages in the `pnpm-workspace.yaml` allowlist may run install scripts; a new entry needs a reason in the comment above it.

8. **Node and runtimes.** Root `package.json` `engines.node` (`>=24`), every workflow's `node-version`, and the Lambda's `runtime` in `infra/lambda.tf` (`nodejs24.x`) agree; the backend's esbuild `--target` doesn't fall behind the runtime by more than it must.

9. **TypeScript majors.** `docs/STACK.md` § Conventions and gotchas explains why the frontend stays on TypeScript 6 while the other workspaces use 7. A Dependabot bump that moves the frontend to 7 before sveltejs/kit#17537 and sveltejs/language-tools#3063 land is a finding, not an upgrade.

10. **Licences.** Out of scope here; `/audit/licenses` covers them.

## Report

- **Critical**: a known-exploited CVE in a shipped path (the Lambda bundle or the frontend bundle), not a dev-only transitive.
- **High**: a CVE with a fix available in a shipped path; a deploy workflow on a floating action ref; Dependabot missing an ecosystem the repo uses.
- **Medium**: overdue upgrade with no CVE; Node version mismatch between `engines`, CI and the Lambda runtime; an install-script allowlist entry with no reason.
- **Low**: a Dependabot ecosystem with nothing to update; a floating ref in a non-deploy workflow; grouping that could be tightened.

For each finding: package + version + advisory link + the file to change + the upgrade command.

## Useful starting points

- `package.json` (root), `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- `frontend/package.json`, `backend/package.json`, `packages/wrsm/package.json`, `packages/wrsm-cli/package.json`
- `.github/workflows/*.yml`, `.github/dependabot.yml`
- `infra/lambda.tf`, `infra/main.tf`

## Delegate to

Use a `general-purpose` agent: the work is mostly running each tool in turn and reading the output. Pass this file as the prompt body.

Read-only audit. Recommend upgrades; don't apply them without instruction (a major bump is its own conversation).
