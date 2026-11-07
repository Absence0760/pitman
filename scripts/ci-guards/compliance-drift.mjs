#!/usr/bin/env node
// Advisory: a change that moves personal data, or starts talking to someone new, should move the privacy
// and data docs with it (estate standard: project-water-management's check_compliance_drift.mjs, threkir's
// and feohledger's compliance-drift.yml).
//
// The failure mode: source starts calling a new outside host, or the sign-in code starts handling a new
// personal-data field, and nothing else changes. The app works; docs/security.md (what is stored, logged
// and sent where) and docs/data.md (every data source and its licence) silently stop describing reality,
// and it only shows on the day someone asks.
//
// Rules, each a pure function of {changed files, per-file diff, the docs as they stand at HEAD}:
//   outbound-host   backend/src, frontend/src or packages/*/src (not tests) gains a URL to a host that is
//                   not local, not reserved (RFC 2606/6761), not AWS and not the site, and that neither
//                   docs/security.md nor docs/data.md names. Quiet when either doc changed in the same diff.
//                   A data source belongs in docs/data.md; a host that receives personal data is a
//                   sub-processor and belongs in docs/security.md.
//   sdk-dependency  a package.json (root or workspace) gains a known analytics / telemetry / third-party SDK
//                   that docs/security.md does not name. Quiet when docs/security.md changed.
//   pii-field       the sign-in code (backend/src/auth, the operator scripts in backend/scripts, the user
//                   table in infra/users.tf; not tests) gains a personal-data-shaped identifier
//                   (`phoneNumber`, `client_ip`, `displayName`, `userAgent`, …) that docs/security.md does
//                   not name. Quiet when docs/security.md changed.
//   auth-kit-bump   backend/package.json moves the @absence0760/auth-kit pin. auth-kit owns the user record
//                   and the audit rows, so a new tag can store new personal data without a line changing
//                   here: read its changelog and update docs/security.md § Users and sign-in.
//
// Mode: COMPLIANCE_DRIFT_MODE=warn (default: annotate, never fail) or fail.
// Base: BASE_SHA (the PR base, or the push's `before`), else the merge base with origin/main.
//
// Run:   pnpm check:compliance
// CI:    .github/workflows/compliance-drift.yml (advisory, never in the CI gate).
// Tests: node --test scripts/ci-guards/compliance-drift.test.mjs (part of `pnpm test:tools`)
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SECURITY_DOC = 'docs/security.md';
export const DATA_DOC = 'docs/data.md';

/** Hosts that are never an outside party: local, reserved names, AWS itself, the site, XML namespaces. */
export const KNOWN_HOST = [
	/(^|\.)localhost$/,
	/^127\./,
	/^0\.0\.0\.0$/,
	/(^|\.)(test|example|invalid)$/,
	/(^|\.)example\.(com|org|net)$/,
	/(^|\.)amazonaws\.com$/,
	/(^|\.)aws\.amazon\.com$/,
	/(^|\.)jaredhoward\.com$/,
	/(^|\.)w3\.org$/,
	/(^|\.)schemastore\.org$/,
];

export const SDK_DEPENDENCY =
	/^(@sentry\/|posthog|@segment\/|analytics-node|mixpanel|@datadog\/|dd-trace|newrelic|@amplitude\/|@google-analytics\/|react-ga|@vercel\/analytics|@vercel\/speed-insights|stripe|twilio|@sendgrid\/|mailgun|resend$|postmark$|openai|@anthropic-ai\/|intercom|hotjar|@bugsnag\/|rollbar|logrocket|@honeycombio\/|@opentelemetry\/|@microsoft\/applicationinsights|@fullstory\/|plausible|@growthbook\/|launchdarkly|@clerk\/|@auth0\/|firebase)/;

// Matched per word of the identifier (camelCase and snake_case both split), so `phoneNumber`, `client_ip`
// and `emailVerifiedAt` count, while `capacity`, `pipeline`, `zip` (the archive) or `ship` do not.
export const PII_WORDS = new Set([
	'email', 'phone', 'mobile', 'cellphone', 'msisdn', 'street', 'postcode', 'postal', 'surname', 'birth',
	'birthday', 'birthdate', 'dob', 'passport', 'gps', 'latitude', 'longitude', 'ip', 'geolocation',
]);
/** Two-word shapes: a name of a person, an address of a home, a user agent, an id number. */
const PII_PAIRS = /\b(first|last|full|display|given|middle|user|real|legal) name\b|\b(home|postal|street|physical|billing|ip|mac) address\b|\buser agent\b|\bid number\b|\bnational id\b/;

