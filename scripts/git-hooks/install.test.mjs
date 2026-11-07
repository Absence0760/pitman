// Tests for the hooks installer the root `prepare` script runs (node:test, `pnpm test:tools`).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, HOOKS_PATH } from './install.mjs';

test("sets core.hooksPath when unset, keeps it when ours, leaves anyone else's, skips CI", () => {
	assert.equal(decide(null, false), 'set');
	assert.equal(decide(HOOKS_PATH, false), 'already');
	assert.equal(decide('../my-hooks', false), 'foreign');
	assert.equal(decide(null, true), 'skip-ci');
});

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), 'install.mjs');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
delete ENV.CI;

/** A throwaway checkout (or, with git false, a plain folder) holding a copy of install.mjs. */
function checkout(t, { git = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'hooks-install-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (git) execFileSync('git', ['init', '-q'], { cwd: dir, env: ENV });
	mkdirSync(join(dir, 'scripts/git-hooks'), { recursive: true });
	copyFileSync(INSTALL, join(dir, 'scripts/git-hooks/install.mjs'));
	const run = (env = {}) => spawnSync('node', ['scripts/git-hooks/install.mjs'], { cwd: dir, env: { ...ENV, ...env }, encoding: 'utf8' });
	const hooksPath = () => spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: dir, env: ENV, encoding: 'utf8' }).stdout.trim();
	const setHooksPath = (v) => execFileSync('git', ['config', 'core.hooksPath', v], { cwd: dir, env: ENV });
	return { run, hooksPath, setHooksPath };
}

test('in a checkout it sets core.hooksPath to .githooks', (t) => {
	const c = checkout(t);
	const r = c.run();
	assert.equal(r.status, 0, r.stderr);
	assert.equal(c.hooksPath(), HOOKS_PATH);
	assert.equal(c.run().status, 0, 'and a second install is a no-op');
});

test('in CI it leaves the config alone', (t) => {
	const c = checkout(t);
	assert.equal(c.run({ CI: 'true' }).status, 0);
	assert.equal(c.hooksPath(), '');
});

test('a hooksPath of your own is kept, with a warning', (t) => {
	const c = checkout(t);
	c.setHooksPath('/somewhere/else');
	const r = c.run();
	assert.equal(r.status, 0);
	assert.equal(c.hooksPath(), '/somewhere/else');
	assert.match(r.stderr, /left alone/);
});

test('outside a git checkout it does nothing and never fails the install', (t) => {
	const c = checkout(t, { git: false });
	const r = c.run({ GIT_CEILING_DIRECTORIES: tmpdir() });
	assert.equal(r.status, 0);
	assert.equal(r.stdout + r.stderr, '');
});
