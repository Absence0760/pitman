/**
 * One place that hears "the session is gone". Every API client fetches
 * through `sessionFetch`, which calls the registered handler when the API
 * answers 401; the root layout registers one that sends the user to
 * `/sign-in?next=<this page>`. The response still reaches the client, which
 * fails its request as before, so nothing else changes.
 *
 * The handler navigates inside the app (no reload) and never touches
 * IndexedDB: the working copy is written on every change, so it is there
 * when the user comes back signed in.
 */

export type UnauthorizedHandler = () => void;

let handler: UnauthorizedHandler | undefined;

/** Register the handler; returns a function that removes it. Only one at a time. */
export function onUnauthorized(next: UnauthorizedHandler): () => void {
	handler = next;
	return () => {
		if (handler === next) handler = undefined;
	};
}

/** Tell the handler (if any) that the API refused the session. */
export function reportUnauthorized(): void {
	handler?.();
}

/** `fetch` (or `inner`, a test's fake) that reports a 401 before handing the response back. */
export function sessionFetch(inner?: typeof fetch): typeof fetch {
	const doFetch = inner ?? globalThis.fetch.bind(globalThis);
	return async (input, init) => {
		const response = await doFetch(input, init);
		if (response.status === 401) reportUnauthorized();
		return response;
	};
}
