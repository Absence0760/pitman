import { describe, expect, it } from 'vitest';
import { PRIVACY_CONTACT } from './contact.js';

describe('the privacy notice’s responsible party', () => {
	it('names a person', () => {
		expect(PRIVACY_CONTACT.name.trim()).not.toBe('');
	});

	// A release (CI_RELEASE=1, set by the deploy workflow) must publish a contact address: POPIA s18 requires the
	// responsible party's address in the notice. Outside a release it may still be null (being set up), but if it is
	// set it must be an address.
	it('privacy contact address is set', () => {
		const email = PRIVACY_CONTACT.email;
		if (process.env['CI_RELEASE'] === '1') expect(email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
		else if (email !== null) expect(email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
	});
});
