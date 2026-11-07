#!/usr/bin/env node
// No farm, client or place name that identifies a client study enters the
// repo (CLAUDE.md rule 2, docs/security.md § Public repo hygiene).
//
// The list of those terms names the clients itself, so it lives OUTSIDE the
// repo, in the private infra-secrets repo:
//
//   ../infra-secrets/pitman/client-terms.txt   (or $CLIENT_TERMS_FILE)
//
// "../" is next to this checkout, or, in a linked git worktree, next to the
// main checkout: a worktree under .claude/worktrees/ has no infra-secrets
// beside it.
//
// One term per line; `#` starts a comment. Matching ignores case, and a space
// in a term also matches "", "_", "-", or a line break plus comment markers,
// so "Some River" catches "SomeRiver", "some-river" and a name split across a
// comment line. A term only matches as a whole word (no letter or digit on
// either side).
//
// Without the terms file the guard is a no-op (a fresh clone, CI, anyone
// outside the project), so it never blocks work, it just cannot check: the
// hook modes (--staged, --message) say nothing at all, the full and history
// scans print one line saying they skipped.
//
// It never prints a matched term or the line's text, only the file, the line
// and the term's number in the list: a CI log is as public as the repo. A
// term inside a reported path is replaced with `[term #N]`.
//
// Every tracked file is scanned, docs/formats/examples/ included: its
// byte-exact WRSM2000 files are synthetic and must stay so.
//
// Run:   pnpm check:terms                  (every tracked file and path)
//        node scripts/ci-guards/check_client_terms.mjs --staged      (pre-commit)
//        node scripts/ci-guards/check_client_terms.mjs --message <f> (commit-msg)
//        node scripts/ci-guards/check_client_terms.mjs --history     (all refs)
// Tests: node --test scripts/ci-guards/check_client_terms.test.mjs (pnpm test:tools)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TERMS_PATH = '../infra-secrets/pitman/client-terms.txt';
export const DEFAULT_TERMS_FILE = resolve(ROOT, TERMS_PATH);

/**
 * Where the terms file may be: beside this checkout, then beside the main
 * checkout that a linked worktree belongs to (the parent of the shared .git).
 * @param {string} root @param {string | null} commonDir absolute git common dir
 */
export function termsFileCandidates(root, commonDir) {
	const out = [resolve(root, TERMS_PATH)];
	if (commonDir) out.push(resolve(dirname(commonDir), TERMS_PATH));
	return [...new Set(out)];
}

function gitCommonDir() {
	try {
		return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
	} catch {
		return null;
	}
}

