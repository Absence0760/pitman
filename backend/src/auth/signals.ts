// What auth-kit's answers say about who was affected, for the alarms only (A-AUTH-7, A-AUTH-11). Never
// changes an HTTP answer: listed and unlisted addresses must stay indistinguishable on the wire.
//
// auth-kit v0.2.0 adds the fields read here: on a `throttled` code request, `limit` ('interval' | 'hour'
// | 'day'), `capReached` (true on the request that found the daily budget just spent) and `listed`; on a
// `locked` verify, `listed` beside `lockStarted`. Pitman pins v0.1.2 until that tag ships, so the fields
// are read as optional extras: with v0.1.2 `sendCapped` is never true and `lockAlarm` keeps v0.1.2's
// behaviour (every lock start). The auth-kit bump wires both for real; signals.test.ts pins the v0.2.0 shapes.

/** The v0.2.0 fields of a throttled code request, all absent before v0.2.0. */
export interface ThrottleSignal {
	status: string;
	limit?: 'interval' | 'hour' | 'day';
	capReached?: boolean;
	listed?: boolean;
}

/** The v0.2.0 field of a locked verify, absent before v0.2.0. */
export interface LockSignal {
	status: string;
	lockStarted?: boolean;
	listed?: boolean;
}

/**
 * True when a listed address has just spent its whole daily send budget (`auth.send_capped`): from then on
 * it can't get a code for up to a day, which is a lockout nobody else would notice (docs/security.md § Known
 * risks). Unlisted addresses never count, so strangers' addresses can't hold the alarm in ALARM.
 */
export function sendCapped(r: ThrottleSignal): boolean {
	return r.status === 'throttled' && r.limit === 'day' && r.capReached === true && r.listed === true;
}

/**
 * True when this verify started a lock that should raise `auth.locked`: a listed address only (v0.2.0), so
 * wrong codes against made-up addresses can't keep the alarm in ALARM and hide a real admin's lockout.
 * Before v0.2.0 there is no `listed`, and every lock start counts, as it always has.
 */
export function lockAlarm(v: LockSignal): boolean {
	if (v.status !== 'locked' || v.lockStarted !== true) return false;
	return v.listed === undefined ? true : v.listed;
}
