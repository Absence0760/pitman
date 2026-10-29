/** Validation messages as a hydrologist reads them: file, line, field, then what is wrong. */

import type { BundleIssue } from './engine.js';

/** `SYRU1.DAT, line 2, column 9, field L.002 AREA`. */
export function issueLocation(issue: BundleIssue): string {
	const parts = [issue.file];
	if (issue.line !== undefined) parts.push(`line ${issue.line}`);
	if (issue.column !== undefined) parts.push(`column ${issue.column}`);
	if (issue.field !== undefined) parts.push(`field ${issue.field}`);
	return parts.join(', ');
}

/** The whole message on one line. */
export function issueText(issue: BundleIssue): string {
	return `${issueLocation(issue)}: ${issue.message}`;
}

/** Issues grouped by file, files in name order, each file's issues by line. */
export function groupIssues(issues: readonly BundleIssue[]): { file: string; issues: BundleIssue[] }[] {
	const byFile = new Map<string, BundleIssue[]>();
	for (const issue of issues) byFile.set(issue.file, [...(byFile.get(issue.file) ?? []), issue]);
	return [...byFile.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([file, list]) => ({ file, issues: [...list].sort((x, y) => (x.line ?? 0) - (y.line ?? 0)) }));
}
