// scripts/deploy/deploy-gate.mjs (node:test, `pnpm test:tools`): the deploy workflows' gate. A manual run deploys
// only main and only a commit CI passed; a CI-triggered run deploys when its surface changed since the commit
// the last *successful deploy job* shipped (not the previous push: CI cancels superseded runs on main, and a
// reviewer can reject a deploy), never rolls back to an older commit, and deploys when nothing was ever deployed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciPassed, decide, inSurface, lastDeployedSha, parsePaths, shaOfRun } from './deploy-gate.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const PATHS = 'backend\npackages/wrsm\npnpm-lock.yaml\npnpm-workspace.yaml\n.github/workflows/deploy-backend.yml\n';

/** A fake GitHub API: deploy runs (newest first), each with its jobs, and CI's successful head SHAs. */
function fakeApi({ runs = [], ciShas = [] } = {}) {
	const calls = [];
	const api = async (path) => {
		calls.push(path);
		let m;
		if ((m = /\/actions\/workflows\/ci\.yml\/runs\?head_sha=([0-9a-f]+)&status=success/.exec(path))) {
			const hit = ciShas.includes(m[1]);
			return { total_count: hit ? 1 : 0, workflow_runs: hit ? [{ id: 1 }] : [] };
		}
		if (/\/actions\/workflows\/deploy-backend\.yml\/runs\?status=success/.test(path)) {
			return { workflow_runs: runs.map(({ id, title }) => ({ id, display_title: title })) };
		}
		if ((m = /\/actions\/runs\/(\d+)\/jobs/.exec(path))) return { jobs: runs.find((r) => String(r.id) === m[1])?.jobs ?? [] };
		throw new Error(`unexpected ${path}`);
	};
	return { api, calls };
}

/** A fake git: `ancestors` maps a commit to the commits it descends from; `diff` maps "base..sha" to files. */
function fakeGit({ known = [A, B, C], ancestors = {}, diff = {} } = {}) {
	return (args) => {
		if (args[0] === 'cat-file') return { ok: known.includes(args[2].replace('^{commit}', '')), out: '' };
		if (args[0] === 'merge-base') return { ok: (ancestors[args[3]] ?? []).includes(args[2]), out: '' };
		if (args[0] === 'diff') {
			const key = `${args[2]}..${args[3]}`;
			return key in diff ? { ok: true, out: diff[key].join('\n') + '\n' } : { ok: false, out: '' };
		}
		throw new Error(`unexpected git ${args.join(' ')}`);
	};
}

const deployed = (id, sha) => ({ id, title: `Deploy backend ${sha}`, jobs: [{ name: 'Build Lambda bundle', conclusion: 'success' }, { name: 'Update Lambda code', conclusion: 'success' }] });
const notDeployed = (id, sha) => ({ id, title: `Deploy backend ${sha}`, jobs: [{ name: 'Decide', conclusion: 'success' }, { name: 'Update Lambda code', conclusion: 'skipped' }] });

const runEnv = (sha, extra = {}) => ({
	GITHUB_REPOSITORY: 'o/r',
	GITHUB_RUN_ID: '999',
	EVENT: 'workflow_run',
	SHA: sha,
	REF: 'refs/heads/main',
	WORKFLOW_FILE: 'deploy-backend.yml',
	DEPLOY_JOB: 'Update Lambda code',
	CI_WORKFLOW: 'ci.yml',
	DEPLOY_PATHS: PATHS,
	...extra
});

test('shaOfRun reads the commit from the run-name, and nothing from a run-name without one', () => {
	assert.equal(shaOfRun({ display_title: `Deploy backend ${A}` }), A);
	assert.equal(shaOfRun({ display_title: 'Deploy backend' }), null);
	assert.equal(shaOfRun({}), null);
});

test('inSurface matches a listed file or anything under a listed directory, not a sibling with the same stem', () => {
	const p = parsePaths(PATHS);
	assert.ok(inSurface('backend/src/app.ts', p));
	assert.ok(inSurface('packages/wrsm/src/index.ts', p));
	assert.ok(inSurface('pnpm-workspace.yaml', p));
	assert.ok(!inSurface('packages/wrsm-cli/src/main.ts', p), 'wrsm-cli is not wrsm');
	assert.ok(!inSurface('backend-notes.md', p));
	assert.ok(!inSurface('frontend/src/app.html', p));
	assert.ok(!inSurface('docs/deployment.md', p));
});

test('parsePaths drops blank lines and comments', () => {
	assert.deepEqual(parsePaths('  backend  \n\n# a comment\nfrontend # trailing\n'), ['backend', 'frontend']);
});

test('lastDeployedSha skips runs whose deploy job did not succeed (rejected, skipped, nothing changed) and this run', async () => {
	const { api } = fakeApi({ runs: [deployed(999, C), notDeployed(3, B), deployed(2, A)] });
	assert.equal(await lastDeployedSha({ api, repo: 'o/r', workflowFile: 'deploy-backend.yml', deployJob: 'Update Lambda code', currentRunId: '999' }), A);
});

