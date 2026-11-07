import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentHashFetch, contentSha256, EMPTY_SHA256 } from './content-hash.js';

/** What Lambda checks the stated hash against: Node's own SHA-256 of the bytes. */
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface Seen {
	input: RequestInfo | URL;
	init: RequestInit | undefined;
}

function recorder() {
	const seen: Seen[] = [];
	const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push({ input, init });
		return new Response('{}', { status: 200 });
	}) as typeof fetch;
	return { seen, f };
}

const header = (s: Seen) => (s.init?.headers as Record<string, string> | undefined)?.['x-amz-content-sha256'];

describe('contentSha256', () => {
	it('is the hex SHA-256 of the UTF-8 bytes a string body is sent as', async () => {
		const body = JSON.stringify({ email: 'someone@example.test', note: 'Kariega — Ü' });
		expect(await contentSha256(body)).toBe(sha256(Buffer.from(body, 'utf8')));
	});

	it('hashes no body as zero bytes', async () => {
		expect(EMPTY_SHA256).toBe(sha256(''));
		expect(await contentSha256(undefined)).toBe(EMPTY_SHA256);
		expect(await contentSha256(null)).toBe(EMPTY_SHA256);
		expect(await contentSha256('')).toBe(EMPTY_SHA256);
	});

	it('hashes binary and Blob bodies byte for byte', async () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 255]);
		expect(await contentSha256(bytes)).toBe(sha256(bytes));
		expect(await contentSha256(bytes.buffer)).toBe(sha256(bytes));
		expect(await contentSha256(new Blob([bytes]))).toBe(sha256(bytes));
	});

	it('refuses bodies whose bytes are not known before sending', async () => {
		const form = new FormData();
		form.set('a', 'b');
		await expect(contentSha256(form)).rejects.toThrow(/FormData/);
		await expect(contentSha256(new ReadableStream())).rejects.toThrow(/stream/);
	});
});

describe('contentHashFetch', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('states the body hash on a POST, keeping the other headers and the body as they were', async () => {
		const r = recorder();
		const body = JSON.stringify({ area: { type: 'Polygon', coordinates: [] } });
		await contentHashFetch(r.f)('/api/chirps/monthly', { method: 'POST', headers: { 'Content-Type': 'application/json', accept: 'application/json' }, body });
		const s = r.seen[0]!;
		expect(header(s)).toBe(sha256(body));
		expect(s.init?.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json', 'x-amz-content-sha256': sha256(body) });
		expect(s.init?.body).toBe(body);
		expect(s.init?.method).toBe('POST');
	});

	it('states it on every method that may carry a body, a bodiless POST included', async () => {
		const r = recorder();
		const call = contentHashFetch(r.f);
		await call('/api/auth/logout', { method: 'POST' });
		await call('/api/users/u1', { method: 'PATCH', body: '{"isAdmin":true}' });
		await call('/api/users/u1', { method: 'delete' });
		await call('/api/x', { method: 'PUT', headers: new Headers({ 'content-type': 'application/json' }), body: '[]' });
		expect(r.seen.map(header)).toEqual([EMPTY_SHA256, sha256('{"isAdmin":true}'), EMPTY_SHA256, sha256('[]')]);
	});

	it('leaves GET and HEAD untouched', async () => {
		const r = recorder();
		const init = { headers: { accept: 'application/json' } };
		await contentHashFetch(r.f)('/api/quaternaries', init);
		await contentHashFetch(r.f)('/api/health', { method: 'HEAD' });
		expect(r.seen[0]!.init).toBe(init);
		expect(header(r.seen[1]!)).toBeUndefined();
	});

	it('hashes a Request’s own body and leaves it readable', async () => {
		const r = recorder();
		const request = new Request('http://localhost/api/x', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
		await contentHashFetch(r.f)(request);
		expect(header(r.seen[0]!)).toBe(sha256('{"a":1}'));
		expect(r.seen[0]!.input).toBe(request);
		expect(await request.text()).toBe('{"a":1}');
	});

	it('rejects with the abort, without fetching, when the caller cancels while the body is hashed', async () => {
		const r = recorder();
		const controller = new AbortController();
		const pending = contentHashFetch(r.f)('/api/chirps/monthly', { method: 'POST', body: '{}', signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(r.seen).toEqual([]);
	});

	it('sends without the header where Web Crypto is unavailable (plain http off localhost; never production)', async () => {
		vi.stubGlobal('crypto', {});
		const r = recorder();
		await contentHashFetch(r.f)('/api/auth/code', { method: 'POST', body: '{}' });
		expect(header(r.seen[0]!)).toBeUndefined();
	});
});
