#!/usr/bin/env node
// Committed env files stay local-only (estate standard: project-water-management's check_env_isolation.mjs,
// feohledger's env-isolation.yml, threkir's env-isolation job).
//
// Pitman commits `backend/.env.development` and `frontend/.env.development` so a fresh clone runs with no
// setup (CLAUDE.md "Local-dev env is committed; real secrets never are"). That is only safe while those
// files stay boring. gitleaks scans for known credential SHAPES; this guard is the semantic complement.
// It asserts that:
//
//   1. the only tracked env files are `*.env.development` and `*.env.example`; no `*.tfvars` (the
//      `.example` is fine) and no sops payload or `.sops.yaml` is tracked (production secrets live in the
//      private infra-secrets repo; `*.sops.yaml.example` key lists are fine);
//   2. every host a committed dev default names is local, and every email address is on a reserved domain
//      (`example.test`, `localhost`, …), so no real mailbox (personal data) and no real server is in git;
//   3. the dev placeholders stay placeholders: a key named like a secret (`*_KEY`, `*_SECRET`, `*_TOKEN`,
//      `*_PASSWORD`) is empty or starts `dev-only-` (auth-kit's AUTH_CODE_KEY / AUTH_SESSION_KEY are
//      Terraform random_passwords in production, A-AUTH-8; CLOUDFRONT_SHARED_SECRET stays empty); no AWS
//      credential or profile is set (production uses the Lambda's role, CI uses OIDC);
//   4. the data sources stay local (docs/data.md): every `*_SOURCE` is `local`, so no default reads IC-WBT's
//      buckets or Cape Farm Mapper; every `*_LOCAL_FILE` / `*_LOCAL_DIR` is a path inside the workspace;
//   5. sign-in stays on the laptop (docs/run-locally.md § Sign-in): USER_STORE is `memory` or `dynamodb`
//      (DynamoDB Local), USERS_TABLE ends `-local`, MAIL_TRANSPORT is `console` or `smtp` (Mailpit), never SES,
//      and MAIL_QUEUE is `inline` (the in-process queue) with no MAIL_QUEUE_URL, never the SQS queue (#30);
//   6. frontend env files define only `PUBLIC_*` keys (anything else in a Vite env file is ignored or a
//      secret in the wrong place), and PUBLIC_API_URL is the same-origin `/api` the cookie depends on.
//
// It never prints a matched VALUE, only the file, the line and the rule: a CI log is as public as the repo.
//
// Run:   pnpm check:env
// CI:    ci.yml, job `env-isolation` (in the `CI gate` needs).
// Tests: node --test scripts/ci-guards/env-isolation.test.mjs (part of `pnpm test:tools`)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ALLOWED_ENV_FILE = /(^|\/)\.env\.(development|example)$/;
const ENV_FILE = /(^|\/)\.env($|\.)/;
const SOPS_FILE = /(^|\/)\.sops\.ya?ml$|\.sops$|\.sops\.(ya?ml|json|env|ini)$/;
const TFVARS_FILE = /\.tfvars(\.json)?$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);
/** RFC 2606 / 6761 reserved names: nothing on them is a real mailbox. */
const RESERVED_MAIL_DOMAIN = /(^|\.)(localhost|test|example|invalid)$|^example\.(com|org|net)$/i;
const SECRET_NAMED = /(^|_)(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)$/;
const AWS_CREDENTIAL = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']);

/** @typedef {{ file: string, line?: number, rule: string }} Finding */

/** @param {string} host */
export const isLocalHost = (host) => LOCAL_HOSTS.has(host.toLowerCase()) || /\.localhost$/i.test(host);

/**
 * @param {readonly string[]} tracked every path `git ls-files` reports
 * @returns {Finding[]}
 */
export function checkTrackedFiles(tracked) {
	/** @type {Finding[]} */
	const out = [];
	for (const f of tracked) {
		const base = f.split('/').pop() ?? f;
		if (ENV_FILE.test(base) && !ALLOWED_ENV_FILE.test(f)) {
			out.push({ file: f, rule: 'env file outside the allowlist is tracked (only *.env.development and *.env.example may be committed)' });
		}
		if (SOPS_FILE.test(f)) {
			out.push({ file: f, rule: 'sops file tracked (encrypted secrets live in the private infra-secrets repo)' });
		}
		if (TFVARS_FILE.test(f)) {
			out.push({ file: f, rule: 'Terraform variables file tracked (only terraform.tfvars.example may be committed)' });
		}
	}
	return out;
}

/**
 * Parse KEY=value lines, skipping comments and blanks.
 * @param {string} text
 * @returns {{ line: number, key: string, value: string }[]}
 */
export function parseEnv(text) {
	const out = [];
	text.split('\n').forEach((raw, i) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) return;
		const eq = line.indexOf('=');
		if (eq <= 0) return;
		let value = line.slice(eq + 1).trim();
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
		out.push({ line: i + 1, key: line.slice(0, eq).trim().replace(/^export\s+/, ''), value });
	});
	return out;
}

/**
 * Hosts named by one value: every `scheme://[user[:pw]@]host` in it.
 * @param {string} value
 */
