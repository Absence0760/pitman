// The access export covers at least what erasure removes: a real erasure (auth-kit's memory store, the
// erase script itself) over a store holding every kind of personal record, each item it deletes or
// rewrites classified into a kind from personal-records.ts. Fails if erasure touches an item or attribute
// no kind accounts for (a new record auth-kit started keeping), if the seed misses a kind (so the guard
// would be hollow), or if the export, run on the same store first, finds nothing of a kind erasure touched.
import { Readable, Writable } from 'node:stream';
import { createAuthKit, cryptoRandom, memoryStore, randomSecret, type Item } from '@absence0760/auth-kit';
import { describe, expect, it } from 'vitest';
import { guardLogs } from '../src/__tests__/logGuard.js';
import { main as erase } from './erase-address.js';
import { gatherExport } from './export-address.js';
import { PERSONAL_RECORD_KINDS, type PersonalRecordKind } from './personal-records.js';

guardLogs();

const ADMIN = 'admin@example.test';
const USER = 'user@example.test';
const OTHER = 'other@example.test';

/** A store with every kind of record naming USER. */
async function everyKind() {
	const store = memoryStore();
	const kit = createAuthKit({ store, codeSecret: randomSecret(cryptoRandom), sessionKeys: [{ kid: 'k', secret: randomSecret(cryptoRandom) }] });
	const admin = await kit.bootstrapAdmin(ADMIN);
	if (!admin.ok) throw new Error(admin.error);
	// user + address, and an audit row naming USER as target (added, as an admin so erasure isn't refused as the last).
	const user = await kit.addUser(admin.value, USER, true);
	if (!user.ok) throw new Error(user.error);
	// addedBy on OTHER, and an audit row naming USER as actor.
	const other = await kit.addUser(user.value, OTHER, false);
	if (!other.ok) throw new Error(other.error);
	// code and throttle, and a signin.failed row with USER as actor.
	expect((await kit.requestCode(USER)).status).toBe('accepted');
	await kit.verifyCode(USER, '000000');
	// The delivery-problem flag on the user item, and a mail.bounce row with USER as target.
	expect((await kit.recordDeliveryProblem(USER, 'bounce', new Date().toISOString())).ok).toBe(true);
	return { store, kit };
}

const keyOf = (i: Item) => `${i.pk}\u0000${i.sk}`;

function deletedKind(i: Item): PersonalRecordKind {
	if (i.pk === 'USER') return 'user';
	if (i.pk.startsWith('EMAIL#')) return 'address';
	if (i.pk.startsWith('CODE#')) return 'code';
	if (i.pk.startsWith('THROTTLE#')) return 'throttle';
	throw new Error(`erasure deleted an item no personal-record kind accounts for: ${i.pk.split('#')[0]}`);
}

function changedKind(i: Item, attr: string): PersonalRecordKind | null {
	if (i.pk === 'META#admins') return null; // the admin count: names nobody
	if (i.pk === 'AUDIT' && attr === 'actor') return 'auditActor';
	if (i.pk === 'AUDIT' && attr === 'target') return 'auditTarget';
	if (i.pk === 'USER' && attr === 'addedBy') return 'addedBy';
	throw new Error(`erasure changed ${i.pk.split('#')[0]}.${attr}, which no personal-record kind accounts for`);
}

/** The kinds an erasure touched, from the store before and after, plus SES if it removed a suppression. */
function touched(before: Item[], after: Item[], sesRemoved: boolean): Set<PersonalRecordKind> {
	const kinds = new Set<PersonalRecordKind>();
	const afterByKey = new Map(after.map((i) => [keyOf(i), i]));
	const beforeKeys = new Set(before.map(keyOf));
	for (const b of before) {
		const a = afterByKey.get(keyOf(b));
		if (!a) {
			kinds.add(deletedKind(b));
			continue;
		}
		for (const attr of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (JSON.stringify(a[attr]) === JSON.stringify(b[attr])) continue;
			const k = changedKind(b, attr);
			if (k) kinds.add(k);
		}
	}
	for (const a of after) {
		if (beforeKeys.has(keyOf(a))) continue;
		// Erasure's own audit row, which names only the pseudonym.
		if (a.pk === 'AUDIT' && a.action === 'erase' && String(a.target).startsWith('erased:')) continue;
		throw new Error(`erasure wrote an item no personal-record kind accounts for: ${a.pk.split('#')[0]}`);
	}
	if (sesRemoved) kinds.add('sesSuppression');
	return kinds;
}

function quietIO(lines: string[]) {
	return {
		stdin: Readable.from(lines.map((l) => `${l}\n`)),
		stdout: new Writable({ write: (_c, _e, done) => done() }),
		args: []
	};
}

describe('access export covers erasure', () => {
	it('every kind erasure touches is listed, seeded and found by the export', async () => {
		const { store, kit } = await everyKind();
		const exported = await gatherExport(kit, USER, { reason: 'BOUNCE', lastUpdated: '2026-11-07T08:00:00.000Z' });
		expect(Object.keys(exported.records)).toEqual(PERSONAL_RECORD_KINDS);

		const before = store.dump();
		let sesRemoved = false;
		const ses = async () => ({ remove: async () => ((sesRemoved = true), 'removed' as const), where: 'the test SES' });
		expect(await erase(quietIO([USER, 'ERASE']), async () => ({ kit, where: 'the test store' }), ses)).toBe(0);
		const kinds = touched(before, store.dump(), sesRemoved);

		// The seed reaches every kind, so this test would notice any one of them dropping out of the export.
		expect([...kinds].sort()).toEqual([...PERSONAL_RECORD_KINDS].sort());
		for (const k of kinds) expect(exported.records[k].found, k).toBeGreaterThan(0);
	});

	it('the export withholds everyone else’s address', async () => {
		const { kit } = await everyKind();
		const json = JSON.stringify(await gatherExport(kit, USER, null));
		expect(json).toContain(USER);
		expect(json).not.toContain(ADMIN);
		expect(json).not.toContain(OTHER);
		expect(json).toContain('another person (withheld)');
	});

	it('the classifier refuses an item it can’t account for', () => {
		const stray = { pk: 'NEWTHING#x', sk: 'NEWTHING' };
		expect(() => touched([stray], [], false)).toThrow(/no personal-record kind/);
		expect(() => touched([], [stray], false)).toThrow(/no personal-record kind/);
		const user = { pk: 'USER', sk: 'USER#1', email: USER };
		expect(() => touched([user], [{ ...user, email: 'x' }], false)).toThrow(/USER\.email/);
	});
});
