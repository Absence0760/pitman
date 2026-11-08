// Guard: every error or warning the backend logs is one JSON line (`console.error(JSON.stringify({ event, … }))`,
// or logUnexpected, which writes one). A raw `console.error('…', err)` prints the error's message and stack,
// which can carry a bucket and key, an address (A-AUTH-11) or a vertex of the user's polygon, and is ~10 × the
// bytes of a JSON line on a log billed per GB (the pre-launch cost audit, 2026-11-07).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('..', import.meta.url).pathname;

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(p);
		return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
	});
}

describe('backend log lines', () => {
	it('logs errors and warnings only as JSON lines, never a raw error', () => {
		const files = sources(SRC);
		expect(files.length).toBeGreaterThan(20);
		const raw = files.flatMap((f) =>
			readFileSync(f, 'utf8')
				.split('\n')
				.flatMap((line, i) => (/console\.(error|warn)\((?!JSON\.stringify\()/.test(line) ? [`${relative(SRC, f)}:${i + 1}: ${line.trim()}`] : []))
		);
		expect(raw, 'use logUnexpected(event, err) from http/logError.ts, or console.error(JSON.stringify({ event, … }))').toEqual([]);
	});
});
