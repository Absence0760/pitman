// Tests for the root-scripts guard (root-scripts.mjs). The committed manifest itself is checked by
// `pnpm test:scripts`, which `pnpm test:tools` runs first; these pin what the guard reads and refuses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PNPM_COMMANDS, checkRootScripts, composeServices, splitCommands, workspaceDirs } from './root-scripts.mjs';

const TREE = {
	frontend: { name: '@app/frontend', scripts: { dev: 'vite', check: 'svelte-check', 'test:e2e': 'playwright test' } },
	backend: { name: '@app/backend', scripts: { dev: 'tsx watch', check: 'tsc' } },
	'packages/engine': { name: '@app/engine', scripts: { check: 'tsc' } },
};
const FILES = ['backend/scripts/seed.ts', 'scripts/tool/run.mjs', 'scripts/tool/a.test.mjs'];

/**
 * The verdict on `scripts`, placed under a `//-- dev --` divider unless `raw`. A baseline script that
 * resolves keeps each case off the "verified nothing" rule, which has its own test.
 * @param {Record<string, string>} scripts
 * @param {{ raw?: boolean, compose?: string[] | null }} [opts]
 */
function verdict(scripts, opts = {}) {
	const manifest = {
		scripts: opts.raw ? scripts : { '//-- dev --': 'Local dev.', 'dev:base': 'pnpm --filter @app/frontend run dev', ...scripts },
	};
	const out = checkRootScripts(manifest, {
		workspaceDirs: Object.keys(TREE),
		readManifest: (d) => TREE[d] ?? null,
		exists: (p) => FILES.includes(p),
		globCount: (p) => FILES.filter((f) => new RegExp(`^${p.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`).test(f)).length,
		composeServices: opts.compose === undefined ? ['dynamodb', 'mailpit'] : opts.compose,
	});
	const mine = (/** @type {string[]} */ l) => l.filter((x) => !x.startsWith('dev:base:'));
	return { ...out, errors: mine(out.errors), ok: mine(out.ok), unverifiable: mine(out.unverifiable) };
}

test('splitCommands: operators separate commands; quotes and escapes group words', () => {
	assert.deepEqual(splitCommands('a b && c; d | e || f & g'), [['a', 'b'], ['c'], ['d'], ['e'], ['f'], ['g']]);
	assert.deepEqual(splitCommands(`node -e "a && b" 'c;d' e\\ f`), [['node', '-e', 'a && b', 'c;d', 'e f']]);
	assert.deepEqual(splitCommands('x ""'), [['x', '']]);
	assert.throws(() => splitCommands("echo 'open"), /unterminated/);
});

test('the baseline passes, so each case below is the only cause of its finding', () => {
	const { errors, ok } = verdict({});
	assert.deepEqual(errors, []);
	assert.deepEqual(ok, []);
});

test('pnpm --filter resolves through the package name, every filter of several', () => {
	assert.deepEqual(verdict({ 'dev:x': 'pnpm --filter @app/frontend --filter @app/backend --parallel run dev' }).errors, []);
	assert.deepEqual(verdict({ 'dev:x': 'pnpm --filter @app/frontend --filter @app/engine run dev' }).errors, [
		'dev:x: packages/engine/package.json has no "dev" script',
	]);
	assert.match(verdict({ 'dev:x': 'pnpm --filter @app/nothing run dev' }).errors.join(), /names no workspace package/);
	assert.deepEqual(verdict({ 'dev:x': 'pnpm -F=@app/frontend test:e2e' }).errors, []);
});

test('pnpm -C <dir> run / exec: the script is declared, the file exists', () => {
	assert.deepEqual(verdict({ 'dev:x': 'pnpm -C frontend run check' }).errors, []);
	assert.deepEqual(verdict({ 'dev:x': 'pnpm -C frontend --silent run nope' }).errors, ['dev:x: frontend/package.json has no "nope" script']);
	assert.deepEqual(verdict({ 'dev:x': 'pnpm -C nowhere run check' }).errors, ['dev:x: no nowhere/package.json']);
	assert.deepEqual(verdict({ 'dev:x': 'pnpm -C backend exec tsx scripts/seed.ts' }).errors, []);
	assert.deepEqual(verdict({ 'dev:x': 'pnpm -C backend exec tsx scripts/gone.ts' }).errors, ['dev:x: missing file backend/scripts/gone.ts']);
	assert.match(verdict({ 'dev:x': 'pnpm -C backend exec tsc --noEmit' }).unverifiable.join(), /names no file/);
});

test('pnpm -r run: some workspace must declare the script', () => {
	assert.deepEqual(verdict({ 'dev:x': 'pnpm -r --no-bail run check' }).errors, []);
	assert.match(verdict({ 'dev:x': 'pnpm -r run lint' }).errors.join(), /reaches no workspace/);
});

