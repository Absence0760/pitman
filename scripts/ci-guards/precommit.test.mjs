// Guard on .pre-commit-config.yaml (node:test, `pnpm test:tools`): the hooks that rewrite whitespace never touch
// docs/formats/examples/, whose WRSM2000 files are byte-exact with CRLF and trailing blanks (CLAUDE.md rule 6).
// .gitattributes' `-text` there does not stop them: pre-commit decides "text" from the file's content.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
