// Guards on .github/workflows (node:test, `pnpm test:tools`): the private auth-kit's read token reaches git
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
