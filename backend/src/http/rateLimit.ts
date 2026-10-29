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
 * CloudFront appends the viewer's address as the **last** X-Forwarded-For entry, so that one is
 * trusted, never the first (which the client can write). Locally there is no header: every request
 * shares one bucket.
 */
export function clientKey(c: Context): string {
	const viewer = c.req.header('cloudfront-viewer-address');
	if (viewer) return viewer.replace(/:\d+$/, '');
	const xff = c.req.header('x-forwarded-for');
	const last = xff?.split(',').at(-1)?.trim();
	return last || 'local';
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
