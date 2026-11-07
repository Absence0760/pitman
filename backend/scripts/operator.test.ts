// The operator scripts on auth-kit's memory store: each reads the address from stdin and refuses one on
// the command line (shell history), does what it says with one audit row, and prints no address.
import { Readable, Writable } from 'node:stream';
import { createAuthKit, cryptoRandom, memoryStore, randomSecret, type AuthKit, type MemoryStore } from '@absence0760/auth-kit';
import { describe, expect, it } from 'vitest';
import { guardLogs } from '../src/__tests__/logGuard.js';
import { main as bootstrap } from './bootstrap-admin.js';
import { main as clearLock } from './clear-lock.js';
import { main as erase, sesSuppression, sesSuppressionRemover, type Suppression } from './erase-address.js';
import { OperatorError } from './operator.js';
import { main as recover } from './recover-admin.js';

guardLogs();

const ADMIN = 'admin@example.test';
const USER = 'user@example.test';

function setUp() {
	const store = memoryStore();
	const kit = createAuthKit({ store, codeSecret: randomSecret(cryptoRandom), sessionKeys: [{ kid: 'k', secret: randomSecret(cryptoRandom) }] });
	return { store, kit, getKit: async () => ({ kit, where: 'the test store' }) };
}

function io(lines: string[], args: string[] = []) {
	let out = '';
	return {
		io: {
			stdin: Readable.from(lines.map((l) => `${l}\n`)),
			stdout: new Writable({
				write(chunk, _enc, done) {
					out += String(chunk);
					done();
				}
			}),
			args
		},
		out: () => out
	};
}

const audit = (store: MemoryStore) => store.dump().filter((i) => i.pk === 'AUDIT').map((i) => i.action);

async function seeded() {
	const s = setUp();
	const admin = await s.kit.bootstrapAdmin(ADMIN);
	if (!admin.ok) throw new Error(admin.error);
	const user = await s.kit.addUser(admin.value, USER, false);
	if (!user.ok) throw new Error(user.error);
	return { ...s, admin: admin.value, user: user.value };
}

