// Guard on .pre-commit-config.yaml (node:test, `pnpm test:tools`): the hooks that rewrite whitespace never touch
// docs/formats/examples/, whose WRSM2000 files are byte-exact with CRLF and trailing blanks (CLAUDE.md rule 6).
// .gitattributes' `-text` there does not stop them: pre-commit decides "text" from the file's content.
// Also: the client-terms hooks and the .githooks/ scripts that run them stay wired together.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

const text = readFileSync(new URL('../../.pre-commit-config.yaml', import.meta.url), 'utf8');

/** The lines of the hook entry `- id: <id>`, up to the next entry. */
function hook(id) {
	const lines = text.split('\n');
	const start = lines.findIndex((l) => l.trim() === `- id: ${id}`);
	assert.notEqual(start, -1, `${id} is not configured`);
	const out = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*(- |#)/.test(line) || line.trim() === '') break;
		out.push(line.trim());
	}
	return out;
}

for (const id of ['end-of-file-fixer', 'trailing-whitespace']) {
	test(`${id} excludes docs/formats/examples/`, () => {
		assert.ok(
			hook(id).some((l) => /^exclude:.*\^docs\/formats\/examples\//.test(l)),
			`${id} must have \`exclude: ^docs/formats/examples/\``,
		);
	});
}

// The client terms hooks (CLAUDE.md rule 2, docs/security.md § Public repo hygiene) run the guard, and
// .githooks/, which runs the guard itself before calling the framework, skips exactly those ids.
test('the client-terms hooks run the guard, and .githooks/ skips them by id', () => {
	assert.ok(hook('client-terms').includes('entry: node scripts/ci-guards/check_client_terms.mjs --staged'));
	assert.ok(hook('client-terms-message').includes('entry: node scripts/ci-guards/check_client_terms.mjs --message'));
	for (const name of ['pre-commit', 'commit-msg']) {
		const sh = readFileSync(new URL(`../../.githooks/${name}`, import.meta.url), 'utf8');
		assert.match(sh, /node scripts\/ci-guards\/check_client_terms\.mjs --(staged|message)/, `${name} runs the guard`);
		assert.match(sh, /SKIP="client-terms,client-terms-message\$\{SKIP:\+,\$SKIP\}"/, `${name} skips the framework's copies`);
	}
});

test('every hook in .githooks/ is executable', () => {
	for (const name of ['pre-commit', 'commit-msg', 'pre-push']) {
		const mode = statSync(new URL(`../../.githooks/${name}`, import.meta.url)).mode;
		assert.ok(mode & 0o111, `.githooks/${name} must be executable (git ignores a hook that is not)`);
	}
});
