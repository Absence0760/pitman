#!/usr/bin/env node
// The `gate` job of deploy-backend.yml and deploy-frontend.yml: decides whether a deploy runs, and refuses one
// that CI hasn't passed. Plain node, no install (it runs before `pnpm install`, with no secret but GITHUB_TOKEN).
//
// The deploys trigger on `workflow_run` of CI, so they start only after CI finished on a push to main; the
// workflow's job-level `if:` already requires that run to have succeeded. This script then answers "did this
// surface change since what is live?" by comparing the commit CI passed against the commit the last
// *successful deploy job* shipped, never against the push's before-SHA: CI cancels a superseded run on main
// (ci.yml's concurrency), and a reviewer may reject a deploy, so the previous commit is not necessarily what
// is live. Each run names its commit in its run-name ("Deploy backend <sha>"), which is how the last
// deployed commit is read back. A manual (workflow_dispatch) run always deploys, but only from main and only a
// commit with a successful CI run. docs/deployment.md § How a deploy happens.
//
// Env: GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_RUN_ID, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY (all set by Actions),
// EVENT (github.event_name), SHA (the commit to deploy), REF (github.ref, checked on a manual run),
// WORKFLOW_FILE (this workflow's file name), DEPLOY_JOB (the deploy job's name), CI_WORKFLOW (ci.yml),
// DEPLOY_PATHS (newline-separated path prefixes that make up this surface).
// Writes `deploy=true|false` and `sha=<commit>` to GITHUB_OUTPUT; exits 1 to refuse.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA_RE = /\b[0-9a-f]{40}\b/;

/** The commit a deploy run shipped, from its run-name ("Deploy backend <sha>"); null if it names none. */
export function shaOfRun(run) {
	return SHA_RE.exec(run?.display_title ?? '')?.[0] ?? null;
}

/** True when `file` is one of `prefixes` or lies under one (a prefix is a file or a directory, never a glob). */
export function inSurface(file, prefixes) {
	return prefixes.some((p) => file === p || file.startsWith(`${p.replace(/\/+$/, '')}/`));
}

/** The path prefixes from DEPLOY_PATHS: one per line, blanks and `#` comments ignored. */
export function parsePaths(text) {
	return (text ?? '')
		.split('\n')
		.map((l) => l.replace(/#.*/, '').trim())
		.filter(Boolean);
}

/**
 * The commit the last successful deploy job shipped, or null if this workflow has never deployed.
 * `api(path)` returns parsed JSON from the GitHub REST API. Runs come newest first.
 */
export async function lastDeployedSha({ api, repo, workflowFile, deployJob, currentRunId }) {
	for (let page = 1; page <= 5; page++) {
		const { workflow_runs: runs = [] } = await api(`/repos/${repo}/actions/workflows/${workflowFile}/runs?status=success&per_page=50&page=${page}`);
		for (const run of runs) {
			if (String(run.id) === String(currentRunId)) continue;
			const sha = shaOfRun(run);
			if (!sha) continue;
			const { jobs = [] } = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
			if (jobs.some((j) => j.name === deployJob && j.conclusion === 'success')) return sha;
		}
		if (runs.length < 50) break;
	}
	return null;
}

/** Whether CI (ciWorkflow) has a successful run on `sha`. */
export async function ciPassed({ api, repo, ciWorkflow, sha }) {
	const { total_count = 0, workflow_runs: runs = [] } = await api(`/repos/${repo}/actions/workflows/${ciWorkflow}/runs?head_sha=${sha}&status=success&per_page=1`);
	return total_count > 0 || runs.length > 0;
}

/**
 * The decision. `git(args)` runs git and returns { ok, out }.
 * Returns { deploy, reason } or throws an Error whose message is the refusal.
 */
export async function decide({ env, api, git }) {
	const repo = env.GITHUB_REPOSITORY;
	const sha = (env.SHA ?? '').trim();
	if (!SHA_RE.test(sha) || sha.length !== 40) throw new Error(`SHA is not a full commit id: "${sha}"`);
	const paths = parsePaths(env.DEPLOY_PATHS);
	if (paths.length === 0) throw new Error('DEPLOY_PATHS is empty');

	if (env.EVENT === 'workflow_dispatch') {
		if (env.REF !== 'refs/heads/main') throw new Error(`a manual deploy runs from main only (got ${env.REF})`);
		if (!(await ciPassed({ api, repo, ciWorkflow: env.CI_WORKFLOW, sha })))
			throw new Error(`CI has no successful run on ${sha}; wait for it (or re-run it) before deploying`);
		return { deploy: true, reason: `manual run: CI passed on ${sha}, deploying it` };
	}

	if (env.EVENT !== 'workflow_run') throw new Error(`unexpected event ${env.EVENT}`);
	const base = await lastDeployedSha({ api, repo, workflowFile: env.WORKFLOW_FILE, deployJob: env.DEPLOY_JOB, currentRunId: env.GITHUB_RUN_ID });
	if (!base) return { deploy: true, reason: 'no earlier successful deploy: deploying' };
	if (base === sha) return { deploy: false, reason: `${sha} is already live` };
	if (!git(['cat-file', '-e', `${base}^{commit}`]).ok)
		return { deploy: true, reason: `the live commit ${base} isn't in this history: deploying` };
	if (git(['merge-base', '--is-ancestor', sha, base]).ok)
		return { deploy: false, reason: `${sha} is older than the live ${base}: not rolling back (revert on main instead)` };
	const diff = git(['diff', '--name-only', base, sha]);
	if (!diff.ok) throw new Error(`git diff ${base} ${sha} failed`);
	const changed = diff.out.split('\n').filter((f) => f && inSurface(f, paths));
	return changed.length > 0
		? { deploy: true, reason: `${changed.length} file(s) changed since the live ${base}, e.g. ${changed.slice(0, 5).join(', ')}` }
		: { deploy: false, reason: `nothing under ${paths.join(', ')} changed since the live ${base}` };
}

function realGit(args) {
	try {
		return { ok: true, out: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
	} catch {
		return { ok: false, out: '' };
	}
}

function realApi(token) {
	return async (path) => {
		const res = await fetch(`https://api.github.com${path}`, {
			headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
		});
		if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status}`);
		return res.json();
	};
}

async function main() {
	const env = process.env;
	const sha = (env.SHA ?? '').trim();
	try {
		const { deploy, reason } = await decide({ env, api: realApi(env.GITHUB_TOKEN), git: realGit });
		console.log(`deploy=${deploy}: ${reason}`);
		if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `deploy=${deploy}\nsha=${sha}\n`);
		if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${deploy ? 'Deploying' : 'Not deploying'}: ${reason}\n`);
	} catch (err) {
		console.log(`::error::Deploy refused: ${err.message}`);
		process.exit(1);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
