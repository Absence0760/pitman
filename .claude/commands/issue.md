---
description: Work one GitHub issue end to end — read it, branch in a worktree, route the work to the right workflow and agents, gate it with pnpm check/test and /check, then merge it into main (while PRs are off) and report back on the issue. The default entry point for a session driven by an issue.
argument-hint: <issue number or URL>
---

Take issue `$ARGUMENTS` from "open" to "done on `main`, tested, reviewed and
reported on the issue". One issue per session, unless the issue itself
splits into independent parts (then one branch per part, each naming the
issue). For a round of issue #3, the orchestrator runs the round instead;
this command is for a single issue or a single task from a round.

**Workflow note.** Until the operator turns PRs back on (issue #22, steps
10–11), work lands **straight on `main`** (CLAUDE.md § Working alongside
other Claude sessions). § 6 below is that flow. When PRs return, replace § 6
with: push the branch, open a PR with `.github/pull_request_template.md`
whose Summary ends `Closes #<n>`, drive it to green, and leave the merge to
the operator.

## 1. Read the issue

`gh issue view <n> --comments`. Take in the body, every comment, the labels,
and any linked issues or docs. Then, in two or three lines, state the goal,
what "done" looks like, and anything the issue leaves open. If a fork
changes what gets built (two readings of the ask, a hydrology or licence
decision), ask before building; if it's a detail, pick the reasonable
default, say which, and carry on.

Check it isn't already done or in flight: `git log --oneline main --grep
'#<n>'`, and `git worktree list` / `git branch --list '*<n>*'` for a branch
another session started.

## 2. Branch in a worktree

```
git worktree add ../pitman-<n>-<slug> -b <type>/<n>-<slug> main
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

## 6. Commit, merge, report (PRs off)

- Commit path-scoped, one logical unit per commit:
  `git commit -m "<type>(<area>): <what>" -- <paths>`. No `Co-Authored-By`
  or generated-by trailer.
- **A sub-agent stops here** and reports its branch, commits, files and
  test results; the orchestrator merges.
- **The orchestrating session** merges the branch into `main` in the main
  checkout (`git merge --no-ff <branch>` or a fast-forward), reruns
  `pnpm check && pnpm test` on `main`, and pushes `main`. Never force-push.
- Comment on the issue with what landed (commit hashes, what's left), and
  close it only if it is fully done: `gh issue comment <n> --body-file …`,
  `gh issue close <n>`. Don't close #3, #21 or #22 (trackers).

## 7. Clean up

`git worktree remove ../pitman-<n>-<slug>` and delete the merged branch
(`git branch -d <branch>`).
