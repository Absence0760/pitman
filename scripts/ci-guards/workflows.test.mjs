// Guards on .github/workflows (node:test, `pnpm test:tools`). ci.yml's docs-only split keeps the Claude tooling guard running and the CI gate waiting on every job (bottom). And the private auth-kit's read token reaches git
// only for the step that installs, as environment-only config, and is never written to a git config file
// that every later step (tests, builds, deploys) could read (the #28 sign-in review, docs/deployment.md § CI).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const DIR = new URL('../../.github/workflows/', import.meta.url).pathname;
const SECRET = '${{ secrets.AUTH_KIT_READ_TOKEN }}';
const KEY = `url.https://x-access-token:${SECRET}@github.com/Absence0760/auth-kit.insteadOf`;
const FORMS = ['ssh://git@github.com/Absence0760/auth-kit', 'git@github.com:Absence0760/auth-kit', 'https://github.com/Absence0760/auth-kit'];

const workflows = readdirSync(DIR)
	.filter((f) => /\.ya?ml$/.test(f))
	.map((f) => ({ name: f, text: readFileSync(join(DIR, f), 'utf8') }));

/** A workflow's steps, as the text of each `- name:` / `- uses:` item under a `steps:` list. */
function steps(text) {
	const out = [];
	let current = null;
	for (const line of text.split('\n')) {
		if (/^\s+- (name|uses):/.test(line)) {
			if (current) out.push(current);
			current = [line];
		} else if (current) {
			if (/^\S/.test(line) || /^ {2}\S/.test(line) || /^ {4}\S/.test(line)) {
				out.push(current);
				current = null;
			} else current.push(line);
		}
	}
	if (current) out.push(current);
	return out.map((l) => l.join('\n'));
}

const tokenSteps = workflows.flatMap((w) => steps(w.text).filter((s) => s.includes(SECRET)).map((s) => ({ workflow: w.name, step: s })));

test('the workflows use the auth-kit token somewhere (the guard is looking at real steps)', () => {
	assert.ok(tokenSteps.length >= 6, `found ${tokenSteps.length}`);
});

test('no workflow writes the token into git config', () => {
	for (const w of workflows) {
		assert.doesNotMatch(w.text, /git config --global[^\n]*(x-access-token|AUTH_KIT_READ_TOKEN)/, w.name);
		assert.doesNotMatch(w.text, /AUTH_KIT_READ_TOKEN[^\n]*>>/, w.name);
	}
});

test('the token reaches git only on a pnpm install step, as GIT_CONFIG_* for auth-kit’s three URL forms', () => {
	for (const { workflow, step } of tokenSteps) {
		const where = `${workflow}: ${step.split('\n')[0].trim()}`;
		if (step.includes('GIT_CONFIG_KEY_')) {
			assert.match(step, /\n\s+run: pnpm install\b/, `${where} carries the token but doesn't install`);
			assert.match(step, /GIT_CONFIG_COUNT: '3'/, where);
			FORMS.forEach((form, i) => {
				assert.ok(step.includes(`GIT_CONFIG_KEY_${i}: ${KEY}`), `${where}: key ${i}`);
				assert.ok(step.includes(`GIT_CONFIG_VALUE_${i}: ${form}\n`), `${where}: value ${i}`);
			});
		} else {
			// The only other use: the check that fails with the setup link when the secret is empty.
			assert.match(step, /AUTH_KIT_READ_TOKEN: \$\{\{ secrets\.AUTH_KIT_READ_TOKEN \}\}/, where);
			assert.ok(step.includes('https://github.com/Absence0760/auth-kit/issues/2'), `${where}: no setup link`);
			assert.doesNotMatch(step, /\bgit\b(?!hub)|>>|GITHUB_ENV/, `${where} must only check the secret`);
		}
	}
});

test('every pnpm install that fetches auth-kit is preceded by the empty-secret check', () => {
	for (const w of workflows) {
		const all = steps(w.text);
		all.forEach((s, i) => {
			if (!s.includes('GIT_CONFIG_KEY_')) return;
			assert.ok(
				all.slice(0, i).some((p) => p.includes('auth-kit/issues/2')),
				`${w.name}: install without the check before it`
			);
		});
	}
});

