import { describe, expect, it } from 'vitest';
import { groupIssues, issueLocation, issueText } from './issues.js';

describe('issue text', () => {
	it('names the file, line, column and field, then the problem', () => {
		const issue = { level: 'error' as const, file: 'SYRU1.DAT', line: 2, column: 9, field: 'L.002 AREA', message: 'expected a number' };
		expect(issueLocation(issue)).toBe('SYRU1.DAT, line 2, column 9, field L.002 AREA');
		expect(issueText(issue)).toBe('SYRU1.DAT, line 2, column 9, field L.002 AREA: expected a number');
		expect(issueLocation({ level: 'error', file: '(folder)', message: 'x' })).toBe('(folder)');
	});

	it('groups by file in name order, each file by line', () => {
		const groups = groupIssues([
			{ level: 'error', file: 'B.DAT', line: 9, message: 'b9' },
			{ level: 'error', file: 'A.DAT', message: 'a' },
			{ level: 'error', file: 'B.DAT', line: 3, message: 'b3' }
		]);
		expect(groups.map((g) => [g.file, g.issues.map((i) => i.message)])).toEqual([
			['A.DAT', ['a']],
			['B.DAT', ['b3', 'b9']]
		]);
	});
});