test('lastDeployedSha is null when nothing was ever deployed', async () => {
	const { api } = fakeApi({ runs: [notDeployed(3, B)] });
	assert.equal(await lastDeployedSha({ api, repo: 'o/r', workflowFile: 'deploy-backend.yml', deployJob: 'Update Lambda code', currentRunId: '1' }), null);
});

test('ciPassed asks for a successful CI run on exactly that commit', async () => {
	const { api, calls } = fakeApi({ ciShas: [A] });
	assert.equal(await ciPassed({ api, repo: 'o/r', ciWorkflow: 'ci.yml', sha: A }), true);
	assert.equal(await ciPassed({ api, repo: 'o/r', ciWorkflow: 'ci.yml', sha: B }), false);
	assert.match(calls[0], new RegExp(`/repos/o/r/actions/workflows/ci\\.yml/runs\\?head_sha=${A}&status=success`));
});

test('CI-triggered: deploys when the surface changed since the live commit, across several pushes', async () => {
	// A is live; B's CI was cancelled (superseded), C passed: the diff is A..C, so B's backend change is included.
	const { api } = fakeApi({ runs: [deployed(2, A)] });
	const git = fakeGit({ ancestors: { [C]: [A, B] }, diff: { [`${A}..${C}`]: ['docs/x.md', 'backend/src/app.ts'] } });
	const r = await decide({ env: runEnv(C), api, git });
	assert.equal(r.deploy, true);
	assert.match(r.reason, /backend\/src\/app\.ts/);
	assert.doesNotMatch(r.reason, /docs\/x\.md/);
});

test('CI-triggered: skips when nothing in the surface changed', async () => {
	const { api } = fakeApi({ runs: [deployed(2, A)] });
	const git = fakeGit({ ancestors: { [B]: [A] }, diff: { [`${A}..${B}`]: ['frontend/src/x.svelte', 'packages/wrsm-cli/a.ts', 'docs/y.md'] } });
	assert.equal((await decide({ env: runEnv(B), api, git })).deploy, false);
});

test('CI-triggered: a rejected deploy is not "live", so its changes ride the next one', async () => {
	// A deployed; B's deploy was rejected (job not successful); C touches only docs. A..C still has B's change.
	const rejected = { id: 3, title: `Deploy backend ${B}`, jobs: [{ name: 'Update Lambda code', conclusion: 'failure' }] };
	const { api } = fakeApi({ runs: [rejected, deployed(2, A)] });
	const git = fakeGit({ ancestors: { [C]: [A, B] }, diff: { [`${A}..${C}`]: ['backend/src/b.ts', 'docs/c.md'] } });
	assert.equal((await decide({ env: runEnv(C), api, git })).deploy, true);
});

test('CI-triggered: deploys when nothing was ever deployed (the stub is live)', async () => {
	const { api } = fakeApi({ runs: [] });
	assert.equal((await decide({ env: runEnv(A), api, git: fakeGit() })).deploy, true);
});

test('CI-triggered: never rolls back to a commit older than the live one, and skips the live one itself', async () => {
	const { api } = fakeApi({ runs: [deployed(2, B)] });
	const git = fakeGit({ ancestors: { [B]: [A] } });
	assert.equal((await decide({ env: runEnv(A), api, git })).deploy, false);
	assert.equal((await decide({ env: runEnv(B), api, git })).deploy, false);
});

test('CI-triggered: deploys when the live commit is gone from history', async () => {
	const { api } = fakeApi({ runs: [deployed(2, A)] });
	assert.equal((await decide({ env: runEnv(B), api, git: fakeGit({ known: [B] }) })).deploy, true);
});

test('manual: deploys a main commit CI passed, whatever changed', async () => {
	const { api } = fakeApi({ ciShas: [A] });
	const r = await decide({ env: runEnv(A, { EVENT: 'workflow_dispatch' }), api, git: fakeGit() });
	assert.equal(r.deploy, true);
});

test('manual: refuses a commit without a successful CI run', async () => {
	const { api } = fakeApi({ ciShas: [] });
	await assert.rejects(decide({ env: runEnv(A, { EVENT: 'workflow_dispatch' }), api, git: fakeGit() }), /CI has no successful run/);
});

test('manual: refuses any ref but main', async () => {
	const { api } = fakeApi({ ciShas: [A] });
	await assert.rejects(decide({ env: runEnv(A, { EVENT: 'workflow_dispatch', REF: 'refs/heads/feature' }), api, git: fakeGit() }), /from main only/);
});

test('refuses a short or missing SHA, an empty surface and an unknown event', async () => {
	const { api } = fakeApi();
	await assert.rejects(decide({ env: runEnv('abc123'), api, git: fakeGit() }), /full commit id/);
	await assert.rejects(decide({ env: runEnv(A, { DEPLOY_PATHS: '\n' }), api, git: fakeGit() }), /DEPLOY_PATHS is empty/);
	await assert.rejects(decide({ env: runEnv(A, { EVENT: 'push' }), api, git: fakeGit() }), /unexpected event/);
});
