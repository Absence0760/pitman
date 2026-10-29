#!/usr/bin/env bash
# Tests for security-patterns.sh: each rule fires on a sample, stays quiet
# on clean code, honours `noqa`, and never fails on input it can't use.
# Run: bash .claude/hooks/security-patterns.test.sh
set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/security-patterns.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
fail=0

# write <repo-relative path> <content>
write() { mkdir -p "$ROOT/$(dirname "$1")"; printf '%s\n' "$2" > "$ROOT/$1"; }

# expect <exit code> <rule or -> <repo-relative path> [raw stdin]
expect() {
  local want="$1" rule="$2" rel="$3" input out code
  input="${4:-$(printf '{"tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$ROOT/$rel")}"
  out="$(printf '%s' "$input" | CLAUDE_PROJECT_DIR="$ROOT" bash "$HOOK" 2>&1)"; code=$?
  if [[ "$code" != "$want" ]] || { [[ "$rule" != - ]] && ! grep -q "\[$rule\]" <<<"$out"; }; then
    echo "FAIL: $rel expected exit $want${rule:+ [$rule]}, got $code"; echo "$out" | sed 's/^/    /'; fail=1
  else
    echo "ok: $rel -> $code ${rule}"
  fi
}

write packages/wrsm/src/io/a.ts "import { readFileSync } from 'node:fs';"
expect 2 engine-purity packages/wrsm/src/io/a.ts
write packages/wrsm/src/runoff/b.ts "const r = Math.random();"
expect 2 engine-nondeterminism packages/wrsm/src/runoff/b.ts
write packages/wrsm/src/io/c.ts "const s = x.toFixed(2);"
expect 2 writer-float32 packages/wrsm/src/io/c.ts
write packages/wrsm/src/io/d.ts "const s = Math.fround(x).toFixed(2);"
expect 0 - packages/wrsm/src/io/d.ts
write packages/wrsm/src/io/e.ts "const s = x.toFixed(2); // noqa: writer-float32 integer-valued count"
expect 0 - packages/wrsm/src/io/e.ts
write packages/wrsm/src/purity2.test.ts "import { readFileSync } from 'node:fs';"
expect 0 - packages/wrsm/src/purity2.test.ts
write packages/wrsm/src/f.ts "// the engine never calls fetch( or process.env"
expect 0 - packages/wrsm/src/f.ts
write frontend/src/lib/g.ts "import { CFM_TOKEN } from '\$env/static/private';"
expect 2 frontend-private-env frontend/src/lib/g.ts
write frontend/src/lib/h.ts "import { PUBLIC_API_URL } from '\$env/static/public';"
expect 0 - frontend/src/lib/h.ts
write backend/src/mirror/store.ts "const s3 = new S3Client({});"
expect 2 s3-client-region backend/src/mirror/store.ts
write backend/src/mirror/store2.ts "const s3 = new S3Client({ region: 'af-south-1' });"
expect 0 - backend/src/mirror/store2.ts
write packages/wrsm-cli/src/x.test.ts "const dir = '/home/someone/networks/XX';"
expect 2 machine-path packages/wrsm-cli/src/x.test.ts
write packages/wrsm-cli/src/main.ts "process.stdout.write('ok');"
expect 0 - packages/wrsm-cli/src/main.ts
write docs/formats/examples/x.ts "const r = Math.random();"
expect 0 - docs/formats/examples/x.ts
write README.md "Math.random() in prose"
expect 0 - README.md
expect 0 - packages/wrsm/src/gone.ts
expect 0 - - 'not json'
expect 0 - - '{"tool_input":{}}'

exit $fail