// ci.yml's docs-only split: no paths filter skips the whole workflow (so the required "CI gate" always
// reports), the `changes` job skips only the heavy jobs, the Claude tooling guard runs on every change,
// and the gate waits on every job.
const ci = workflows.find((w) => w.name === 'ci.yml')?.text ?? '';
/** Job ids under `jobs:`, each with the text of its block. */
const ciJobs = new Map(
	(ci.split(/^jobs:\n/m)[1] ?? '')
		.split(/^(?= {2}[\w-]+:\n)/m)
		.map((block) => [/^ {2}([\w-]+):/.exec(block)?.[1], block])
		.filter(([id]) => id)
);

test('ci.yml runs on every pull request: no paths filter, and no ci-gate-docs.yml to stand in for it', () => {
	assert.ok(ciJobs.size >= 4, `found jobs ${[...ciJobs.keys()]}`);
	assert.doesNotMatch(ci.split(/^jobs:/m)[0], /^\s+paths(-ignore)?:/m);
	assert.ok(!workflows.some((w) => w.name === 'ci-gate-docs.yml'));
});

test('the Claude tooling guard runs on docs-only changes, and the CI gate needs every job', () => {
	const claude = ciJobs.get('claude-tooling') ?? '';
	assert.match(claude, /run: node scripts\/ci-guards\/check_claude_tooling\.mjs/);
	assert.doesNotMatch(claude, /^ {4}if:/m, 'claude-tooling must not be skipped by the changes job');
	const needs = /^ {4}needs: \[([^\]]*)\]/m.exec(ciJobs.get('ci-gate') ?? '')?.[1].split(',').map((s) => s.trim()) ?? [];
	assert.deepEqual([...needs].sort(), [...ciJobs.keys()].filter((id) => id !== 'ci-gate').sort());
});

// The pnpm store holds auth-kit's built package, and a fork's pull request can restore caches saved on main
// once the repo is public, so no workflow that installs auth-kit may cache the store: no `cache:` input on
// setup-node (or pnpm/action-setup), no actions/cache, no `pnpm store path` step (docs/deployment.md § Sign-in).
const installers = workflows.filter((w) => w.text.includes(SECRET));

test('a reusable workflow asks for no broad top-level permissions its callers would have to match', () => {
	// gitleaks.yml's top-level `read-all` exceeded gitleaks-sweep.yml's grant, so the weekly sweep never started.
	const reusable = workflows.filter((w) => /^\s+workflow_call:/m.test(w.text));
	assert.ok(reusable.some((w) => w.name === 'gitleaks.yml'), 'gitleaks.yml is reusable');
	for (const w of reusable) assert.doesNotMatch(w.text, /^permissions:\s*(read|write)-all\b/m, `${w.name}: top-level permissions must be scoped`);
});

test('terraform.yml runs only as a ci.yml job, so the required CI gate waits on it', () => {
	const tf = workflows.find((w) => w.name === 'terraform.yml').text;
	assert.doesNotMatch(tf, /^\s+(push|pull_request):/m, 'no own push/PR triggers (it would run twice and never gate)');
	assert.match(tf, /^\s+workflow_call:/m);
	const ci = workflows.find((w) => w.name === 'ci.yml').text;
	assert.match(ci, /\n {2}terraform:\n(?: {4}.*\n)*? {4}uses: \.\/\.github\/workflows\/terraform\.yml/);
	assert.match(ci, /\n {2}terraform:\n(?: {4}.*\n)*? {4}if: needs\.changes\.outputs\.infra == 'true'/);
	assert.match(ci, /\n {2}ci-gate:\n(?: {4}.*\n)*? {4}needs: \[[^\]]*\bterraform\b[^\]]*\]/);
});

