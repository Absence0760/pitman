#!/usr/bin/env node
// Guard for the root package.json `scripts` block (CLAUDE.md § "Root package.json scripts", which requires
// a `test:scripts` guard). Ported from project-water-management's and threkir's check_root_scripts.mjs and
// written against pitman's own shapes:
//
//   pnpm --filter @pitman/x [--filter …] [--parallel] run y   each named package declares `y`
//   pnpm --filter @pitman/x                                   a workspace alias: the package exists
//   pnpm -C backend exec tsx scripts/foo.ts                   backend/scripts/foo.ts exists
//   pnpm -r [--no-bail] run y                                 at least one workspace declares `y`
//   pnpm y                                                    the root declares `y`
//   node scripts/x.mjs / node --test a/*.test.mjs b/…         every file exists, every glob matches
//   docker compose up -d --wait dynamodb mailpit              docker-compose.yml declares each service
//
// and the format:
//
//   - the block opens with a `//-- <group> --` divider, and every divider has a description;
//   - no divider is empty;
//   - every script's first name segment is its group's first word (`dev:auth:up` under `//-- dev: sign-in --`,
//     `check:env` under `//-- check --`), except the `//-- workspaces --` group, which holds only bare
//     `pnpm --filter <package>` aliases;
//   - no script is named after one of pnpm's own commands (pnpm runs its command, never the script).
//
// A command it does not know how to read is reported as unverifiable, never silently passed, and a manifest
// that gives it nothing to verify fails (threkir's "--filter made it check nothing" lesson).
//
// Run:   pnpm test:scripts      (part of `pnpm test:tools`, which CI's `test` job runs)
// Tests: node --test scripts/ci-guards/root-scripts.test.mjs
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** @typedef {{ name?: string, scripts?: Record<string, string> }} Manifest */
/**
 * @typedef {object} Tree
 * @property {readonly string[]} workspaceDirs repo-relative workspace directories
 * @property {(dir: string) => Manifest | null} readManifest repo-relative dir -> its package.json
 * @property {(path: string) => boolean} exists repo-relative path
 * @property {(pattern: string) => number} globCount repo-relative glob -> number of matches
 * @property {readonly string[] | null} composeServices docker-compose.yml's services, null when absent
 */

export const isDivider = (/** @type {string} */ name) => name.startsWith('//');

/** pnpm 10's own commands, less the ones that run the script of their name (test, start, restart, stop). */
export const PNPM_COMMANDS = new Set(
	'add approve-builds audit bin cache cat-file cat-index config create dedupe deploy dlx doctor env exec fetch find-hash get help i ignored-builds import init install install-test la licenses link list ll ls outdated pack patch patch-commit patch-remove prune publish rebuild recursive remove rm root run self-update server set setup store unlink up update why'.split(
		' '
	)
);

/** The group whose entries are workspace aliases (`pnpm frontend <script>`), not verb-first scripts. */
export const ALIAS_GROUP = 'workspaces';

/**
 * Split a script into commands, each a list of words, the way a shell would for the subset root scripts
 * use: `&&`, `||`, `;`, `|` and `&` separate commands; single and double quotes group; a backslash escapes.
 * @param {string} cmd
 * @returns {string[][]}
 */
export function splitCommands(cmd) {
	/** @type {string[][]} */
	const commands = [];
	/** @type {string[]} */
	let words = [];
	let word = null;
	/** @type {string | null} */
	let quote = null;
	const endWord = () => {
		if (word !== null) words.push(word);
		word = null;
	};
	const endCommand = () => {
		endWord();
		if (words.length) commands.push(words);
		words = [];
	};
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (c === '\\' && quote === '"' && i + 1 < cmd.length) word += cmd[++i];
			else word += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			word ??= '';
		} else if (c === '\\' && i + 1 < cmd.length) {
			word = (word ?? '') + cmd[++i];
		} else if (/\s/.test(c)) {
			endWord();
		} else if (c === ';' || c === '|' || c === '&') {
			if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
			endCommand();
		} else {
			word = (word ?? '') + c;
		}
	}
	if (quote) throw new Error(`unterminated ${quote} quote`);
	endCommand();
	return commands;
}

