// `pnpm admin:export`: step 3 of the access-request procedure (POPIA s23, docs/security.md § Access requests).
// Reads the address from stdin (never argv, so never shell history), writes an audit row first (actor
// `operator`, action `export`, target the address if listed or `unlisted:<hmac>` if not, like clear-lock), so
// no export goes unrecorded, then gathers every record that names the address, one section per kind in
// personal-records.ts (the same list erasure's coverage is tested against), and writes it as JSON to a file
// the operator names, outside the repository, or to stdout. Other people's addresses in those records are
// withheld. Prints counts only, never the address.
//
// The table is read through auth-kit's own store (the operator's credentials), the same way erase-address
// works. SES's suppression list is read with SES v2 GetSuppressedDestination (the profile needs
// ses:GetSuppressedDestination). The Lambda can do neither.
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_RETENTION_MONTHS, OPERATOR, SYSTEM, auditExpiry, normalEmail, type AuditAction, type AuditEntry, type AuthKit } from '@absence0760/auth-kit';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { type OperatorIO, operatorSes, prompter, refuseArguments, runIfMain } from './operator.js';
import { PERSONAL_RECORDS, type PersonalRecordKind } from './personal-records.js';

/**
 * The audit action this script records. auth-kit's AuditAction has no access-request action yet, so the row
 * carries one outside its union; the store writes and reads it unchanged and the Users page words it
 * (frontend/src/lib/auth/audit.ts). To be replaced by auth-kit's own action once it has one.
 */
export const EXPORT_ACTION = 'export' as AuditAction;

/** An SES suppression entry for the address, or none. */
export type SuppressionEntry = { reason: string; lastUpdated: string } | null;
export type ReadSuppression = (email: string) => Promise<SuppressionEntry>;
export type SuppressionLookup = { read: ReadSuppression; where: string } | { read: null; why: string };

/** SES v2 GetSuppressedDestination through `client`, NotFoundException meaning not suppressed. */
export function sesSuppressionReader(client: Pick<SESv2Client, 'send'>): ReadSuppression {
	return async (email) => {
		const { GetSuppressedDestinationCommand } = await import('@aws-sdk/client-sesv2');
		try {
			const r = await client.send(new GetSuppressedDestinationCommand({ EmailAddress: email }));
			const d = r.SuppressedDestination;
			return { reason: d?.Reason ?? 'unknown', lastUpdated: d?.LastUpdateTime ? new Date(d.LastUpdateTime).toISOString() : 'unknown' };
		} catch (e) {
			if (e instanceof Error && e.name === 'NotFoundException') return null;
			throw e;
		}
	};
}

/** The real one: SES in af-south-1 with the operator's profile; none against DynamoDB Local. */
export async function sesSuppressionLookup(env: Record<string, string | undefined> = process.env): Promise<SuppressionLookup> {
	const ses = await operatorSes(env);
	if (!ses.client) return { read: null, why: `${ses.why}: there is no SES suppression list to read` };
	return { read: sesSuppressionReader(ses.client), where: ses.where };
}

/** auth-kit's audit actions in words. A Record over the union, so a new auth-kit action fails the typecheck here. */
const ACTIONS: Record<AuditAction, string> = {
	bootstrap: 'made the first admin',
	add: 'added to the user list',
	remove: 'removed from the user list',
	'make admin': 'made an admin',
	'remove admin': 'admin rights taken away',
	recover: 'admin rights restored by the operator',
	'clear-lock': 'sign-in lock cleared',
	erase: 'address erased from the log',
	'mail.bounce': 'mail to the address bounced (reported by Amazon SES)',
	'mail.complaint': 'mail was marked as spam (reported by Amazon SES)',
	'mail.cleared': 'mail problem cleared by an admin',
	signin: 'signed in',
	'signin.failed': 'entered a wrong sign-in code',
	'signin.locked': 'locked out after wrong sign-in codes'
};
const actionInWords = (a: string) => (a === EXPORT_ACTION ? 'personal information exported for an access request' : (ACTIONS[a as AuditAction] ?? a));

const iso = (ms: number | null | undefined) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

export interface AuditRowOut {
	at: string;
	action: string;
	actionInWords: string;
	actor: string;
	target: string | null;
	admin?: boolean;
	/** When the row is due to be deleted (DynamoDB TTL, usually within a few days of it). */
	deletedAround: string | null;
}