/** @param {string} identifier → its words, lower-case: `clientIPAddress` → `client ip address` */
export const words = (identifier) =>
	identifier
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.trim()
		.toLowerCase();

/** @param {string} identifier */
export const isPiiIdentifier = (identifier) => {
	const w = words(identifier);
	return w.split(' ').some((t) => PII_WORDS.has(t)) || PII_PAIRS.test(w);
};

/** @typedef {{ file: string, rule: string, detail: string }} Finding */

/** @param {string} diff */
const added = (diff) =>
	diff
		.split('\n')
		.filter((l) => l.startsWith('+') && !l.startsWith('+++'))
		.map((l) => l.slice(1));

const isComment = (/** @type {string} */ l) => /^\s*(\/\/|\*|\/\*|#|<!--)/.test(l);

/** @param {string} diff */
export function hostsInDiff(diff) {
	const hosts = new Set();
	for (const l of added(diff)) {
		if (isComment(l)) continue;
		for (const m of l.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1].toLowerCase());
	}
	return [...hosts].sort();
}

/**
 * Whether a doc names a host: the host itself, or a parent domain down to the registrable one
 * (`data.chc.ucsb.edu` is named by a doc that says `chc.ucsb.edu`; `x.org.za` keeps three labels).
 * @param {string} host
 * @param {string} docs
 */
export function docNamesHost(host, docs) {
	const labels = host.split('.');
	const floor = /^(co|org|gov|ac|net|com|edu)\.[a-z]{2}$/.test(labels.slice(-2).join('.')) ? 3 : 2;
	for (let i = 0; labels.length - i >= floor; i++) if (docs.includes(labels.slice(i).join('.'))) return true;
	// The registrable domain's own label as a word: `www.openstreetmap.org` by "OpenStreetMap", `www.wrc.org.za` by "WRC".
	const label = labels[labels.length - floor];
	return label !== undefined && label.length >= 3 && new RegExp(`\\b${label.replace(/-/g, '[- ]?')}\\b`, 'i').test(docs);
}

/** @param {string} diff  a package.json diff */
export function sdkDependenciesInDiff(diff) {
	const out = new Set();
	for (const l of added(diff)) {
		const m = l.match(/^\s*"(@?[a-z0-9][\w./-]*)"\s*:\s*"[^"]*"/i);
		if (m && SDK_DEPENDENCY.test(m[1])) out.add(m[1]);
	}
	return [...out].sort();
}

/**
 * Personal-data-shaped identifiers on the added lines of a code diff (strings and comments included in the
 * scan only as identifiers: a quoted `'phone'` key counts, prose in a comment does not).
 * @param {string} diff
 */
export function piiIdentifiersInDiff(diff) {
	const out = new Set();
	for (const l of added(diff)) {
		if (isComment(l)) continue;
		for (const m of l.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (isPiiIdentifier(m[0])) out.add(m[0]);
	}
	return [...out].sort();
}

/**
 * The personal-data concepts in an identifier: its PII words and two-word shapes (`clientIpAddress` → `ip`,
 * `ip address`; `displayName` → `display name`).
 * @param {string} identifier
 */
export const piiConcepts = (identifier) => {
	const w = words(identifier);
	const out = w.split(' ').filter((t) => PII_WORDS.has(t));
	for (const m of w.matchAll(new RegExp(PII_PAIRS.source, 'g'))) out.push(m[0]);
	return [...new Set(out)];
};

/**
 * Whether a doc already covers an identifier: it names every personal-data concept in it as a word. So
 * `badEmail` and `DEV_ADMIN_EMAIL` are covered by a doc that talks about email; `phoneNumber` is not.
 * @param {string} identifier
 * @param {string} doc
 */
export const docNamesIdentifier = (identifier, doc) =>
	piiConcepts(identifier).every((c) => new RegExp(`\\b${c.replace(/ /g, '[ _-]?')}s?\\b`, 'i').test(doc));

/** @param {string} diff  backend/package.json */
export function authKitPinMoved(diff) {
	const pin = (/** @type {string} */ sign) =>
		diff
			.split('\n')
			.filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3)) && l.includes('"@absence0760/auth-kit"'))
			.map((l) => l.slice(1).trim());
	const before = pin('-');
	const after = pin('+');
	return after.length > 0 && after.join() !== before.join();
}

const SOURCE = /^(backend\/src|frontend\/src|packages\/[^/]+\/src)\/.+\.(ts|js|mjs|svelte)$/;
const TEST = /(\.test\.|\.spec\.|\/__tests__\/|\/e2e\/)/;
const AUTH_AREA = /^(backend\/src\/auth\/.+\.ts|backend\/scripts\/.+\.ts|infra\/users\.tf)$/;
const MANIFEST = /^(package\.json|(backend|frontend|packages\/[^/]+)\/package\.json)$/;

