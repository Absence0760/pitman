// A per-client request limit **per Lambda instance**: a fixed window counted in this process's memory.
// Lambda runs many instances, each with its own counts, so this bounds what one client can make one
// instance do (a burst of CHIRPS reads), not what it can make the service do: the global per-IP limit is
// the WAF rate rule on the CloudFront distribution (infra/waf.tf), and the Lambda's reserved concurrency
// bounds the rest.
import type { Context, MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
	/** Requests one client may make per window. */
	limit: number;
	windowMs: number;
	now?: () => number;
	/** Clients tracked before the oldest windows are dropped (a bound on memory). */
	maxClients?: number;
}

/**
 * The client's address. Behind CloudFront (the only way in once CLOUDFRONT_SHARED_SECRET is set),
 * CloudFront appends the viewer's address to X-Forwarded-For, so the entries on the left are the
 * client's own writing and never trusted. Whether the Function URL then appends the address that
 * connected to it (the CloudFront edge) is not documented, so entries equal to that connecting address
 * (the Lambda event's `requestContext.http.sourceIp`) are dropped from the right first: the key is the
 * viewer either way, never the edge that many unrelated viewers share. Locally there is no header:
 * every request shares one bucket. `CloudFront-Viewer-Address` is deliberately not read: the origin
 * request policy (AllViewerExceptHostHeader) doesn't ask CloudFront to add it, so a client could send
 * its own and choose its key.
 */
export function clientKey(c: Context): string {
	const entries = (c.req.header('x-forwarded-for') ?? '')
		.split(',')
		.map((e) => e.trim())
		.filter(Boolean);
	const source = connectingAddress(c);
	while (source && entries.length > 1 && entries.at(-1) === source) entries.pop();
	return entries.at(-1) || 'local';
}

/** The address that opened the connection to the Function URL, from the Lambda event (hono/aws-lambda puts it on `c.env`). */
function connectingAddress(c: Context): string | undefined {
	const env = c.env as { event?: { requestContext?: { http?: { sourceIp?: unknown } } } } | undefined;
	const ip = env?.event?.requestContext?.http?.sourceIp;
	return typeof ip === 'string' && ip ? ip : undefined;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
	const now = opts.now ?? Date.now;
	const maxClients = opts.maxClients ?? 10_000;
	const windows = new Map<string, { start: number; count: number }>();
	return async (c, next) => {
		const t = now();
		const key = clientKey(c);
		let w = windows.get(key);
		if (!w || t - w.start >= opts.windowMs) {
			windows.delete(key);
			w = { start: t, count: 0 };
			windows.set(key, w);
			// Oldest first: drop windows past their time, then the oldest while there are too many.
			for (const [k, v] of windows) {
				if (windows.size <= maxClients && t - v.start < opts.windowMs) break;
				if (k !== key) windows.delete(k);
			}
		}
		if (w.count >= opts.limit) {
			const retry = Math.max(1, Math.ceil((w.start + opts.windowMs - t) / 1000));
			c.header('Retry-After', String(retry));
			return c.json({ error: `too many requests from this address: at most ${opts.limit} every ${Math.round(opts.windowMs / 60_000)} minutes; try again in ${retry} s` }, 429);
		}
		w.count++;
		await next();
	};
}
