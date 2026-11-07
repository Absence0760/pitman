// Tests for the client terms guard (node:test, `pnpm test:tools`). Synthetic terms only: the real list
// lives outside the repo (docs/security.md § Public repo hygiene).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addedLines, compileTerms, parseTerms, redact, scanText, termsFileCandidates } from './check_client_terms.mjs';

const patterns = compileTerms(parseTerms('# invented client\nMadeup River\nFakefarm  # a farm\n\n'));

test('parseTerms drops comments and blank lines', () => {
	assert.deepEqual(parseTerms('# c\nMadeup River\n  Fakefarm  # farm\n\n'), ['Madeup River', 'Fakefarm']);
});

test('a spaced term matches every spelling a rename produces', () => {
	for (const s of ['Madeup River', 'madeup river', 'MadeupRiver', 'madeup-river', 'madeup_river', 'data/madeupriver/x.json', "MadeupRiver's"]) {
		assert.equal(scanText(s, patterns).length, 1, s);
	}
});

test('a term split across a comment line break still matches', () => {
	assert.deepEqual(scanText('// plus the Madeup\n// River network', patterns), [{ line: 1, term: 1 }]);
	assert.deepEqual(scanText('# the Madeup\n# River', patterns), [{ line: 1, term: 1 }]);
});

test('a CRLF file (the byte-exact WRSM2000 examples) matches like any other', () => {
	assert.deepEqual(scanText('ROUTE 1  \r\nMadeup\r\nRiver  \r\nFakefarm\r\n', patterns), [
		{ line: 2, term: 1 },
		{ line: 4, term: 2 },
	]);
});

test('whole words only, with the line and term number of each hit', () => {
	assert.deepEqual(scanText('Fakefarms and unFakefarm and Fakefarm2', patterns), []);
	assert.deepEqual(scanText('ok\nFakefarm!Z17 = 1\nMadeup River, Fakefarm', patterns), [
		{ line: 2, term: 2 },
		{ line: 3, term: 1 },
		{ line: 3, term: 2 },
	]);
});

test('redact replaces every spelling of every term in a path', () => {
	assert.equal(redact('data/madeup-river/Fakefarm_dams.json', patterns), 'data/[term #1]/[term #2]_dams.json');
	assert.equal(redact('docs/ok.md', patterns), 'docs/ok.md');
});

test('addedLines keeps only added lines, with new-file line numbers', () => {
	const diff = [
		'diff --git a/a.md b/a.md',
		'--- a/a.md',
		'+++ b/a.md',
		'@@ -3,0 +4,2 @@',
		'+first',
		'+second',
		'@@ -10 +12 @@',
		'-old Fakefarm',
		'+new',
		'diff --git a/gone.md b/gone.md',
		'--- a/gone.md',
		'+++ /dev/null',
		'@@ -1 +0,0 @@',
		'-Fakefarm',
	].join('\n');
	assert.deepEqual(Object.fromEntries(addedLines(diff)), {
		'a.md': [
			{ line: 4, text: 'first' },
			{ line: 5, text: 'second' },
			{ line: 12, text: 'new' },
		],
	});
});

test('a linked worktree also looks beside the main checkout for the terms file', () => {
	const f = '/infra-secrets/pitman/client-terms.txt';
	assert.deepEqual(termsFileCandidates('/r/pitman-a', '/r/pitman/.git'), ['/r' + f]);
	assert.deepEqual(termsFileCandidates('/r/pitman/.claude/worktrees/x', '/r/pitman/.git'), ['/r/pitman/.claude/worktrees' + f, '/r' + f]);
	assert.deepEqual(termsFileCandidates('/r/pitman', '/r/pitman/.git'), ['/r' + f]);
	assert.deepEqual(termsFileCandidates('/r/pitman', null), ['/r' + f]);
});

// End to end, in a throwaway git repo with a synthetic terms file.
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check_client_terms.mjs');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
delete GIT_ENV.CLIENT_TERMS_FILE;

