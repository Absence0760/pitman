import { describe, expect, it } from 'vitest';
import { isPublicPath, safeNext, signInHref } from './next.js';

describe('safeNext: only a path on this site', () => {
	it.each([
		['/', '/'],
		['/users', '/users'],
		['/users?tab=audit#log', '/users?tab=audit#log'],
		['/methods/', '/methods/'],
		['/a/../users', '/users']
	])('follows %s', (raw, want) => {
		expect(safeNext(raw)).toBe(want);
	});

	it.each([
		[null],
		[undefined],
		[''],
		['//evil.example'],
		['//evil.example/users'],
		['/\\evil.example'],
		['\\\\evil.example'],
		['/\t/evil.example'],
		['/\n/evil.example'],
		['https://evil.example/'],
		['http:evil.example'],
		['javascript:alert(1)'],
		['users'],
		['evil.example'],
		['/sign-in'],
		['/sign-in/?next=/users'],
		// A dot segment that resolves away and leaves '//host' (the check runs on the result, not the input).
		['/.//evil.example'],
		['/..//evil.example'],
		['/%2e//evil.example'],
		['/%2E%2E//evil.example'],
		['/a/..//evil.example'],
		['/x/../..//evil.example/path?q#h'],
		['/./%2F/evil.example'],
		['/%2F/evil.example'],
		['/%5C/evil.example'],
		['/./%5c/evil.example'],
		['/.\\/evil.example'],
		['/%2e/\\evil.example']
	])('refuses %j and goes home', (raw) => {
		expect(safeNext(raw)).toBe('/');
	});

	it('never returns anything that resolves to another origin', () => {
		const hostile = ['/.//evil.example', '/%2e//evil.example', '/./%2F/evil.example', '/a/b/../../..//evil.example', '/.%2F/evil.example'];
		for (const raw of hostile) {
			const got = safeNext(raw);
			expect(got.startsWith('//')).toBe(false);
			expect(new URL(got, 'https://pitman.example').origin).toBe('https://pitman.example');
		}
	});
});

describe('signInHref', () => {
	it('carries the page to come back to', () => {
		expect(signInHref('/users?x=1')).toBe('/sign-in?next=%2Fusers%3Fx%3D1');
		expect(safeNext(decodeURIComponent(signInHref('/users?x=1').split('next=')[1]!))).toBe('/users?x=1');
	});

	it('leaves home and anything unsafe out', () => {
		expect(signInHref('/')).toBe('/sign-in');
		expect(signInHref('//evil.example')).toBe('/sign-in');
	});
});

describe('isPublicPath (A-AUTH-1)', () => {
	it('lets sign-in, privacy and methods through, with or without a slash', () => {
		for (const p of ['/sign-in', '/privacy', '/methods', '/methods/']) expect(isPublicPath(p)).toBe(true);
	});

	it('gates everything else', () => {
		for (const p of ['/', '/users', '/privacy-policy', '/methodsx']) expect(isPublicPath(p)).toBe(false);
	});
});
