// Every kind of record that can name a person, in one list for both data-subject operator scripts:
// `pnpm admin:erase` (erase-address.ts) removes or pseudonymises each, and `pnpm admin:export`
// (export-address.ts) reads each, one section per kind. personal-records.test.ts runs a real erasure over a
// store holding every kind, classifies each item it deletes or rewrites, and fails if erasure touched a kind
// that is not listed here, or a kind the export left empty: so an access request can never come back with
// less than an erasure would remove. docs/security.md § Access requests and § Erasure.

/** What each kind is, in the words an export uses. Keyed by the export's section names. */
export const PERSONAL_RECORDS = {
	user: 'Your user record: your address, whether you are an admin, who added you and when, when you last signed out everywhere, and any mail-delivery problem recorded against you.',
	address: 'The index entry that finds your user record from your address.',
	code: 'A sign-in code that is waiting to be used (only its keyed hash is stored, never the code), when it expires and how many wrong tries it has had.',
	throttle: 'Your sign-in limits: when codes were sent to you in the last 24 hours, wrong codes in a row, and any lock.',
	auditActor: 'Audit-log rows recording something you did (sign-ins, wrong codes, changes you made to the user list). Other people’s addresses are withheld.',
	auditTarget: 'Audit-log rows recording something done to you or about you (being added, made admin, a mail problem, a lock cleared). Other people’s addresses are withheld.',
	addedBy: 'Users you added, who still name you as "added by". Their addresses are withheld.',
	sesSuppression: 'Whether Amazon SES has put your address on Pitman’s suppression list (after a hard bounce or a spam complaint), and when.'
} as const;

export type PersonalRecordKind = keyof typeof PERSONAL_RECORDS;

export const PERSONAL_RECORD_KINDS = Object.keys(PERSONAL_RECORDS) as PersonalRecordKind[];
