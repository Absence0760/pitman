/** Display formatting for the app shell. */

/** `29 Oct 2026, 10:00` in the viewer's time zone; the ISO text when it doesn't parse. */
export function formatDateTime(iso: string, locale = 'en-ZA'): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** `1 file`, `3 files`. */
export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