export interface AccessExport {
	about: string;
	generatedAt: string;
	address: string;
	/** Every kind in personal-records.ts, in its order. */
	records: { [K in PersonalRecordKind]: { what: string; found: number; data: unknown } };
	/** Who has or has had access (POPIA s23(1)(b)). */
	recipients: readonly string[];
	notHeld: string[];
}

/**
 * Everything the table and SES hold that names `email`, with other people's addresses withheld. `ids` are the
 * forms the address takes in audit rows: itself, `unlisted:<hmac>` (sign-in attempts and lock clears while
 * unlisted) and `erased:<hmac>` (a previous erasure).
 */
export async function gatherExport(kit: AuthKit, email: string, suppression: SuppressionEntry | { notChecked: string }): Promise<AccessExport> {
	const { store, keys, clock } = kit.deps;
	const addressKey = await keys.addressKey(email);
	const ids = new Set([email, `unlisted:${addressKey}`, `erased:${addressKey}`]);
	const who = (v: string | null): string | null => {
		if (v === null) return null;
		if (ids.has(v)) return 'you';
		if (v === OPERATOR) return 'the operator';
		if (v === SYSTEM) return 'mail delivery (Amazon SES)';
		return 'another person (withheld)';
	};

	const user = await store.getUserByEmail(email);
	const { code, throttle } = await store.getCodeState(addressKey);
	const audit = await store.listAudit();
	const row = (a: AuditEntry): AuditRowOut => ({
		at: a.at,
		action: a.action,
		actionInWords: actionInWords(a.action),
		actor: who(a.actor) ?? '',
		target: who(a.target),
		...(a.admin !== undefined ? { admin: a.admin } : {}),
		deletedAround: iso(a.expiresAt * 1000)
	});
	// Oldest first: a record reads as a history.
	const asActor = audit.filter((a) => ids.has(a.actor)).map(row).reverse();
	const asTarget = audit.filter((a) => a.target !== null && ids.has(a.target)).map(row).reverse();
	const added = (await store.listUsers()).filter((u) => u.addedBy === email).map((u) => ({ addedAt: u.addedAt, admin: u.isAdmin }));

	const section = <T>(kind: PersonalRecordKind, data: T, found: number) => ({ what: PERSONAL_RECORDS[kind], found, data });
	const records: AccessExport['records'] = {
		user: section(
			'user',
			user && {
				id: user.id,
				address: user.email,
				admin: user.isAdmin,
				addedBy: who(user.addedBy),
				addedAt: user.addedAt,
				signedOutEverywhereAt: iso(user.sessionsRevokedAt),
				mailProblem: user.undeliverable
			},
			user ? 1 : 0
		),
		address: section('address', user ? { address: user.email, findsUser: user.id } : null, user ? 1 : 0),
		code: section('code', code && { expiresAt: iso(code.expiresAt), wrongTries: code.tries }, code ? 1 : 0),
		throttle: section(
			'throttle',
			throttle && {
				codesSent: throttle.sends.map((s) => iso(s)),
				wrongCodesInARow: throttle.fails,
				lastWrongCodeAt: iso(throttle.lastFailAt),
				lockedUntil: iso(throttle.lockedUntil)
			},
			throttle ? 1 : 0
		),
		auditActor: section('auditActor', asActor, asActor.length),
		auditTarget: section('auditTarget', asTarget, asTarget.length),
		addedBy: section('addedBy', added, added.length),
		sesSuppression: section('sesSuppression', suppression, suppression && !('notChecked' in suppression) ? 1 : 0)
	};
	return {
		about: `The personal information Pitman holds about ${email}, gathered for an access request under POPIA section 23. Times are UTC (ISO 8601). Audit rows are kept for about ${AUDIT_RETENTION_MONTHS} months.`,
		generatedAt: new Date(clock.now()).toISOString(),
		address: email,
		records,
		recipients: RECIPIENTS,
		notHeld: [
			'Network files and the working copy stay in your browser; Pitman’s servers never receive them. The data API receives only area outlines.',
			'Server logs record events with at most a user id, never an address, code or token, and are deleted after 30 days.',
			'Signed-out sessions are recorded by session id and user id only, until the session would have expired (7 days).',
			'Deleted records stay in the database’s point-in-time recovery for 35 days, and are not restored from it.'
		]
	};
}

/**
 * Who has or has had access to the records (POPIA s23(1)(b): "the identity of all third parties, or categories of
 * third parties, who have, or have had, access"). Fixed: Pitman shares nothing with anyone else.
 */
