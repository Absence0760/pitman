// An error as a log line may carry it (A-AUTH-11): its name and an AWS-style error code, never the message
// (SES and others fill it with the request's own values, a recipient's address among them) and never the
// stack, whose first line repeats the message.
export interface ErrorSummary {
	error: string;
	code?: string;
}

export function errorSummary(e: unknown): ErrorSummary {
	if (!(e instanceof Error)) return { error: typeof e };
	const summary: ErrorSummary = { error: /^[A-Za-z0-9_.-]{1,64}$/.test(e.name) ? e.name : 'Error' };
	const raw = e as { code?: unknown; Code?: unknown };
	const code = raw.code ?? raw.Code;
	if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) summary.code = code;
	return summary;
}

/** Logs an unexpected error as one JSON line: `{"event": <event>, "error": <name>, "code"?: <code>}`. */
export function logUnexpected(event: string, e: unknown) {
	console.error(JSON.stringify({ event, ...errorSummary(e) }));
}