describe('the operator scripts', () => {
	it.each([
		['bootstrap', bootstrap],
		['recover', recover],
		['clear-lock', clearLock],
		['erase', erase]
	] as const)('%s refuses an address on the command line before touching the store', async (_name, main) => {
		let asked = false;
		const run = io([ADMIN, 'ERASE'], [ADMIN]);
		await expect(
			main(run.io, async () => {
				asked = true;
				return { kit: {} as AuthKit, where: '' };
			})
		).rejects.toThrow(OperatorError);
		expect(asked).toBe(false);
	});

	it('bootstrap reads the address from stdin, once only', async () => {
		const { store, getKit } = setUp();
		const first = io([` ${ADMIN} `]);
		expect(await bootstrap(first.io, getKit)).toBe(0);
		expect((await store.listUsers()).map((u) => [u.email, u.isAdmin])).toEqual([[ADMIN, true]]);
		expect(first.out()).not.toContain(ADMIN);
		const second = io([USER]);
		expect(await bootstrap(second.io, getKit)).toBe(1);
		expect(second.out()).toContain('Refused (409)');
		expect(audit(store)).toEqual(['bootstrap']);
	});

	it('recover makes a listed user an admin and audits it', async () => {
		const { store, getKit, user } = await seeded();
		const run = io([USER]);
		expect(await recover(run.io, getKit)).toBe(0);
		expect((await store.getUser(user.id))?.isAdmin).toBe(true);
		expect(audit(store).filter((a) => a === 'recover')).toHaveLength(1);
		expect(run.out()).not.toContain(USER);
		expect(await recover(io(['nobody@example.test']).io, getKit)).toBe(1);
	});

	it('clear-lock clears a locked address without changing its role', async () => {
		const { store, kit, getKit, user } = await seeded();
		for (let i = 0; i < 5; i++) await kit.verifyCode(USER, '000000');
		expect((await kit.requestCode(USER)).status).toBe('locked');
		const run = io([USER]);
		expect(await clearLock(run.io, getKit)).toBe(0);
		expect((await kit.requestCode(USER)).status).toBe('accepted');
		expect((await store.getUser(user.id))?.isAdmin).toBe(false);
		expect(audit(store).filter((a) => a === 'clear-lock')).toHaveLength(1);
		expect(run.out()).not.toContain(USER);
	});

	it('clear-lock also lifts a spent daily send budget (the remedy for auth.send_capped)', async () => {
		let now = Date.parse('2026-11-07T08:00:00Z');
		const store = memoryStore();
		const kit = createAuthKit({ store, codeSecret: randomSecret(cryptoRandom), sessionKeys: [{ kid: 'k', secret: randomSecret(cryptoRandom) }], clock: { now: () => now } });
		const admin = await kit.bootstrapAdmin(ADMIN);
		if (!admin.ok) throw new Error(admin.error);
		// Ten sends, spaced past the 60 s gap and the hourly limit: the day's budget.
		for (let i = 0; i < 10; i++) {
			expect((await kit.requestCode(ADMIN)).status).toBe('accepted');
			now += i === 4 ? 60 * 60_000 : 61_000;
		}
		// An hour on, the hourly limit has passed but the daily cap holds, for most of a day.
		now += 60 * 60_000;
		const capped = await kit.requestCode(ADMIN);
		expect(capped.status).toBe('throttled');
		expect(capped.status === 'throttled' && capped.retryAfterMs).toBeGreaterThan(10 * 60 * 60_000);
		expect(await clearLock(io([ADMIN]).io, async () => ({ kit, where: 'the test store' }))).toBe(0);
		expect((await kit.requestCode(ADMIN)).status).toBe('accepted');
	});

	it('erase asks for confirmation, leaves no copy of the address, and clears its SES suppression itself', async () => {
		const { store, getKit } = await seeded();
		const removed: string[] = [];
		const ses = async (): Promise<Suppression> => ({ remove: async (e) => (removed.push(e), 'removed'), where: 'the test SES' });
		const unconfirmed = io([USER, 'yes']);
		expect(await erase(unconfirmed.io, getKit, ses)).toBe(1);
		expect(JSON.stringify(store.dump())).toContain(USER);
		expect(removed).toEqual([]);

		// Typed with spaces and capitals: SES gets the address auth-kit erased, read once from stdin.
		const run = io([' User@Example.test ', 'ERASE']);
		expect(await erase(run.io, getKit, ses)).toBe(0);
		expect(JSON.stringify(store.dump())).not.toContain(USER);
		expect(audit(store)).toContain('erase');
		expect(removed).toEqual([USER]);
		expect(run.out()).toContain('SES suppression list (the test SES): the address was removed.');
		// No command to type the address into, and no copy of it.
		expect(run.out()).not.toMatch(/aws sesv2|ADDRESS/);
		expect(run.out().toLowerCase()).not.toContain(USER);
	});

	it('erase treats a NotFoundException as never suppressed', async () => {
		const { getKit } = await seeded();
		const sent: unknown[] = [];
		const client = { send: async (cmd: unknown) => { sent.push(cmd); throw Object.assign(new Error(`${USER} is not on the suppression list`), { name: 'NotFoundException' }); } };
		const run = io([USER, 'ERASE']);
		expect(await erase(run.io, getKit, async () => ({ remove: sesSuppressionRemover(client as never), where: 'the test SES' }))).toBe(0);
		expect(sent).toHaveLength(1);
		expect((sent[0] as { constructor: { name: string }; input: unknown }).constructor.name).toBe('DeleteSuppressedDestinationCommand');
		expect((sent[0] as { input: unknown }).input).toEqual({ EmailAddress: USER });
		expect(run.out()).toContain('the address was not on it');
		expect(run.out()).not.toContain(USER);
	});

	it('erase reports an SES failure by name only and exits 1, the database part done and safe to repeat', async () => {
		const { store, getKit } = await seeded();
		const denied = async (): Promise<Suppression> => ({
			remove: sesSuppressionRemover({ send: async () => { throw Object.assign(new Error(`User is not authorized to delete ${USER}`), { name: 'AccessDeniedException' }); } } as never),
			where: 'the test SES'
		});
		const run = io([USER, 'ERASE']);
		expect(await erase(run.io, getKit, denied)).toBe(1);
		expect(JSON.stringify(store.dump())).not.toContain(USER);
		expect(run.out()).toContain('failed (AccessDeniedException)');
		expect(run.out()).toContain('ses:DeleteSuppressedDestination');
		expect(run.out()).not.toContain(USER);
		// Again, once the grant is fixed: nothing left to rewrite, and SES is cleared.
		const again = io([USER, 'ERASE']);
		expect(await erase(again.io, getKit, async () => ({ remove: async () => 'removed', where: 'the test SES' }))).toBe(0);
		expect(again.out()).toContain('the address was not listed');
	});

	it('erase reports auth-kit’s “rows still appearing” throw by name and asks for a second run, touching no SES', async () => {
		const { kit } = await seeded();
		const throwing = { ...kit, eraseAddress: async () => { throw Object.assign(new Error(`rows for ${USER} keep appearing`), { name: 'ScrubIncompleteError' }); } };
		let asked = false;
		const run = io([USER, 'ERASE']);
		expect(await erase(run.io, async () => ({ kit: throwing, where: 'the test store' }), async () => { asked = true; return { remove: null, why: 'unused' }; })).toBe(1);
		expect(run.out()).toContain('Not finished (ScrubIncompleteError)');
		expect(run.out()).toContain('again');
		expect(run.out()).not.toContain(USER);
		expect(asked).toBe(false);
	});

	it('erase skips SES against DynamoDB Local, and uses af-south-1 and the pitman profile otherwise', async () => {
		const local = await sesSuppression({ DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000' });
		expect(local.remove).toBeNull();
		const { getKit } = await seeded();
		const run = io([USER, 'ERASE']);
		expect(await erase(run.io, getKit, async () => local)).toBe(0);
		expect(run.out()).toContain('SES suppression list: skipped, DynamoDB Local');

		const profile = process.env.AWS_PROFILE;
		try {
			delete process.env.AWS_PROFILE;
			const real = await sesSuppression({});
			expect(real.remove).toBeTypeOf('function');
			expect('where' in real && real.where).toBe('SES in af-south-1 (profile pitman)');
		} finally {
			if (profile === undefined) delete process.env.AWS_PROFILE;
			else process.env.AWS_PROFILE = profile;
		}
	});

	it('erase refuses the last admin', async () => {
		const { store, getKit } = await seeded();
		const run = io([ADMIN, 'ERASE']);
		expect(await erase(run.io, getKit)).toBe(1);
		expect(run.out()).toContain('Refused (409)');
		expect((await store.listUsers()).map((u) => u.email)).toContain(ADMIN);
	});
});
