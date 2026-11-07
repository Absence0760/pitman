---
description: Work one GitHub issue end to end — read it, branch in a worktree, route the work to the right workflow and agents, gate it with pnpm check/test and /check, then open a PR, merge it once CI gate is green, and report back on the issue. The default entry point for a session driven by an issue.
argument-hint: <issue number or URL>
---

Take issue `$ARGUMENTS` from "open" to "done on `main`, tested, reviewed and
reported on the issue". One issue per session, unless the issue itself
splits into independent parts (then one branch per part, each naming the
issue). For a round of issue #3, the orchestrator runs the round instead;
this command is for a single issue or a single task from a round.

**Workflow note.** Every change reaches `main` through a pull request
(CLAUDE.md § Working alongside other Claude sessions): `main` is protected,
admins included, and merges a PR only once its required `CI gate` check is
green, squash or rebase (linear history). § 6 below is that flow.

## 1. Read the issue

`gh issue view <n> --comments`. Take in the body, every comment, the labels,
and any linked issues or docs. Then, in two or three lines, state the goal,
what "done" looks like, and anything the issue leaves open. If a fork
changes what gets built (two readings of the ask, a hydrology or licence
decision), ask before building; if it's a detail, pick the reasonable
default, say which, and carry on.

Check it isn't already done or in flight: `git log --oneline origin/main
--grep '#<n>'`, `gh pr list --search '#<n>' --state all`, and
`git worktree list` / `git branch --list '*<n>*'` for a branch another
session started.

## 2. Branch in a worktree

```
git fetch origin
git worktree add ../pitman-<n>-<slug> -b <type>/<n>-<slug> origin/main
```

`<type>` is `fix`, `feat`, `docs`, `chore` or `test`. If the session was
given a branch or worktree, use that instead. Work only in the worktree
(CLAUDE.md § Working alongside other Claude sessions), and `pnpm install`
there first.

## 3. Route the work

Read the docs for the area first (`docs/STACK.md` § Where to look, and the
spec under `docs/`). Then pick the workflow by what the issue touches; more
than one can apply.

| The issue touches | Use |
|---|---|
| A bug | Reproduce it first (a failing test is best), fix the cause, keep the test (CLAUDE.md § Fix bugs at the source) |
| Engine behaviour or a file format in `packages/wrsm` | Work from the spec (`docs/theory/*.md`, `docs/formats.md`) with manual and page citations; record any open choice in `docs/decisions.md` first and any difference from WRSM2000 in `docs/departures.md`; run the `wrsm-engine-reviewer` agent on the diff |
| A decision marked provisional or **Needs operator** | Don't change it in code. Change `docs/decisions.md` (with the operator's say-so for **Needs operator**), then the code |
| A question only the hydrologist can answer | Add it to issue #21 instead of guessing; build what doesn't depend on it |
| The backend data proxy, a token, CORS, `infra/`, a workflow | `/safe-edit` (coder, reviewer, fix, re-review); `infra-auditor` for spend or cross-account grants |
| A screen's layout or design | the `ui-designer` agent (`build:` or `review:`) |
| A data or software licence question (WR2012, DWS, CHIRPS, CHELSA, Cape Farm Mapper, the clean-room rule) | the `za-legal-researcher` agent, before building |
| A domain question (would a hydrologist accept this?) | the `persona-hydrologist` agent, read-only |
| Anything else | build it directly |

Keep the diff to what the issue asks. A real problem you find on the way is
either fixed here (small, same area) or opened as its own issue; never left
as a passing remark (CLAUDE.md § Fix the root cause).

Never: anything derived from WRSM2000's executable or DLLs; client or
reference-network data in a test, fixture, doc, commit or issue; a farm or
client name anywhere (CLAUDE.md § Project rules).

## 4. Test while you work

`pnpm test:<surface>` for the workspace you touched (`test:wrsm`,
`test:wrsm-cli`, or `pnpm frontend test` / `pnpm backend test`). With
`WRSM_REFERENCE_DIR` set, the reference comparison runs too; without it, it
skips, and you say so in the report.

## 5. Gate

1. `pnpm check && pnpm test` in the worktree.
2. `/check` on the diff, plus `wrsm-engine-reviewer` if `packages/wrsm`
   changed. Apply the findings you agree with; for the ones you don't, say
   why in your report.
3. Docs and tests changed with the code, or the report says why not.

## 6. Commit, open a PR, merge, report

- Commit path-scoped, one logical unit per commit:
  `git commit -m "<type>(<area>): <what>" -- <paths>`. No `Co-Authored-By`
  or generated-by trailer, in commits or in the PR.
- **A sub-agent stops here** and reports its branch, commits, files and
  test results; it never pushes. The orchestrator brings its branch into
  the orchestrator's own (merge or cherry-pick).
- **The orchestrating session** brings the branch up to date
  (`git fetch origin && git rebase origin/main`; `git merge origin/main`
  instead once the branch is pushed), pushes it (`git push -u origin
  <branch>`; the `pre-push` hook runs `pnpm check && pnpm test` on code
  changes), and opens the PR: `gh pr create --base main --title
  "<type>(<area>): <what>" --body-file <file>`, the body following
  `.github/pull_request_template.md` with a Summary ending `Closes #<n>`
  (`Part of #<n>` when the issue stays open). `pr-title-lint` checks the
  title, and a squash merge makes it the commit subject on `main`.
- Drive it to green with the `steward` skill (`gh pr checks <pr> --watch`).
  A red check is fixed with another commit on the branch, never by
  re-running until it passes.
- Merge once `CI gate` is green and every review conversation is resolved:
  `gh pr merge <pr> --squash --delete-branch` (`--rebase` when each commit
  is worth keeping on `main`). Never `--admin`, never push to `main`.
- Comment on the issue with what landed (the PR, its merge commit, what's
  left), and close it only if it is fully done and `Closes #<n>` didn't
  already: `gh issue comment <n> --body-file …`, `gh issue close <n>`.
  Don't close #3, #21 or #22 (trackers).

## 7. Clean up

`git worktree remove ../pitman-<n>-<slug>`, then delete the local branch
with `git branch -D <branch>` (a squash merge leaves its commits off `main`,
so `-d` refuses it), and `git pull --ff-only` in the main checkout.
