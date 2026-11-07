---
description: Audit README, CLAUDE.md, docs/STACK.md and docs/* against what the code, package.json scripts, workflows and Terraform actually do, and the specs' cross-references against each other
---

Survey the project's docs for stale claims after a change to commands,
workspaces, the engine's public surface, the data API, workflows or infra.

## Goal

A reader, or a future agent that loads `CLAUDE.md` and `docs/STACK.md` to
bootstrap, acts on the doc; the doc lies; bug. Pitman started from a
template, so template text that no longer matches this project is the
likeliest drift. Sweep the docs against current reality and report each
delta.

## What to check

1. **`docs/STACK.md` and `docs/architecture.md`** (both loaded early, so
   the costliest to get wrong). Cross-reference:
   - the stack lines (framework versions: SvelteKit, Svelte, Vite, Hono,
     Node `engines`) against each workspace's `package.json`;
   - the workspace list and repo-layout tree against `pnpm-workspace.yaml`
     and the actual tree (`packages/wrsm`, `packages/wrsm-cli`,
     `frontend/`, `backend/`, `infra/`);
   - "Commands" against the root `package.json` scripts, name by name;
   - "Tests live in …" against where `*.test.ts` files are;
   - template leftovers: "find-and-replace the project name", `~/repos/`
     paths (the estate uses `~/github/`), features this project doesn't
     have (accounts, a CMS, a database).

2. **Root `package.json` comment keys.** Each `//-- <group> --` line's
   description against the scripts beneath it (ports, prerequisites,
   which workspaces run).

3. **`docs/run-locally.md` and `docs/deployment.md`.** Env vars against
   what `backend/src/` and `frontend/` read (`grep -rn
   'process.env\|import.meta.env\|\$env/'`) and the committed
   `.env.development` files; deploy steps against
   `.github/workflows/deploy-*.yml` and `infra/`.

4. **`infra/README.md`** against `infra/*.tf`: resources listed, variable
   names and defaults, region (D-6 says `af-south-1`; check
   `variables.tf`'s default and say if they disagree).

5. **Workflows.** `CLAUDE.md` § Where to look and `docs/STACK.md` § Where
   to look list workflows: each exists in `.github/workflows/`, and each
   workflow there is listed.

6. **`.claude/README.md` and `CLAUDE.md` § Available Claude tooling**
   against `.claude/agents/`, `.claude/commands/`, `.claude/hooks/` and
   `.claude/settings.json`: every listed item exists, every item that
   exists is listed. `pnpm check:claude`
   (`scripts/ci-guards/check_claude_tooling.mjs`) already fails on a
   leftover template placeholder or a cited path that doesn't exist; run it
   and report what it says, then look for what it can't see: an agent that
   describes a service, route or rule Pitman doesn't have in words the
   guard doesn't match.

7. **Specs and decisions.** IDs cited in code comments and docs
   (`D…`, `OQ-…`, `U-…`, `A…`, `B…`) exist in `docs/decisions.md` or the
   spec's open questions; section links between `docs/theory/*.md`,
   `docs/formats.md` and `docs/data.md` resolve (anchors included); the
   engine's exports in `packages/wrsm/src/index.ts` match what the specs
   say the engine offers.

8. **Issue #3's status.** Rounds or decisions the issue (`gh issue view 3
   --comments`) marks done but a doc still calls pending, or the reverse.

9. **`README.md`** (root): what it tells a visitor to run and read still
   works.

## Report

- **High**: a doc names a command, script, env var, file or workflow that
  doesn't exist (a reader following it fails), or a decision ID that
  doesn't resolve.
- **Medium**: template text describing a feature or path this project
  doesn't have; a version or region that disagrees with the code; a tool
  that exists but isn't listed.
- **Low**: wording drift; a broken anchor; a stale commit hash.

For each: doc file + line, the reality (file:line or command output), and
the change to apply.

## Useful starting points

- `README.md`, `CLAUDE.md`, `docs/STACK.md`, `docs/architecture.md`,
  `docs/run-locally.md`, `docs/deployment.md`, `docs/security.md`,
  `infra/README.md`, `.claude/README.md`
- root and workspace `package.json`, `pnpm-workspace.yaml`
- `git log --oneline -50`: recent commits hint at what drifted

## Delegate to

The `Explore` agent (read-only, broad scan). Pass this file as the prompt;
its job is to compare each claim in the docs against the code. `Explore`
can't write files, so it returns the full delta report as its final
message and **the invoking session writes it to `reviews/docs-drift.md`**
(overwrite if present). Findings only; no doc edits.
