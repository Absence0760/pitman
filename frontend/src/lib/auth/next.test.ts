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
		['/sign-in/?next=/users']
	])('refuses %j and goes home', (raw) => {
		expect(safeNext(raw)).toBe('/');
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
