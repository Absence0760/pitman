#!/usr/bin/env node
// Adapted from project-water-management infra/scripts/check-csp.mjs (MIT,
// same author, commit 575da51f9): Pitman adds the style checks and reads
// the header policy from infra/csp.json.
//
// Deploy-time guard for the split Content-Security-Policy
// (infra/security_headers.tf). The CloudFront header allows
// `script-src 'self' 'unsafe-inline'` because SvelteKit's bootstrap script
// changes hash every build; what makes the effective policy strict is
// SvelteKit's own <meta http-equiv="content-security-policy"> (csp.mode =
// 'hash'), which the browser enforces on top of the header. If that meta tag
// ever disappears, the site silently falls back to 'unsafe-inline'. This
// script refuses that build, and anything else the header would block.
//
// For every .html file under the build directory it checks that:
//   - a meta CSP comes before the first <script>, and its script-src lists a
//     sha256 hash for EVERY inline <script> and allows neither
//     'unsafe-inline' nor 'unsafe-eval';
//   - no element carries an inline event-handler attribute (onclick=...);
//   - every style="..." attribute and every inline <style> element is allowed
//     by the header's style-src (infra/csp.json) by hash, so the strict
//     style-src can't break the page unnoticed.
// And that the header policy itself (csp.json) has no 'unsafe-eval', no
// style-src 'unsafe-inline' and connect-src exactly 'self'.
//
// Usage: node infra/scripts/check-csp.mjs [frontend/build]
// Exit code 1 on any violation. Run by .github/workflows/deploy-frontend.yml
// between the build and the S3 sync.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** The header policy as { directive: Set(sources) }, from csp.json's `site`. */
export function headerPolicy(cspJson) {
	return new Map(cspJson.site.map(([name, ...sources]) => [name, new Set(sources)]));
}

/** Problems with the header policy itself (csp.json), independent of any build. */
export function checkHeaderPolicy(policy) {
	const errors = [];
	for (const [name, sources] of policy) {
		if (sources.has("'unsafe-eval'")) errors.push(`csp.json ${name} allows 'unsafe-eval'`);
	}
	if (policy.get('style-src')?.has("'unsafe-inline'")) errors.push("csp.json style-src allows 'unsafe-inline' (hash the attribute instead)");
	const connect = [...(policy.get('connect-src') ?? [])];
	if (connect.length !== 1 || connect[0] !== "'self'") errors.push(`csp.json connect-src must be exactly 'self' (is: ${connect.join(' ') || 'missing'})`);
	if (!policy.get('default-src')?.has("'self'")) errors.push("csp.json default-src must be 'self'");
	return errors;
}

// The few entities an attribute value can carry; the browser hashes the
// decoded value.
const decode = (s) =>
	s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function checkHtml(html, policy) {
	const errors = [];

	// Only executable inline scripts: no src, and no non-JS type (JSON data
	// blocks don't run and don't need a hash).
	const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
	const inline = scripts
		.filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs))
		.filter(([, attrs]) => {
			const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
			return !type || type === 'module' || type === 'text/javascript';
		})
		.map(([, , body]) => body);

	const metaMatch = /<meta\b[^>]*http-equiv\s*=\s*["']content-security-policy["'][^>]*>/i.exec(html);
	const content = metaMatch && /\bcontent\s*=\s*"([^"]*)"/i.exec(metaMatch[0])?.[1];

	if (!content) {
		if (inline.length)
			errors.push(
				`${inline.length} inline script(s) but no <meta http-equiv="content-security-policy"> (set csp: { mode: 'hash', directives: { 'script-src': ['self'] } } in frontend/vite.config.ts's sveltekit({...}))`
			);
	} else {
		if (scripts.length && scripts[0].index < metaMatch.index) errors.push('a <script> comes before the meta CSP, so the meta policy does not cover it');
		const scriptSrc = decode(content)
			.split(';')
			.map((d) => d.trim().split(/\s+/))
			.find(([name]) => name === 'script-src');
		if (!scriptSrc) {
			errors.push('meta CSP has no script-src directive');
		} else {
			const sources = new Set(scriptSrc.slice(1));
			for (const bad of ["'unsafe-inline'", "'unsafe-eval'"]) {
				if (sources.has(bad)) errors.push(`meta CSP script-src allows ${bad}`);
			}
			for (const body of inline) {
				const h = sha256(body);
				if (!sources.has(h)) errors.push(`inline script ${h} is not in the meta CSP script-src`);
			}
		}
	}

	const handler = /<[a-z][^>]*\s(on[a-z]+)\s*=/i.exec(html);
	if (handler) errors.push(`inline event handler attribute ${handler[1]}= (blocked by CSP)`);

	const styleSrc = policy.get('style-src') ?? new Set();
	for (const [, , value] of html.matchAll(/<[a-z][^>]*?\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
		const h = sha256(decode(value));
		if (!styleSrc.has("'unsafe-hashes'") || !styleSrc.has(h))
			errors.push(`style attribute "${decode(value)}" (${h}) is not allowed by infra/csp.json's style-src: use a class, or add 'unsafe-hashes' and ${h} there`);
	}
	for (const [, body] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
		const h = sha256(body);
		if (!styleSrc.has(h)) errors.push(`inline <style> ${h} is not in infra/csp.json's style-src: move it to a .css file, or add ${h} there`);
	}

	return { errors, inlineScripts: inline.length };
}

function htmlFiles(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) return htmlFiles(p);
		return name.endsWith('.html') ? [p] : [];
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = process.argv[2] ?? 'frontend/build';
	const policy = headerPolicy(JSON.parse(readFileSync(new URL('../csp.json', import.meta.url), 'utf8')));
	let failed = false;
	for (const e of checkHeaderPolicy(policy)) {
		failed = true;
		console.error(`check-csp: ${e}`);
	}
	const files = htmlFiles(root);
	if (!files.length) {
		console.error(`check-csp: no .html files under ${root}; build first.`);
		process.exit(1);
	}
	for (const file of files) {
		const { errors, inlineScripts } = checkHtml(readFileSync(file, 'utf8'), policy);
		const name = relative(process.cwd(), file);
		if (errors.length) {
			failed = true;
			console.error(`check-csp: ${name}\n  ${errors.join('\n  ')}`);
		} else {
			console.log(`check-csp: ${name} OK (${inlineScripts} inline script(s), all hashed in the meta CSP; inline styles all allowed)`);
		}
	}
	process.exit(failed ? 1 : 0);
}