export function hostsIn(value) {
	const hosts = [];
	for (const m of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@\s/]*@)?(\[[^\]]+\]|[^:/?#\s,;"']+)/gi)) {
		hosts.push(m[1].replace(/^\[|\]$/g, ''));
	}
	return hosts;
}

/**
 * Domains of the email addresses in one value (not the userinfo of a URL, which hostsIn covers).
 * @param {string} value
 */
export function mailDomainsIn(value) {
	const bare = value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s,;]*/gi, '');
	return [...bare.matchAll(/[\w.+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)*)/gi)].map((m) => m[1]);
}

/** A path relative to its workspace that stays inside it. */
const isInsidePath = (/** @type {string} */ p) => p !== '' && !/^([/~\\]|[a-z]:)/i.test(p) && !p.split(/[/\\]/).includes('..');

/**
 * @param {string} file repo-relative
 * @param {string} text
 * @returns {Finding[]}
 */
export function checkEnvFile(file, text) {
	/** @type {Finding[]} */
	const out = [];
	const isDev = /\.env\.development$/.test(file);
	const isFrontend = file.startsWith('frontend/');
	/** @param {number} line @param {string} rule */
	const add = (line, rule) => out.push({ file, line, rule });
	for (const { line, key, value } of parseEnv(text)) {
		if (isFrontend && !key.startsWith('PUBLIC_')) {
			add(line, `${key} is not a PUBLIC_* key; a frontend env file may only hold values that are safe to bake into the public bundle`);
		}
		if (isFrontend && key === 'PUBLIC_API_URL' && value !== '/api') {
			add(line, 'PUBLIC_API_URL must be the same-origin /api (Vite proxies it in dev, CloudFront in production; the session cookie depends on it)');
		}
		if (!isDev) continue;

		for (const host of hostsIn(value)) {
			if (!isLocalHost(host)) add(line, `${key} names a non-local host; committed dev defaults must point at the local stack`);
		}
		if (/_HOST$/.test(key) && value && !isLocalHost(value)) {
			add(line, `${key} is not a local host; committed dev defaults must point at the local stack`);
		}
		for (const domain of mailDomainsIn(value)) {
			if (!RESERVED_MAIL_DOMAIN.test(domain)) add(line, `${key} names an email address on a real domain; use a reserved one (example.test, localhost)`);
		}
		if (AWS_CREDENTIAL.has(key)) {
			add(line, `${key} must not be committed; the Lambda uses its role, CI uses OIDC, and DynamoDB Local needs no real credentials`);
		} else if (SECRET_NAMED.test(key) && value !== '' && !value.startsWith('dev-only-')) {
			add(line, `${key} is neither empty nor a dev-only- placeholder; a real key here is public. Production keys are Terraform's or live in infra-secrets`);
		}
		if (/_SOURCE$/.test(key) && value !== 'local') {
			add(line, `${key} must be local in a committed dev default (the real source needs AWS credentials or the operator's token; docs/data.md)`);
		}
		if (/_LOCAL_(FILE|DIR)$/.test(key) && !isInsidePath(value)) {
			add(line, `${key} must be a relative path inside the workspace, not a machine path`);
		}
		if (key === 'USER_STORE' && value !== 'memory' && value !== 'dynamodb') {
			add(line, 'USER_STORE must be memory or dynamodb (DynamoDB Local) in a committed dev default');
		}
		if (key === 'USERS_TABLE' && !value.endsWith('-local')) {
			add(line, 'USERS_TABLE must name a -local table in a committed dev default, never the production user table');
		}
		if (key === 'MAIL_TRANSPORT' && value !== 'console' && value !== 'smtp') {
			add(line, 'MAIL_TRANSPORT must be console or smtp (Mailpit) in a committed dev default; SES sends real mail');
		}
		if (key === 'MAIL_QUEUE' && value !== 'inline') {
			add(line, 'MAIL_QUEUE must be inline in a committed dev default; the SQS queue needs AWS credentials and is production only');
		}
		if (key === 'MAIL_QUEUE_URL' && value !== '') {
			add(line, 'MAIL_QUEUE_URL must not be set in a committed dev default; the SQS queue is production only');
		}
	}
	return out;
}

function main() {
	const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
	const findings = checkTrackedFiles(tracked);
	const envFiles = tracked.filter((f) => ALLOWED_ENV_FILE.test(f));
	for (const want of ['backend/.env.development', 'frontend/.env.development']) {
		if (!envFiles.includes(want)) findings.push({ file: want, rule: 'not tracked; the file list derivation stopped matching, so the rules above checked nothing' });
	}
	for (const f of envFiles) {
		console.log(`Scanning ${f}`);
		findings.push(...checkEnvFile(f, readFileSync(f, 'utf8')));
	}
	for (const f of findings) {
		const loc = f.line ? `file=${f.file},line=${f.line}` : `file=${f.file}`;
		console.error(`::error ${loc}::${f.rule}`);
	}
	if (findings.length) {
		console.error(`${findings.length} env-isolation finding(s). Values are deliberately not printed.`);
		return 1;
	}
	console.log(`Env isolation OK (${envFiles.length} committed env files).`);
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
