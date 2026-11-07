#!/usr/bin/env bash
# SessionStart hook: surface work that lives off `main`.
#
# With per-session git worktrees (`claude --worktree <name>`), each session
# commits on its own branch, and that work reaches `main` only through a pull
# request (`main` is protected; CLAUDE.md § Working alongside other Claude
# sessions). If a worktree branch is forgotten, its commits sit stranded off
# `main`.
#
# This hook lists every local branch holding commits not yet on `main` and
# prints a warning to stdout — which Claude Code injects as session context, so
# the next turn can surface it and offer to merge. Silent when everything is on
# `main`. Fail-open: any error exits 0 with no output, never wedging startup.
set -u

repo="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$repo" ] || exit 0

# Does `main` exist? If not, this repo doesn't use the convention — stay quiet.
git -C "$repo" rev-parse --verify --quiet main >/dev/null 2>&1 || exit 0

# Branches with commits not contained in `main` (main itself never lists here).
branches="$(git -C "$repo" branch --no-merged main --format='%(refname:short)' 2>/dev/null)" || exit 0
[ -n "$branches" ] || exit 0

# Map branch -> worktree path (if any) for a more useful message.
report=""
while IFS= read -r br; do
	[ -n "$br" ] || continue
	count="$(git -C "$repo" rev-list --count "main..$br" 2>/dev/null || echo '?')"
	wt="$(git -C "$repo" worktree list --porcelain 2>/dev/null \
		| awk -v b="refs/heads/$br" '
			/^worktree /{path=substr($0,10)}
			$0=="branch "b{print path}')"
	if [ -n "$wt" ]; then
		report="${report}  - ${br} (${count} commit(s) off main) — worktree: ${wt}
"
	else
		report="${report}  - ${br} (${count} commit(s) off main)
"
	fi
done <<EOF
$branches
EOF

[ -n "$report" ] || exit 0

cat <<EOF
[unmerged-worktree-check] Work exists that is NOT on \`main\`:
${report}
To land it, push the branch and open a pull request (\`main\` is protected and
merges a PR once "CI gate" is green, squash or rebase):
  git push -u origin <branch> && gh pr create --base main --fill
A branch whose PR was squash-merged still lists here (its own commits never
reach main): if \`gh pr list --head <branch> --state merged\` shows it, delete
it with \`git branch -D <branch>\`. Merged work also lists until the primary
checkout's main is current: \`git pull --ff-only\` there first.
Surface this to the user and offer to land or clean it up before it's forgotten.
EOF
exit 0
