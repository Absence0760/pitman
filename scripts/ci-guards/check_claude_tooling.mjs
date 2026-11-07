#!/usr/bin/env node
// The Claude agents and commands stay true to this repo.
//
// `.claude/` started as the templates repo's scaffolding, and its gate agents
// described another app (a payment processor, a CMS, an email service, SQL
// migrations) while every /check ran them: nothing failed when an agent named
// a path or a rule the repo didn't have. This guard is that failure (ported
// from project-water-management's scripts/guards/). It asserts that:
//
//   1. every agent (.claude/agents/**/*.md), command (.claude/commands/**/*.md)
//      and skill (.claude/skills/*/SKILL.md) opens with a frontmatter block
//      that has a `description:`, and every
//      agent a `name:` equal to its file name, unique across the tree
//      (Claude Code finds agents by that name, not by path);
//   2. no template placeholder survives (`<CMS>`, `the migrations directory`,
//      `your migration runner`, …): each one means an agent was never adapted;
//   3. every repo path an agent, a command, a skill, `.claude/README.md` or `CLAUDE.md`
//      cites in backticks exists (a path with a placeholder or a glob in it is
//      a pattern, not a citation, and is skipped).
//
// Run:   pnpm check:claude
// CI:    ci.yml, job `claude-tooling` (runs on docs-only PRs too).
// Tests: pnpm test:tools (scripts/ci-guards/check_claude_tooling.test.mjs)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{ file: string, line?: number, rule: string }} Finding */

/** Template leftovers: text that only makes sense before a project adapts the file. */
export const PLACEHOLDERS = [
	/<payment-processor>/i,
	/<CMS>/,
	/<cms-client>/i,
	/<email-service>/i,
	/<EMAIL_SERVICE>/,
	/<aws-region>/i,
	/<hosted-worker-platform>/i,
	/<backend-framework>/i,
	/the migrations directory/i,
	/your migration runner/i,
	/the backend types file/i,
	/the frontend API types file/i,
	/the smoke test directory/i,
	/the account-deletion backend route/i,
	/the data-export worker/i,
	/app\.current_org_id/,
	/\btenantQuery\b/,
	/`studio\//,
];

/** Top-level entries a backticked token must start with to count as a repo path. */
const PATH_ROOTS = /^(?:backend|frontend|packages|docs|scripts|infra|\.github|\.claude)\/|^(?:CLAUDE\.md|README\.md|SECURITY\.md|CONTRIBUTING\.md|SUPPORT\.md|package\.json|pnpm-workspace\.yaml|docker-compose\.ya?ml|\.tool-versions|\.gitignore|\.pre-commit-config\.yaml)$/;
/** A token with any of these is a pattern or an example, not a citation. */
const PATTERN = /[<>*{}$…]|NNN|\s|\.\.\./;
/**
 * Outputs, git-ignored inputs and throwaway files an agent is told to create and delete (`zz-` specs), so they may
 * rightly be absent; and the git-ignored local secret files (`.env`, `terraform.tfvars`, `backend.config`) an audit
 * names to check they never reach git.
 */
const NOT_TRACKED =
	/^(?:reviews\/|frontend\/build|frontend\/\.svelte-kit|backend\/dist|backend\/\.local|frontend\/e2e\/zz-)|^(?:backend|frontend)\/\.env(?:\.[\w-]+\.local)?$|^infra\/(?:terraform\.tfvars|backend\.config)$/;

/**
 * @param {string} text
 * @returns {{ fields: Map<string, string>, body: string, bodyLine: number } | null}
 */
export function parseFrontmatter(text) {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
	if (!m) return null;
	const fields = new Map();
	for (const line of m[1].split('\n')) {
		const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (kv) fields.set(kv[1], kv[2].trim());
	}
	return { fields, body: text.slice(m[0].length), bodyLine: m[0].split('\n').length };
}

/**
 * Backticked tokens that look like repo paths, with their line numbers.
 * `file:12`, `file § Heading` and a trailing `/` are trimmed to the path.
 * @param {string} text
 */
export function citedPaths(text) {
	/** @type {{ path: string, line: number }[]} */
	const out = [];
	text.split('\n').forEach((lineText, i) => {
		for (const [, raw] of lineText.matchAll(/`([^`\n]+)`/g)) {
			let token = raw.trim().replace(/\s+§.*$/, '').replace(/:\d+(?:-\d+)?$/, '');
			if (PATTERN.test(token) || !PATH_ROOTS.test(token)) continue;
			token = token.replace(/\/$/, '');
			if (NOT_TRACKED.test(token)) continue;
			out.push({ path: token, line: i + 1 });
		}
	});
	return out;
}