test('a bare pnpm <name> is a root script; pnpm commands are reported, not looked up', () => {
	assert.deepEqual(verdict({ 'dev:x': 'pnpm dev:base && pnpm dev:gone' }).errors, ['dev:x: the root package.json has no "dev:gone" script']);
	assert.match(verdict({ 'dev:x': 'pnpm install' }).unverifiable.join(), /pnpm's own command/);
});

test('node: the entry file exists; node --test: every file or glob matches', () => {
	assert.deepEqual(verdict({ 'dev:x': 'node scripts/tool/run.mjs --flag value' }).errors, []);
	assert.deepEqual(verdict({ 'dev:x': 'node scripts/tool/gone.mjs' }).errors, ['dev:x: missing file scripts/tool/gone.mjs']);
	assert.deepEqual(verdict({ 'dev:x': 'node --test scripts/tool/*.test.mjs' }).errors, []);
	assert.deepEqual(verdict({ 'dev:x': 'node --test scripts/tool/*.test.mjs scripts/gone/*.test.mjs' }).errors, [
		'dev:x: scripts/gone/*.test.mjs matches no file',
	]);
	assert.match(verdict({ 'dev:x': 'node ../elsewhere/x.mjs' }).errors.join(), /outside the repository/);
	assert.match(verdict({ 'dev:x': 'node $SCRIPT' }).unverifiable.join(), /run time/);
});

test('docker compose: each named service is in docker-compose.yml; logs -f is follow, not a file', () => {
	assert.deepEqual(verdict({ 'dev:x': 'docker compose up -d --wait dynamodb mailpit' }).errors, []);
	const logs = verdict({ 'dev:x': 'docker compose logs -f dynamodb mailpit' });
	assert.deepEqual(logs.errors, []);
	assert.ok(logs.ok.includes('dev:x: docker-compose.yml declares "dynamodb"'));
	assert.deepEqual(verdict({ 'dev:x': 'docker compose -f docker-compose.yml up redis' }).errors, ['dev:x: docker-compose.yml has no "redis" service']);
	assert.match(verdict({ 'dev:x': 'docker compose up' }, { compose: null }).errors.join(), /no docker-compose\.yml/);
});

test('an unknown command and unreadable shell are reported, never passed', () => {
	assert.match(verdict({ 'dev:x': 'make all' }).unverifiable.join(), /`make` is not a command/);
	assert.deepEqual(verdict({ 'dev:x': "echo 'open" }).errors, ['dev:x: unreadable shell']);
});

// ── format (CLAUDE.md § Root package.json scripts) ─────────────────────────

test('a script before the first divider is ungrouped', () => {
	const { errors } = verdict({ loose: 'pnpm -C frontend run check', '//-- dev --': 'Dev.', 'dev:a': 'pnpm -C frontend run dev' }, { raw: true });
	assert.deepEqual(errors, ['loose: not under a "//-- <group> --" divider']);
});

test('a script joins the group its name starts with', () => {
	assert.deepEqual(verdict({ 'dev:auth:up': 'docker compose up dynamodb' }).errors, []);
	assert.deepEqual(verdict({ 'check:x': 'pnpm -C frontend run check' }).errors, ['check:x: sits in the "dev" group, but its name does not start with "dev"']);
	const subgroup = verdict({ '//-- dev: sign-in --': 'Sign-in services.', 'dev:auth:up': 'docker compose up dynamodb' });
	assert.deepEqual(subgroup.errors, []);
});

test('dividers: the //-- name -- shape, a description, never empty', () => {
	assert.match(verdict({ '//--Bad': 'x', 'dev:y': 'pnpm dev:base' }).errors.join(), /a divider is written/);
	assert.match(verdict({ '//-- test --': '', 'test:y': 'pnpm dev:base' }).errors.join(), /needs a one-line description/);
	assert.deepEqual(verdict({ '//-- test --': 'Tests.' }).errors, ['"test" is an empty group']);
});

test('the workspaces group holds only pnpm --filter aliases', () => {
	assert.deepEqual(verdict({ '//-- workspaces --': 'Aliases.', web: 'pnpm --filter @app/frontend' }).errors, []);
	assert.deepEqual(verdict({ '//-- workspaces --': 'Aliases.', web: 'pnpm --filter @app/frontend run dev' }).errors, [
		'web: the "workspaces" group holds only `pnpm --filter <package>` aliases',
	]);
	assert.match(verdict({ '//-- workspaces --': 'Aliases.', web: 'pnpm --filter @app/web' }).errors.join(), /names no workspace package/);
});

test('a script named after a pnpm command is shadowed', () => {
	assert.ok(PNPM_COMMANDS.has('setup') && !PNPM_COMMANDS.has('test'));
	assert.match(verdict({ '//-- setup --': 'One-time.', setup: 'pnpm dev:base' }).errors.join(), /shadows this script/);
});

test('vacuity: no scripts, or nothing verified, fails', () => {
	assert.match(verdict({}, { raw: true }).errors.join(), /declares no scripts/);
	assert.match(verdict({ '//-- dev --': 'x', 'dev:a': 'make a', 'dev:b': 'make b' }, { raw: true }).errors.join(), /verified nothing across 2/);
});

test('workspaceDirs expands globs; composeServices reads top-level service keys only', () => {
	assert.deepEqual(workspaceDirs("packages:\n  - frontend\n  - 'packages/*'\nonlyBuiltDependencies:\n  - esbuild\n", () => ['packages/a', 'packages/b']), [
		'frontend',
		'packages/a',
		'packages/b',
	]);
	assert.deepEqual(composeServices('services:\n  # c\n  db:\n    image: x\n    ports:\n      - "1:1"\n  mail:\n    image: y\nvolumes:\n  data:\n'), ['db', 'mail']);
});
