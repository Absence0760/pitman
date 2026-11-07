/**
 * Where sign-in sends the user afterwards (`/sign-in?next=…`). `next` comes
 * from the address bar, so anyone can write a link with it: only a path on
 * this site is followed, never another origin (an open redirect would let a
 * phishing link borrow Pitman's sign-in page). Anything else goes to `/`.
 */

export const SIGN_IN_PATH = '/sign-in';

/** Routes that render without a session (A-AUTH-1). Everything else checks `/api/auth/me` on load. */
export const PUBLIC_PATHS: readonly string[] = [SIGN_IN_PATH, '/privacy', '/methods'];

export function isPublicPath(pathname: string): boolean {
	const p = pathname.replace(/\/+$/, '') || '/';
	return PUBLIC_PATHS.includes(p);
}

// A stand-in origin to resolve against: whatever `next` says, it must still be on this one.
const HERE = 'https://pitman.invalid';
// '//', '/\\', '/%2F' or '/%5C' at the start of a path.
const LEADING_SECOND_SLASH = /^\/(?:[/\\]|%2f|%5c)/i;

/** A same-site path to go to after signing in, or `/`. */
export function safeNext(raw: string | null | undefined): string {
	if (typeof raw !== 'string' || raw === '') return '/';
	// Only a path: '/x', never '//host' or '/\host' (browsers read a backslash as a slash), a scheme or a bare word.
	if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
	// Control characters (tab, newline) are stripped by the URL parser, which can turn '/\t/host' into '//host'.
	if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
	let url: URL;
	try {
		url = new URL(raw, HERE);
	} catch {
		return '/';
	}
	if (url.origin !== HERE) return '/';
	// Check what is returned, not what came in: resolving '/.//host' or '/%2e//host' collapses the dot
	// segment and leaves '//host', which a browser reads as another origin. A leading slash or backslash,
	// literal or percent-encoded, after the first is refused too.
	if (LEADING_SECOND_SLASH.test(url.pathname)) return '/';
	const path = url.pathname + url.search + url.hash;
	if (!path.startsWith('/') || new URL(path, HERE).origin !== HERE) return '/';
	// Back to sign-in would loop.
	if (url.pathname.replace(/\/+$/, '') === SIGN_IN_PATH) return '/';
	return path;
}

/** The sign-in link that returns to `here` (path, query and hash of the current page). */
export function signInHref(here: string): string {
	const next = safeNext(here);
	return next === '/' ? SIGN_IN_PATH : `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`;
}
