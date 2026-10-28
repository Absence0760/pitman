/**
 * Example domain module. Real projects replace this with their own
 * topic modules under `src/lib/`, grouped by topic rather than by type
 * (see CLAUDE.md "Code organization"). It ships so the template has a
 * working `$lib` import plus a co-located test — not an empty folder.
 */
export function greeting(name: string): string {
	const trimmed = name.trim();
	return trimmed ? `Hello, ${trimmed}!` : 'Hello!';
}
