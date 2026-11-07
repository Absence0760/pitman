// `pnpm admin:export` on auth-kit's memory store: reads the address from stdin, audits before reading,
// writes the export only outside the repository (never overwriting, mode 0600), and prints no address.
// That its coverage equals erasure's is personal-records.test.ts's job.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createAuthKit, cryptoRandom, memoryStore, randomSecret } from '@absence0760/auth-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardLogs } from '../src/__tests__/logGuard.js';
import { type AccessExport, main as exportAddress, outputPath, sesSuppressionLookup, sesSuppressionReader, type SuppressionLookup } from './export-address.js';
import { OperatorError } from './operator.js';

guardLogs();

const ADMIN = 'admin@example.test';
const USER = 'user@example.test';
const REPO = fileURLToPath(new URL('../..', import.meta.url));

async function seeded() {
	const store = memoryStore();
	const kit = createAuthKit({ store, codeSecret: randomSecret(cryptoRandom), sessionKeys: [{ kid: 'k', secret: randomSecret(cryptoRandom) }] });
	const admin = await kit.bootstrapAdmin(ADMIN);
	if (!admin.ok) throw new Error(admin.error);
	const user = await kit.addUser(admin.value, USER, false);
	if (!user.ok) throw new Error(user.error);
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

const noSes = async (): Promise<SuppressionLookup> => ({ read: null, why: 'not in this test' });
const suppressed = async (): Promise<SuppressionLookup> => ({ read: async () => ({ reason: 'COMPLAINT', lastUpdated: '2026-11-01T10:00:00.000Z' }), where: 'the test SES' });

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'pitman-export-'));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('admin:export', () => {
	it('refuses an address on the command line before touching the store', async () => {
		let asked = false;
		await expect(
			exportAddress(io([USER, '-'], [USER]).io, async () => {
				asked = true;
				throw new Error('unreachable');
			})
		).rejects.toThrow(OperatorError);
		expect(asked).toBe(false);
	});

	it('writes every section to a new 0600 file, audits "export" first, and prints no address', async () => {
		const { store, getKit } = await seeded();
		const file = join(dir, 'answer.json');
		const run = io([' User@Example.test ', file]);
		expect(await exportAddress(run.io, getKit, suppressed)).toBe(0);
		expect(run.out()).not.toContain(USER);
		expect(run.out()).toContain(`written to ${file}`);
		expect(run.out()).toContain('Audited as "export"');
		expect((await stat(file)).mode & 0o777).toBe(0o600);

		const data = JSON.parse(await readFile(file, 'utf8')) as AccessExport;
		expect(data.address).toBe(USER);
		expect(data.records.user.data).toMatchObject({ address: USER, admin: false, addedBy: 'another person (withheld)' });
		expect(data.records.sesSuppression.data).toEqual({ reason: 'COMPLAINT', lastUpdated: '2026-11-01T10:00:00.000Z' });
		// The export's own audit row is in it: the operator exported, about "you".
		const rows = data.records.auditTarget.data as { action: string; actor: string; target: string; actionInWords: string }[];
		expect(rows.map((r) => [r.action, r.actor, r.target])).toEqual([
			['add', 'another person (withheld)', 'you'],
			['export', 'the operator', 'you']
		]);
		expect(rows[1]?.actionInWords).toMatch(/access request/);
		expect(JSON.stringify(data)).not.toContain(ADMIN);
		const audit = store.dump().filter((i) => i.pk === 'AUDIT' && i.action === 'export');
		expect(audit.map((a) => [a.actor, a.target])).toEqual([['operator', USER]]);

		// Never overwrites an earlier answer.
		const again = io([USER, file]);
		expect(await exportAddress(again.io, getKit, noSes)).toBe(1);
		expect(again.out()).toContain('Not written (EEXIST)');
	});

	it('audits an unlisted address by its key, never in clear', async () => {
		const { store, getKit } = await seeded();
		const stranger = 'stranger@example.test';
		const run = io([stranger, join(dir, 'x.json')]);
		expect(await exportAddress(run.io, getKit, noSes)).toBe(0);
		expect(run.out()).toContain('not on the user list');
		const row = store.dump().find((i) => i.pk === 'AUDIT' && i.action === 'export');
		expect(String(row?.target)).toMatch(/^unlisted:/);
		expect(JSON.stringify(store.dump())).not.toContain(stranger);
		const data = JSON.parse(await readFile(join(dir, 'x.json'), 'utf8')) as AccessExport;
		expect(data.records.user.found).toBe(0);
		expect(data.records.sesSuppression.data).toEqual({ notChecked: 'not in this test' });
	});

	it('writes to stdout on -', async () => {
		const { getKit } = await seeded();
		const run = io([USER, '-']);
		expect(await exportAddress(run.io, getKit, noSes)).toBe(0);
		expect(run.out()).toContain('"records"');
	});

	it('refuses a bad address and a path inside the repository, before auditing', async () => {
		const { store, getKit } = await seeded();
		expect(await exportAddress(io(['not an address', '-']).io, getKit, noSes)).toBe(1);
		const inside = io([USER, join(REPO, 'answer.json')]);
		expect(await exportAddress(inside.io, getKit, noSes)).toBe(1);
		expect(inside.out()).toContain('inside the repository');
		expect(store.dump().filter((i) => i.pk === 'AUDIT' && i.action === 'export')).toEqual([]);
	});

	it('reads only absolute or ~/ paths outside the repository', () => {
		expect(outputPath('-')).toBe('-');
		expect(outputPath('/tmp/a.json', '/repo')).toBe('/tmp/a.json');
		expect(outputPath('~/a.json', '/repo')).toMatch(/\/a\.json$/);
		expect(() => outputPath('a.json', '/repo')).toThrow(/absolute/);
		expect(() => outputPath('/repo/a.json', '/repo')).toThrow(/inside the repository/);
		expect(() => outputPath('/repo/x/../b/a.json', '/repo')).toThrow(/inside the repository/);
		expect(() => outputPath('/repo', '/repo')).toThrow(/inside the repository/);
		expect(outputPath('/repo-private/a.json', '/repo')).toBe('/repo-private/a.json');
		expect(() => outputPath('', '/repo')).toThrow(/No output path/);
	});

	it('reports an SES refusal by name, still writes the export saying so, and exits 1', async () => {
		const { getKit } = await seeded();
		const denied = async (): Promise<SuppressionLookup> => ({
			read: sesSuppressionReader({ send: async () => { throw Object.assign(new Error(`not authorized to read ${USER}`), { name: 'AccessDeniedException' }); } } as never),
			where: 'the test SES'
		});
		const file = join(dir, 'a.json');
		const run = io([USER, file]);
		expect(await exportAddress(run.io, getKit, denied)).toBe(1);
		expect(run.out()).toContain('ses:GetSuppressedDestination');
		expect(run.out()).not.toContain(USER);
		const data = JSON.parse(await readFile(file, 'utf8')) as AccessExport;
		expect(data.records.sesSuppression).toMatchObject({ found: 0, data: { notChecked: 'SES refused (AccessDeniedException)' } });
	});

	it('reads SES with GetSuppressedDestination, NotFoundException meaning not suppressed', async () => {
		const sent: { constructor: { name: string }; input: unknown }[] = [];
		const missing = sesSuppressionReader({ send: async (cmd: never) => { sent.push(cmd); throw Object.assign(new Error('nope'), { name: 'NotFoundException' }); } } as never);
		expect(await missing(USER)).toBeNull();
		expect(sent[0]?.constructor.name).toBe('GetSuppressedDestinationCommand');
		expect(sent[0]?.input).toEqual({ EmailAddress: USER });
		const found = sesSuppressionReader({ send: async () => ({ SuppressedDestination: { EmailAddress: USER, Reason: 'BOUNCE', LastUpdateTime: new Date('2026-10-01T00:00:00Z') } }) } as never);
		expect(await found(USER)).toEqual({ reason: 'BOUNCE', lastUpdated: '2026-10-01T00:00:00.000Z' });
	});

	it('skips SES against DynamoDB Local, and uses af-south-1 and the pitman profile otherwise', async () => {
		expect((await sesSuppressionLookup({ DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000' })).read).toBeNull();
		const profile = process.env.AWS_PROFILE;
		try {
			delete process.env.AWS_PROFILE;
			const real = await sesSuppressionLookup({});
			expect(real.read).toBeTypeOf('function');
			expect('where' in real && real.where).toBe('SES in af-south-1 (profile pitman)');
		} finally {
			if (profile === undefined) delete process.env.AWS_PROFILE;
			else process.env.AWS_PROFILE = profile;
		}
	});
});
