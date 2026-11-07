/**
 * The body hash CloudFront's origin access control needs (issue #33, decision
 * R4-I6 in docs/decisions.md). In production the API's Function URL is
 * on `AWS_IAM` and CloudFront signs each `/api/*` request to it with SigV4.
 * CloudFront can't hash a body itself: for a request with one it signs the
 * hash the viewer states in `x-amz-content-sha256`, and Lambda, which takes no
 * unsigned payloads, refuses a POST or PUT that lacks it (or states a wrong
 * one) with 403 before the function runs. So every API client sends the hex
 * SHA-256 of the exact bytes it sends, for every method that can carry a body.
 *
 * Locally there is no CloudFront: the dev server ignores the header, so it is
 * harmless there. Web Crypto's `subtle` exists only in a secure context
 * (https, or localhost); on plain http from another host (the dev server
 * opened by LAN address) the header is left off rather than the request
 * failing, since only production checks it and production is https only.
 */

/** Methods that never carry a body: their requests go out untouched. */
const BODILESS = new Set(['GET', 'HEAD']);

/** The SHA-256 of zero bytes, what a POST with no body states. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The bytes `fetch` would send for `body`. FormData and streams are refused: their bytes aren't known before sending. */
async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array<ArrayBuffer> | ArrayBuffer> {
	if (body === undefined || body === null) return new Uint8Array(0);
	if (typeof body === 'string') return new TextEncoder().encode(body);
	if (typeof FormData !== 'undefined' && body instanceof FormData) {
		throw new TypeError('An API request body cannot be FormData: its multipart boundary is chosen when it is sent, so its hash cannot be stated beforehand.');
	}
	if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
		throw new TypeError('An API request body cannot be a stream: its hash must be stated before it is sent.');
	}
	// Blob, ArrayBuffer, a typed array or URLSearchParams: Response serialises them exactly as fetch does.
	return new Response(body).arrayBuffer();
}

/** Lower-case hex SHA-256 of `body`, as `x-amz-content-sha256` wants it. */
export async function contentSha256(body: BodyInit | null | undefined, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
	const digest = new Uint8Array(await subtle.digest('SHA-256', await bodyBytes(body)));
	return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `fetch` (or `inner`, a test's fake) that adds `x-amz-content-sha256` to every
 * request whose method may carry a body (anything but GET and HEAD, so POST,
 * PUT, PATCH and DELETE, with or without one). Headers go to `inner` as a
 * plain object with lower-case names.
 */
export function contentHashFetch(inner?: typeof fetch): typeof fetch {
	const doFetch = inner ?? globalThis.fetch.bind(globalThis);
	return async (input, init) => {
		const fromRequest = input instanceof Request ? input : undefined;
		const method = (init?.method ?? fromRequest?.method ?? 'GET').toUpperCase();
		const subtle = globalThis.crypto?.subtle;
		if (BODILESS.has(method) || subtle === undefined) return doFetch(input, init);
		// A Request's own body is read from a clone, so the original still sends it.
		const hash = init?.body !== undefined || !fromRequest ? await contentSha256(init?.body, subtle) : await contentSha256(await fromRequest.clone().arrayBuffer(), subtle);
		// Hashing is a step of its own: a cancel that came during it rejects here, as fetch would.
		(init?.signal ?? fromRequest?.signal)?.throwIfAborted();
		const headers = Object.fromEntries(new Headers(init?.headers ?? fromRequest?.headers));
		headers['x-amz-content-sha256'] = hash;
		return doFetch(input, { ...init, headers });
	};
}
