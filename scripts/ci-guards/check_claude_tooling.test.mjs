// Tests for check_claude_tooling.mjs (node:test, `pnpm test:tools`).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkFile, checkRepo, citedPaths, parseFrontmatter } from './check_claude_tooling.mjs';

const has = (/** @type {string[]} */ paths) => (/** @type {string} */ p) => paths.includes(p);

test('parseFrontmatter reads the fields and finds none without a block', () => {
	const fm = parseFrontmatter('---\nname: code-reviewer\ndescription: Reviews: a diff\n---\nbody\n');
	assert.equal(fm?.fields.get('name'), 'code-reviewer');
	assert.equal(fm?.fields.get('description'), 'Reviews: a diff');
	assert.equal(parseFrontmatter('# no frontmatter\n'), null);
});

test('citedPaths keeps repo paths, trims line numbers and sections, skips patterns and prose', () => {
	const text = [
		'Read `docs/security.md § Personal information` and `backend/src/db/tx.ts:22`.',
		'Tests like `backend/src/<area>/*.db.test.ts`, `{@html}`, `withUser`, `pnpm check`.',
		'Reports go to `reviews/security-rls.md`; client data in `data/client-catchment/`.',
		'A folder: `backend/migrations/`. A root file: `CLAUDE.md`.',
	].join('\n');
	assert.deepEqual(citedPaths(text), [
		{ path: 'docs/security.md', line: 1 },
		{ path: 'backend/src/db/tx.ts', line: 1 },
		{ path: 'backend/migrations', line: 4 },
		{ path: 'CLAUDE.md', line: 4 },
	]);
});

test('positive control: an adapted agent that cites real paths passes', () => {
	const text = '---\nname: code-reviewer\ndescription: Reviews a diff\n---\nCheck `backend/src/db/tx.ts`.\n';
	assert.deepEqual(checkFile('.claude/agents/engineering/code-reviewer.md', text, 'agent', has(['backend/src/db/tx.ts'])), []);
});

test('a missing path, a placeholder and a name that disagrees with the file are each reported', () => {
	const text = [
		'---',
		'name: reviewer',
		'description: Reviews a diff',
		'---',
		'Check the <CMS> webhook and `backend/src/cms.ts`.',
		'Apply it with your migration runner.',
	].join('\n');
	const rules = checkFile('.claude/agents/engineering/code-reviewer.md', text, 'agent', has([])).map((f) => [f.line, f.rule]);
	assert.equal(rules.length, 4);
	assert.match(rules[0][1], /name "reviewer" does not match/);
	assert.deepEqual(rules.slice(1).map(([line]) => line), [5, 6, 5]);
	assert.match(rules[3][1], /backend\/src\/cms\.ts/);
});

test('commands need a description but no name; docs need neither', () => {
	assert.deepEqual(checkFile('.claude/commands/check.md', '---\ndescription: Gate\n---\n', 'command', has([])), []);
	assert.match(checkFile('.claude/commands/check.md', '---\nargument-hint: x\n---\n', 'command', has([]))[0].rule, /no description/);
	assert.deepEqual(checkFile('.claude/README.md', '# Tooling\n', 'doc', has([])), []);
});

test('throwaway zz- specs an agent is told to create and delete are not citations', () => {
	assert.deepEqual(citedPaths('Throwaway `frontend/e2e/zz-shot.spec.ts`.'), []);
});

test('git-ignored local secret files an audit checks stay out of git are not citations; committed env files are', () => {
	const text = 'Never commit `backend/.env`, `frontend/.env.development.local`, `infra/terraform.tfvars` or `infra/backend.config`; `backend/.env.development` is committed.';
	assert.deepEqual(citedPaths(text), [{ path: 'backend/.env.development', line: 1 }]);
});

test('a skill (SKILL.md) is checked like a command; other files under a skill are docs', () => {
	const root = mkdtempSync(join(tmpdir(), 'claude-tooling-'));
	try {
		mkdirSync(join(root, '.claude/skills/run'), { recursive: true });
		writeFileSync(join(root, '.claude/skills/run/SKILL.md'), '---\nname: run\n---\nRead `docs/missing.md`.\n');
		writeFileSync(join(root, '.claude/skills/run/notes.md'), '# Notes, no frontmatter\n');
		const rules = checkRepo(root).map((f) => `${f.file}: ${f.rule}`);
		assert.deepEqual(rules, ['.claude/skills/run/SKILL.md: frontmatter has no description', '.claude/skills/run/SKILL.md: cites `docs/missing.md`, which does not exist']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('two agents with the same name are reported, wherever they live', () => {
	const root = mkdtempSync(join(tmpdir(), 'claude-tooling-'));
	try {
		for (const dir of ['engineering', 'audit']) {
			mkdirSync(join(root, '.claude/agents', dir), { recursive: true });
			writeFileSync(join(root, '.claude/agents', dir, 'code-reviewer.md'), '---\nname: code-reviewer\ndescription: Reviews\n---\n');
		}
		const rules = checkRepo(root).map((f) => f.rule);
		assert.equal(rules.length, 1);
		assert.match(rules[0], /agent name "code-reviewer" is also used by/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the repo itself passes', () => {
	const root = fileURLToPath(new URL('../..', import.meta.url));
	assert.deepEqual(checkRepo(root), []);
});