/** pnpm options that take a value, so the next word is that value, not the subcommand. */
const PNPM_VALUE_OPTIONS = new Set(['-C', '--dir', '--filter', '-F', '--reporter', '--workspace-concurrency']);
/** docker compose's global options that take a value (before the subcommand: there `-f` is `--file`). */
const COMPOSE_GLOBAL_VALUE_OPTIONS = new Set(['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory']);
/** Subcommand options that take a value (after it: there `-f` is `logs --follow`, a switch). */
const COMPOSE_SUB_VALUE_OPTIONS = new Set(['-t', '--timeout', '--wait-timeout', '--tail', '--since', '--until']);

const looksLikeFile = (/** @type {string} */ w) => /\.(m?[jt]s|cjs|json)$/.test(w) && !w.startsWith('-');
const isGlob = (/** @type {string} */ w) => /[*?[{]/.test(w);
const isDynamic = (/** @type {string} */ w) => w.includes('$');

/**
 * @param {Manifest} manifest the root package.json
 * @param {Tree} tree
 * @returns {{ errors: string[], ok: string[], unverifiable: string[], scriptCount: number }}
 */
export function checkRootScripts(manifest, tree) {
	/** @type {string[]} */ const errors = [];
	/** @type {string[]} */ const ok = [];
	/** @type {string[]} */ const unverifiable = [];
	const scripts = manifest.scripts ?? {};

	/** @type {Map<string, string>} */
	const packageDirs = new Map();
	for (const dir of tree.workspaceDirs) {
		const name = tree.readManifest(dir)?.name;
		if (name) packageDirs.set(name, dir);
	}

	// ── format ────────────────────────────────────────────────────────────────
	const entries = Object.entries(scripts);
	/** @type {string | null} */
	let group = null;
	let groupSize = 0;
	const closeGroup = () => {
		if (group !== null && groupSize === 0) errors.push(`"${group}" is an empty group`);
	};
	for (const [name, value] of entries) {
		if (isDivider(name)) {
			closeGroup();
			const m = name.match(/^\/\/-- ([a-z][a-z0-9:, -]*[a-z0-9]) --$/);
			if (!m) errors.push(`"${name}": a divider is written "//-- <group> --" (lower-case group name)`);
			if (typeof value !== 'string' || value.trim() === '') errors.push(`"${name}": a divider needs a one-line description`);
			group = m ? m[1] : name;
			groupSize = 0;
			continue;
		}
		groupSize++;
		if (PNPM_COMMANDS.has(name)) errors.push(`${name}: pnpm's own \`${name}\` command shadows this script, so \`pnpm ${name}\` never runs it`);
		if (group === null) {
			errors.push(`${name}: not under a "//-- <group> --" divider`);
			continue;
		}
		if (group === ALIAS_GROUP) {
			const words = safeSplit(value);
			const alias = words?.length === 1 && words[0].length === 3 && words[0][0] === 'pnpm' && /^(--filter|-F)$/.test(words[0][1]);
			if (!alias) errors.push(`${name}: the "${ALIAS_GROUP}" group holds only \`pnpm --filter <package>\` aliases`);
			continue;
		}
		const groupWord = group.split(/[: ,]/)[0];
		const scriptWord = name.split(':')[0];
		if (scriptWord !== groupWord) errors.push(`${name}: sits in the "${group}" group, but its name does not start with "${groupWord}"`);
	}
	closeGroup();

	// ── targets ───────────────────────────────────────────────────────────────
	/**
	 * @param {string} script
	 * @param {string} dir '' for the root
	 * @param {string} target
	 */
	const checkTarget = (script, dir, target) => {
		const label = dir === '' ? 'the root package.json' : `${dir}/package.json`;
		const child = dir === '' ? manifest : tree.readManifest(dir);
		if (!child) return void errors.push(`${script}: no ${dir}/package.json`);
		if (!(target in (child.scripts ?? {}))) return void errors.push(`${script}: ${label} has no "${target}" script`);
		ok.push(`${script}: ${label} declares "${target}"`);
	};
	/** @param {string} script @param {string} path repo-relative */
	const checkPath = (script, path) => {
		if (isDynamic(path)) return void unverifiable.push(`${script}: \`${path}\` is decided at run time`);
		if (normalize(path).startsWith('..')) return void errors.push(`${script}: ${path} is outside the repository`);
		if (isGlob(path)) {
			if (tree.globCount(path) === 0) errors.push(`${script}: ${path} matches no file`);
			else ok.push(`${script}: ${path} matches`);
			return;
		}
		if (!tree.exists(path)) errors.push(`${script}: missing file ${path}`);
		else ok.push(`${script}: ${path} exists`);
	};

	let scriptCount = 0;
	for (const [script, cmd] of entries) {
		if (isDivider(script)) continue;
		scriptCount++;
		const commands = safeSplit(cmd);
		if (commands === null) {
			errors.push(`${script}: unreadable shell`);
			continue;
		}
		for (const words of commands) {
			const [bin] = words;
			if (bin === 'pnpm') checkPnpm(script, words);
			else if (bin === 'node') checkNode(script, words);
			else if (bin === 'docker' && words[1] === 'compose') checkCompose(script, words);
			else unverifiable.push(`${script}: \`${bin}\` is not a command this guard reads`);
		}
	}

	/** @param {string} script @param {string[]} words */
	function checkPnpm(script, words) {
		/** @type {string | null} */ let dir = null;
		/** @type {string[]} */ const filters = [];
		let recursive = false;
		/** @type {string[]} */ const positional = [];
		for (let i = 1; i < words.length; i++) {
			const w = words[i];
			// Everything after the subcommand belongs to it (`exec tsx scripts/x.ts`, `run y --flag`).
			if (positional.length && (positional[0] === 'exec' || positional.length >= (positional[0] === 'run' ? 2 : 1))) {
				positional.push(w);
				continue;
			}
			if (!w.startsWith('-')) {
				positional.push(w);
				continue;
			}
			const eq = w.indexOf('=');
			const flag = eq > 0 ? w.slice(0, eq) : w;
			const value = eq > 0 ? w.slice(eq + 1) : PNPM_VALUE_OPTIONS.has(flag) ? words[++i] : null;
			if (flag === '-C' || flag === '--dir') dir = value ?? null;
			else if (flag === '--filter' || flag === '-F') {
				if (value) filters.push(value);
			} else if (flag === '-r' || flag === '--recursive') recursive = true;
		}

		/** @type {string[] | null} the package dirs the command runs in; null = recursive */
		let dirs;
		if (dir !== null) {
			if (isDynamic(dir)) return void unverifiable.push(`${script}: \`pnpm -C ${dir}\` is decided at run time`);
			dirs = [normalize(dir)];
		} else if (filters.length) {
			dirs = [];
			for (const f of filters) {
				const d = packageDirs.get(f);
				if (d === undefined) errors.push(`${script}: \`--filter ${f}\` names no workspace package (${[...packageDirs.keys()].join(', ')})`);
				else dirs.push(d);
			}
			if (dirs.length !== filters.length) return;
		} else if (recursive) dirs = null;
		else dirs = [''];

		const [verb, ...rest] = positional;
		if (verb === undefined) {
			if (filters.length && dirs) for (const d of dirs) ok.push(`${script}: alias for the workspace in ${d}`);
			else unverifiable.push(`${script}: \`pnpm\` with nothing to run`);
			return;
		}
		if (verb === 'exec') {
			const files = rest.slice(1).filter(looksLikeFile);
			if (!files.length) return void unverifiable.push(`${script}: \`pnpm exec ${rest[0] ?? ''}\` names no file`);
			if (dirs === null) return void unverifiable.push(`${script}: \`pnpm -r exec\` runs in every workspace`);
			for (const d of dirs) for (const f of files) checkPath(script, d === '' ? f : `${d}/${f}`);
			return;
		}
		const target = verb === 'run' ? rest[0] : verb;
		if (target === undefined) return void unverifiable.push(`${script}: \`pnpm run\` with no script`);
		if (verb !== 'run' && PNPM_COMMANDS.has(target)) return void unverifiable.push(`${script}: \`pnpm ${target}\` is pnpm's own command, not a script`);
		if (dirs === null) {
			const declaring = tree.workspaceDirs.filter((d) => target in (tree.readManifest(d)?.scripts ?? {}));
			if (!declaring.length) errors.push(`${script}: \`pnpm -r run ${target}\` reaches no workspace (none declares "${target}")`);
			else ok.push(`${script}: "${target}" is declared in ${declaring.join(', ')}`);
			return;
		}
		for (const d of dirs) checkTarget(script, d, target);
	}

	/** @param {string} script @param {string[]} words */
	function checkNode(script, words) {
		const args = words.slice(1);
		if (args.includes('--test')) {
			const files = args.filter((w) => !w.startsWith('-'));
			if (!files.length) return void unverifiable.push(`${script}: \`node --test\` with no file list runs node's default discovery`);
			for (const f of files) checkPath(script, f);
			return;
		}
		const entry = args.find((w) => !w.startsWith('-'));
		if (entry === undefined) return void unverifiable.push(`${script}: \`node\` with no entry file`);
		checkPath(script, entry);
	}

	/** @param {string} script @param {string[]} words */
	function checkCompose(script, words) {
		if (tree.composeServices === null) return void errors.push(`${script}: runs docker compose, but there is no docker-compose.yml`);
		const positional = [];
		for (let i = 2; i < words.length; i++) {
			const w = words[i];
			if (w.startsWith('-')) {
				if ((positional.length ? COMPOSE_SUB_VALUE_OPTIONS : COMPOSE_GLOBAL_VALUE_OPTIONS).has(w)) i++;
				continue;
			}
			positional.push(w);
		}
		const [sub, ...services] = positional;
		if (sub === undefined) return void unverifiable.push(`${script}: \`docker compose\` with no subcommand`);
		ok.push(`${script}: docker compose ${sub}`);
		for (const s of services) {
			if (tree.composeServices.includes(s)) ok.push(`${script}: docker-compose.yml declares "${s}"`);
			else errors.push(`${script}: docker-compose.yml has no "${s}" service`);
		}
	}

	if (scriptCount === 0) errors.push('the root package.json declares no scripts, so nothing was checked');
	else if (ok.length === 0) errors.push(`verified nothing across ${scriptCount} root scripts: every command changed shape, or this guard stopped reading them`);
	return { errors, ok, unverifiable, scriptCount };
}

/** @param {unknown} cmd */
function safeSplit(cmd) {
	if (typeof cmd !== 'string') return null;
	try {
		return splitCommands(cmd);
	} catch {
		return null;
	}
}

/**
 * The workspace directories pnpm-workspace.yaml lists, with `dir/*` expanded through `listDirs`.
 * @param {string} yaml
 * @param {(pattern: string) => string[]} expand
 */
export function workspaceDirs(yaml, expand) {
	const block = yaml.match(/^packages:\s*\n((?:\s+-.*\n?)+)/m);
	if (!block) return [];
	const dirs = [];
	for (const m of block[1].matchAll(/^\s+-\s*['"]?([^'"\s#]+)['"]?/gm)) dirs.push(...(isGlob(m[1]) ? expand(m[1]) : [m[1]]));
	return dirs;
}

/** Top-level service names in a docker-compose file (two-space-indented keys under `services:`). */
export function composeServices(/** @type {string} */ yaml) {
	const block = yaml.match(/^services:\s*\n([\s\S]*?)(?=^\S|(?![\s\S]))/m);
	if (!block) return [];
	return [...block[1].matchAll(/^ {2}([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]);
}

/** The real tree, rooted at `root`. */
export function repoTree(root = ROOT) {
	/** @type {Map<string, Manifest | null>} */
	const cache = new Map();
	const compose = join(root, 'docker-compose.yml');
	return {
		workspaceDirs: workspaceDirs(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'), (p) =>
			globSync(p, { cwd: root }).filter((d) => existsSync(join(root, d, 'package.json')))
		),
		readManifest: (/** @type {string} */ dir) => {
			if (!cache.has(dir)) {
				const file = join(root, dir, 'package.json');
				cache.set(dir, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
			}
			return cache.get(dir) ?? null;
		},
		exists: (/** @type {string} */ p) => existsSync(join(root, p)),
		globCount: (/** @type {string} */ p) => globSync(p, { cwd: root }).length,
		composeServices: existsSync(compose) ? composeServices(readFileSync(compose, 'utf8')) : null,
	};
}

function main() {
	const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
	const { errors, ok, unverifiable, scriptCount } = checkRootScripts(manifest, repoTree());
	for (const line of unverifiable) console.warn(`[skip] ${line}`);
	for (const line of errors) console.error(`  - ${line}`);
	if (errors.length) {
		console.error(`Root scripts check failed (${errors.length} issue${errors.length === 1 ? '' : 's'}).`);
		return 1;
	}
	console.log(`Root scripts OK: ${ok.length} claims verified across ${scriptCount} scripts${unverifiable.length ? `, ${unverifiable.length} commands unverifiable` : ''}.`);
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
