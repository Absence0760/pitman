// How the API refuses: always `{ error }` JSON with a message written by us (never a stack or an
// upstream body), and a status that says whose problem it is.
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CopyUnavailableError } from '../chirps/copy.js';
import { AreaRefusedError } from '../chirps/monthly.js';
import { ReadDeadlineError } from '../chirps/readMonthly.js';
import { logUnexpected } from './logError.js';

/** A refusal with its status. */
export class ApiError extends Error {
	constructor(
		readonly status: ContentfulStatusCode,
		message: string,
		readonly extra: Record<string, unknown> = {}
	) {
		super(message);
	}
}

/** The response for anything a route threw: known refusals keep their message, anything else is a 500. */
export function errorResponse(c: Context, err: unknown) {
	if (err instanceof ApiError) return c.json({ error: err.message, ...err.extra }, err.status);
	if (err instanceof AreaRefusedError) return c.json({ error: err.message }, 422);
	if (err instanceof ReadDeadlineError) return c.json({ error: err.message }, 504);
	if (err instanceof CopyUnavailableError) return c.json({ error: err.message }, 503);
	// Name and code only: a message can carry a request's values (A-AUTH-11).
	logUnexpected('unhandled_error', err);
	return c.json({ error: 'Internal server error' }, 500);
}
