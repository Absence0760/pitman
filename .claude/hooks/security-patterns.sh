#!/usr/bin/env bash
# .claude/hooks/security-patterns.sh
#
# Cheap, fast pattern checks for the regressions Pitman's rules forbid,
# run as a PostToolUse hook on Edit / Write / MultiEdit so a violation
# surfaces to Claude before the next turn. Adapted from feohledger's
# hook of the same name (estate pattern); the rules are Pitman's own.
#
# It never blocks work: PostToolUse runs after the edit has happened, so
# exit 2 only shows the findings to Claude as feedback. Anything the hook
# can't parse (no jq, no file path, a deleted file) exits 0.
#
# Rules are greps for bug classes with a stable textual shape. Each one
# states WHY it exists and the safer alternative. They complement, never
# replace, the real guards: `packages/wrsm/src/purity.test.ts`, the
# round-trip tests and the `wrsm-engine-reviewer` agent.
#
# Bypass: append `// noqa: <rule_name>` (with a short reason) to the line.
# Project-wide opt-out: delete the rule's block below.
#
# Exit codes: 0 no findings (or file out of scope); 2 findings on stderr.
#
# Test: .claude/hooks/security-patterns.test.sh

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat || true)"
FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
[[ -n "$FILE" && "$FILE" != "null" ]] || exit 0

# Repo-relative form for scoping, whether the path came in absolute or not.
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
REL="${FILE#"$ROOT"/}"
REL="/${REL#/}"

case "$REL" in
  */node_modules/*|*/dist/*|*/build/*|*/.svelte-kit/*|*/coverage/*) exit 0 ;;
  /docs/formats/examples/*) exit 0 ;;   # byte-exact fixtures (CLAUDE.md project rule 6)
  *.ts|*.svelte|*.js|*.mjs) ;;
  *) exit 0 ;;
esac
[[ -f "$FILE" ]] || exit 0

IS_TEST=0
case "$REL" in *.test.ts|*.test.mjs|*/__tests__/*|*/fixtures/*) IS_TEST=1 ;; esac

FINDINGS=""

register() {
  local rule="$1" lineno="$2" why="$3" fix="$4" content
  content="$(sed -n "${lineno}p" "$FILE" 2>/dev/null || true)"
  if grep -qE "noqa:[[:space:]]*${rule}\b" <<<"$content"; then
    return
  fi
  FINDINGS+="  [${rule}] ${REL#/}:${lineno}
    why: ${why}
    fix: ${fix}

"
}

# Line numbers of lines matching $1 that aren't // comments.
lines() {
  grep -nE "$1" "$FILE" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' | cut -d: -f1 || true
}

# ===== Engine (packages/wrsm/src, not tests) ===============================
if [[ "$REL" == /packages/wrsm/src/* && $IS_TEST -eq 0 ]]; then

  # Why: the engine runs in the browser and in Lambda; readers and writers
  # take and return strings (CLAUDE.md project rule 4). purity.test.ts
  # catches this at test time; the hook catches it at edit time.
  for ln in $(lines "from[[:space:]]+['\"](node:[a-z_/]+|fs|path|os|child_process)['\"/]|import\([[:space:]]*['\"]node:|require\(|\bprocess\.|\bwindow\.|\bdocument\.|\bfetch\("); do
    register "engine-purity" "$ln" \
      "Node, DOM or network API in packages/wrsm: the engine must stay pure" \
      "Take and return strings; do the I/O in packages/wrsm-cli or backend/"
  done

  # Why: same inputs, same outputs. A random number or a wall-clock date in
  # the engine makes a run unrepeatable and a time zone can shift a month.
  for ln in $(lines "Math\.random\(|new Date\(|Date\.now\("); do
    register "engine-nondeterminism" "$ln" \
      "Math.random / Date in the engine: results must not depend on the clock, time zone or chance" \
      "Pass the year or month in as data; months are hydrological-year indices (0 = October, src/types.ts)"
  done

  # Why: WRSM2000's reals are float32 and writers round the float32 value
  # half away from zero (docs/formats.md § 2, U-18). toFixed on a float64
  # can print a tie differently and break byte-identity of a written file.
  if [[ "$REL" == /packages/wrsm/src/io/* ]]; then
    for ln in $(lines "\.toFixed\("); do
      grep -q 'fround' <<<"$(sed -n "${ln}p" "$FILE")" && continue
      register "writer-float32" "$ln" \
        "toFixed on a value not passed through Math.fround: writers must round the float32 value" \
        "Use the shared number formatter (Math.fround first, then half away from zero; docs/formats.md § 2)"
    done
  fi

  for ln in $(lines "console\.(log|warn|error|info)\("); do
    register "engine-console" "$ln" \
      "console output from the engine: problems are returned as data (docs/formats.md § 1.4)" \
      "Return a warning or error with file, line and field; let the CLI or app print it"
  done
fi

# ===== Frontend =============================================================
if [[ "$REL" == /frontend/src/* ]]; then
  # Why: the frontend is a static SPA; everything it imports ships to every
  # visitor. A private env module is how a token (e.g. Cape Farm Mapper's,
  # decision D3) would reach the browser.
  for ln in $(lines "\\\$env/(static|dynamic)/private"); do
    register "frontend-private-env" "$ln" \
      "Private env imported into the static frontend: its value would ship to the browser" \
      "Keep secrets in the backend proxy; the frontend reads only \$env/static/public"
  done
fi

# ===== Backend ==============================================================
if [[ "$REL" == /backend/src/* && $IS_TEST -eq 0 ]]; then
  # Why: IC-WBT's buckets are in af-south-1, an opt-in region; an S3Client
  # with no region uses the Lambda's own (docs/data.md § Cross-account access).
  for ln in $(lines "new[[:space:]]+S3Client\([[:space:]]*(\{[[:space:]]*\})?[[:space:]]*\)"); do
    register "s3-client-region" "$ln" \
      "S3Client built with no region: cross-account reads go to the wrong region" \
      "Pass region explicitly (new S3Client({ region }))"
  done
fi

# ===== Everywhere (tests included) =========================================
# Why: no client data in git (CLAUDE.md project rule 2). A hard-coded path
# into someone's machine is how a reference network's location, or a
# fixture copied from it, ends up committed. Tests read WRSM_REFERENCE_DIR.
for ln in $(lines "['\"\`](/home/|/Users/|[A-Za-z]:\\\\\\\\Users)"); do
  register "machine-path" "$ln" \
    "Hard-coded path into a user's machine: reference data stays off git" \
    "Read the location from WRSM_REFERENCE_DIR (tests skip only when it is unset), or use a synthetic fixture"
done

if [[ -n "$FINDINGS" ]]; then
  {
    echo "Pattern hook flagged the change to ${REL#/}:"
    echo
    printf '%s' "$FINDINGS"
    echo "If a rule is wrong here, append '// noqa: <rule_name>' with a short reason. Rules: .claude/hooks/security-patterns.sh"
  } >&2
  exit 2
fi
exit 0