/**
 * @param {string} file repo-relative
 * @param {string} text
 * @param {'agent' | 'command' | 'doc'} kind
 * @param {(path: string) => boolean} exists
 * @returns {Finding[]}
 */
export function checkFile(file, text, kind, exists) {
	/** @type {Finding[]} */
	const out = [];
	if (kind !== 'doc') {
		const fm = parseFrontmatter(text);
		if (!fm) {
			out.push({ file, line: 1, rule: 'no frontmatter block (--- … ---) at the top' });
		} else {
			if (!fm.fields.get('description')) out.push({ file, line: 1, rule: 'frontmatter has no description' });
			if (kind === 'agent') {
				const want = basename(file, '.md');
				const name = fm.fields.get('name');
				if (!name) out.push({ file, line: 1, rule: 'agent frontmatter has no name' });
				else if (name !== want) out.push({ file, line: 1, rule: `agent name "${name}" does not match its file name "${want}"` });
			}
		}
	}
	text.split('\n').forEach((lineText, i) => {
		for (const re of PLACEHOLDERS) {
			if (re.test(lineText)) out.push({ file, line: i + 1, rule: `template placeholder ${re} was never replaced with this repo's real name` });
		}
	});
	for (const { path, line } of citedPaths(text)) {
		if (!exists(path)) out.push({ file, line, rule: `cites \`${path}\`, which does not exist` });
	}
	return out;
}

/** @param {string} dir absolute */
function markdownUnder(dir) {
	/** @type {string[]} */
	const out = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...markdownUnder(full));
		else if (entry.endsWith('.md')) out.push(full);
	}
	return out;
}

/**
 * @param {string} root absolute repo root
 * @returns {Finding[]}
 */
export function checkRepo(root) {
	const exists = (/** @type {string} */ p) => existsSync(join(root, p));
	/** @type {Finding[]} */
	const out = [];
	/** @type {Map<string, string>} */
	const names = new Map();
	for (const full of markdownUnder(join(root, '.claude/agents'))) {
		const file = relative(root, full);
		const kind = basename(file) === 'README.md' ? 'doc' : 'agent';
		const text = readFileSync(full, 'utf8');
		out.push(...checkFile(file, text, kind, exists));
		if (kind === 'agent') {
			const name = parseFrontmatter(text)?.fields.get('name');
			if (name && names.has(name)) out.push({ file, line: 1, rule: `agent name "${name}" is also used by ${names.get(name)}` });
			if (name) names.set(name, file);
		}
	}
	for (const full of markdownUnder(join(root, '.claude/commands'))) {
		const file = relative(root, full);
		out.push(...checkFile(file, readFileSync(full, 'utf8'), basename(file) === 'README.md' ? 'doc' : 'command', exists));
	}
	for (const full of markdownUnder(join(root, '.claude/skills'))) {
		const file = relative(root, full);
		out.push(...checkFile(file, readFileSync(full, 'utf8'), basename(file) === 'SKILL.md' ? 'command' : 'doc', exists));
	}
	for (const file of ['.claude/README.md', '.claude/personas/README.md', 'CLAUDE.md']) {
		if (exists(file)) out.push(...checkFile(file, readFileSync(join(root, file), 'utf8'), 'doc', exists));
	}
	return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = fileURLToPath(new URL('../..', import.meta.url));
	const findings = checkRepo(root);
	for (const f of findings) console.error(`${f.file}${f.line ? `:${f.line}` : ''}: ${f.rule}`);
	if (findings.length) {
		console.error(`\n${findings.length} problem(s) in the Claude tooling. Fix the agent or command, not this guard (.claude/README.md § Adding or changing an agent).`);
		process.exit(1);
	}
	console.log('Claude tooling OK.');
}