export const RECIPIENTS = [
	'Amazon Web Services, which runs Pitman’s servers, database and mail (Amazon SES) in South Africa (af-south-1), as Pitman’s operator.',
	'Pitman’s admins, who see the user list and the audit record on the Users page.',
	'Pitman’s owner, who runs the operator scripts (this export among them).'
] as const;

/** The repository's root (this file is backend/scripts/export-address.ts). */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Where to write: an absolute or `~/` path outside the repository, or `-` for stdout. Throws on a path inside it. */
export function outputPath(answer: string, repoRoot = REPO_ROOT): string | '-' {
	if (answer === '-') return '-';
	if (!answer) throw new Error('No output path given.');
	const expanded = answer === '~' || answer.startsWith('~/') ? homedir() + answer.slice(1) : answer;
	if (!isAbsolute(expanded)) throw new Error('Give an absolute path (or one starting ~/), outside the repository, or - for stdout.');
	const abs = resolve(expanded);
	const rel = relative(resolve(repoRoot), abs);
	if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('That path is inside the repository: personal information never goes into the working tree. Choose a path outside it.');
	return abs;
}

export async function main(
	io: OperatorIO,
	kit: () => Promise<{ kit: AuthKit; where: string }>,
	suppression: () => Promise<SuppressionLookup> = () => sesSuppressionLookup()
): Promise<number> {
	refuseArguments(io);
	const { kit: auth, where } = await kit();
	io.stdout.write(`Exporting what ${where} holds about an address (POPIA access request).\n`);
	const ask = prompter(io);
	const email = normalEmail(await ask('Email address to export: '));
	if (!email) {
		io.stdout.write('Refused (400): that is not an email address.\n');
		return 1;
	}
	let out: string;
	try {
		out = outputPath(await ask('Write the export to (an absolute path outside the repository, or - for stdout): '));
	} catch (e) {
		io.stdout.write(`Refused: ${(e as Error).message}\n`);
		return 1;
	}

	// Audited before anything is read, so no export goes unrecorded; the row is part of the export.
	const { store, keys, clock, random } = auth.deps;
	const listed = (await store.getUserByEmail(email)) !== null;
	const now = clock.now();
	await store.appendAudit({
		id: random.uuid(),
		at: new Date(now).toISOString(),
		actor: OPERATOR,
		action: EXPORT_ACTION,
		target: listed ? email : `unlisted:${await keys.addressKey(email)}`,
		expiresAt: auditExpiry(now)
	});

	const ses = await suppression();
	let entry: SuppressionEntry | { notChecked: string };
	let sesFailed = false;
	if (!ses.read) {
		entry = { notChecked: ses.why };
	} else {
		try {
			entry = await ses.read(email);
		} catch (e) {
			// By name only: SES may put the address in its message.
			const name = e instanceof Error ? e.name : 'unknown error';
			entry = { notChecked: `SES refused (${name})` };
			sesFailed = true;
		}
	}

	const data = await gatherExport(auth, email, entry);
	const json = `${JSON.stringify(data, null, '\t')}\n`;
	if (out === '-') {
		io.stdout.write(`\n${json}\n`);
	} else {
		try {
			// Never overwrites; readable by the operator only.
			await writeFile(out, json, { flag: 'wx', mode: 0o600 });
		} catch (e) {
			io.stdout.write(`Not written (${e instanceof Error && 'code' in e ? String(e.code) : 'error'}): choose a new file in a directory that exists.\n`);
			return 1;
		}
	}
	const counts = Object.entries(data.records)
		.map(([k, v]) => `${k} ${v.found}`)
		.join(', ');
	io.stdout.write(
		[
			`Done${out === '-' ? '' : `: written to ${out}`}. Found: ${counts}. ${listed ? 'The address is on the user list.' : 'The address is not on the user list.'} Audited as "export".`,
			sesFailed
				? 'SES suppression list: not read; your profile needs ses:GetSuppressedDestination. The export says it was not checked: fix the grant and run `pnpm admin:export` again, or check it by hand (docs/security.md § Access requests).'
				: ses.read
					? `SES suppression list (${ses.where}): read.`
					: `SES suppression list: skipped, ${ses.why}.`,
			'',
			'Next (docs/security.md § Access requests):',
			'  4. Check the mail-event dead-letter queue and the logs as that section says, and add anything found.',
			'  5. Send the file to the verified address only, then delete your copy; record the date and that it was answered (not the address).',
			''
		].join('\n')
	);
	return sesFailed ? 1 : 0;
}

runIfMain(import.meta.url, main);
