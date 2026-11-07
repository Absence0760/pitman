// `pnpm admin:export`: step 3 of the access-request procedure (POPIA s23, docs/security.md § Access requests).
// Reads the address from stdin (never argv, so never shell history), then calls auth-kit's exportAddress,
// which writes an audit row first (actor `operator`, action `export`, target the address if listed or
// `unlisted:<hmac>` if not, like clear-lock), so no export goes unrecorded, and returns every record in the
// table that names the address, one section per kind in auth-kit's PERSONAL_RECORDS (the same list its
// eraseAddress works from, and its tests hold the two together), other people's addresses withheld. Pitman
// adds the one kind it keeps outside the table, the SES suppression entry, and writes it all as JSON to a
// file the operator names, outside the repository, or to stdout. Prints counts only, never the address.
//
// The table is read through auth-kit (the operator's credentials), the same way erase-address works. SES's
// suppression list is read with SES v2 GetSuppressedDestination (the profile needs
// ses:GetSuppressedDestination). The Lambda can do neither.
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_RETENTION_MONTHS, normalEmail, type AddressExport, type AuditAction, type AuthKit, type ExportedAuditRow } from '@absence0760/auth-kit';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { type OperatorIO, operatorSes, prompter, refuseArguments, runIfMain } from './operator.js';

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
	export: 'personal information exported for an access request',
	'mail.bounce': 'mail to the address bounced (reported by Amazon SES)',
	'mail.complaint': 'mail was marked as spam (reported by Amazon SES)',
	'mail.cleared': 'mail problem cleared by an admin',
	signin: 'signed in',
	'signin.failed': 'entered a wrong sign-in code',
	'signin.locked': 'locked out after wrong sign-in codes'
};

/** An audit row as auth-kit exports it, with its action in words. */
export type AuditRowOut = ExportedAuditRow & { actionInWords: string };

/** The kind of record pitman holds outside auth-kit's table, in the same words as auth-kit's PERSONAL_RECORDS. */
export const SES_SUPPRESSION = 'Whether Amazon SES has put your address on Pitman’s suppression list (after a hard bounce or a spam complaint), and when.';

type Records = AddressExport['records'];
type Section<T> = { what: string; found: number; data: T };

export interface AccessExport {
	about: string;
	generatedAt: string;
	address: string;
	/** Every kind in auth-kit's PERSONAL_RECORDS, in its order (audit rows with their actions in words), then SES. */
	records: Omit<Records, 'auditActor' | 'auditTarget'> & {
		auditActor: Section<AuditRowOut[]>;
		auditTarget: Section<AuditRowOut[]>;
		sesSuppression: Section<SuppressionEntry | { notChecked: string }>;
	};
	/** Who has or has had access (POPIA s23(1)(b)). */
	recipients: readonly string[];
	notHeld: string[];
}

/** Who a record names, in the export's words: auth-kit's defaults, with its mail service named. */
export const PARTIES = { system: 'mail delivery (Amazon SES)' } as const;

/**
 * auth-kit's export of the table, with audit actions in words and the SES suppression entry added: everything
 * Pitman holds that names the address, with other people's addresses withheld.
 */
export function accessExport(table: AddressExport, suppression: SuppressionEntry | { notChecked: string }): AccessExport {
	const inWords = (s: Section<ExportedAuditRow[]>): Section<AuditRowOut[]> => ({ ...s, data: s.data.map((r) => ({ ...r, actionInWords: ACTIONS[r.action] })) });
	return {
		about: `The personal information Pitman holds about ${table.address}, gathered for an access request under POPIA section 23. Times are UTC (ISO 8601). Audit rows are kept for about ${AUDIT_RETENTION_MONTHS} months.`,
		generatedAt: table.generatedAt,
		address: table.address,
		records: {
			...table.records,
			auditActor: inWords(table.records.auditActor),
			auditTarget: inWords(table.records.auditTarget),
			sesSuppression: { what: SES_SUPPRESSION, found: suppression && !('notChecked' in suppression) ? 1 : 0, data: suppression }
		},
		recipients: RECIPIENTS,
		notHeld: [
			'Network files and the working copy stay in your browser; Pitman’s servers never receive them. The data API receives only area outlines.',
			'Server logs record events with at most a user id, never an address, code or token, and are deleted after 30 days.',
			'Sessions you signed out of are in revokedSessions while you are on the user list. Once you are removed, any still held name only a session id and a user id that no longer leads to your address, until they would have expired (7 days), so they cannot be found by address.',
			'Deleted records stay in the database’s point-in-time recovery for 35 days, and are not restored from it.',
			'A sign-in code requested in the last day may still sit in the mail queue (or, if it could not be sent, its dead-letter queue for a day), sealed with your address so no one can read it, until it expires; it cannot be searched by address.'
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

	// auth-kit audits before it reads, so no export goes unrecorded; the row is part of the export. SES after.
	const table = await auth.exportAddress(email, PARTIES);
	if (!table.ok) {
		io.stdout.write(`Refused (${table.status}): ${table.error} Nothing was exported.\n`);
		return 1;
	}
	const { listed } = table.value;

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

	const data = accessExport(table.value, entry);
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
