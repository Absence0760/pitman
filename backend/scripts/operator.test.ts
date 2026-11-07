// The operator scripts on auth-kit's memory store: each reads the address from stdin and refuses one on
// the command line (shell history), does what it says with one audit row, and prints no address.
import { Readable, Writable } from 'node:stream';
import { createAuthKit, cryptoRandom, memoryStore, randomSecret, type AuthKit, type MemoryStore } from '@absence0760/auth-kit';
import { describe, expect, it } from 'vitest';
import { guardLogs } from '../src/__tests__/logGuard.js';
import { main as bootstrap } from './bootstrap-admin.js';
import { main as clearLock } from './clear-lock.js';
import { main as erase, SES_STEP } from './erase-address.js';
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

	it('erase asks for confirmation, leaves no copy of the address, and prints the SES step without it', async () => {
		const { store, getKit } = await seeded();
		const unconfirmed = io([USER, 'yes']);
		expect(await erase(unconfirmed.io, getKit)).toBe(1);
		expect(JSON.stringify(store.dump())).toContain(USER);

		const run = io([USER, 'ERASE']);
		expect(await erase(run.io, getKit)).toBe(0);
		expect(JSON.stringify(store.dump())).not.toContain(USER);
		expect(audit(store)).toContain('erase');
		expect(run.out()).toContain(SES_STEP);
		expect(run.out()).not.toContain(USER);
		expect(SES_STEP).toBe('aws sesv2 delete-suppressed-destination --email-address ADDRESS --profile pitman --region af-south-1');
	});

	it('erase refuses the last admin', async () => {
		const { store, getKit } = await seeded();
		const run = io([ADMIN, 'ERASE']);
		expect(await erase(run.io, getKit)).toBe(1);
		expect(run.out()).toContain('Refused (409)');
		expect((await store.listUsers()).map((u) => u.email)).toContain(ADMIN);
	});
});
