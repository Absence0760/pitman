import { describe, expect, it } from 'vitest';
import { actionText, actorText } from './audit.js';

describe('the audit log in words', () => {
	it('names who acted, without showing a key as an address', () => {
		expect(actorText('admin@example.test')).toBe('admin@example.test');
		expect(actorText('operator')).toBe('The operator');
		expect(actorText('unlisted:3f9a')).toBe('An address not on the list');
		expect(actorText('system')).toBe('Mail delivery');
	});

	it('says each of auth-kit’s actions', () => {
		const t = 'user@example.test';
		expect(actionText({ at: '', actor: 'a', action: 'add', target: t })).toBe(`added ${t}`);
		expect(actionText({ at: '', actor: 'a', action: 'add', target: t, admin: true })).toBe(`added ${t} as an admin`);
		expect(actionText({ at: '', actor: 'a', action: 'remove', target: t })).toBe(`removed ${t}`);
		expect(actionText({ at: '', actor: 'a', action: 'make admin', target: t })).toBe(`made ${t} an admin`);
		expect(actionText({ at: '', actor: 'a', action: 'remove admin', target: t })).toBe(`took admin rights from ${t}`);
		expect(actionText({ at: '', actor: 'a', action: 'bootstrap', target: t })).toBe(`made ${t} the first admin`);
		expect(actionText({ at: '', actor: 'a', action: 'recover', target: t })).toBe(`restored admin rights to ${t}`);
		expect(actionText({ at: '', actor: 'a', action: 'clear-lock', target: t })).toBe(`cleared the sign-in lock on ${t}`);
		expect(actionText({ at: '', actor: 'a', action: 'erase', target: t })).toBe(`erased ${t} from the log`);
		// Pitman's own (`pnpm admin:export`), until auth-kit has an access-request action.
		expect(actionText({ at: '', actor: 'operator', action: 'export', target: t })).toBe(`exported what Pitman holds about ${t} (access request)`);
		expect(actionText({ at: '', actor: 'system', action: 'mail.bounce', target: t })).toBe(`reported that mail to ${t} bounced`);
		expect(actionText({ at: '', actor: 'system', action: 'mail.complaint', target: t })).toBe(`reported that ${t} marked Pitman’s mail as spam`);
		expect(actionText({ at: '', actor: 'a', action: 'mail.cleared', target: t })).toBe(`cleared the mail problem for ${t}`);
		expect(actionText({ at: '', actor: 'a', action: 'signin', target: null })).toBe('signed in');
		expect(actionText({ at: '', actor: 'a', action: 'signin.failed' })).toBe('entered a wrong code');
		expect(actionText({ at: '', actor: 'a', action: 'signin.locked' })).toBe('was locked out after wrong codes');
	});

	it('shows an action it doesn’t know as it came', () => {
		expect(actionText({ at: '', actor: 'a', action: 'rename', target: 'x@y.test' })).toBe('rename: x@y.test');
		expect(actionText({ at: '', actor: 'a', action: 'rename' })).toBe('rename');
	});
});