/** @param {string} text */
export function parseTerms(text) {
	return text
		.split(/\r?\n/)
		.map((l) => l.replace(/#.*$/, '').trim())
		.filter(Boolean);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One case-insensitive, whole-word pattern per term. @param {string[]} terms */
export function compileTerms(terms) {
	return terms.map((t) => {
		const body = t.split(/\s+/).map(escape).join('(?:[\\s_-]|\\n[\\s#/*>-]*)*');
		return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
	});
}

/**
 * Findings in one text: which term matched on which line. The text is never
 * returned. @param {string} text @param {RegExp[]} patterns
 * @returns {{ line: number, term: number }[]}
 */
export function scanText(text, patterns) {
	const out = [];
	patterns.forEach((re, i) => {
		re.lastIndex = 0;
		for (const m of text.matchAll(re)) {
			out.push({ line: text.slice(0, m.index).split('\n').length, term: i + 1 });
		}
	});
	return out.sort((a, b) => a.line - b.line || a.term - b.term);
}

/**
 * Added lines of a unified diff, keyed by file and new-file line number.
 * @param {string} diff @returns {Map<string, { line: number, text: string }[]>}
 */
export function addedLines(diff) {
	const files = new Map();
	let file = null;
	let line = 0;
	for (const l of diff.split('\n')) {
		if (l.startsWith('+++ ')) {
			file = l === '+++ /dev/null' ? null : l.slice(6);
			if (file && !files.has(file)) files.set(file, []);
		} else if (l.startsWith('@@')) {
			line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
		} else if (file && l.startsWith('+')) {
			files.get(file).push({ line, text: l.slice(1) });
			line++;
		} else if (!l.startsWith('-') && !l.startsWith('\\')) {
			line++;
		}
	}
	return files;
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 });

/**
 * The text with every term replaced by `[term #N]`: a path that contains a
 * term is reported this way, so the report never prints the term itself.
 * @param {string} text @param {RegExp[]} patterns
 */
export function redact(text, patterns) {
	return patterns.reduce((s, re, i) => s.replace(re, `[term #${i + 1}]`), text);
}

function report(findings, what, patterns) {
	const loc = (f) => {
		const file = redact(f.file, patterns);
		return f.line ? `file=${file},line=${f.line}` : `file=${file}`;
	};
	for (const f of findings) console.error(`::error ${loc(f)}::client term #${f.term} from the terms file`);
	if (findings.length) {
		console.error(`${findings.length} client-term finding(s) in ${what}. Terms are deliberately not printed; see docs/security.md § Public repo hygiene.`);
		process.exit(1);
	}
	console.log(`Client terms OK (${what}).`);
}

function main() {
	const args = process.argv.slice(2);
	const candidates = process.env.CLIENT_TERMS_FILE ? [process.env.CLIENT_TERMS_FILE] : termsFileCandidates(ROOT, gitCommonDir());
	const termsFile = candidates.find((f) => existsSync(f));
	const hookMode = args[0] === '--staged' || args[0] === '--message';
	if (!termsFile) {
		if (!hookMode) console.log(`No client terms file at ${candidates.join(' or ')}; skipping (see docs/security.md § Public repo hygiene).`);
		return;
	}
	const patterns = compileTerms(parseTerms(readFileSync(termsFile, 'utf8')));
	if (!patterns.length) {
		if (!hookMode) console.log('Client terms file is empty; nothing to check.');
		return;
	}
	const findings = [];
	const scanPath = (p) => scanText(p, patterns).forEach((f) => findings.push({ file: p, term: f.term }));

	if (args[0] === '--message') {
		const msg = readFileSync(args[1], 'utf8').replace(/^#.*$/gm, '');
		scanText(msg, patterns).forEach((f) => findings.push({ ...f, file: '(commit message)' }));
		return report(findings, 'the commit message', patterns);
	}
	if (args[0] === '--staged') {
		for (const p of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean)) scanPath(p);
		for (const [file, lines] of addedLines(git(['diff', '--cached', '-U0', '--no-color', '--text']))) {
			// Join consecutive added lines so a term split across two lines still matches.
			const text = lines.map((l) => l.text).join('\n');
			for (const f of scanText(text, patterns)) findings.push({ file, line: lines[f.line - 1].line, term: f.term });
		}
		return report(findings, 'staged changes', patterns);
	}
	if (args[0] === '--history') {
		for (const f of scanText(git(['log', '--all', '--format=%B']), patterns)) findings.push({ file: '(commit messages, all refs)', term: f.term });
		for (const f of scanText(git(['log', '--all', '-p', '--text', '--format=', '--no-color']), patterns)) findings.push({ file: '(diffs, all refs)', term: f.term });
		for (const p of new Set(git(['log', '--all', '--format=', '--name-only']).split('\n').filter(Boolean))) scanPath(p);
		return report(findings, 'the history of every ref', patterns);
	}
	const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
	for (const p of tracked) {
		scanPath(p);
		const abs = resolve(ROOT, p);
		const buf = existsSync(abs) ? readFileSync(abs) : null;
		if (buf && !buf.includes(0)) scanText(buf.toString('utf8'), patterns).forEach((f) => findings.push({ file: p, ...f }));
	}
	report(findings, `${tracked.length} tracked files`, patterns);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
