// ISO dates as whole days since 1970-01-01 (UTC), the few helpers the copied mirror code took from
// IC-WBT's `@water-management/engine/calendar` (toEpochDay, fromEpochDay, isIsoDate). Proleptic
// Gregorian, through Date.UTC, so leap years are the calendar's.

const DAY_MS = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `s` is a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(s: string): boolean {
	const m = ISO.exec(s);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const t = new Date(Date.UTC(y, mo - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Days since 1970-01-01 of an ISO date (throws on anything else). */
export function toEpochDay(iso: string): number {
	if (!isIsoDate(iso)) throw new RangeError(`not an ISO date: ${iso}`);
	return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS;
}

/** The ISO date of a day count since 1970-01-01. */
export function fromEpochDay(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Days in calendar month `month` (1 = January) of `year`. */
export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
