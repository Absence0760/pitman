// Guards on .github/workflows/fresh-clone.yml (node:test, `pnpm test:tools`): the workflow runs the first-run
// commands docs/run-locally.md documents, and its path filters name files that exist, so a rename can't
// silently stop the job from triggering (docs/run-locally.md § Fresh clone).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const text = readFileSync(new URL('.github/workflows/fresh-clone.yml', ROOT), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));

/** The `paths:` list under the trigger `event:`. */
function paths(event) {
	const lines = text.split('\n');
	const start = lines.findIndex((l) => l === `  ${event}:`);
	assert.notEqual(start, -1, `no ${event} trigger`);
	const at = lines.findIndex((l, i) => i > start && l === '    paths:');
	const out = [];
	for (const line of lines.slice(at + 1)) {
		const m = line.match(/^ {6}- '?([^']+?)'?$/);
		if (!m) break;
		out.push(m[1]);
	}
	return out;
}

test('pull_request and push to main watch the same paths', () => {
	assert.ok(paths('pull_request').length > 5);
	assert.deepEqual(paths('push'), paths('pull_request'));
});

test('every literal path the workflow watches exists', () => {
	for (const p of paths('pull_request')) {
		if (p.includes('*')) continue;
		assert.ok(existsSync(new URL(p, ROOT)), `${p} is watched but not in the repository`);
	}
});

test('it runs the documented first run: pnpm install, pnpm dev:data:synthetic, pnpm dev', () => {
	assert.match(text, /\n {8}run: pnpm install --frozen-lockfile\n/);
	assert.match(text, /\n {10}pnpm dev:data:synthetic\n/);
	assert.match(text, /setsid pnpm dev >/);
	assert.ok(pkg.scripts['dev:data:synthetic'] && pkg.scripts.dev);
	assert.match(text, /node-version-file: \.tool-versions\n/);
});

test('the Node .tool-versions pins satisfies package.json engines', () => {
	const pinned = readFileSync(new URL('.tool-versions', ROOT), 'utf8').match(/^nodejs (\d+)/m);
	const floor = pkg.engines.node.match(/^>=(\d+)$/);
	assert.ok(pinned && floor, 'nodejs pin or engines floor not found');
	assert.ok(Number(pinned[1]) >= Number(floor[1]), `.tool-versions pins ${pinned[1]}, engines needs ${floor[1]}`);
});

// actions/setup-node reads .tool-versions with `node-version-file`, and the template's commented-out
// toolchain list made it resolve Node version '#' (the first fresh-clone run, 2026-11-07). Keep the file
// to bare `<tool> <version>` lines.
test('.tool-versions holds only `<tool> <version>` lines, no comments or blanks', () => {
	const lines = readFileSync(new URL('.tool-versions', ROOT), 'utf8').replace(/\n$/, '').split('\n');
	for (const line of lines) assert.match(line, /^[a-z][\w-]* \S+$/, `.tool-versions line ${JSON.stringify(line)}`);
});
