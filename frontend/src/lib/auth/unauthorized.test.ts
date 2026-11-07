import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { onUnauthorized, sessionFetch } from './unauthorized.js';

const answer = (status: number) => (async () => new Response(status === 204 ? null : '{}', { status })) as typeof fetch;

describe('sessionFetch', () => {
	let off: (() => void) | undefined;
	afterEach(() => off?.());

	it('reports a 401 and still hands the response back', async () => {
		let heard = 0;
		off = onUnauthorized(() => heard++);
		const response = await sessionFetch(answer(401))('/api/quaternaries');
		expect(response.status).toBe(401);
		expect(heard).toBe(1);
	});

	it('says nothing for any other answer', async () => {
		let heard = 0;
		off = onUnauthorized(() => heard++);
		for (const status of [200, 204, 400, 403, 404, 429, 500]) await sessionFetch(answer(status))('/api/x');
		expect(heard).toBe(0);
	});

	it('is quiet with no handler, and a removed handler stays removed', async () => {
		let heard = 0;
		const remove = onUnauthorized(() => heard++);
		remove();
		await sessionFetch(answer(401))('/api/x');
		expect(heard).toBe(0);
	});

	it('only the newest handler hears it', async () => {
		const heard: string[] = [];
		const first = onUnauthorized(() => heard.push('first'));
		off = onUnauthorized(() => heard.push('second'));
		first(); // A stale removal doesn't take the newer handler with it.
		await sessionFetch(answer(401))('/api/x');
		expect(heard).toEqual(['second']);
	});
});

describe('every API client reports a 401', () => {
	// A new client that builds an API URL must fetch through sessionFetch, or a lapsed session leaves the user
	// stuck on errors instead of going to sign-in (issue #28 P5).
	it('each module calling apiUrl() also uses sessionFetch', () => {
		const lib = fileURLToPath(new URL('..', import.meta.url));
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|svelte)$/.test(e.name) && !/\.test(-helper)?\.ts$/.test(e.name) ? [join(dir, e.name)] : []));
		const callers = walk(lib).filter((f) => /\bapiUrl\(/.test(readFileSync(f, 'utf8').replace('export function apiUrl(', '')));
		const missing = callers.filter((f) => !/sessionFetch\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(lib, f));
		expect(callers.length).toBeGreaterThanOrEqual(6);
		expect(missing).toEqual([]);
	});
});
