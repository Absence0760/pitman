## Summary

<!-- 1–3 sentences on what this PR does and why. End with `Closes #<n>`
     (or `Part of #<n>` when the issue stays open). The PR title is the
     squash commit's subject: `type(scope): lowercase subject`. -->

## Changes

<!-- Bulleted list of the user-visible or developer-visible changes. -->

-

## Surface touched

- [ ] Engine (`packages/wrsm`): readers/writers, runoff model, comparison
- [ ] CLI (`packages/wrsm-cli`)
- [ ] Frontend (`frontend/`)
- [ ] Backend (`backend/`): routes, the data proxy, sign-in wiring
- [ ] Infrastructure (`infra/`)
- [ ] CI / GitHub Actions (`.github/`), repo scripts (`scripts/`)
- [ ] Docs or `.claude/` only

## Pitman rules

<!-- Tick what applies. Leave a line that doesn't apply unticked rather than
     deleting it, so the reviewer can see it was considered. -->

- [ ] Every new equation cites the WRC manual and page (TT 687/689/690/691); nothing comes from WRSM2000's executable or DLLs
- [ ] A new or changed choice is recorded in `docs/decisions.md` with its ID; a difference from WRSM2000's output is in `docs/departures.md`
- [ ] No client or reference-network data, and no farm or client name, in code, tests, docs, this PR or its commits (`pnpm check:terms`)
- [ ] `packages/wrsm` stays pure: no I/O, DOM or Node APIs
- [ ] `docs/formats/examples/` untouched, or still byte-exact (CRLF, trailing blanks)
- [ ] No auth code outside auth-kit; no secret or real credential committed, and none with a hardcoded fallback
- [ ] A new outside host, SDK or personal-data field moved `docs/security.md` / `docs/data.md` with it (`pnpm check:compliance`)

## Test plan

<!-- How this was verified. Delete rows that don't apply. -->

- [ ] `pnpm check && pnpm test`
- [ ] `pnpm test:tools` (scripts, guards, workflows)
- [ ] `pnpm test:frontend:e2e` (UI changes)
- [ ] Reference comparison with `WRSM_REFERENCE_DIR` set (engine changes), or say why it was skipped
- [ ] `wrsm-engine-reviewer` on a `packages/wrsm` change; `/check` on the diff
- [ ] `terraform -chdir=infra validate` and `terraform -chdir=infra test` (`infra/` changes)
