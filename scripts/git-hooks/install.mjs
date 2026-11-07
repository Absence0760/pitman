#!/usr/bin/env node
// Points git at the repo's own hooks (.githooks/), run by the root `prepare`
// script on every `pnpm install`. docs/security.md § Public repo hygiene.
//
// Before this the hooks depended on a manual `pre-commit install` and a
// hand-copied pre-push (`cp ... .git/hooks/pre-push`), per clone. Nothing ran
// them for a new checkout, so a commit could reach main without meeting the
// client terms guard (CLAUDE.md rule 2). Ported from project-water-management,
// where exactly that happened.
//
// core.hooksPath goes in the repository's config, which every linked worktree
// shares; the relative path resolves in each worktree's own root, so each
// runs the hooks of the branch it has checked out.
//
// It never fails an install: outside a git checkout, in CI, or when
// core.hooksPath already names somewhere else (your own hooks), it only says
// so and leaves the config alone.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS_PATH = '.githooks';

/** What to do given the current core.hooksPath. @param {string | null} current @param {boolean} ci */
export function decide(current, ci) {
	if (ci) return 'skip-ci';
	if (current === HOOKS_PATH) return 'already';
	if (current) return 'foreign';
	return 'set';
}

function main() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
	const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	try {
		if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return;
	} catch {
		return; // not a git checkout (a tarball, a container build)
	}
	let current = null;
	try {
		current = git(['config', '--get', 'core.hooksPath']) || null;
	} catch {
		// unset
	}
	const action = decide(current, Boolean(process.env.CI));
	if (action === 'set') {
		git(['config', 'core.hooksPath', HOOKS_PATH]);
		console.log(`git hooks: core.hooksPath set to ${HOOKS_PATH} (client terms guard on every commit).`);
	} else if (action === 'foreign') {
		console.warn(`git hooks: core.hooksPath is ${current}, not ${HOOKS_PATH}; left alone, so this repo's hooks (the client terms guard) don't run. docs/security.md § Public repo hygiene.`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (e) {
		console.warn(`git hooks: not installed (${e.message}).`);
	}
}