test('no workflow that installs auth-kit caches the pnpm store', () => {
	assert.ok(installers.length >= 7, `found ${installers.map((w) => w.name)}`);
	for (const w of installers) {
		const code = w.text
			.split('\n')
			.filter((l) => !/^\s*#/.test(l))
			.join('\n');
		assert.doesNotMatch(code, /^\s+cache:/m, `${w.name}: a cache: input`);
		assert.doesNotMatch(code, /uses:\s*actions\/cache\b/, `${w.name}: actions/cache`);
		assert.doesNotMatch(code, /pnpm store path/, `${w.name}: reads the pnpm store path (to cache it)`);
	}
});

// The deploys run only after CI passed on the commit they ship: `workflow_run` of CI, completed, on main,
// gated on success + a push from this repo, checking out the commit CI tested; the gate script
// (scripts/deploy/deploy-gate.mjs, its own tests) decides whether the surface changed since the last
// successful deploy job, whose commit each run records in its run-name. docs/deployment.md § How a deploy happens.
/** Job ids of a workflow, each with the text of its block. */
function jobsOf(text) {
	return new Map(
		(text.split(/^jobs:\n/m)[1] ?? '')
			.split(/^(?= {2}[\w-]+:\n)/m)
			.map((block) => [/^ {2}([\w-]+):/.exec(block)?.[1], block])
			.filter(([id]) => id)
	);
}

const ciName = /^name: (.+)$/m.exec(ci)?.[1];
const RUN_SHA = '${{ github.event.workflow_run.head_sha || github.sha }}';

for (const [file, surface, deployJob, mustDeployOn] of [
	['deploy-backend.yml', 'backend', 'Update Lambda code', ['backend', 'packages/wrsm', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.github/workflows/deploy-backend.yml']],
	['deploy-frontend.yml', 'frontend', 'Deploy to S3 + CloudFront', ['frontend', 'packages/wrsm', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'infra/csp.json', 'infra/scripts/check-csp.mjs', '.github/workflows/deploy-frontend.yml']]
]) {
	const text = workflows.find((w) => w.name === file)?.text ?? '';
	const head = text.split(/^jobs:/m)[0];
	const jobs = jobsOf(text);

	test(`${file} triggers only on CI completing on main, or by hand`, () => {
		assert.equal(ciName, 'CI');
		const on = /^on:\n([\s\S]*?)^\S/m.exec(head)?.[1] ?? '';
		assert.match(on, /^ {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n {4}branches: \[main\]\n/m);
		assert.match(on, /^ {2}workflow_dispatch:/m);
		assert.doesNotMatch(on, /^ {2}(push|pull_request|pull_request_target):/m, 'a push trigger would deploy alongside CI, not after it');
		assert.ok(head.includes(`run-name: Deploy ${surface} ${RUN_SHA}`), 'the run-name records the commit (the gate reads it back)');
	});

	test(`${file}: the gate requires a successful CI run on a push to this repo's main, and checks out its commit`, () => {
		assert.deepEqual([...jobs.keys()], ['gate', 'build', 'deploy']);
		const gate = jobs.get('gate');
		for (const cond of [
			"github.event_name == 'workflow_dispatch'",
			"github.event.workflow_run.conclusion == 'success'",
			"github.event.workflow_run.event == 'push'",
			"github.event.workflow_run.head_branch == 'main'",
			'github.event.workflow_run.head_repository.full_name == github.repository',
			"vars.AWS_DEPLOY_ROLE_ARN != ''"
		])
			assert.ok(gate.includes(cond), `gate if: missing ${cond}`);
		assert.ok(gate.includes(`ref: ${RUN_SHA}`) && /fetch-depth: 0/.test(gate), 'the gate checks out the commit CI passed, with history');
		assert.match(gate, /run: node scripts\/deploy\/deploy-gate\.mjs/);
		assert.ok(gate.includes(`WORKFLOW_FILE: ${file}\n`) && gate.includes(`DEPLOY_JOB: ${deployJob}\n`) && gate.includes('CI_WORKFLOW: ci.yml\n'));
		assert.ok(gate.includes(`SHA: ${RUN_SHA}\n`));
		const paths = /DEPLOY_PATHS: \|\n((?: {12}\S.*\n)+)/
			.exec(gate)?.[1]
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		assert.deepEqual(paths, mustDeployOn);
		assert.match(gate, /actions: read/);
		assert.doesNotMatch(gate, /id-token|secrets\./, 'the gate mints no OIDC token and reads no secret');
	});

	test(`${file}: build waits for the gate and builds its commit; only the production deploy job mints a token`, () => {
		const build = jobs.get('build');
		assert.match(build, /^ {4}needs: gate\n {4}if: needs\.gate\.outputs\.deploy == 'true'\n/m);
		assert.ok(build.includes('ref: ${{ needs.gate.outputs.sha }}'));
		assert.doesNotMatch(build, /id-token/);
		const deploy = jobs.get('deploy');
		assert.match(deploy, new RegExp(`^ {4}name: ${deployJob.replace(/[+]/g, '\\+')}\n {4}needs: build\n`, 'm'), 'DEPLOY_JOB names this job');
		assert.match(deploy, /^ {4}environment: production$/m);
		assert.match(deploy, /id-token: write/);
	});
}
