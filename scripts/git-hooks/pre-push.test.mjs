// Tests for .githooks/pre-push (node:test, `pnpm test:tools`): which pushes run
// `pnpm check && pnpm test`, against a throwaway repo and a stand-in `pnpm`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '../../.githooks/pre-push');
const ZERO = '0'.repeat(40);

/** A repo with main = origin/main, a fake pnpm on PATH that logs its calls, and a git helper. */
function repo(t) {
	const dir = mkdtempSync(join(tmpdir(), 'pre-push-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const work = join(dir, 'work');
	const bin = join(dir, 'bin');
	const log = join(dir, 'pnpm.log');
	mkdirSync(work);
	mkdirSync(bin);
	writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env bash\necho "$*" >> "${log}"\nexit "\${FAKE_PNPM_EXIT:-0}"\n`);
	chmodSync(join(bin, 'pnpm'), 0o755);
	// HOME is the temp dir, so the hook doesn't source a real nvm that could put the real pnpm first.
	const env = {
		...process.env,
		HOME: dir,
		PATH: `${bin}:${process.env.PATH}`,
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_AUTHOR_NAME: 't',
		GIT_AUTHOR_EMAIL: 't@example.invalid',
		GIT_COMMITTER_NAME: 't',
		GIT_COMMITTER_EMAIL: 't@example.invalid',
	};
	const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' }).trim();
	const commit = (path, msg) => {
		mkdirSync(dirname(join(work, path)), { recursive: true });
		writeFileSync(join(work, path), `${msg}\n`);
		git('add', '--', path);
		git('commit', '-q', '-m', msg, '--', path);
		return git('rev-parse', 'HEAD');
	};
	git('init', '-q', '-b', 'main');
	const root = commit('src/a.ts', 'root');
	git('update-ref', 'refs/remotes/origin/main', root);
	/** Run the hook with one stdin line per [localSha, remoteSha]; returns status and pnpm's calls. */
	const push = (lines, extra = {}) => {
		const input = lines.map(([l, r]) => `refs/heads/x ${l} refs/heads/x ${r}`).join('\n') + '\n';
		const res = spawnSync('bash', [HOOK, 'origin', 'git@example.invalid:o/r.git'], { cwd: work, env: { ...env, ...extra }, input, encoding: 'utf8' });
		const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
		rmSync(log, { force: true });
		return { status: res.status, calls, stderr: res.stderr };
	};
	return { git, commit, push, root };
}

test('a new feature branch with a code change runs check and test', (t) => {
	const r = repo(t);
	r.git('switch', '-q', '-c', 'fix/1');
	const tip = r.commit('backend/src/x.ts', 'code');
	const res = r.push([[tip, ZERO]]);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(res.calls, ['check', 'test']);
});

test('a new branch with only docs, markdown or .claude/ skips', (t) => {
	const r = repo(t);
	r.git('switch', '-q', '-c', 'docs/1');
	r.commit('docs/x.md', 'doc');
	r.commit('README.md', 'readme');
	const tip = r.commit('.claude/commands/x.md', 'claude');
	const res = r.push([[tip, ZERO]]);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(res.calls, []);
});

test('an update to a pushed branch looks only at the new commits', (t) => {
	const r = repo(t);
	r.git('switch', '-q', '-c', 'feat/1');
	const pushed = r.commit('frontend/src/y.ts', 'code');
	const docTip = r.commit('docs/y.md', 'doc');
	assert.deepEqual(r.push([[docTip, pushed]]).calls, [], 'docs-only update skips');
	const codeTip = r.commit('packages/wrsm/src/z.ts', 'code 2');
	assert.deepEqual(r.push([[codeTip, docTip]]).calls, ['check', 'test']);
});

test('a rewritten branch whose old tip is not local is compared from main', (t) => {
	const r = repo(t);
	r.git('switch', '-q', '-c', 'feat/2');
	const tip = r.commit('backend/src/w.ts', 'code');
	assert.deepEqual(r.push([[tip, 'f'.repeat(40)]]).calls, ['check', 'test']);
});

test('deleting a remote branch runs nothing', (t) => {
	const r = repo(t);
	assert.deepEqual(r.push([[ZERO, r.root]]).calls, []);
});

test('a failing check stops the push', (t) => {
	const r = repo(t);
	r.git('switch', '-q', '-c', 'fix/2');
	const tip = r.commit('backend/src/v.ts', 'code');
	const res = r.push([[tip, ZERO]], { FAKE_PNPM_EXIT: '1' });
	assert.equal(res.status, 1);
	assert.match(res.stderr, /not pushing/);
});
