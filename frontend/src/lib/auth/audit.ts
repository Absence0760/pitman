/** The Users page's audit log in words: who did what to whom (auth-kit's `AuditAction`s). */

import type { AuditRow } from './api.js';

/** `operator` and `unlisted:<key>` are not addresses: say what they are. */
export function actorText(actor: string): string {
	if (actor === 'operator') return 'The operator';
	if (actor.startsWith('unlisted:')) return 'An address not on the list';
	if (actor.startsWith('erased:')) return 'An erased user';
	return actor;
}

/** What happened, as a sentence fragment after the actor. */
export function actionText(row: AuditRow): string {
	const target = row.target ?? '';
	switch (row.action) {
		case 'bootstrap':
			return `made ${target} the first admin`;
		case 'add':
			return row.admin ? `added ${target} as an admin` : `added ${target}`;
		case 'remove':
			return `removed ${target}`;
		case 'make admin':
			return `made ${target} an admin`;
		case 'remove admin':
			return `took admin rights from ${target}`;
		case 'recover':
			return `restored admin rights to ${target}`;
		case 'clear-lock':
			return `cleared the sign-in lock on ${target}`;
		case 'erase':
			return `erased ${target} from the log`;
		case 'signin':
			return 'signed in';
		case 'signin.failed':
			return 'entered a wrong code';
		case 'signin.locked':
			return 'was locked out after wrong codes';
		default:
			return target ? `${row.action}: ${target}` : row.action;
	}
}