/**
 * @param {{ files: readonly string[], diffFor: (f: string) => string, docAtHead: (f: string) => string }} input
 * @returns {Finding[]}
 */
export function collectFindings({ files, diffFor, docAtHead }) {
	/** @type {Finding[]} */
	const findings = [];
	const touched = (/** @type {string} */ p) => files.includes(p);
	const security = docAtHead(SECURITY_DOC);
	const securityAndData = `${security}\n${docAtHead(DATA_DOC)}`;
	for (const f of files) {
		if (SOURCE.test(f) && !TEST.test(f) && !touched(SECURITY_DOC) && !touched(DATA_DOC)) {
			const hosts = hostsInDiff(diffFor(f)).filter((h) => !KNOWN_HOST.some((re) => re.test(h)) && !docNamesHost(h, securityAndData));
			if (hosts.length) {
				findings.push({
					file: f,
					rule: 'outbound-host',
					detail: `reaches ${hosts.join(', ')}, which neither ${SECURITY_DOC} nor ${DATA_DOC} names. A data source goes in ${DATA_DOC} (source, licence, credit); a host that receives personal data is a sub-processor and goes in ${SECURITY_DOC}. The CSP (infra/csp.json) blocks an unlisted origin from the browser anyway.`,
				});
			}
		}
		if (MANIFEST.test(f) && !touched(SECURITY_DOC)) {
			const sdks = sdkDependenciesInDiff(diffFor(f)).filter((s) => !security.includes(s));
			if (sdks.length) {
				findings.push({
					file: f,
					rule: 'sdk-dependency',
					detail: `adds third-party SDK(s) ${sdks.join(', ')}. Document what it collects and where it sends it in ${SECURITY_DOC} before it ships.`,
				});
			}
		}
		if (AUTH_AREA.test(f) && !TEST.test(f) && !touched(SECURITY_DOC)) {
			const ids = piiIdentifiersInDiff(diffFor(f)).filter((id) => !docNamesIdentifier(id, security));
			if (ids.length) {
				findings.push({
					file: f,
					rule: 'pii-field',
					detail: `handles personal-data-shaped field(s) ${ids.join(', ')}, which ${SECURITY_DOC} does not name. Record what is stored or logged, for how long, and whether erasure (\`pnpm admin:erase\`, ${SECURITY_DOC} § Erasure) covers it.`,
				});
			}
		}
		if (f === 'backend/package.json' && !touched(SECURITY_DOC) && authKitPinMoved(diffFor(f))) {
			findings.push({
				file: f,
				rule: 'auth-kit-bump',
				detail: `moves the @absence0760/auth-kit pin. auth-kit owns the user record and the audit rows: check its changelog for new stored or logged personal data and bring ${SECURITY_DOC} § Users and sign-in up to date.`,
			});
		}
	}
	return findings;
}

/** @param {string[]} args */
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** @param {string} path */
const showAtHead = (path) => {
	try {
		return git(['show', `HEAD:${path}`]);
	} catch {
		return '';
	}
};

function resolveBase() {
	const base = process.env.BASE_SHA;
	if (base && !/^0+$/.test(base)) {
		try {
			git(['cat-file', '-e', `${base}^{commit}`]);
			return base;
		} catch {
			console.log(`::notice::BASE_SHA ${base} is not in this clone; diffing against origin/main instead`);
		}
	}
	return git(['merge-base', 'HEAD', 'origin/main']).trim();
}

function main() {
	const mode = process.env.COMPLIANCE_DRIFT_MODE ?? 'warn';
	const base = resolveBase();
	const files = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
	const findings = collectFindings({ files, diffFor: (f) => git(['diff', `${base}...HEAD`, '--', f]), docAtHead: showAtHead });
	const level = mode === 'fail' ? 'error' : 'warning';
	for (const f of findings) console.log(`::${level} file=${f.file}::[${f.rule}] ${f.detail}`);
	const summary = findings.length
		? `${findings.length} compliance-drift finding(s) across ${files.length} changed files (mode: ${mode}).`
		: `No compliance drift across ${files.length} changed files.`;
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) {
		const body = ['## Compliance drift (advisory)', '', summary, '', ...findings.map((f) => `- \`${f.file}\` **${f.rule}**: ${f.detail}`), ''];
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.join('\n') + '\n');
	}
	return mode === 'fail' && findings.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
