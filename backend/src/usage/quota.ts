// The per-user daily quota on the costly routes (decision R4-D7): each signed-in user may make so many
// requests of a route per UTC day, counted across every Lambda instance (usage/store.ts). The per-IP,
// per-instance limits (http/rateLimit.ts) and the WAF stay in front: they bound a burst, this bounds a day.
//
// Every request that reaches the route is counted, a cached answer or a refusal included: the count comes
// before the work, so it can't be outrun by requests in flight. Fails closed: with no usable store, or a
// store that doesn't answer, the route answers 503 rather than serving uncounted.
import { createMiddleware } from 'hono/factory';
import type { AuthEnv } from '../auth/middleware.js';
import { logUnexpected } from '../http/logError.js';
import type { UsageStore } from './store.js';

export const DAY_MS = 86_400_000;
export const QUOTA_UNCONFIGURED = 'usage limits are not configured on this server';
export const QUOTA_UNAVAILABLE = 'usage limits could not be checked just now; try again shortly';

export interface DailyQuotaOptions {
	usage: UsageStore | { problem: string };
	/** The route's name in the count's key (`chirps`, `delineate`, …). */
	route: string;
	/** What one request is, plural, for the 429's message ("CHIRPS rainfall reads"). */
	what: string;
	limit: number;
	now?: () => number;
}

/** The UTC day of `t`, `YYYY-MM-DD`. */
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The count's key: one per route, user and UTC day. The user is auth-kit's random id, never the address. */
export const quotaKey = (route: string, userId: string, day: string) => `quota#${route}#${userId}#${day}`;

/** When a day's count may be forgotten (epoch seconds): a day after it ends, so a clock a little off still finds it. */
export const quotaExpiresAt = (t: number) => Math.floor((Math.floor(t / DAY_MS) + 2) * (DAY_MS / 1000));

function untilReset(t: number) {
	const ms = (Math.floor(t / DAY_MS) + 1) * DAY_MS - t;
	const seconds = Math.max(1, Math.ceil(ms / 1000));
	const minutes = Math.ceil(seconds / 60);
	const text = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
	return { seconds, text };
}

/** Logged once per instance, by its description (as sign-in's `auth.unconfigured`). */
let unconfiguredLogged = false;

export function dailyQuota(opts: DailyQuotaOptions) {
	const now = opts.now ?? Date.now;
	return createMiddleware<AuthEnv>(async (c, next) => {
		const usage = opts.usage;
		if ('problem' in usage) {
			if (!unconfiguredLogged) {
				unconfiguredLogged = true;
				console.error(JSON.stringify({ event: 'usage.unconfigured', problem: usage.problem }));
			}
			return c.json({ error: QUOTA_UNCONFIGURED }, 503);
		}
		const t = now();
		// The gate (auth/middleware.ts) runs first, so there is always a user here.
		const user = c.get('user');
		let counted: boolean;
		try {
			counted = await usage.take(quotaKey(opts.route, user.id, utcDay(t)), opts.limit, quotaExpiresAt(t));
		} catch (err) {
			logUnexpected('usage.quota_failed', err);
			return c.json({ error: QUOTA_UNAVAILABLE }, 503);
		}
		if (!counted) {
			const reset = untilReset(t);
			c.header('Retry-After', String(reset.seconds));
			return c.json({ error: `you have used today's ${opts.limit.toLocaleString('en-ZA')} ${opts.what}, the daily limit per user; it resets at 00:00 UTC, in ${reset.text}` }, 429);
		}
		await next();
	});
}

/** For tests: lets the next unconfigured store log again. */
export function resetQuotaLogForTests() {
	unconfiguredLogged = false;
}