function repo() {
	const dir = mkdtempSync(join(tmpdir(), 'client-terms-'));
	const g = (...args) =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env: GIT_ENV, stdio: 'pipe' });
	g('init', '-q', '-b', 'main');
	mkdirSync(join(dir, 'scripts/ci-guards'), { recursive: true });
	copyFileSync(GUARD, join(dir, 'scripts/ci-guards/check_client_terms.mjs'));
	writeFileSync(join(dir, 'terms.txt'), 'Fakefarm\n');
	const put = (path, text, { stage = true } = {}) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
		if (stage) g('add', path);
	};
	const commit = (msg) => g('commit', '-q', '-m', msg);
	/** Runs the guard; `terms: false` points CLIENT_TERMS_FILE at a file that doesn't exist. */
	const run = (args = [], { terms = true } = {}) => {
		const env = { ...GIT_ENV, CLIENT_TERMS_FILE: join(dir, terms ? 'terms.txt' : 'absent.txt') };
		const r = spawnSync('node', ['scripts/ci-guards/check_client_terms.mjs', ...args], { cwd: dir, env, encoding: 'utf8' });
		assert.doesNotMatch(r.stdout + r.stderr, /fakefarm/i, 'the guard never prints a term');
		return r;
	};
	put('.gitignore', 'terms.txt\nabsent.txt\nmsg.txt\n');
	put('README.md', 'synthetic\n');
	commit('init');
	return { dir, g, put, commit, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the full scan passes a clean tree and fails a term in a file or a path, never printing it', (t) => {
	const r = repo();
	t.after(r.done);
	assert.equal(r.run().status, 0);
	r.put('docs/notes.md', 'ok\nnear the Fakefarm weir\n');
	r.put('docs/formats/examples/FAKEFARM.NET', 'ROUTE 1  \r\n');
	r.commit('add');
	const res = r.run();
	assert.equal(res.status, 1);
	assert.match(res.stderr, /::error file=docs\/notes\.md,line=2::client term #1/);
	assert.match(res.stderr, /::error file=docs\/formats\/examples\/\[term #1\]\.NET::client term #1/);
	assert.doesNotMatch(res.stderr, /weir/, 'nor the line text');
});

test('--staged checks only what is staged: added lines and paths, not the rest of the tree', (t) => {
	const r = repo();
	t.after(r.done);
	r.put('old.md', 'Fakefarm\n');
	r.commit('old');
	r.put('new.md', 'clean\n');
	r.put('loose.md', 'Fakefarm\n', { stage: false });
	assert.equal(r.run(['--staged']).status, 0);
	r.put('new.md', 'clean\nthe Fakefarm dam\n');
	const res = r.run(['--staged']);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /::error file=new\.md,line=2::client term #1/);
});

test("--message fails on a term in the message and ignores git's comment lines", (t) => {
	const r = repo();
	t.after(r.done);
	r.put('msg.txt', 'docs: clean\n\n# Fakefarm in a comment line\n', { stage: false });
	assert.equal(r.run(['--message', join(r.dir, 'msg.txt')]).status, 0);
	r.put('msg.txt', 'docs: the Fakefarm study\n', { stage: false });
	const res = r.run(['--message', join(r.dir, 'msg.txt')]);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /::error file=\(commit message\),line=1::client term #1/);
});

test('without the terms file every mode exits 0, and the hook modes say nothing', (t) => {
	const r = repo();
	t.after(r.done);
	r.put('docs/notes.md', 'Fakefarm\n');
	r.commit('add');
	r.put('msg.txt', 'Fakefarm\n', { stage: false });
	r.put('more.md', 'Fakefarm\n');
	for (const args of [['--staged'], ['--message', join(r.dir, 'msg.txt')]]) {
		const res = r.run(args, { terms: false });
		assert.equal(res.status, 0, args[0]);
		assert.equal(res.stdout + res.stderr, '', `${args[0]} is silent`);
	}
	const full = r.run([], { terms: false });
	assert.equal(full.status, 0);
	assert.match(full.stdout, /No client terms file .*; skipping/);
});

test('--history finds a term removed from HEAD but still in an earlier commit', (t) => {
	const r = repo();
	t.after(r.done);
	r.put('a.md', 'Fakefarm\n');
	r.commit('add');
	r.put('a.md', 'clean\n');
	r.commit('reword');
	assert.equal(r.run().status, 0);
	const res = r.run(['--history']);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /::error file=\(diffs, all refs\)::client term #1/);
});
